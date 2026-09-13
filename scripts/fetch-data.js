// ============================================================================
// 数据源交叉核对 / 抓取（V4.5，方案 17.5 L2 与第十二节风险表）
// ----------------------------------------------------------------------------
// 这个脚本做三件事，顺序不能变：
//   1. 从主数据源（gudaoxuri/lottery_history）拉取最新全量数据；
//   2. 与本地已有数据**逐期逐号交叉核对**——不一致就报警并停线，绝不"随便挑一个继续跑"；
//   3. 只有核对通过才写回 data/ssq_source.json（写之前先备份上一版）。
//
// 关于"多数据源"的诚实说明：
//   本脚本的主源是 gudaoxuri/lottery_history（GitHub Actions 每日更新，数据文件
//   data/ssq.json，字段 issueNumber/redBalls/blueBall/drawDate）。
//   第二个独立来源需要人工/联网核实后通过 --peer 参数传入，脚本会把两个来源
//   在**新增期号**上做比对，只有两个来源一致的新期才会被接受。
//   这是方案里"多数据源容灾 + 不一致就报警"那一条的最小可用实现。
//
// 用法：
//   node scripts/fetch-data.js                      # 抓取 + 与本地核对，报告差异
//   node scripts/fetch-data.js --apply              # 核对通过后写回 ssq_source.json（自动备份）
//   node scripts/fetch-data.js --peer <url|file>    # 额外用第二个来源比对新增期
// ============================================================================

const fs = require("fs");
const path = require("path");
const https = require("https");

const ROOT = path.join(__dirname, "..");
const LOCAL_SOURCE = path.join(ROOT, "data", "ssq_source.json");
const UPSTREAM_REPO = "gudaoxuri/lottery_history";

// 上游数据的两个读取入口，走的是 GitHub 的两个不同域名。
// 顺序是实测出来的，不是猜的：
//   · api.github.com       —— 本机 Node 拉取稳定成功
//   · raw.githubusercontent —— 本机 Node 经常 ENOTFOUND / ECONNRESET
//     （同一时刻 PowerShell 却能拉到，说明是 Node 这条链路/解析的问题，不是网络断了）
// 所以第一个入口放稳定的那个；备用入口保留，是为了应对单域名故障或 API 限流
// （未认证的 contents API 每小时 60 次，我们一天最多用几次，完全够）。
// 教训：这个脚本存在的意义就是"别让该更新的那一期静默漏掉"，
// 而"只认一个域名"本身就是一种静默失败源。
const UPSTREAM_URLS = [
  { name: "api.github.com (contents API)", url: `https://api.github.com/repos/${UPSTREAM_REPO}/contents/data/ssq.json`, accept: "application/vnd.github.raw" },
  { name: "raw.githubusercontent.com", url: `https://raw.githubusercontent.com/${UPSTREAM_REPO}/main/data/ssq.json` },
];

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const peerIdx = args.indexOf("--peer");
const PEER = peerIdx >= 0 ? args[peerIdx + 1] : null;

function fetchText(url, redirects = 0, accept = null) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("重定向次数过多"));
    const headers = { "User-Agent": "LotteryLab-fetch/1.0" };
    headers.Accept = accept || "application/json,text/plain,*/*";
    https
      .get(url, { headers }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(fetchText(res.headers.location, redirects + 1, accept));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        let body = "";
        res.setEncoding("utf-8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve(body));
      })
      .on("error", reject);
  });
}

// 带重试的抓取（方案要求：抓取脚本必须做重试 + 容灾）
async function fetchWithRetry(url, attempts = 3, accept = null) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fetchText(url, 0, accept);
    } catch (e) {
      lastErr = e;
      // 有些网络错误（如 ECONNRESET）的 message 是空字符串，
      // 直接打印会变成"第 1/3 次抓取失败："后面什么都没有——那种日志等于没有日志。
      const desc = e.message || e.code || e.name || String(e);
      console.log(`  第 ${i}/${attempts} 次抓取失败：${desc}`);
      if (i < attempts) await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
  throw lastErr;
}

/**
 * 依次尝试多个 GitHub 域名，取第一个成功的。
 * 返回 { body, sourceName } —— 把实际用了哪个入口带出去，写进日志，
 * 这样"某天开始一直走备用入口"这件事是可见的，而不是悄悄降级。
 */
async function fetchUpstream() {
  const errors = [];
  for (const entry of UPSTREAM_URLS) {
    console.log(`  尝试入口：${entry.name}`);
    try {
      const body = await fetchWithRetry(entry.url, 3, entry.accept);
      return { body, sourceName: entry.name };
    } catch (e) {
      errors.push(`${entry.name}: ${e.message}`);
      console.log(`  入口 ${entry.name} 全部重试失败，切换到下一个入口`);
    }
  }
  throw new Error(`所有上游入口均失败：\n      · ${errors.join("\n      · ")}`);
}

// 把任意来源的记录规范化成 { period, date, red[], blue }
// 支持两种字段风格：issueNumber/redBalls/blueBall/drawDate（上游）与
// period/red/blue/date（本项目内部格式），这样 --peer 可以吃本地同格式的文件。
function normalizeRecord(r) {
  const period = String(r.issueNumber ?? r.period ?? "");
  const date = String(r.drawDate ?? r.date ?? "");
  const redRaw = r.redBalls ?? r.red;
  const blueRaw = r.blueBall ?? r.blue;
  if (!period || !date || !Array.isArray(redRaw) || blueRaw === undefined) return null;
  return {
    period,
    date,
    red: redRaw.map((n) => Number(n)).sort((a, b) => a - b),
    blue: Number(blueRaw),
  };
}

function normalizeList(list) {
  return list.map(normalizeRecord).filter(Boolean).sort((a, b) => Number(a.period) - Number(b.period));
}

function describe(rec) {
  return `红[${rec.red.map((n) => String(n).padStart(2, "0")).join(" ")}] 蓝${String(rec.blue).padStart(2, "0")} (${rec.date})`;
}

function assertSane(recs, label) {
  // 交叉核对之前先做最低限度的形状校验：如果一个来源自己就是坏的，
  // 拿它去"核对"另一个来源只会把错误放大。
  const problems = [];
  const seen = new Set();
  recs.forEach((r) => {
    if (!/^\d{5}$/.test(r.period)) problems.push(`${r.period}: 期号格式异常`);
    if (seen.has(r.period)) problems.push(`${r.period}: 期号重复`);
    seen.add(r.period);
    if (r.red.length !== 6 || new Set(r.red).size !== 6) problems.push(`${r.period}: 红球数量/重复异常`);
    if (r.red.some((n) => n < 1 || n > 33)) problems.push(`${r.period}: 红球越界`);
    if (r.blue < 1 || r.blue > 16) problems.push(`${r.period}: 蓝球越界`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) problems.push(`${r.period}: 日期格式异常`);
  });
  if (problems.length) {
    console.log(`  [FAIL] ${label} 自身形状校验未通过，共 ${problems.length} 处：`);
    problems.slice(0, 8).forEach((p) => console.log(`         · ${p}`));
    return false;
  }
  console.log(`  [pass] ${label} 形状校验通过：${recs.length} 期，${recs[0].period} ~ ${recs[recs.length - 1].period}`);
  return true;
}

async function main() {
  console.log("=".repeat(78));
  console.log("数据源交叉核对（V4.5）");
  console.log("=".repeat(78));
  console.log(`主数据源：${UPSTREAM_REPO}`);
  console.log(`本地文件：data/ssq_source.json`);
  console.log("");

  if (!fs.existsSync(LOCAL_SOURCE)) {
    console.error("[fail] 本地数据文件不存在，无法做交叉核对（首次抓取请先手动确认来源）。");
    process.exit(1);
  }

  console.log("【1/4】抓取上游数据（多入口 + 每个入口 3 次重试）...");
  const fetched = await fetchUpstream();
  const upstreamRaw = fetched.body;
  console.log(`  成功，来源入口：${fetched.sourceName}`);
  const upstream = normalizeList(JSON.parse(upstreamRaw));
  const upstreamOk = assertSane(upstream, "上游数据");

  console.log("");
  console.log("【2/4】读取本地数据...");
  const local = normalizeList(JSON.parse(fs.readFileSync(LOCAL_SOURCE, "utf-8")));
  const localOk = assertSane(local, "本地数据");

  if (!upstreamOk || !localOk) {
    console.log("");
    console.log("任一方形状校验未通过 —— 停止，不做任何合并。");
    console.log("抓错数据不被发现，比抓不到数据要恐怖得多（方案第六节）。");
    process.exit(1);
  }

  console.log("");
  console.log("【3/4】逐期交叉核对...");
  const upMap = new Map(upstream.map((r) => [r.period, r]));
  const locMap = new Map(local.map((r) => [r.period, r]));

  const mismatches = [];
  let matched = 0;
  for (const [period, l] of locMap) {
    const u = upMap.get(period);
    if (!u) continue;
    matched++;
    const same = JSON.stringify(l.red) === JSON.stringify(u.red) && l.blue === u.blue && l.date === u.date;
    if (!same) mismatches.push({ period, local: l, upstream: u });
  }

  const onlyLocal = [...locMap.keys()].filter((p) => !upMap.has(p)).sort();
  const onlyUpstream = [...upMap.keys()].filter((p) => !locMap.has(p)).sort();

  console.log(`  两边共有的期数：${matched}`);
  console.log(`  号码/日期不一致：${mismatches.length} 期`);
  console.log(`  只在上游有（本地缺失的新期）：${onlyUpstream.length} 期`);
  console.log(`  只在本地有（上游查不到，可疑）：${onlyLocal.length} 期`);

  if (mismatches.length > 0) {
    console.log("");
    console.log("  [FAIL] 两个来源对同一期给出不同号码，禁止自动发布：");
    mismatches.slice(0, 10).forEach((m) => {
      console.log(`         · 第 ${m.period} 期：本地 ${describe(m.local)}  vs  上游 ${describe(m.upstream)}`);
    });
    console.log("");
    console.log("=".repeat(78));
    console.log("交叉核对失败 —— 按方案要求：暂停自动发布并报警，不挑一个继续跑。");
    console.log("=".repeat(78));
    process.exit(1);
  }

  if (onlyLocal.length > 0) {
    console.log("");
    console.log("  [warn] 以下期号只存在于本地、在上游查不到，需要人工确认后再决定是否保留：");
    onlyLocal.slice(0, 10).forEach((p) => console.log(`         · ${p}  ${describe(locMap.get(p))}`));
  }

  const newRecords = onlyUpstream.map((p) => upMap.get(p));
  if (newRecords.length > 0) {
    console.log("");
    console.log("  上游新增期数明细：");
    newRecords.forEach((r) => console.log(`         · ${r.period}  ${describe(r)}`));
  } else {
    console.log("");
    console.log("  上游没有新期，本地数据已是最新。");
  }

  console.log("");
  console.log("【4/4】第二来源比对" + (PEER ? `（${PEER}）` : "（未提供，跳过）"));
  let peerVerified = null;
  if (PEER && newRecords.length > 0) {
    try {
      let peerRaw;
      if (/^https?:\/\//i.test(PEER)) {
        peerRaw = await fetchWithRetry(PEER);
      } else {
        peerRaw = fs.readFileSync(path.resolve(PEER), "utf-8");
      }
      const peer = normalizeList(JSON.parse(peerRaw));
      assertSane(peer, "第二来源");
      const peerMap = new Map(peer.map((r) => [r.period, r]));
      const results = newRecords.map((r) => {
        const p = peerMap.get(r.period);
        if (!p) return { period: r.period, status: "第二来源没有这一期" };
        const same = JSON.stringify(p.red) === JSON.stringify(r.red) && p.blue === r.blue && p.date === r.date;
        return { period: r.period, status: same ? "一致" : `不一致：第二来源 ${describe(p)}` };
      });
      results.forEach((x) => console.log(`         · ${x.period}：${x.status}`));
      const disagree = results.filter((x) => x.status !== "一致");
      peerVerified = disagree.length === 0;
      if (disagree.length > 0) {
        console.log("");
        console.log("  [FAIL] 新增期在两个来源之间不一致，禁止写入。");
        process.exit(1);
      }
    } catch (e) {
      console.log(`         [warn] 第二来源读取失败：${e.message}（不阻断，但新增期将标记为"单一来源"）`);
      peerVerified = false;
    }
  } else if (PEER && newRecords.length === 0) {
    console.log("         没有新增期，无需比对。");
  } else if (newRecords.length > 0) {
    console.log("         [warn] 有新增期但没有第二来源背书 —— 这些期会被标记为「单一来源」，");
    console.log("                页面必须如实显示这一点（方案：单源数据不能自称已交叉核对）。");
  }

  console.log("");
  if (!APPLY) {
    console.log("=".repeat(78));
    console.log(`核对完成（未写入）。共有 ${newRecords.length} 期新增。`);
    console.log("确认无误后加上 --apply 才会写回 data/ssq_source.json（写入前自动备份）。");
    console.log("=".repeat(78));
    return;
  }

  // 写回：本地全量 + 上游新增（保持上游字段风格，prepare-data.js 才能直接吃）
  // 只有在**确实有新增期**时才写文件、才做备份。
  // 否则工作流一天空跑好几次，data/ 目录里会堆满一模一样的备份——噪音会淹掉信号，
  // 真正需要回头看某次数据变更时，反而分不清哪个备份是有意义的。
  if (newRecords.length === 0) {
    console.log("");
    console.log("上游没有新期，无需写入，也不生成备份（避免空跑产生无意义的备份文件）。");
    return;
  }

  const backup = LOCAL_SOURCE.replace(/\.json$/, `.bak-${Date.now()}.json`);
  fs.copyFileSync(LOCAL_SOURCE, backup);
  console.log(`已备份旧版数据 → ${path.relative(ROOT, backup).replace(/\\/g, "/")}`);

  const merged = [
    ...JSON.parse(fs.readFileSync(LOCAL_SOURCE, "utf-8")),
    ...newRecords.map((r) => ({
      issueNumber: r.period,
      redBalls: [...r.red],
      blueBall: r.blue,
      drawDate: r.date,
    })),
  ];
  fs.writeFileSync(LOCAL_SOURCE, JSON.stringify(merged, null, 2), "utf-8");
  console.log(`已写回 data/ssq_source.json，共 ${merged.length} 期。`);
  console.log("");
  console.log("下一步（顺序不能变）：");
  console.log("  node scripts/prepare-data.js   # 清洗");
  console.log("  node scripts/verify-data.js    # 硬校验门禁");
  console.log("  node src/build.js              # 重跑回测");
  console.log("  node src/build-site.js         # 重新生成页面");
  console.log("  node scripts/audit-safety.js   # 合规审计门禁");
  if (peerVerified === false) {
    console.log("");
    console.log(`注意：本次新增期只有单一来源（${UPSTREAM_REPO}）背书，页面文案必须如实标注。`);
  } else if (peerVerified === true) {
    console.log("");
    console.log("本次新增期已通过两个独立来源比对，可以表述为「已交叉核对」。");
  }
}

main().catch((e) => {
  console.error(`[fail] ${e.message}`);
  process.exit(1);
});
