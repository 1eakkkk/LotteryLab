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
    return;
  }

  let problems = 0;
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
      console.log(`  [pass] ${rel}`);
    } else {
      problems += results.length;
      console.log(`  [FAIL] ${rel} —— ${results.length} 处问题：`);
      results.forEach((r) => {
        console.log(`         · 第 ${r.line} 行 第 ${r.column} 列 [${r.kind}] ${r.message}`);
      });
    }
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
  console.log("全部工作流通过 GitHub 规则级校验。");
  console.log("=".repeat(78));
}

main().catch((e) => {
  console.error(`[fail] ${e.message}`);
  process.exit(1);
});
