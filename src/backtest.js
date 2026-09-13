// Walk-Forward 回测引擎
// 核心原则（方案 3.3 / 7.5）：
//   1. 预测第 t+1 期时，只能使用第 1~t 期的数据（history.slice(0, t)）。
//   2. 待预测目标必须是 history[t]（0-indexed 下标 t，也就是第 t+1 期），
//      而不是 history[t+1] —— 这是原方案里必须修正的 off-by-one 错误。
//   3. 入口处强制按期号升序排序，防御"数据源最新一期在前"的倒序陷阱，
//      否则会出现用未来数据预测过去的严重问题。

const RED_TOTAL = 33;
const RED_PICK = 6;
const BLUE_TOTAL = 16;

const RED_EXPECTATION = RED_PICK * (RED_PICK / RED_TOTAL); // 6 * 6/33 ≈ 1.0909
const BLUE_EXPECTATION = 1 / BLUE_TOTAL; // 1/16 = 0.0625

function sortAscending(rawHistory) {
  return [...rawHistory].sort((a, b) => Number(a.period) - Number(b.period));
}

/**
 * @param {Array} rawHistory 原始历史数据（不保证顺序）
 * @param {Function} strategyPredictFn (trainData, targetPeriod, ctx) => { red: string[6], blue: string }
 * @param {number} minTrainSize 至少要看过多少期历史才开始"预测"，避免样本太小时的策略毫无意义
 * @param {Object} [strategyCtx] 跨期共享的上下文（例如 ML 策略的权重缓存）。
 *        为什么需要它：像逻辑回归这种"每隔若干期重训一次"的策略需要一个跨期存活的对象
 *        保存上次训练结果；否则每一期都要重新训练，3502 期回测会慢到不可用。
 *        默认空对象，对确定性策略（热号/冷号/随机）完全没有影响。
 */
function walkForwardBacktest(rawHistory, strategyPredictFn, minTrainSize = 100, strategyCtx = {}) {
  const history = sortAscending(rawHistory);

  const records = [];
  for (let t = minTrainSize; t < history.length; t++) {
    const trainData = history.slice(0, t); // 只能看到前 t 期
    const actual = history[t]; // 真实第 t+1 期（0-indexed 下标 t）

    const predicted = strategyPredictFn(trainData, actual.period, strategyCtx);

    const redHits = actual.red.filter((b) => predicted.red.includes(b)).length;
    const blueHit = actual.blue === predicted.blue;

    records.push({
      period: actual.period,
      date: actual.date,
      predicted_red: predicted.red,
      actual_red: actual.red,
      predicted_blue: predicted.blue,
      actual_blue: actual.blue,
      redHits,
      blueHit,
      prize: calculatePrize(redHits, blueHit),
    });
  }
  return records;
}

// 双色球奖级判定：只判定"中了第几等奖"，不在这里决定具体金额（一/二等奖是浮动奖金）
function calculatePrize(redHits, blueHit) {
  if (redHits === 6 && blueHit) return { level: 1, bonusType: "floating" };
  if (redHits === 6) return { level: 2, bonusType: "floating" };
  if (redHits === 5 && blueHit) return { level: 3, bonusType: "fixed", bonus: 3000 };
  if (redHits === 5 || (redHits === 4 && blueHit)) return { level: 4, bonusType: "fixed", bonus: 200 };
  if (redHits === 4 || (redHits === 3 && blueHit)) return { level: 5, bonusType: "fixed", bonus: 10 };
  if (blueHit) return { level: 6, bonusType: "fixed", bonus: 5 };
  return { level: 0, bonusType: "fixed", bonus: 0 };
}

// 一、二等奖是浮动奖金，用官方历史公布的近似平均值估算，不还原真实奖池分配算法。
// 这两个数字是粗略估计，仅用于资金曲线的示意，不是精算结果。
const FLOATING_BONUS_ESTIMATE = {
  1: 6_000_000, // 一等奖近似平均单注金额（历史上常见区间约 500万~1000万，随奖池浮动）
  2: 200_000, // 二等奖近似平均单注金额（历史上常见区间约数万~数十万，随奖池浮动）
};

function estimateFloatingBonus(level) {
  return FLOATING_BONUS_ESTIMATE[level] ?? 0;
}

function bonusOf(prize) {
  if (prize.bonusType === "floating") return estimateFloatingBonus(prize.level);
  return prize.bonus;
}

function mean(arr) {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function sampleVariance(arr, m) {
  const mu = m ?? mean(arr);
  if (arr.length < 2) return 0;
  return arr.reduce((s, v) => s + (v - mu) ** 2, 0) / (arr.length - 1);
}

// 统计摘要：样本均值、理论期望、95% 置信区间
function summarize(records) {
  const hits = records.map((r) => r.redHits);
  const n = hits.length;
  const meanHit = mean(hits);
  const variance = sampleVariance(hits, meanHit);
  const stderr = Math.sqrt(variance / n);
  const ci95 = [meanHit - 1.96 * stderr, meanHit + 1.96 * stderr];

  const blueHitRate = mean(records.map((r) => (r.blueHit ? 1 : 0)));

  const distribution = [0, 0, 0, 0, 0, 0, 0]; // 命中0~6个红球的次数分布
  records.forEach((r) => (distribution[r.redHits] += 1));

  const extremeEvents = {
    ge4: records.filter((r) => r.redHits >= 4).length,
    ge5: records.filter((r) => r.redHits >= 5).length,
    all6: records.filter((r) => r.redHits === 6).length,
    prizeCount: records.filter((r) => r.prize.level > 0).length,
  };

  return {
    periodsTested: n,
    meanHit,
    ci95,
    theoreticalExpectation: RED_EXPECTATION,
    blueHitRate,
    blueTheoretical: BLUE_EXPECTATION,
    distribution,
    extremeEvents,
  };
}

// 配对差值检验：strategyRecords 和 baselineRecords 必须是同一段历史、逐期对齐
// （见方案 3.5 节：对同一期上"策略命中数 - 随机基准命中数"做配对检验，
//  比分别看两条 CI 是否覆盖理论期望更直接。这里作为内部校验层保留，
//  界面上优先展示 3.6 节的蒙特卡洛分位数）
function pairedDiffTest(strategyRecords, baselineRecords) {
  const n = Math.min(strategyRecords.length, baselineRecords.length);
  const diffs = [];
  for (let i = 0; i < n; i++) {
    diffs.push(strategyRecords[i].redHits - baselineRecords[i].redHits);
  }
  const meanDiff = mean(diffs);
  const variance = sampleVariance(diffs, meanDiff);
  const stderr = Math.sqrt(variance / n);
  const tStat = stderr === 0 ? 0 : meanDiff / stderr;
  return { meanDiff, tStat, n };
}

/**
 * 蒙特卡洛随机分布（方案 3.6 节）：固定真实开奖序列不变，生成 numRuns 条相互独立的
 * "随机选号策略"，让它们都跑一遍同样的 Walk-Forward 流程，得到一条经验分布。
 * 再把要评估的策略的得分插进这条分布里，直接读分位数——这比 p 值更容易向非统计
 * 背景的用户解释，也不需要假设正态分布。
 */
// boundaries 可选：{ validationStart, blindStart }。传入后除了整体分布，
// 还会把每一次独立模拟按同样的固定期号边界切开，分别累积出
// train / validation / blind / dev 四条经验分布，用于给每个数据段
// 各自算出正确口径的分位数（盲测集样本量小，它自己的分布也应该只由
// 盲测区间内的独立随机模拟构成，不能直接套用整体分布）。
function monteCarloDistribution(rawHistory, minTrainSize, numRuns = 5000, boundaries = null) {
  const history = sortAscending(rawHistory);
  const overall = [];
  const train = [];
  const validation = [];
  const blind = [];
  const dev = [];
  for (let run = 0; run < numRuns; run++) {
    const runId = `mc-${run}`;
    const records = walkForwardBacktest(history, (trainData, targetPeriod) =>
      require("./strategies").randomStrategy(trainData, targetPeriod, runId), minTrainSize);
    overall.push(mean(records.map((r) => r.redHits)));
    if (boundaries) {
      const seg = splitByPeriodBoundaries(records, boundaries);
      train.push(mean(seg.train.map((r) => r.redHits)));
      validation.push(mean(seg.validation.map((r) => r.redHits)));
      blind.push(mean(seg.blind.map((r) => r.redHits)));
      dev.push(mean(seg.dev.map((r) => r.redHits)));
    }
  }
  overall.sort((a, b) => a - b);
  train.sort((a, b) => a - b);
  validation.sort((a, b) => a - b);
  blind.sort((a, b) => a - b);
  dev.sort((a, b) => a - b);
  return boundaries ? { overall, train, validation, blind, dev } : overall;
}

// 给定一个分数，返回它在蒙特卡洛分布里的分位数（0~100，表示跑赢了百分之多少的随机策略）
function percentileOf(distribution, score) {
  const below = distribution.filter((v) => v <= score).length;
  return (below / distribution.length) * 100;
}

/**
 * 训练/验证/盲测三段式分割（V0.5 新增，方案第九节 / README「还没做的」第一条）。
 *
 * 关键设计原则：分割边界必须是「固定的期号」，不能是「数据长度的百分比」。
 * 如果每次重新构建都按"最新数据的后 20%"来划盲测集，那么盲测集会随着新一期
 * 开奖不断整体后移、名字叫"盲测"实际上只是"最近窗口"，起不到真正的封存作用。
 * 正确做法：一旦宣布了 validationStart / blindStart 这两个期号，就必须写死，
 * 不因为后续追加了新数据而重新计算——新开出的期数只会不断累积进"盲测集"，
 * 而不会导致盲测集的起点跟着挪动。调整这两个常量只能是有意识的版本决策
 * （比如宣布"盲测集 V2 从某期开始重新计算"），不能是构建脚本自动推导的副作用。
 *
 * @param {Array} records walkForwardBacktest 的输出（已经是按期号升序的）
 * @param {{validationStart: string|number, blindStart: string|number}} boundaries 固定期号边界
 */
function splitByPeriodBoundaries(records, { validationStart, blindStart }) {
  const vStart = Number(validationStart);
  const bStart = Number(blindStart);
  const train = records.filter((r) => Number(r.period) < vStart);
  const validation = records.filter((r) => Number(r.period) >= vStart && Number(r.period) < bStart);
  const blind = records.filter((r) => Number(r.period) >= bStart);
  const dev = records.filter((r) => Number(r.period) < bStart); // 开发集 = 训练 + 验证
  return { train, validation, blind, dev };
}

module.exports = {
  RED_EXPECTATION,
  BLUE_EXPECTATION,
  walkForwardBacktest,
  calculatePrize,
  estimateFloatingBonus,
  bonusOf,
  summarize,
  pairedDiffTest,
  monteCarloDistribution,
  percentileOf,
  sortAscending,
  splitByPeriodBoundaries,
};
