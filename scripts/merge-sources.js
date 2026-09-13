// ============================================================================
// 多数据源合并（方案 17.5 L2 的升级：从"单源 + 人工双源抽查"升级为"多源自动交叉核对"）
// ----------------------------------------------------------------------------
// 为什么需要这个脚本：
//   原先只有 gudaoxuri/lottery_history 一个源、252 期。两个问题：
//     1. 252 期的统计分辨力很弱（很多结论只能标"无证据"）；
//     2. 单源数据无法交叉核对——我只能人工抽查最新一期（26105 期查过官方公告）。
//   现在接入一个有完整历史的第二源，一次解决这两个问题。
//
// 数据源（都经过实际抓取验证，不是"网上听说"）：
//   源A  gudaoxuri/lottery_history  data/ssq.json          —— 每日更新，覆盖近期
//   源C  samuai0410/lottery         data/ssq_history.json  —— 2003 至今完整历史（3446 期）
//
// 合并规则（**每条都要能说清理由**）：
//   1. 两个源对同一期给出不同号码 → **立即停线报警**，不合并（方案第六节）；
//   2. 两源一致 → 标记 corroborated_by = 2，可信度最高；
//   3. 只有单源有的期 → 保留，但标记 corroborated_by = 1，并在页面/README 里如实说明
//      "这部分只有单一来源背书"——不允许悄悄把单源数据当成已核对的。
//   4. 冲突时**不做"少数服从多数"**：只有两个源，没有多数可言；
//      三期以上才谈得上投票，而本站的原则是不一致就停线、人工介入。
//
// 用法：
//   node scripts/merge-sources.js            # 只核对不写入
//   node scripts/merge-sources.js --apply    # 写回 data/ssq_source.json
// ============================================================================

const fs = require("fs");
const path = require("path");
const https = require("https");

const ROOT = path.join(__dirname, "..");
const OUT_SOURCE = path.join(ROOT, "data", "ssq_source.json");
const CORROBORATION_FILE = path.join(ROOT, "data", "source_corroboration.json");
const APPLY = process.argv.includes("--apply");

const SOURCES = [
  {
    key: "A",
    name: "gudaoxuri/lottery_history",
    // 每个源都给多个入口，走不同域名。
    // 实测：本机 Node 拉 raw.githubusercontent.com 频繁 ENOTFOUND/ECONNRESET
    //（同一时刻 PowerShell 却能拉到），而 api.github.com 稳定。
    // "只认一个域名"本身就是静默失败源——抓取容灾的第一课。
    endpoints: [
      {
        url: "https://api.github.com/repos/gudaoxuri/lottery_history/contents/data/ssq.json",
        accept: "application/vnd.github.raw",
      },
      { url: "https://raw.githubusercontent.com/gudaoxuri/lottery_history/main/data/ssq.json" },
    ],
    kind: "gudaoxuri",
  },
  {
    key: "C",
    name: "samuai0410/lottery",
    endpoints: [
      {
        url: "https://api.github.com/repos/samuai0410/lottery/contents/data/ssq_history.json",
        accept: "application/vnd.github.raw",
      },
      { url: "https://raw.githubusercontent.com/samuai0410/lottery/main/data/ssq_history.json" },
    ],
    kind: "samuai",
  },
];

function fetchText(url, accept, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("重定向过多"));
    const headers = { "User-Agent": "LotteryLab-merge/1.0" };
    headers.Accept = accept || "application/json,text/plain,*/*";
    https
      .get(url, { headers }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(fetchText(res.headers.location, accept, redirects + 1));
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

async function fetchWithRetry(url, accept, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fetchText(url, accept);
    } catch (e) {
      lastErr = e;
      const desc = e.message || e.code || String(e);
      console.log(`      第 ${i}/${attempts} 次失败：${desc}`);
      if (i < attempts) await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
  throw lastErr;
}

// 把两种不同的字段风格统一成 { period, date, red[], blue }
function normalize(kind, raw) {
  const rows = kind === "gudaoxuri" ? raw : raw.draws;
  if (!Array.isArray(rows)) throw new Error("数据结构不是数组，字段风格可能变了");
  return rows
    .map((r) => {
      const period = kind === "gudaoxuri" ? r.issueNumber : r.issue;
      const date = kind === "gudaoxuri" ? r.drawDate : r.date;
      const red = kind === "gudaoxuri" ? r.redBalls : r.redBalls;
      const blue = kind === "gudaoxuri" ? r.blueBall : r.blueBall;
      if (period === undefined || !Array.isArray(red)) return null;
      return {
        period: String(period),
        date: String(date),
        red: red.map(Number).sort((a, b) => a - b),
        blue: Number(blue),
      };
    })
    .filter(Boolean)
    .sort((a, b) => Number(a.period) - Number(b.period));
}

function sanity(rows, label) {
  const problems = [];
  const seen = new Set();
  rows.forEach((r) => {
    if (!/^\d{5}$/.test(r.period)) problems.push(`${r.period}: 期号格式异常`);
    if (seen.has(r.period)) problems.push(`${r.period}: 期号重复`);
    seen.add(r.period);
    if (r.red.length !== 6 || new Set(r.red).size !== 6) problems.push(`${r.period}: 红球数量/重复异常`);
    if (r.red.some((n) => n < 1 || n > 33)) problems.push(`${r.period}: 红球越界`);
    if (r.blue < 1 || r.blue > 16) problems.push(`${r.period}: 蓝球越界`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) problems.push(`${r.period}: 日期格式异常`);
  });
  if (problems.length) {
    console.log(`  [FAIL] ${label} 自身形状校验未通过（${problems.length} 处）：`);
    problems.slice(0, 6).forEach((p) => console.log("         · " + p));
    return false;
  }
  console.log(
    `  [pass] ${label}：${rows.length} 期，${rows[0].period} ~ ${rows[rows.length - 1].period}`
  );
  return true;
}

async function main() {
  console.log("=".repeat(78));
  console.log("多数据源合并与交叉核对");
  console.log("=".repeat(78));

  const fetched = {};
  for (const s of SOURCES) {
    console.log(`\n【抓取】源${s.key} ${s.name}`);
    let body = null;
    const errors = [];
    for (const ep of s.endpoints) {
      const host = ep.url.replace(/^https:\/\/([^/]+).*$/, "$1");
      console.log(`      尝试入口：${host}`);
      try {
        body = await fetchWithRetry(ep.url, ep.accept);
        console.log(`      成功`);
        break;
      } catch (e) {
        errors.push(`${host}: ${e.message || e.code || String(e)}`);
        console.log(`      该入口失败，切换下一个`);
      }
    }
    if (!body) {
      console.error(`  [fail] 源${s.key} 所有入口均失败：\n      · ${errors.join("\n      · ")}`);
      process.exit(1);
    }
    const raw = JSON.parse(body);
    const rows = normalize(s.kind, raw);
    if (!sanity(rows, `源${s.key}`)) {
      console.log("\n源自身有问题 —— 停止，不合并。");
      process.exit(1);
    }
    fetched[s.key] = { ...s, rows, meta: raw.metadata || null };
    if (raw.metadata) {
      console.log(
        `         源自身声明：${raw.metadata.firstIssue}（${raw.metadata.firstDate}）~ ` +
          `${raw.metadata.latestIssue}（${raw.metadata.latestDate}），共 ${raw.metadata.totalCount} 期，` +
          `来源 ${raw.metadata.source}`
      );
    }
  }

  // ---- 逐期交叉核对 ----
  console.log("\n【核对】逐期逐号比对");
  const maps = {};
  Object.keys(fetched).forEach((k) => {
    maps[k] = new Map(fetched[k].rows.map((r) => [r.period, r]));
  });

  const allPeriods = [...new Set(Object.values(maps).flatMap((m) => [...m.keys()]))].sort(
    (a, b) => Number(a) - Number(b)
  );

  const conflicts = [];
  const merged = [];
  for (const period of allPeriods) {
    const present = Object.keys(maps).filter((k) => maps[k].has(period));
    const recs = present.map((k) => ({ key: k, rec: maps[k].get(period) }));
    if (recs.length > 1) {
      const first = recs[0].rec;
      const disagree = recs.filter(
        (x) =>
          JSON.stringify(x.rec.red) !== JSON.stringify(first.red) ||
          x.rec.blue !== first.blue ||
          x.rec.date !== first.date
      );
      if (disagree.length > 0) {
        conflicts.push({ period, recs });
        continue;
      }
    }
    merged.push({
      period,
      date: recs[0].rec.date,
      red: recs[0].rec.red,
      blue: recs[0].rec.blue,
      corroborated_by: recs.length,
      sources: present.map((k) => fetched[k].name),
    });
  }

  if (conflicts.length > 0) {
    console.log(`  [FAIL] 发现 ${conflicts.length} 期两个数据源给出不同号码：`);
    conflicts.slice(0, 10).forEach((c) => {
      console.log(`         · 第 ${c.period} 期：`);
      c.recs.forEach((x) =>
        console.log(
          `             源${x.key} 红[${x.rec.red.join(" ")}] 蓝${String(x.rec.blue).padStart(2, "0")} ${x.rec.date}`
        )
      );
    });
    console.log("");
    console.log("=".repeat(78));
    console.log("交叉核对失败 —— 按方案要求：暂停发布并报警，不挑一个继续跑。");
    console.log("=".repeat(78));
    process.exit(1);
  }

  const byOne = merged.filter((m) => m.corroborated_by === 1);
  const byTwo = merged.filter((m) => m.corroborated_by >= 2);
  console.log(`  [pass] 无冲突`);
  console.log(`         两个源共同印证：${byTwo.length} 期`);
  console.log(`         仅单一来源：${byOne.length} 期`);
  const singleBySource = {};
  byOne.forEach((m) => {
    m.sources.forEach((s) => (singleBySource[s] = (singleBySource[s] || 0) + 1));
  });
  Object.entries(singleBySource).forEach(([s, n]) => console.log(`           · 只有 ${s}：${n} 期`));

  const range = { from: merged[0].period, to: merged[merged.length - 1].period, count: merged.length };
  console.log(`\n【结果】合并后：${range.count} 期（${range.from} ~ ${range.to}）`);
  console.log(`        相较合并前的 ${fetched.A.rows.length} 期，增加 ${range.count - fetched.A.rows.length} 期`);

  // 记录每期的印证情况，供页面如实展示（不允许把单源数据说成"已交叉核对"）
  const corroboration = {
    generated_at: new Date().toISOString(),
    sources: SOURCES.map((s) => ({ key: s.key, name: s.name, periods: fetched[s.key].rows.length })),
    total_periods: range.count,
    period_range: range,
    corroborated_by_two_or_more: byTwo.length,
    corroborated_by_one: byOne.length,
    single_source_breakdown: singleBySource,
    conflicts: 0,
    method:
      "两个独立数据源逐期逐号比对（期号、红球集合、蓝球、开奖日期四项全等）。" +
      "两源一致的期标记为已交叉印证；只有单一来源的期如实标记，不作为'已核对'对待。" +
      "任何一期两源不一致即停线报警，不做少数服从多数（只有两个源，没有多数可言）。",
    single_source_note:
      byOne.length > 0
        ? `其中 ${byOne.length} 期只有单一来源背书：` +
          Object.entries(singleBySource)
            .map(([s, n]) => `${s} ${n} 期`)
            .join("、") +
          "。这部分数据通过了内部自洽校验，但没有第二个来源交叉印证——页面与 README 必须如实说明。"
        : "全部期数均由至少两个来源交叉印证。",
  };

  if (!APPLY) {
    console.log("\n（未写入。确认无误后加 --apply）");
    return;
  }

  const backup = OUT_SOURCE.replace(/\.json$/, `.bak-merge-${Date.now()}.json`);
  fs.copyFileSync(OUT_SOURCE, backup);
  console.log(`\n已备份旧数据 → ${path.relative(ROOT, backup).replace(/\\/g, "/")}`);

  // 输出成 prepare-data.js 能吃的格式（保持 issueNumber 字段风格）
  const out = merged.map((m) => ({
    issueNumber: m.period,
    redBalls: m.red,
    blueBall: m.blue,
    drawDate: m.date,
    corroborated_by: m.corroborated_by,
    sources: m.sources,
  }));
  fs.writeFileSync(OUT_SOURCE, JSON.stringify(out, null, 2), "utf-8");
  fs.writeFileSync(CORROBORATION_FILE, JSON.stringify(corroboration, null, 2), "utf-8");
  console.log(`已写回 data/ssq_source.json（${out.length} 期）`);
  console.log(`已写出 data/source_corroboration.json（每期印证情况，供页面展示）`);
  console.log("\n下一步：node scripts/prepare-data.js && node scripts/verify-data.js && node src/build.js && node src/build-site.js");
}

main().catch((e) => {
  console.error(`[fail] ${e.message}`);
  process.exit(1);
});
