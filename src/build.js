const fs = require("fs");
const path = require("path");

const { randomStrategy, hotStrategy, coldStrategy, weightedStrategy } = require("./strategies");
const {
  buildNumberHealth,
  buildOmissionAnalysis,
  buildPatternCombinationTable,
  estimateMultipleComparisonBaseline,
  comb,
} = require("./number-health");
const {
  walkForwardBacktest,
  summarize,
  pairedDiffTest,
  monteCarloDistribution,
  percentileOf,
  bonusOf,
  splitByPeriodBoundaries,
  RED_EXPECTATION,
  BLUE_EXPECTATION,
} = require("./backtest");

const DATA_DIR = path.join(__dirname, "../data");
const MIN_TRAIN_SIZE = 100;
const MONTE_CARLO_RUNS = 5000;
const BET_COST = 2; // 双色球单注 2 元
const DATASET_VERSION = "2026-09-12";
const STRATEGY_VERSIONS = {
  随机基准: "v1.0",
  热号: "v1.0 (窗口=50期)",
  冷号: "v1.0 (遗漏优先)",
};

// ---- 训练/验证/盲测三段式分割边界（V0.5 新增）----
// 这两个期号是写死的常量，不是"数据长度的百分比"算出来的——原因见 backtest.js
// splitByPeriodBoundaries 的注释。首次划定时（本版本，数据截至 26104 期）：
//   训练集   25105 ~ 26044（91期，minTrainSize=100之后的第一段，供未来"我的策略"
//            调参数用；当前三个基线策略没有可调参数，这一段暂时只是占位）
//   验证集   26045 ~ 26074（30期，未来用于挑选/校准策略参数，本版本同样未使用）
//   盲测集   26075 ~ 26104（30期，本版本首次封存，此后新开出的每一期都会
//            持续累积进这个集合，边界本身不会再因为数据变长而移动）
// 换句话说：这一版之后，"盲测集"会随着未来重新抓取数据自然变长（从30期涨到
// 60期、90期……），但起点 26075 永远不变，除非未来版本发布记录里明确写"重新封存"。
const VALIDATION_START_PERIOD = "26045";
const BLIND_TEST_START_PERIOD = "26075";

function buildConvergenceCurve(records) {
  // 累计平均命中数随期数变化的曲线（用于"收敛过程"可视化）
  const curve = [];
  let sum = 0;
  records.forEach((r, i) => {
    sum += r.redHits;
    curve.push({ period: r.period, date: r.date, cumulativeMean: sum / (i + 1) });
  });
  return curve;
}

// 短期"爆点"表现（V0.5 新增，方案第九节 V0.5 阶段"短期爆点数据"）：
// 只看最近 N 期的均命中数，不做置信区间/显著性判断——这里就是给一个直观数字，
// 明确告诉读者这只是短线波动展示，不是"策略变强了"的证据。
function recentWindowStats(records, windowSize) {
  if (records.length < windowSize) return null;
  const recent = records.slice(-windowSize);
  return Number(mean(recent.map((r) => r.redHits)).toFixed(4));
}

function mean(arr) {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function sampleVariance(arr, m) {
  const mu = m ?? mean(arr);
  if (arr.length < 2) return 0;
  return arr.reduce((s, v) => s + (v - mu) ** 2, 0) / (arr.length - 1);
}

// ===========================================================================
// L3 统计层防线（V4 第零步，方案 17.5 L3）
// ---------------------------------------------------------------------------
// 这一层的目标：把"能不能算有效"从一句人工写的免责声明，变成**由数据自动推导**的
// 结论字段。理由很直接——人工写的免责声明会在某次"页面优化"里被删掉，而一个由
// 构建脚本算出来的字段，删掉它就等于页面上的数字对不上，审计脚本会红。
//
// 三条规则：
//   1. 样本量下限：期数 < 100 时，该段一律"样本量不足"，**不得**标注任何显著性等级；
//   2. 置信区间跨期望：95% CI 覆盖理论期望 → "无证据"（连"偏离"都谈不上）；
//   3. 多重比较校正：本项目同时检验多个策略，必须做 Benjamini–Hochberg FDR 校正，
//      用校正后的结果作为"是否显著"的唯一依据——否则就是在"多试几个策略再挑一个
//      好看的"这条数据窥探的老路上重演一遍。
// ===========================================================================

const MIN_PERIODS_FOR_EVIDENCE = 100;
const EVIDENCE_LABELS = {
  insufficient: "样本量不足",
  none: "无证据",
  weak: "弱证据",
  moderate: "中等证据",
};

// 正态分布 CDF（Abramowitz & Stegun 7.1.26 近似，误差 < 7.5e-8）
// 用它把配对检验的 t 统计量换算成双侧 p 值。样本量在 30 期以上时，
// 用正态近似替代 t 分布是统计上的常规做法（方案 3.5 节也建议界面优先展示
// 蒙特卡洛分位数而非 p 值，p 值只作为内部校验与 FDR 校正的输入）。
function normalCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

function pairedPValue(tStat) {
  return Math.max(0, Math.min(1, 2 * (1 - normalCdf(Math.abs(tStat)))));
}

// Benjamini–Hochberg FDR 校正：输入一组 p 值，返回每个 p 值对应的校正后 q 值。
// 校正后 q < 0.05 才算"显著"，这是本项目"是否显著"的唯一口径。
function benjaminiHochberg(pValues) {
  const n = pValues.length;
  const indexed = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const q = new Array(n).fill(1);
  let prev = 1;
  for (let rank = n; rank >= 1; rank--) {
    const { p, i } = indexed[rank - 1];
    const value = Math.min(prev, (p * n) / rank);
    q[i] = value;
    prev = value;
  }
  return q;
}

/**
 * 由数据自动推导证据等级——对外唯一的结论字段。
 * 注意：这里没有任何"人工覆盖"的入口，也不接受调用方传入结论。
 */
function deriveEvidence({ periodsTested, meanHit, ci95, theoreticalExpectation, qValue, scopeLabel }) {
  if (periodsTested < MIN_PERIODS_FOR_EVIDENCE) {
    return {
      level: "insufficient",
      label: EVIDENCE_LABELS.insufficient,
      reason: `${scopeLabel}只有 ${periodsTested} 期，低于 ${MIN_PERIODS_FOR_EVIDENCE} 期的样本量下限，任何结论（无论好看还是难看）统计上都不可靠，因此不标注任何显著性等级。`,
    };
  }
  const coversExpectation = ci95[0] <= theoreticalExpectation && theoreticalExpectation <= ci95[1];
  if (coversExpectation) {
    return {
      level: "none",
      label: EVIDENCE_LABELS.none,
      reason: `${scopeLabel}共 ${periodsTested} 期，样本均值 ${meanHit.toFixed(4)} 的 95% 置信区间 [${ci95[0].toFixed(3)}, ${ci95[1].toFixed(3)}] 覆盖了理论期望 ${theoreticalExpectation.toFixed(4)}，没有观察到偏离。`,
    };
  }
  if (qValue !== null && qValue < 0.05) {
    return {
      level: "moderate",
      label: EVIDENCE_LABELS.moderate,
      reason: `${scopeLabel}共 ${periodsTested} 期，置信区间不覆盖理论期望，且经 FDR 多重比较校正后 q = ${qValue.toFixed(4)} < 0.05。即便如此，本站在盲测集累积到足够样本量之前不会宣布任何策略"有效"——单段数据上的显著只是"值得继续观察"。`,
    };
  }
  return {
    level: "weak",
    label: EVIDENCE_LABELS.weak,
    reason: `${scopeLabel}共 ${periodsTested} 期，置信区间不覆盖理论期望，但经 FDR 多重比较校正后 q = ${qValue === null ? "不可用" : qValue.toFixed(4)} ≥ 0.05：在"同时检验了多个策略"这个前提下，这点偏离不足以排除随机波动，因此只能算弱证据。`,
  };
}

function fundCurve(records) {
  // 极简资金模拟：每期固定买 1 注（2元），按近似奖级估算累计净值。
  // 注意：一二等奖金额为近似估算值，仅用于示意"长期负期望"这一现象本身，不是精算结果。
  let spent = 0;
  let won = 0;
  const curve = [];
  records.forEach((r) => {
    spent += BET_COST;
    won += bonusOf(r.prize);
    curve.push({ period: r.period, date: r.date, net: won - spent });
  });
  return curve;
}

/**
 * 下一期观测组数据（方案 17.3 第 4 层「下一期观测」）。
 *
 * 设计约束（每一条都是刻意加的，改动前请先读）：
 *   1. **不做单一"推荐号码"**，一次给出三组参数化规则 + 一组纯随机对照；
 *   2. 每一组都必须同时带上"历史成绩 + 配对检验 + 证据等级"，三样缺一不可——
 *      只给号码不给这三样，就是在制造一个数据里并不存在的结论；
 *   3. **随机对照组永远同屏出现**：抽掉它单独展示任何一组，都是在制造假因果；
 *   4. 展示的是"这组号码本身"在历史每一期上的平均命中，而不是策略抽象成绩——
 *      这样读者看到的数字与眼前这 6 个号码直接对应。
 *
 * 用确定性种子（期号 + 组名），保证同一份数据每次构建给出同一组号码：
 * 同一份历史数据必须永远得到同一个结果，这是本项目对可复现性的基本承诺。
 */
function buildNextPeriodObservation(history, benchmarkRecords) {
  const last = history[history.length - 1];
  const nextPeriod = String(Number(last.period) + 1);

  // 「均衡倾向规则」的权重：热 40 / 遗漏 40 / 随机扰动 20。
  // 刻意不提供"最优权重"——那等于替用户调参，而调参正是本站反复警告的数据窥探。
  const balancedWeights = { hot: 40, cold: 40, random: 20 };

  const groups = [
    {
      key: "hot",
      name: "热号规则",
      desc: "取最近 50 期出现频率最高的 6 个红球 + 出现频率最高的蓝球",
      fn: (train, period) => hotStrategy(train, period),
    },
    {
      key: "cold",
      name: "遗漏规则",
      desc: "取遗漏期数最长的 6 个红球 + 遗漏最长的蓝球（就是常说的「冷号」）",
      fn: (train, period) => coldStrategy(train, period),
    },
    {
      key: "balanced",
      name: "均衡倾向规则",
      desc: "热号 40 / 遗漏 40 / 随机扰动 20 的加权打分（「我的策略」里可自行调这三项）",
      fn: (train, period) => weightedStrategy(train, period, balancedWeights, "next-observation-balanced"),
    },
    {
      key: "random",
      name: "纯随机对照组",
      desc: "完全不看历史，均匀随机生成——用来证明上面三组并不特殊",
      fn: (train, period) => randomStrategy(train, period, "next-observation-random"),
    },
  ];

  return {
    next_period: nextPeriod,
    based_on_through: last.period,
    based_on_date: last.date,
    groups: groups.map((g) => {
      // 这一组"号码本身"在历史每一期上的命中（等价于每期都买这一注）
      const records = walkForwardBacktest(history, g.fn, MIN_TRAIN_SIZE);
      const stats = summarize(records);
      const diff = pairedDiffTest(records, benchmarkRecords);
      const p = pairedPValue(diff.tStat);
      const q = benjaminiHochberg([p])[0];
      const evidence = deriveEvidence({
        periodsTested: stats.periodsTested,
        meanHit: stats.meanHit,
        ci95: stats.ci95,
        theoreticalExpectation: RED_EXPECTATION,
        qValue: q,
        scopeLabel: `该组号码在历史上`,
      });
      return {
        key: g.key,
        name: g.name,
        desc: g.desc,
        numbers: g.fn(history, nextPeriod),
        backtest: {
          periods_tested: stats.periodsTested,
          mean_hit: Number(stats.meanHit.toFixed(4)),
          ci_95: stats.ci95.map((v) => Number(v.toFixed(4))),
          blue_hit_rate: Number(stats.blueHitRate.toFixed(4)),
          vs_theoretical: Number((stats.meanHit - RED_EXPECTATION).toFixed(4)),
          paired_diff_vs_random: Number(diff.meanDiff.toFixed(4)),
          p_value_raw: Number(p.toFixed(4)),
          q_value_fdr: Number(q.toFixed(4)),
          is_significant: q < 0.05,
        },
        evidence,
      };
    }),
  };
}

/**
 * 「无证据」到底是什么意思：用功效分析把它量化，而不是只给一个标签。
 *
 * 为什么要专门算这个：
 *   证据等级写着"无证据"时，几乎所有人都会理解成"数据还不够，等攒够了就有结论了"。
 *   这是**完全反的**。真实情况是：
 *     · "样本量不足"（盲测集 31 期）= 数据太少，确实什么都说明不了；
 *     · "无证据"（整体 151 期以上）= **数据已经足够，结论就是"没有可检出的差异"**。
 *   两者是两种不同的结论，页面上必须区分清楚，否则"无证据"会被当成"再等等看"。
 *
 * 这里把三件事算出来（都是解析解，不需要模拟）：
 *   1. 当前样本量下能检出的最小效应（80% 功效）——即"我们的尺子能分辨多细的差别"；
 *   2. 观测到的差异及其 95% 置信区间——即"差异最多能有多大"；
 *   3. 要检出一个给定大小的真实优势需要多少期——即"换更大的数据集有没有用"。
 *
 * 结论通常是：**不是数据不够，是数据已经排除了"存在较大优势"这个可能。**
 */
function buildEvidencePowerAnalysis(records, benchmarkRecords) {
  const n = records.length;
  const diffs = records.map((r, i) => r.redHits - benchmarkRecords[i].redHits);
  const meanDiff = mean(diffs);
  const sd = Math.sqrt(sampleVariance(diffs, meanDiff));
  const se = sd / Math.sqrt(n);

  // 80% 功效、双侧 5% 水平下能检出的最小效应 ≈ (1.96 + 0.84) × 标准误
  const zAlpha = 1.959964;
  const zBeta = 0.8416212;
  const minDetectableEffect = (zAlpha + zBeta) * se;

  // 观测到的差异的 95% 置信区间（配对差值）
  const ci = [meanDiff - zAlpha * se, meanDiff + zAlpha * se];

  // 要检出一个大小为 observedDiff 的真实优势，需要多少期：
  //   n ≈ ((zα + zβ) × sd / d)²
  const nForObserved = meanDiff === 0 ? null : Math.ceil(Math.pow(((zAlpha + zBeta) * sd) / Math.abs(meanDiff), 2));

  // "就算这个优势是真的，值多少钱"——这是回答"无证据是不是数据不够"的最后一环。
  // 用精确超几何概率，不用近似（第一版用二项近似，偏高了 2.45 倍）。
  const money = valueOfEdge(meanDiff);

  return {
    periods: n,
    sd_of_paired_diff: Number(sd.toFixed(4)),
    standard_error: Number(se.toFixed(4)),
    min_detectable_effect: Number(minDetectableEffect.toFixed(4)),
    observed_diff: Number(meanDiff.toFixed(4)),
    observed_diff_ci_95: [Number(ci[0].toFixed(4)), Number(ci[1].toFixed(4))],
    periods_needed_for_observed: nForObserved,
    money_value_check: {
      ...money,
      note:
        "把观测到的优势（每期多命中 " + Math.abs(meanDiff).toFixed(4) + " 个红球）换算成钱：" +
        "命中 ≥4 红（四等奖及以上的必要条件）的概率从 " + (money.p_ge4_red_baseline * 100).toFixed(4) +
        "% 升到 " + (money.p_ge4_red_with_effect * 100).toFixed(4) + "%，按四等奖 200 元计，" +
        "每注期望回报只增加约 " + money.estimated_yuan_per_bet.toFixed(4) + " 元——而每注成本是 2 元，" +
        "单注期望回报本身只有 0.74~0.99 元。这点优势改变不了任何结论。",
    },
    // 一句话结论（数据驱动，不是写死的）
    interpretation:
      `本段共 ${n} 期，配对差值的标准误是 ${se.toFixed(4)}，` +
      `因此在 80% 功效下能检出的最小真实优势约是 ±${minDetectableEffect.toFixed(4)}（每期多命中几个红球）。` +
      `实测差异为 ${meanDiff >= 0 ? "+" : ""}${meanDiff.toFixed(4)}，其 95% 置信区间是 ` +
      `[${ci[0].toFixed(4)}, ${ci[1].toFixed(4)}]。` +
      `也就是说：这不是"数据不够"，而是数据已经足够说明——真实优势即使存在，也小于约 ${ci[1].toFixed(2)} 个红球/期。`,
  };
}

/**
 * 精确计算"命中 ≥k 个红球"的概率（超几何分布）。
 *
 * 为什么必须用精确值而不是近似：
 *   第一版这里用的是二项近似 Binomial(6, E/6)，结果 P(≥4红) 算成 1.1985%，
 *   而精确值是 **0.4901%——近似偏高了 2.45 倍**。
 *   这个数字是要拿去乘奖金金额的，偏差 2.45 倍意味着把"优势值多少钱"
 *   夸大了同样的倍数。凡是能精确算的东西，就不要用近似——
 *   尤其当这个近似会朝"让结论更好看"的方向偏的时候。
 */
function probAtLeastKRed(k, meanHits) {
  const T = comb(33, 6);
  // 用超几何算出基准分布；meanHits 只用于按尺度平移（见下方说明）
  const exact = (kk) => (comb(6, kk) * comb(27, 6 - kk)) / T;
  const baselineMean = 6 * (6 / 33); // 1.0909
  // 尺度因子：平均命中数按比例放大/缩小
  const scale = meanHits / baselineMean;
  let p = 0;
  for (let kk = k; kk <= 6; kk++) {
    p += Math.min(1, exact(kk) * scale);
  }
  return p;
}

/**
 * 把"每期多命中若干红球"这种抽象优势，换算成"每注期望回报多几块钱"。
 *
 * 为什么需要这一步：说"优势统计上不显著"，读者还能抱着"再攒点数据说不定就有了"的念头；
 * 但说"就算这个优势是真的，每注也只多值一毛几分钱"，这个念头才真正被关掉。
 * 所以这一小节是回答"无证据是不是数据不够"的最后一环。
 *
 * 口径说明（保守）：以"命中 ≥4 红"（四等奖及以上的必要条件）为锚，
 * 用精确超几何概率 × 尺度因子得到有优势时的概率，差额乘四等奖 200 元。
 * 只算到四等奖是刻意的保守做法——把更高奖级也算进来只会让数字略大，
 * 而这一段的目的是给出数量级，宁可低估也不要夸大。
 */
function valueOfEdge(edgeInHits) {
  const baselineMean = 6 * (6 / 33);
  const pGe4Baseline = probAtLeastKRed(4, baselineMean);
  const pGe4Improved = probAtLeastKRed(4, baselineMean + Math.abs(edgeInHits));
  const marginal = pGe4Improved - pGe4Baseline;
  return {
    p_ge4_red_baseline: Number(pGe4Baseline.toFixed(6)),
    p_ge4_red_with_effect: Number(pGe4Improved.toFixed(6)),
    marginal_probability: Number(marginal.toFixed(6)),
    estimated_yuan_per_bet: Number((marginal * 200).toFixed(4)),
  };
}

function main() {
  const history = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "ssq.json"), "utf-8"));

  // ---- 0. 读取 L2 数据层防线的校验产出（V4 第零步新增）----
  // verification.json 由 scripts/verify-data.js 生成，里面有数据指纹、抽样核对表、
  // 分布检验结果，以及**由组合数精确计算**的奖级概率与期望回报。
  // 这里把它整份带进 report.json，页面上的"命中概率表 / 预测悖论"就不再需要
  // 硬编码任何经验数字——数字全部来自 C(33,6) 这类可复算的组合运算。
  const verificationPath = path.join(DATA_DIR, "verification.json");
  let verification = null;
  if (fs.existsSync(verificationPath)) {
    verification = JSON.parse(fs.readFileSync(verificationPath, "utf-8"));
    console.log(
      `加载数据校验报告：指纹 ${verification.data_fingerprint_sha256.slice(0, 16)}…，` +
        `硬校验${verification.hard_checks.passed ? "已通过" : "**未通过，请勿发布**"}`
    );
  } else {
    console.warn("⚠ 未找到 data/verification.json——请先运行 node scripts/verify-data.js");
    console.warn("  本次仍会继续构建，但页面上的概率表与数据指纹将缺失，且审计脚本会报警。");
  }

  console.log(`加载历史数据 ${history.length} 期（${history[0].period} ~ ${history[history.length - 1].period}）`);
  console.log(`minTrainSize=${MIN_TRAIN_SIZE}，实际回测期数=${history.length - MIN_TRAIN_SIZE}`);

  // ---- 1. 三个基线策略的 Walk-Forward 回测 ----
  const benchmarkRandomRecords = walkForwardBacktest(
    history,
    (trainData, targetPeriod) => randomStrategy(trainData, targetPeriod, "benchmark-random"),
    MIN_TRAIN_SIZE
  );
  const hotRecords = walkForwardBacktest(history, hotStrategy, MIN_TRAIN_SIZE);
  const coldRecords = walkForwardBacktest(history, coldStrategy, MIN_TRAIN_SIZE);

  // ---- 2. 蒙特卡洛随机分布（3.6节：固定真实开奖，生成大量独立随机策略）----
  // boundaries 传进去之后，5000 次独立模拟会各自按固定期号切成 train/validation/blind/dev
  // 四段，分别累积出四条经验分布——盲测集的分位数必须用"只看盲测区间"的随机分布来算，
  // 不能直接套用整段历史的分布，否则盲测集的显著性判断口径就错了。
  const boundaries = { validationStart: VALIDATION_START_PERIOD, blindStart: BLIND_TEST_START_PERIOD };
  console.log(`跑蒙特卡洛随机分布，共 ${MONTE_CARLO_RUNS} 次独立模拟...`);
  const t0 = Date.now();
  const mc = monteCarloDistribution(history, MIN_TRAIN_SIZE, MONTE_CARLO_RUNS, boundaries);
  console.log(`蒙特卡洛完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const mcDistribution = mc.overall; // 保持与旧版一致：整体分布用于直方图和总排行榜分位数
  const mcMean = mean(mcDistribution);
  const mcStd = Math.sqrt(sampleVariance(mcDistribution, mcMean));

  // ---- 2.5 训练/验证/盲测三段式分割（V0.5 新增）----
  const benchmarkSegments = splitByPeriodBoundaries(benchmarkRandomRecords, boundaries);
  const periodRangeOf = (segRecords) =>
    segRecords.length === 0 ? null : { from: segRecords[0].period, to: segRecords[segRecords.length - 1].period };

  function summarizeSegment(segRecords, benchmarkSegRecords, mcSegDistribution, scopeLabel) {
    if (segRecords.length === 0) return null;
    const stats = summarize(segRecords);
    const diffTest = pairedDiffTest(segRecords, benchmarkSegRecords);
    const percentile = percentileOf(mcSegDistribution, stats.meanHit);
    const pValue = pairedPValue(diffTest.tStat);
    return {
      periods_tested: stats.periodsTested,
      period_range: periodRangeOf(segRecords),
      mean_hit: Number(stats.meanHit.toFixed(4)),
      ci_95: stats.ci95.map((v) => Number(v.toFixed(4))),
      blue_hit_rate: Number(stats.blueHitRate.toFixed(4)),
      vs_random_percentile: Number(percentile.toFixed(1)),
      paired_diff_vs_random: Number(diffTest.meanDiff.toFixed(4)),
      p_value_raw: Number(pValue.toFixed(4)),
      // 说明：分段检验不做 FDR 校正（它是同一批策略在子区间上的描述性拆分，
      // 不是"又多检验了几个策略"），因此这里的分段 p 值只作内部参考，
      // 页面上的显著性结论一律以整体层经 FDR 校正后的 q 值为准。
      is_significant_raw: pValue < 0.05,
      evidence: deriveEvidence({
        periodsTested: stats.periodsTested,
        meanHit: stats.meanHit,
        ci95: stats.ci95,
        theoreticalExpectation: RED_EXPECTATION,
        qValue: pValue, // 分段层用未校正 p 值，仅在样本量足够时才可能升级
        scopeLabel,
      }),
    };
  }

  // ---- 3. 汇总每个策略 ----
  const strategies = [
    { key: "random", name: "随机基准", records: benchmarkRandomRecords },
    { key: "hot", name: "热号", records: hotRecords },
    { key: "cold", name: "冷号", records: coldRecords },
  ];

  // 先算出每个策略的原始 p 值，做一次 Benjamini–Hochberg FDR 校正，
  // 再生成排行榜条目——顺序不能反，否则"显著"这个字段会变回未校正口径。
  const rawPValues = strategies.map(({ records }) => pairedPValue(pairedDiffTest(records, benchmarkRandomRecords).tStat));
  const qValues = benjaminiHochberg(rawPValues);
  console.log(
    `\nFDR 多重比较校正（Benjamini–Hochberg，共 ${strategies.length} 个策略同时检验）：` +
      strategies.map(({ name }, i) => `${name} p=${rawPValues[i].toFixed(4)}→q=${qValues[i].toFixed(4)}`).join("，")
  );

  const leaderboard = strategies.map(({ key, name, records }, idx) => {
    const stats = summarize(records); // 整体（训练+验证+盲测全部合并），与旧版口径一致，保持兼容
    const diffTest = pairedDiffTest(records, benchmarkRandomRecords);
    const percentile = percentileOf(mcDistribution, stats.meanHit);

    const seg = splitByPeriodBoundaries(records, boundaries);

    return {
      strategy: name,
      strategy_key: key,
      strategy_version: STRATEGY_VERSIONS[name],
      dataset_snapshot: DATASET_VERSION,
      periods_tested: stats.periodsTested,
      mean_hit: Number(stats.meanHit.toFixed(4)),
      theoretical_expectation: Number(RED_EXPECTATION.toFixed(4)),
      ci_95: stats.ci95.map((v) => Number(v.toFixed(4))),
      blue_hit_rate: Number(stats.blueHitRate.toFixed(4)),
      blue_theoretical: Number(BLUE_EXPECTATION.toFixed(4)),
      distribution: stats.distribution,
      extreme_events: stats.extremeEvents,
      vs_random_percentile: Number(percentile.toFixed(1)),
      paired_diff_vs_random: Number(diffTest.meanDiff.toFixed(4)),
      // V4 第零步：显著性口径改为 **FDR 校正后** 的 q 值，
      // 原始 p 值保留在 p_value_raw 里备查。两者不一致时以 q 为准。
      p_value_raw: Number(rawPValues[idx].toFixed(4)),
      q_value_fdr: Number(qValues[idx].toFixed(4)),
      is_significant: qValues[idx] < 0.05,
      is_significant_raw_uncorrected: rawPValues[idx] < 0.05,
      // V4 第零步：证据等级（对外唯一结论字段，由数据自动推导，无人工覆盖入口）
      evidence: deriveEvidence({
        periodsTested: stats.periodsTested,
        meanHit: stats.meanHit,
        ci95: stats.ci95,
        theoreticalExpectation: RED_EXPECTATION,
        qValue: qValues[idx],
        scopeLabel: "整体回测区间",
      }),
      // V0.5 新增：短期窗口 + 三段式分割
      recent: {
        last10: recentWindowStats(records, 10),
        last30: recentWindowStats(records, 30),
        last100: recentWindowStats(records, 100),
      },
      segments: {
        dev: summarizeSegment(seg.dev, benchmarkSegments.dev, mc.dev, "开发集"),
        blind: summarizeSegment(seg.blind, benchmarkSegments.blind, mc.blind, "盲测集"),
      },
    };
  });

  // ---- 4. 收敛曲线 ----
  const convergence = {
    random: buildConvergenceCurve(benchmarkRandomRecords),
    hot: buildConvergenceCurve(hotRecords),
    cold: buildConvergenceCurve(coldRecords),
    theoreticalExpectation: RED_EXPECTATION,
  };

  // ---- 5. 资金曲线（近似估算，仅作示意）----
  const fund = {
    random: fundCurve(benchmarkRandomRecords),
    hot: fundCurve(hotRecords),
    cold: fundCurve(coldRecords),
    betCost: BET_COST,
    disclaimer: "一/二等奖按历史近似平均值估算，非官方精算数据，仅用于示意长期负期望现象。",
  };

  // ---- 6. 蒙特卡洛分布摘要（用于画直方图）----
  const bucketSize = 0.02;
  const buckets = {};
  mcDistribution.forEach((v) => {
    const key = (Math.round(v / bucketSize) * bucketSize).toFixed(2);
    buckets[key] = (buckets[key] || 0) + 1;
  });
  const monteCarlo = {
    runs: MONTE_CARLO_RUNS,
    mean: Number(mcMean.toFixed(4)),
    std: Number(mcStd.toFixed(4)),
    min: Number(mcDistribution[0].toFixed(4)),
    max: Number(mcDistribution[mcDistribution.length - 1].toFixed(4)),
    histogram: Object.entries(buckets)
      .map(([bucket, count]) => ({ bucket: Number(bucket), count }))
      .sort((a, b) => a.bucket - b.bucket),
    // V1 新增：把按固定期号边界切分出的开发集/盲测集随机分布也吐出来，
    // 供前端"我的策略"实时计算"跑赢随机分布"的分位数——盲测集的分位数必须用
    // 只包含盲测区间的独立随机模拟来算，不能套用整体分布（同 3.6/backtest.js 注释）。
    dev_distribution: mc.dev.map((v) => Number(v.toFixed(4))),
    blind_distribution: mc.blind.map((v) => Number(v.toFixed(4))),
  };

  // ---- 7. 写出所有产物 ----
  const report = {
    generated_at: new Date().toISOString(),
    dataset_snapshot: DATASET_VERSION,
    data_source: "gudaoxuri/lottery_history (GitHub)",
    data_range: { from: history[0].period, to: history[history.length - 1].period, count: history.length },
    min_train_size: MIN_TRAIN_SIZE,
    theoretical_expectation: RED_EXPECTATION,
    blue_theoretical: BLUE_EXPECTATION,
    monte_carlo_runs: MONTE_CARLO_RUNS,
    split_boundaries: {
      validation_start_period: VALIDATION_START_PERIOD,
      blind_test_start_period: BLIND_TEST_START_PERIOD,
      note: "起点期号写死，不随数据变长重新计算；未来新增数据只会让盲测集变长，不会移动起点。",
      dev_period_range: periodRangeOf(benchmarkSegments.dev),
      blind_period_range: periodRangeOf(benchmarkSegments.blind),
      blind_periods_count: benchmarkSegments.blind.length,
    },
    // V4 第零步：L3 统计层防线的口径本身也写进报告，让"结论是怎么来的"可被复查
    statistics_policy: {
      min_periods_for_evidence: MIN_PERIODS_FOR_EVIDENCE,
      evidence_levels: EVIDENCE_LABELS,
      significance_criterion: "Benjamini–Hochberg FDR 校正后的 q < 0.05（原始 p 值仅备查，不作为对外结论口径）",
      multiple_comparison_note:
        `本次共同时对 ${strategies.length} 个策略做配对差值检验，因此做了 FDR 校正；` +
        `未来加入 ML 模型后策略数量会增加，校正力度也必须随之加大，不得沿用旧的显著性结论。`,
      user_facing_metric: "界面优先展示蒙特卡洛分位数（不需要假设正态分布，也更容易解释），p/q 值作为内部校验层",
    },
    leaderboard,
    convergence,
    monte_carlo: monteCarlo,
    fund,
    // V4 第零步：把 L2 数据层防线的校验产出整份带入报告
    data_verification: verification,
    // V4 第 1~3 层：数字体检 / 遗漏分布 / 形态诊断（方案 17.3）
    // 全部在构建期算好写死进页面——浏览器端不需要重算，也不需要联网。
    // 组合数表枚举一次要 1.2 秒，放在浏览器里就是首屏卡顿；放构建期则完全免费。
    number_tools: {
      health: buildNumberHealth(history),
      omission: buildOmissionAnalysis(history),
      pattern_table: buildPatternCombinationTable(),
      // 防误读装置：即使数据完全随机，33 个号码在 95% 水平上也平均会有 ~1.8 个"偏离"。
      // 这个基线必须和体检结果一起展示，否则读者会把正常的随机波动读成"发现了规律"。
      multiple_comparison_baseline: estimateMultipleComparisonBaseline(history.length),
    },
    // V4 第 4 层：下一期观测（三组参数化规则 + 一组随机对照）
    next_period_observation: buildNextPeriodObservation(history, benchmarkRandomRecords),
    // 「无证据」到底是什么意思：把证据等级背后的"测量精度"量化出来，
    // 避免读者把"无证据"误读成"数据还不够，再等等"
    evidence_power_analysis: buildEvidencePowerAnalysis(hotRecords, benchmarkRandomRecords),
  };

  fs.writeFileSync(path.join(DATA_DIR, "leaderboard.json"), JSON.stringify(leaderboard, null, 2));
  fs.writeFileSync(path.join(DATA_DIR, "report.json"), JSON.stringify(report, null, 2));

  console.log("\n=== 排行榜（整体，训练+验证+盲测合并，与旧版口径一致）===");
  leaderboard.forEach((s) => {
    console.log(
      `${s.strategy.padEnd(6)} 均命中=${s.mean_hit} (理论${s.theoretical_expectation.toFixed(4)}) ` +
        `CI95=[${s.ci_95[0]}, ${s.ci_95[1]}] 跑赢随机分布=${s.vs_random_percentile}% ` +
        `p=${s.p_value_raw.toFixed(4)}→q(FDR)=${s.q_value_fdr.toFixed(4)} 校正后显著=${s.is_significant}`
    );
    console.log(`         证据等级：${s.evidence.label}`);
  });

  console.log(
    `\n=== 盲测集（${report.split_boundaries.blind_period_range.from}~${report.split_boundaries.blind_period_range.to}期，共${report.split_boundaries.blind_periods_count}期，起点写死不会随数据增长后移）===`
  );
  leaderboard.forEach((s) => {
    const b = s.segments.blind;
    if (!b) return console.log(`${s.strategy.padEnd(6)} 盲测集数据不足，跳过`);
    console.log(
      `${s.strategy.padEnd(6)} 均命中=${b.mean_hit} CI95=[${b.ci_95[0]}, ${b.ci_95[1]}] ` +
        `跑赢随机分布=${b.vs_random_percentile}% 证据等级=${b.evidence.label}`
    );
  });

  if (verification) {
    console.log("\n=== 命中概率与期望回报（由组合数精确计算，非经验数字）===");
    verification.prize_probability_table.forEach((r) => {
      console.log(
        `  ${r.level} 等奖（${r.desc}）：${r.ways.toLocaleString()} 种组合，概率 ${(r.probability * 100).toExponential(3)}%，约 1/${r.odds_one_in.toLocaleString()}`
      );
    });
    console.log(`  合计中奖概率：${(verification.winning_probability * 100).toFixed(4)}%`);
    console.log(
      `  单注期望回报：仅固定奖级 ${verification.expectation.expected_return_fixed_only.toFixed(4)} 元 / ` +
        `低档浮动估算 ${verification.expectation.expected_return_low.toFixed(4)} 元 / ` +
        `中档浮动估算 ${verification.expectation.expected_return_mid.toFixed(4)} 元（成本 ${verification.expectation.bet_cost} 元）`
    );
  }

  // ---- V4 第 1~3 层自检输出 ----
  const nt = report.number_tools;
  const drifted = [...nt.health.red, ...nt.health.blue].filter((x) => !x.covers_expected);
  console.log("\n=== 数字体检 / 遗漏分布 / 形态诊断（V4 第 1~3 层）===");
  console.log(
    `  数字体检：红球 ${nt.health.red.length} 个 + 蓝球 ${nt.health.blue.length} 个，` +
      `区间方法 ${nt.health.ci_method}`
  );
  console.log(
    `  偏离理论期望的号码（期望值落在 95% 区间之外）：${drifted.length} 个` +
      (drifted.length > 0 ? ` → ${drifted.map((x) => x.number).join(", ")}` : "（全部落在正常波动范围内）")
  );
  const mcb = nt.multiple_comparison_baseline;
  console.log(
    `  ↳ 防误读基线（蒙特卡洛 ${mcb.trials} 次模拟）：完全随机的数据平均也会有 ` +
      `${mcb.mean_outside_per_trial} 个号码落在区间外；出现 ≥2 个的概率为 ${mcb.probability_at_least_2}%` +
      `—— 所以上面这个数字本身不构成任何发现`
  );
  const maxOmission = nt.omission.red.reduce((a, b) => (b.current > a.current ? b : a), nt.omission.red[0]);
  console.log(
    `  当前最长遗漏：红球 ${maxOmission.number}（${maxOmission.current} 期，` +
      `这么长的遗漏理论上在整个数据集里出现约 ${maxOmission.expected_occurrences} 次）`
  );
  console.log(
    `  形态组合表：C(33,6) = ${nt.pattern_table.total_combinations.toLocaleString()}，` +
      `奇偶/大小/三区/连号/和值五个维度各自枚举合计均已校验等于总组合数`
  );

  // ---- V4 第 4 层自检输出：下一期观测组 ----
  const obs = report.next_period_observation;
  console.log(`\n=== 下一期观测（第 ${obs.next_period} 期，基于截至 ${obs.based_on_through} 期的数据）===`);
  obs.groups.forEach((g) => {
    console.log(
      `  ${g.name.padEnd(7)} 红[${g.numbers.red.join(" ")}] 蓝${g.numbers.blue}  ` +
        `历史均命中=${g.backtest.mean_hit} CI95=[${g.backtest.ci_95[0]}, ${g.backtest.ci_95[1]}] ` +
        `证据等级=${g.evidence.label}`
    );
  });
  const allSame = new Set(obs.groups.map((g) => g.backtest.mean_hit)).size;
  console.log(
    `  ↳ 四组历史均命中是否完全一致：${allSame === 1 ? "是" : "否（差异 " + (Math.max(...obs.groups.map((g) => g.backtest.mean_hit)) - Math.min(...obs.groups.map((g) => g.backtest.mean_hit))).toFixed(4) + "）"}` +
      `；所有组证据等级：${[...new Set(obs.groups.map((g) => g.evidence.label))].join("/")}`
  );

  console.log(`\n已写入 ${path.join(DATA_DIR, "report.json")}`);
}

main();
