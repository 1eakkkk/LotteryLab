// ============================================================================
// 工作流规则级校验（GitHub 专属规则，YAML 解析器查不出来的那些）
// ----------------------------------------------------------------------------
// 为什么必须有这个脚本（这是一次真实故障换来的）：
//
//   更新工作流里曾经把 cron 的星期写成 "40 13 * * 2,4,7"（想用 7 表示周日）。
//   cron 的星期范围是 0~6，没有 7。GitHub 在**校验阶段就拒绝了整份文件**。
//
//   而它表现出来的样子完全不像 cron 的问题：
//     · workflow 列表里 name 退化成文件路径（因为文件根本没被解析）
//     · 每次 push 都产生一条运行记录，但 jobs = 0
//     · 状态 failure，点进去没有任何日志
//     · 邮件通知只说 "No jobs were run"
//     · **本地所有 YAML 解析器都放行**，因为 "7" 是合法 YAML，只是非法 cron
//
//   结果是排查了很久，方向一度完全跑偏（怀疑过权限、账单、编码、隐藏字符……）。
//   根本原因就是缺一道"按 GitHub 自己的规则校验"的关卡。
//
// 做法：优先用 actionlint（Go 写的官方规则校验器，这里用它的 WASM 构建）。
// 它不在环境里时**不阻断**，但会明确打印"跳过"——不允许静默略过。
// ============================================================================

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const WF_DIR = path.join(ROOT, ".github", "workflows");

function listWorkflows() {
  if (!fs.existsSync(WF_DIR)) return [];
  return fs
    .readdirSync(WF_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => path.join(WF_DIR, f));
}

async function tryLoadActionlint() {
  // 允许通过环境变量指定 actionlint 的安装位置（CI 里可以预装）
  const candidates = [];
  if (process.env.ACTIONLINT_PATH) candidates.push(process.env.ACTIONLINT_PATH);
  candidates.push("actionlint");
  for (const c of candidates) {
    try {
      const mod = require(c);
      if (typeof mod.createLinter === "function") return await mod.createLinter();
    } catch (e) {
      /* 继续尝试下一个 */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 语义校验：cron 表达式必须真的对准开奖日
// ---------------------------------------------------------------------------
// actionlint 只能证明 cron「合法」；它证明不了 cron「对不对」。
// 上次的故障里其实藏了两个独立的错，而 actionlint 只抓得到第一个：
//   · 第一个：星期写成 7 —— 非法，GitHub 直接拒绝整份文件（actionlint 抓到）
//   · 第二个：次日窗口写成周一/三/五 —— 完全合法，但开奖日是周二/周四/周日，
//             次日应该是周三/周五/周一，整个窗口错开了一天（actionlint 抓不到）
// 如果只修第一个，定时任务会在错误的日子醒来，而且不会有任何报错。
//
// 所以这里把「开奖日 → 应当什么时候跑」这个**业务约定**也写成断言。
// 它防的是：以后有人改排程时改错了某一位，而所有工具都说"没问题"。
const DRAW_DAYS = [0, 2, 4]; // 双色球开奖：周日(0) / 周二(2) / 周四(4)

// 期望的排程表。这里写成**完整清单**而不是"至少有一个对得上"，
// 因为后者有漏洞：本次真实性测试里，只把 00:00 那个窗口的星期改错，校验仍然是绿的——
// 因为另一个 08:40 窗口的星期刚好也对得上，把错误掩盖过去了。
// （教训：断言"存在一个正确的"几乎总是太弱，要断言"全部都正确"。）
// 改排程时同步改这张表；如果是有意调整，下面的注释会提醒你在文档里写清原因。
const EXPECTED_SCHEDULE = [
  { expr: "40 13 * * 2,4,0", purpose: "开奖当天 21:40（北京）—— 号码公布后" },
  { expr: "0 16 * * 3,5,1", purpose: "开奖日的次日 00:00（北京）—— 上游通常在这个窗口写入新数据" },
  { expr: "40 0 * * 3,5,1", purpose: "开奖日的次日 08:40（北京）—— 上游刚更新完的兜底" },
];

function parseCron(expr) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dom, month, dow] = parts;
  return {
    minute: Number(minute),
    hour: Number(hour),
    dom,
    month,
    dows: dow.split(",").map(Number),
  };
}

function checkScheduleSemantics(files) {
  const problems = [];
  let checkedAny = false;

  for (const file of files) {
    const rel = path.relative(ROOT, file).replace(/\\/g, "/");
    // 只对抓取更新工作流做这条业务断言（其他工作流不涉及开奖日）
    if (!rel.includes("update-lottery")) continue;
    const src = fs.readFileSync(file, "utf-8");

    const cronRe = /-\s*cron:\s*["']([^"']+)["']/g;
    const crons = [];
    let m;
    while ((m = cronRe.exec(src)) !== null) {
      crons.push({ expr: m[1].trim(), line: src.slice(0, m.index).split("\n").length });
    }
    if (crons.length === 0) continue;
    checkedAny = true;

    const nextDayOf = (d) => (d + 1) % 7;
    const expectSameNight = [...DRAW_DAYS].sort((a, b) => a - b);
    const expectNextDay = DRAW_DAYS.map(nextDayOf).sort((a, b) => a - b);
    const eqSet = (a, b) => JSON.stringify([...a].sort((x, y) => x - y)) === JSON.stringify([...b].sort((x, y) => x - y));
    const dowName = (d) => "周" + "日一二三四五六"[d];

    // ---- 第一层：每个 cron 自身是否合法 ----
    for (const c of crons) {
      const p = parseCron(c.expr);
      if (!p) {
        problems.push(`${rel}:${c.line} cron "${c.expr}" 不是 5 段格式`);
        continue;
      }
      const badDow = p.dows.filter((d) => !Number.isInteger(d) || d < 0 || d > 6);
      if (badDow.length) {
        problems.push(`${rel}:${c.line} cron "${c.expr}" 星期含非法值 ${badDow.join(",")}（合法域 0~6，0=周日；注意没有 7）`);
      }
      if (!(p.hour >= 0 && p.hour <= 23)) problems.push(`${rel}:${c.line} cron "${c.expr}" 小时越界`);
      if (!(p.minute >= 0 && p.minute <= 59)) problems.push(`${rel}:${c.line} cron "${c.expr}" 分钟越界`);
    }

    // ---- 第二层：期望排程必须逐条存在 ----
    const actualSet = new Set(crons.map((c) => c.expr));
    for (const exp of EXPECTED_SCHEDULE) {
      if (!actualSet.has(exp.expr)) {
        problems.push(
          `${rel}: 缺少预期排程 "${exp.expr}"（${exp.purpose}）。` +
            `若是有意调整排程，请同步更新 scripts/lint-workflows.js 里的 EXPECTED_SCHEDULE，并在方案/README 写清原因。`
        );
      }
    }

    // ---- 第三层：每个 cron 的星期必须落在两个合法窗口之一 ----
    // 这一层防的是"多写了一个日子错的开奖窗口"——上面两层都查不出来。
    for (const c of crons) {
      const p = parseCron(c.expr);
      if (!p) continue;
      const isSameNight = eqSet(p.dows, expectSameNight);
      const isNextDay = eqSet(p.dows, expectNextDay);
      if (!isSameNight && !isNextDay) {
        problems.push(
          `${rel}:${c.line} cron "${c.expr}" 的星期 [${p.dows.map(dowName).join("/")}] 既不是开奖当天` +
            `（${expectSameNight.map(dowName).join("/")}）也不是其次日（${expectNextDay.map(dowName).join("/")}）——排错日子了`
        );
      }
    }

    // ---- 第四层：两个窗口都必须有（防"整类窗口被删掉"）----
    const hasSameNight = crons.some((c) => {
      const p = parseCron(c.expr);
      return p && eqSet(p.dows, expectSameNight);
    });
    const hasNextDay = crons.some((c) => {
      const p = parseCron(c.expr);
      return p && eqSet(p.dows, expectNextDay);
    });
    if (!hasSameNight) {
      problems.push(`${rel}: 没有任何 cron 落在「开奖当天」（${expectSameNight.map(dowName).join("/")}）——当晚的更新窗口缺失`);
    }
    if (!hasNextDay) {
      problems.push(`${rel}: 没有任何 cron 落在「开奖日的次日」（${expectNextDay.map(dowName).join("/")}）——次日补跑窗口缺失`);
    }
  }

  return { problems, checkedAny };
}

async function main() {
  const files = listWorkflows();
  console.log("=".repeat(78));
  console.log("工作流规则级校验（actionlint / GitHub 专属规则）");
  console.log("=".repeat(78));
  console.log(`待校验工作流：${files.length} 个`);

  if (files.length === 0) {
    console.log("  [warn] .github/workflows/ 下没有工作流文件，跳过");
    return;
  }

  // ---- 第一层：actionlint（GitHub 语法与规则）----
  const lint = await tryLoadActionlint();
  if (!lint) {
    console.log("");
    console.log("  [SKIP] 未找到 actionlint，无法做规则级校验。");
    console.log("         安装方式（任选其一）：");
    console.log("           npm i -D actionlint                # 用它的 WASM 构建，跨平台");
    console.log("           或在 CI 里预装后设置 ACTIONLINT_PATH 环境变量");
    console.log("");
    console.log("  ⚠ 这不是可以长期忽略的提示：缺了这道校验，一个非法 cron 表达式");
    console.log("    就能让整个定时任务静默失效，而且症状完全不像 cron 的问题。");
  }

  let problems = 0;
  if (lint) {
    for (const file of files) {
      const rel = path.relative(ROOT, file).replace(/\\/g, "/");
      const src = fs.readFileSync(file, "utf-8");
      let results;
      try {
        results = lint(src, rel);
      } catch (e) {
        problems++;
        console.log(`  [FAIL] ${rel} 校验过程抛错：${e.message}`);
        continue;
      }
      if (!results || results.length === 0) {
        console.log(`  [pass] ${rel}  （GitHub 规则级校验）`);
      } else {
        problems += results.length;
        console.log(`  [FAIL] ${rel} —— ${results.length} 处问题：`);
        results.forEach((r) => {
          console.log(`         · 第 ${r.line} 行 第 ${r.column} 列 [${r.kind}] ${r.message}`);
        });
      }
    }
  }

  // ---- 第二层：语义校验（cron 是否真的对准开奖日）----
  console.log("");
  console.log("-".repeat(78));
  console.log("语义校验：cron 是否对准开奖日（actionlint 查不出这一类问题）");
  const sem = checkScheduleSemantics(files);
  if (!sem.checkedAny) {
    console.log("  [warn] 没有找到需要做语义校验的更新工作流，跳过");
  } else if (sem.problems.length === 0) {
    console.log(`  [pass] 开奖当天窗口与次日窗口的星期均与开奖日(${DRAW_DAYS.map((d) => "周" + "日一二三四五六"[d]).join("/")})对齐`);
  } else {
    problems += sem.problems.length;
    sem.problems.forEach((p) => console.log(`  [FAIL] ${p}`));
  }

  console.log("");
  if (problems > 0) {
    console.log("=".repeat(78));
    console.log("工作流校验未通过 —— GitHub 会拒绝执行这些文件，定时更新会静默失效。");
    console.log("请先把上面的问题改掉再推送。");
    console.log("=".repeat(78));
    process.exit(1);
  }
  console.log("=".repeat(78));
  console.log("全部工作流通过 GitHub 规则级校验与开奖日语义校验。");
  console.log("=".repeat(78));
}

main().catch((e) => {
  console.error(`[fail] ${e.message}`);
  process.exit(1);
});
