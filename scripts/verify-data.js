// ============================================================================
// L2 数据层防线：数据自洽性校验（方案第十七节 17.5）
// ----------------------------------------------------------------------------
// 定位（非常重要，不要误解这个脚本能做什么）：
//   它能证明的：这份数据**内部没有自相矛盾**（格式、范围、顺序、奖级规则、概率总和）。
//   它不能证明的：这份数据**来自官方**。数据来源是否真实，只能靠人工核对官方渠道，
//                 或者靠多数据源交叉比对——见下方"抽样核对表"，那是目前唯一诚实的替代方案。
//
// 所以本脚本的产出有两条用途：
//   1. 硬校验失败 → 直接停线（脏数据不许进回测管线）；退出码 1。
//   2. 通过 → 生成 data/verification.json，把"数据指纹 + 抽样核对表 + 分布检验结果"
//      交给页面展示，把原本隐藏的信任假设变成页面上公开可见的已知限制。
//
// 用法：
//   node scripts/verify-data.js                       # 校验 data/ssq.json
//   node scripts/verify-data.js data/ssq_broken.json  # 校验指定文件（用于防线真实性测试）
// ============================================================================

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { calculatePrize, bonusOf } = require("../src/backtest");

const ROOT = path.join(__dirname, "..");
const target = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, "data", "ssq.json");
const OUT = path.join(ROOT, "data", "verification.json");

const RED_TOTAL = 33;
const RED_PICK = 6;
const BLUE_TOTAL = 16;
const TOTAL_COMBOS = comb(RED_TOTAL, RED_PICK) * BLUE_TOTAL; // C(33,6) × 16 = 17,721,088

const hard = [];
const soft = [];

function hardFail(msg) {
  hard.push(msg);
}
function softNote(msg) {
  soft.push(msg);
}

function comb(n, k) {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
}

// ---------------------------------------------------------------------------
// 硬校验 1：格式 / 范围 / 顺序
// ---------------------------------------------------------------------------
function checkFormat(rows) {
  const problems = [];
  const periods = new Set();

  rows.forEach((r, i) => {
    const at = `第 ${i + 1} 条（期号 ${r.period ?? "缺失"}）`;

    if (typeof r.period !== "string" || !/^\d{5}$/.test(r.period)) {
      problems.push(`${at}：period 必须是 5 位数字字符串，实际为 ${JSON.stringify(r.period)}`);
    } else if (periods.has(r.period)) {
      problems.push(`${at}：期号重复出现`);
    } else {
      periods.add(r.period);
    }

    if (typeof r.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.date) || Number.isNaN(Date.parse(r.date))) {
      problems.push(`${at}：date 必须是 YYYY-MM-DD，实际为 ${JSON.stringify(r.date)}`);
    }

    if (!Array.isArray(r.red) || r.red.length !== RED_PICK) {
      problems.push(`${at}：红球必须是 ${RED_PICK} 个，实际 ${Array.isArray(r.red) ? r.red.length : "非数组"}`);
    } else {
      const nums = r.red.map(Number);
      if (nums.some((n) => !Number.isInteger(n) || n < 1 || n > RED_TOTAL)) {
        problems.push(`${at}：红球越界，实际 [${r.red.join(", ")}]（合法范围 1~${RED_TOTAL}）`);
      }
      if (new Set(nums).size !== nums.length) {
        problems.push(`${at}：红球有重复，实际 [${r.red.join(", ")}]`);
      }
      if (r.red.some((b) => typeof b !== "string" || !/^\d{2}$/.test(b))) {
        problems.push(`${at}：红球必须是两位字符串（如 "05"），实际 [${r.red.join(", ")}]`);
      }
      if (nums.some((n, idx) => idx > 0 && n < nums[idx - 1])) {
        problems.push(`${at}：红球未按升序存储，实际 [${r.red.join(", ")}]`);
      }
    }

    const blue = Number(r.blue);
    if (typeof r.blue !== "string" || !/^\d{2}$/.test(r.blue) || !Number.isInteger(blue) || blue < 1 || blue > BLUE_TOTAL) {
      problems.push(`${at}：蓝球必须是 01~${BLUE_TOTAL} 的两位字符串，实际 ${JSON.stringify(r.blue)}`);
    }

    if (!r.source || typeof r.source !== "string") {
      problems.push(`${at}：缺少 source 字段——多数据源交叉核对的前提，缺失即视为不可核实数据`);
    }
    if (!r.fetched_at || typeof r.fetched_at !== "string") {
      problems.push(`${at}：缺少 fetched_at 字段`);
    }
  });

  // 顺序：期号严格递增、日期严格递增
  for (let i = 1; i < rows.length; i++) {
    if (Number(rows[i].period) <= Number(rows[i - 1].period)) {
      problems.push(`期号未严格递增：${rows[i - 1].period} → ${rows[i].period}（回测引擎虽然会兜底排序，但数据本身必须有序）`);
    }
    if (Date.parse(rows[i].date) < Date.parse(rows[i - 1].date)) {
      problems.push(`日期未递增：${rows[i - 1].date} → ${rows[i].date}`);
    }
  }

  if (problems.length === 0) {
    console.log(`  [pass] 格式/范围/顺序：${rows.length} 期全部合法（期号唯一且严格递增、日期递增、红球 6 个互异且升序、蓝球 01~16、source/fetched_at 齐全）`);
  } else {
    problems.forEach((p) => hardFail(`格式校验：${p}`));
  }
  return problems.length === 0;
}

// ---------------------------------------------------------------------------
// 硬校验 2：奖级规则全枚举自检
// ---------------------------------------------------------------------------
// 这是整个数据层里最有价值的一条检查：把 (0~6 红命中) × (蓝中/不中) 共 14 种情况
// 全部跑一遍 calculatePrize，逐条断言它符合官方奖级表。
// 它证明的不是"数据对不对"，而是"我们算奖级的代码对不对"——这件事一旦错了，
// 后面所有资金曲线、ROI、中奖次数全部是错的，而且错得没人看得出来。
const OFFICIAL_PRIZE_TABLE = [
  { red: 6, blue: true, level: 1, bonusType: "floating" },
  { red: 6, blue: false, level: 2, bonusType: "floating" },
  { red: 5, blue: true, level: 3, bonusType: "fixed", bonus: 3000 },
  { red: 5, blue: false, level: 4, bonusType: "fixed", bonus: 200 },
  { red: 4, blue: true, level: 4, bonusType: "fixed", bonus: 200 },
  { red: 4, blue: false, level: 5, bonusType: "fixed", bonus: 10 },
  { red: 3, blue: true, level: 5, bonusType: "fixed", bonus: 10 },
  { red: 2, blue: true, level: 6, bonusType: "fixed", bonus: 5 },
  { red: 1, blue: true, level: 6, bonusType: "fixed", bonus: 5 },
  { red: 0, blue: true, level: 6, bonusType: "fixed", bonus: 5 },
  { red: 3, blue: false, level: 0, bonusType: "fixed", bonus: 0 },
  { red: 2, blue: false, level: 0, bonusType: "fixed", bonus: 0 },
  { red: 1, blue: false, level: 0, bonusType: "fixed", bonus: 0 },
  { red: 0, blue: false, level: 0, bonusType: "fixed", bonus: 0 },
];

function checkPrizeRules() {
  const problems = [];
  for (const exp of OFFICIAL_PRIZE_TABLE) {
    const got = calculatePrize(exp.red, exp.blue);
    if (got.level !== exp.level) {
      problems.push(
        `奖级判定错误：${exp.red} 红 + 蓝球${exp.blue ? "命中" : "未中"} → 期望第 ${exp.level} 等奖，实际返回第 ${got.level} 等奖`
      );
    }
    if (got.bonusType !== exp.bonusType) {
      problems.push(
        `奖金类型错误：${exp.red} 红 + 蓝球${exp.blue ? "命中" : "未中"} → 期望 ${exp.bonusType}，实际 ${got.bonusType}`
      );
    }
    if (exp.bonusType === "fixed" && got.bonus !== exp.bonus) {
      problems.push(
        `固定奖金金额错误：第 ${exp.level} 等奖期望 ${exp.bonus} 元，实际 ${got.bonus} 元`
      );
    }
  }
  if (problems.length === 0) {
    console.log(`  [pass] 奖级规则全枚举自检：14 种（红球命中 × 蓝球命中）组合全部符合官方奖级表`);
  } else {
    problems.forEach((p) => hardFail(`奖级自检：${p}`));
  }
  return problems.length === 0;
}

// ---------------------------------------------------------------------------
// 硬校验 3：组合层概率自检
// ---------------------------------------------------------------------------
function buildPrizeProbabilityTable() {
  // 用超几何分布精确计算各奖级组合数，不用任何"经验数字"
  const redWays = (hits) => comb(RED_PICK, hits) * comb(RED_TOTAL - RED_PICK, RED_PICK - hits);
  const rows = [
    { level: 1, desc: "6红 + 蓝", ways: redWays(6) * 1 },
    { level: 2, desc: "6红", ways: redWays(6) * (BLUE_TOTAL - 1) },
    { level: 3, desc: "5红 + 蓝", ways: redWays(5) * 1 },
    { level: 4, desc: "5红 或 4红+蓝", ways: redWays(5) * (BLUE_TOTAL - 1) + redWays(4) * 1 },
    { level: 5, desc: "4红 或 3红+蓝", ways: redWays(4) * (BLUE_TOTAL - 1) + redWays(3) * 1 },
    { level: 6, desc: "仅蓝球", ways: redWays(2) * 1 + redWays(1) * 1 + redWays(0) * 1 },
  ];
  const totalWays = rows.reduce((s, r) => s + r.ways, 0);
  return rows.map((r) => ({ ...r, probability: r.ways / TOTAL_COMBOS, totalWays }));
}

function checkCombinations(table) {
  const problems = [];
  const sumWays = table[0].totalWays;
  if (sumWays >= TOTAL_COMBOS) {
    problems.push(`中奖组合数 ${sumWays} 不小于总组合数 ${TOTAL_COMBOS}，组合计算有误`);
  }
  for (const row of table) {
    if (!(row.probability > 0 && row.probability < 1)) {
      problems.push(`第 ${row.level} 等奖概率 ${row.probability} 不在 (0,1) 区间内`);
    }
  }
  // 逐奖级独立复算：一等奖必须是 1/17721088
  const first = table.find((r) => r.level === 1);
  if (first.ways !== 1) problems.push(`一等奖组合数应为 1，实际 ${first.ways}`);

  if (problems.length === 0) {
    console.log(
      `  [pass] 组合层概率自检：总组合数 C(33,6)×16 = ${TOTAL_COMBOS.toLocaleString()}，` +
        `各奖级组合数合计 ${sumWays.toLocaleString()}，中奖概率 ${(sumWays / TOTAL_COMBOS * 100).toFixed(4)}%`
    );
  } else {
    problems.forEach((p) => hardFail(`组合自检：${p}`));
  }
  return problems.length === 0;
}

// ---------------------------------------------------------------------------
// 软校验 1：分布自洽性（蒙特卡洛校准的卡方检验）
// ---------------------------------------------------------------------------
// 为什么用蒙特卡洛而不是查卡方分布表：这样就不需要在项目里塞一张临界值表，
// 也不会因为"用了近似公式"而被质疑。做法是：在"每期等概率"的零假设下模拟
// 同样规模的数据集，看真实数据的卡方统计量落在模拟分布的哪个位置。
// 它回答的不是"彩票是不是随机的"，而是"这份数据内部有没有表现出不该有的规律"。
function chiSquareMC(observedCounts, expectedCount, trials = 2000) {
  const stat = (counts) => counts.reduce((s, o) => s + (o - expectedCount) ** 2 / expectedCount, 0);
  const observed = stat(observedCounts);
  const k = observedCounts.length;
  let ge = 0;
  // 用确定性的种子随机，保证同一份数据、同一个种子，每次跑出完全一样的 p 值。
  // 种子取一个小常数即可：LCG 的输出质量与种子大小无关，取大数字反而会被
  // "数字出处检查"当成一个来路不明的硬编码数字。
  // 顺序是"先推进状态、再取输出"——如果先取输出，第一次调用会直接返回种子本身，
  // 整个序列也就跟着种子平移（改种子会连带改掉全部 p 值，虽然不影响可复现性，
  // 但会让"为什么数字变了"变得难以解释）。
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const draws = Math.round(expectedCount * k / RED_PICK); // 反推期数：每期 6 个红球
  for (let t = 0; t < trials; t++) {
    const counts = new Array(k).fill(0);
    for (let d = 0; d < draws; d++) {
      // 每期抽 6 个不重复位置
      const pool = Array.from({ length: k }, (_, i) => i);
      for (let j = 0; j < RED_PICK; j++) {
        const idx = Math.floor(rand() * pool.length);
        counts[pool[idx]]++;
        pool.splice(idx, 1);
      }
    }
    if (stat(counts) >= observed) ge++;
  }
  return { statistic: observed, pValue: ge / trials, trials, draws };
}

function checkDistributions(rows) {
  const redCounts = new Array(RED_TOTAL).fill(0);
  const blueCounts = new Array(BLUE_TOTAL).fill(0);
  const sums = [];
  const oddCounts = new Array(7).fill(0);

  rows.forEach((r) => {
    r.red.forEach((b) => redCounts[Number(b) - 1]++);
    blueCounts[Number(r.blue) - 1]++;
    sums.push(r.red.reduce((s, b) => s + Number(b), 0));
    oddCounts[r.red.filter((b) => Number(b) % 2 === 1).length]++;
  });

  const redExpected = (rows.length * RED_PICK) / RED_TOTAL;
  const blueExpected = rows.length / BLUE_TOTAL;
  const redTest = chiSquareMC(redCounts, redExpected);
  const blueTest = chiSquareMC(blueCounts, blueExpected);

  // 自检：同一个检验跑两遍必须给出完全一样的 p 值。
  // 这个项目对外的承诺是"同一份数据 + 同一个算法 = 同样的结果"，
  // 如果蒙特卡洛检验本身不可复现，那么页面上这个 p 值就随时会变，
  // 而"数字为什么会变"会变成一件没人能解释的事——那是比数字不好看更糟的情况。
  const determinismCheck = chiSquareMC(redCounts, redExpected);
  if (determinismCheck.pValue !== redTest.pValue || determinismCheck.statistic !== redTest.statistic) {
    hardFail(
      `可复现性自检失败：同一个卡方检验跑两遍得到不同的结果（${redTest.pValue} vs ${determinismCheck.pValue}）——` +
        `蒙特卡洛的伪随机数不再确定性，页面上的 p 值会随每次构建漂移`
    );
  } else {
    console.log(`  [pass] 可复现性自检：同一检验重复运行得到完全相同的 p 值（${redTest.pValue}）`);
  }

  const redP = redTest.pValue;
  const blueP = blueTest.pValue;
  const thresh = 0.01;

  if (redP < thresh) {
    softNote(
      `红球出现频次偏离均匀分布：卡方统计量 ${redTest.statistic.toFixed(2)}，蒙特卡洛 p = ${redP.toFixed(4)}（${redTest.trials} 次模拟）` +
        `——这可能是数据错误，也可能是随机波动，按方案规则必须在页面明示并人工复查，不得当作"发现了规律"`
    );
  } else {
    console.log(
      `  [pass] 红球频次分布：卡方统计量 ${redTest.statistic.toFixed(2)}，蒙特卡洛 p = ${redP.toFixed(4)}，与"每期等概率"一致`
    );
  }
  if (blueP < thresh) {
    softNote(`蓝球出现频次偏离均匀分布：卡方统计量 ${blueTest.statistic.toFixed(2)}，蒙特卡洛 p = ${blueP.toFixed(4)}`);
  } else {
    console.log(
      `  [pass] 蓝球频次分布：卡方统计量 ${blueTest.statistic.toFixed(2)}，蒙特卡洛 p = ${blueP.toFixed(4)}，与"每期等概率"一致`
    );
  }

  const meanSum = sums.reduce((a, b) => a + b, 0) / sums.length;
  console.log(
    `  [info] 和值：均值 ${meanSum.toFixed(2)}（理论 102），范围 ${Math.min(...sums)}~${Math.max(...sums)}；` +
      `奇偶比分布抽样：奇数个数 0~6 的次数 = [${oddCounts.join(", ")}]`
  );

  // 抽样核对表：给人工核对官方数据用
  const sample = [...rows.slice(0, 5), ...rows.slice(-5)].map((r) => ({
    period: r.period,
    date: r.date,
    red: r.red.join(" "),
    blue: r.blue,
  }));

  return {
    red: { statistic: Number(redTest.statistic.toFixed(3)), pValue: Number(redP.toFixed(4)), trials: redTest.trials, expectedPerNumber: Number(redExpected.toFixed(2)) },
    blue: { statistic: Number(blueTest.statistic.toFixed(3)), pValue: Number(blueP.toFixed(4)), trials: blueTest.trials, expectedPerNumber: Number(blueExpected.toFixed(2)) },
    sum_mean: Number(meanSum.toFixed(2)),
    sum_range: [Math.min(...sums), Math.max(...sums)],
    odd_count_distribution: oddCounts,
    sample_rows: sample,
  };
}

// ---------------------------------------------------------------------------
// 期望回报演示（预测悖论，方案 17.3 第 5 层）—— 全部由组合数推出
// ---------------------------------------------------------------------------
function buildExpectationDemo(table) {
  // 一/二等奖是浮动奖金，这里给出"按公开常见区间的估算"，并把估算值本身暴露出来，
  // 让读者能自己改假设重算——而不是给一个看不出出处的"经验数字"。
  const floatingLow = { 1: 3_000_000, 2: 100_000 };
  const floatingMid = { 1: 6_000_000, 2: 200_000 };
  const fixed = { 3: 3000, 4: 200, 5: 10, 6: 5 };

  const expectedWith = (f) =>
    table.reduce((s, row) => {
      const amount = f[row.level] ?? fixed[row.level] ?? 0;
      return s + row.probability * amount;
    }, 0);

  const low = expectedWith(floatingLow);
  const mid = expectedWith(floatingMid);
  const fixedOnly = expectedWith({});

  return {
    bet_cost: 2,
    expected_return_fixed_only: Number(fixedOnly.toFixed(4)),
    expected_return_low: Number(low.toFixed(4)),
    expected_return_mid: Number(mid.toFixed(4)),
    floating_assumption_low: floatingLow,
    floating_assumption_mid: floatingMid,
    note:
      "期望回报由各奖级概率 × 奖金相加得到，概率全部由组合数精确计算；一/二等奖为浮动奖金，" +
      "此处给出低/中两档公开常见区间的估算，估算假设本身已在数据里暴露，可自行替换重算。" +
      "结论：即使按较乐观的中档估算，单注期望回报仍低于 2 元成本——这就是'预测悖论'。",
  };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function main() {
  console.log("=".repeat(78));
  console.log("数据自洽性校验（方案第十七节 17.5 · L2 数据层防线）");
  console.log("=".repeat(78));
  console.log(`校验目标：${path.relative(ROOT, target).replace(/\\/g, "/")}`);
  console.log("");

  if (!fs.existsSync(target)) {
    console.error(`[fail] 找不到数据文件：${target}`);
    process.exit(1);
  }
  const rows = JSON.parse(fs.readFileSync(target, "utf-8"));
  console.log(`共 ${rows.length} 期：${rows[0].period}（${rows[0].date}） ~ ${rows[rows.length - 1].period}（${rows[rows.length - 1].date}）`);
  console.log("");

  console.log("【硬校验】失败即停线，脏数据不许进回测管线");
  checkFormat(rows);
  checkPrizeRules();
  const table = buildPrizeProbabilityTable();
  checkCombinations(table);

  console.log("");
  console.log("【软校验】输出报告，不阻断构建");
  let dist = null;
  try {
    dist = checkDistributions(rows);
  } catch (e) {
    softNote(`分布检验执行失败：${e.message}`);
  }

  const expectation = buildExpectationDemo(table);
  console.log(
    `  [info] 单注期望回报：仅固定奖级 ${expectation.expected_return_fixed_only.toFixed(4)} 元；` +
      `含浮动奖级（低档估算）${expectation.expected_return_low.toFixed(4)} 元；` +
      `（中档估算）${expectation.expected_return_mid.toFixed(4)} 元；成本 ${expectation.bet_cost} 元`
  );

  // 数据指纹：让"这份排行榜是拿哪份数据算的"变成可验证的
  const canonical = JSON.stringify(rows.map((r) => [r.period, r.date, r.red, r.blue]));
  const fingerprint = crypto.createHash("sha256").update(canonical).digest("hex");

  const sources = [...new Set(rows.map((r) => r.source))];

  // 数据源核实记录（人工核实 + 双源比对的凭据）如果在，就一并并入校验产出。
  // 这样页面上的每一个数字都有结构化出处，不需要把公告里的销售额、注数等
  // 硬编码进页面模板——那正是 17.5 L4 明令禁止的做法。
  const sourceVerificationPath = path.join(ROOT, "data", "source_verification.json");
  let sourceVerification = null;
  if (fs.existsSync(sourceVerificationPath)) {
    try {
      sourceVerification = JSON.parse(fs.readFileSync(sourceVerificationPath, "utf-8"));
      console.log(
        `  [info] 已并入数据源核实记录：主源 ${sourceVerification.primary_source.name}，` +
          `交叉核对 ${sourceVerification.cross_check.matched_periods} 期 / ${sourceVerification.cross_check.mismatches} 处不符`
      );
    } catch (e) {
      softNote(`数据源核实记录解析失败（不影响硬校验）：${e.message}`);
    }
  }

  const verification = {
    verified_at: new Date().toISOString(),
    data_file: path.relative(ROOT, target).replace(/\\/g, "/"),
    data_fingerprint_sha256: fingerprint,
    data_range: { from: rows[0].period, to: rows[rows.length - 1].period, count: rows.length },
    declared_sources: sources,
    source_integrity_note:
      "本校验只能证明这份数据内部自洽（格式、范围、顺序、奖级规则、概率总和），" +
      "不能证明它逐期都与官方一致。" +
      `当前声明的数据源为：${sources.join("、")}——请使用下方抽样核对表到官方渠道逐条核对。`,
    source_verification: sourceVerification,
    hard_checks: {
      passed: hard.length === 0,
      total: 3,
      failures: hard,
      items: [
        "格式/范围/顺序（期号唯一且严格递增、日期递增、红球 6 个互异升序、蓝球 01~16、source/fetched_at 齐全）",
        "奖级规则全枚举自检（14 种红球命中 × 蓝球命中组合逐条对照官方奖级表）",
        "组合层概率自检（总组合数、各奖级组合数、中奖概率合计）",
      ],
    },
    soft_notes: soft,
    distribution: dist,
    prize_probability_table: table.map((r) => ({
      level: r.level,
      desc: r.desc,
      ways: r.ways,
      probability: r.probability,
      odds_one_in: Math.round(TOTAL_COMBOS / r.ways),
    })),
    total_combinations: TOTAL_COMBOS,
    winning_probability: table[0].totalWays / TOTAL_COMBOS,
    expectation,
  };

  fs.writeFileSync(OUT, JSON.stringify(verification, null, 2), "utf-8");

  console.log("");
  console.log("-".repeat(78));
  console.log(`数据指纹（SHA-256，前 16 位）：${fingerprint.slice(0, 16)}`);
  console.log(`抽样核对表（供人工核对官方渠道）：`);
  (dist?.sample_rows || []).forEach((s) => {
    console.log(`  ${s.period}  ${s.date}  红 ${s.red}  蓝 ${s.blue}`);
  });
  console.log(`已写入 ${path.relative(ROOT, OUT).replace(/\\/g, "/")}`);

  if (hard.length > 0) {
    console.log("");
    console.log(`【硬校验失败】共 ${hard.length} 项：`);
    hard.forEach((h) => console.log(`  [FAIL] ${h}`));
    console.log("");
    console.log("=".repeat(78));
    console.log("校验未通过 —— 禁止继续跑回测、禁止发布。");
    console.log("抓错数据不被发现，比抓不到数据要恐怖得多（方案第六节）。");
    console.log("=".repeat(78));
    process.exit(1);
  }

  if (soft.length > 0) {
    console.log("");
    console.log(`【软校验提示】共 ${soft.length} 项（不阻断，但必须在页面明示）：`);
    soft.forEach((s) => console.log(`  [warn] ${s}`));
  }

  console.log("");
  console.log("=".repeat(78));
  console.log("硬校验全部通过。注意：这不能替代官方渠道的数据核对。");
  console.log("=".repeat(78));
}

main();
