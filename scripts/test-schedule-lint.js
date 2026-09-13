// 真实性测试：确认 lint-workflows.js 的「排程语义校验」真的会红。
//
// 为什么这个测试必须存在：
//   第一版语义校验写的是"至少有一个 cron 的星期对得上开奖日"，看起来没问题。
//   但真实性测试立刻发现它有漏洞——只把 00:00 那个窗口的星期改错时，校验仍然是绿的，
//   因为另一个 08:40 窗口的星期刚好也对得上，把错误掩盖了。
//   改成"逐条断言期望排程 + 每个 cron 的星期都必须落在合法窗口内"之后才真正有效。
//   **一条从来没红过的校验，和没有校验是一样的**，这个文件就是让它红一次给你看。
//
// 安全性：它会临时改动 .github/workflows/update-lottery.yml，但
//   · 无论正常结束、断言失败还是进程被中断（SIGINT/SIGTERM/未捕获异常），
//     都会把文件还原（见 restore() 与各处的 try/finally、信号处理）；
//   · 还原后又跑了一次校验，确认确实恢复为绿；
//   · 如果还原失败，会以非零码退出并明确报警。
//
// 用法：node scripts/test-schedule-lint.js
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const WF = path.join(ROOT, ".github", "workflows", "update-lottery.yml");
const original = fs.readFileSync(WF, "utf-8");

let restored = false;
function restore() {
  if (restored) return;
  try {
    fs.writeFileSync(WF, original, "utf-8");
    restored = true;
  } catch (e) {
    console.error("!! 还原工作流文件失败：" + e.message);
    console.error("!! 请手工检查 " + WF);
    process.exitCode = 2;
  }
}

// 任何意外退出路径都要还原——这个测试会改动真实文件，不能留下残局
process.on("exit", restore);
process.on("SIGINT", () => {
  restore();
  process.exit(130);
});
process.on("SIGTERM", () => {
  restore();
  process.exit(143);
});
process.on("uncaughtException", (e) => {
  console.error("未捕获异常：" + e.message);
  restore();
  process.exit(1);
});

const mutations = [
  { name: "次日 00:00 窗口改错（3,5,1 → 2,4,6）", from: 'cron: "0 16 * * 3,5,1"', to: 'cron: "0 16 * * 2,4,6"' },
  { name: "次日 08:40 窗口改错（3,5,1 → 2,4,6）", from: 'cron: "40 0 * * 3,5,1"', to: 'cron: "40 0 * * 2,4,6"' },
  { name: "当晚窗口改错（2,4,0 → 2,4,6）", from: 'cron: "40 13 * * 2,4,0"', to: 'cron: "40 13 * * 2,4,6"' },
  { name: "重新引入非法星期 7（回归测试：就是那个真实故障）", from: 'cron: "40 13 * * 2,4,0"', to: 'cron: "40 13 * * 2,4,7"' },
  { name: "整条当晚窗口被删掉", from: '    - cron: "40 13 * * 2,4,0"', to: '    # (已删除)' },
];

let failures = 0;

function runLint() {
  try {
    const out = execFileSync("node", [path.join(ROOT, "scripts", "lint-workflows.js")], {
      cwd: ROOT,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status === undefined ? 1 : e.status, out: (e.stdout || "") + (e.stderr || "") };
  }
}

console.log("=".repeat(78));
console.log("排程语义校验 · 真实性测试（故意改错 cron，看校验会不会红）");
console.log("=".repeat(78));

const base = runLint();
console.log(`基线（未改动）: exit=${base.code} ${base.code === 0 ? "✓ 绿" : "✗ 本应通过（校验脚本自身有问题）"}`);
if (base.code !== 0) {
  failures++;
  console.log(base.out.split("\n").filter((l) => l.includes("[FAIL]")).map((l) => "        " + l.trim()).join("\n"));
}

for (const m of mutations) {
  if (!original.includes(m.from)) {
    console.log(`\n[FAIL] ${m.name} —— 测试自身失效：在工作流里找不到目标文本 ${JSON.stringify(m.from)}`);
    console.log("        （多半是排程被改过，请同步更新本测试的 mutations 列表）");
    failures++;
    continue;
  }
  try {
    fs.writeFileSync(WF, original.replace(m.from, m.to), "utf-8");
    const r = runLint();
    const red = r.code !== 0;
    if (!red) failures++;
    console.log(`\n[${red ? "pass" : "FAIL"}] ${m.name}`);
    console.log(`        校验 exit=${r.code} → ${red ? "已变红 ✓" : "仍是绿的 ✗（校验有漏洞）"}`);
    const reason = r.out
      .split("\n")
      .filter((l) => l.includes("[FAIL]"))
      .slice(0, 3)
      .map((l) => "        " + l.trim())
      .join("\n");
    if (reason) console.log(reason);
  } finally {
    restore();
    restored = false; // 允许下一轮继续改动
  }
}

// 最后一次还原 + 确认恢复为绿
restore();
const finalRun = runLint();
console.log(`\n已还原并复核: exit=${finalRun.code} ${finalRun.code === 0 ? "✓ 恢复为绿" : "✗ 还原后仍失败，请手工检查"}`);
if (finalRun.code !== 0) failures++;

console.log("");
console.log("=".repeat(78));
if (failures === 0) {
  console.log(`真实性测试全部通过（${mutations.length} 种错误注入全部被拦截，且修复后恢复为绿）。`);
} else {
  console.log(`真实性测试失败 ${failures} 项 —— 校验可能存在漏洞，或测试自身失效。`);
  process.exit(1);
}
console.log("=".repeat(78));

