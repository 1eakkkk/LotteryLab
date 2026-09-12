const fs = require("fs");
const path = require("path");

const { randomStrategy, hotStrategy, coldStrategy } = require("./strategies");
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

function main() {
  const history = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "ssq.json"), "utf-8"));

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

  function summarizeSegment(segRecords, benchmarkSegRecords, mcSegDistribution) {
    if (segRecords.length === 0) return null;
    const stats = summarize(segRecords);
    const diffTest = pairedDiffTest(segRecords, benchmarkSegRecords);
    const percentile = percentileOf(mcSegDistribution, stats.meanHit);
    return {
      periods_tested: stats.periodsTested,
      period_range: periodRangeOf(segRecords),
      mean_hit: Number(stats.meanHit.toFixed(4)),
      ci_95: stats.ci95.map((v) => Number(v.toFixed(4))),
      blue_hit_rate: Number(stats.blueHitRate.toFixed(4)),
      vs_random_percentile: Number(percentile.toFixed(1)),
      paired_diff_vs_random: Number(diffTest.meanDiff.toFixed(4)),
      is_significant: Math.abs(diffTest.tStat) > 1.96,
    };
  }

  // ---- 3. 汇总每个策略 ----
  const strategies = [
    { key: "random", name: "随机基准", records: benchmarkRandomRecords },
    { key: "hot", name: "热号", records: hotRecords },
    { key: "cold", name: "冷号", records: coldRecords },
  ];

  const leaderboard = strategies.map(({ key, name, records }) => {
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
      is_significant: Math.abs(diffTest.tStat) > 1.96, // 内部参考，界面优先展示分位数
      // V0.5 新增：短期窗口 + 三段式分割
      recent: {
        last10: recentWindowStats(records, 10),
        last30: recentWindowStats(records, 30),
        last100: recentWindowStats(records, 100),
      },
      segments: {
        dev: summarizeSegment(seg.dev, benchmarkSegments.dev, mc.dev),
        blind: summarizeSegment(seg.blind, benchmarkSegments.blind, mc.blind),
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
    leaderboard,
    convergence,
    monte_carlo: monteCarlo,
    fund,
  };

  fs.writeFileSync(path.join(DATA_DIR, "leaderboard.json"), JSON.stringify(leaderboard, null, 2));
  fs.writeFileSync(path.join(DATA_DIR, "report.json"), JSON.stringify(report, null, 2));

  console.log("\n=== 排行榜（整体，训练+验证+盲测合并，与旧版口径一致）===");
  leaderboard.forEach((s) => {
    console.log(
      `${s.strategy.padEnd(6)} 均命中=${s.mean_hit} (理论${s.theoretical_expectation.toFixed(4)}) ` +
        `CI95=[${s.ci_95[0]}, ${s.ci_95[1]}] 跑赢随机分布=${s.vs_random_percentile}% 显著=${s.is_significant}`
    );
  });

  console.log(
    `\n=== 盲测集（${report.split_boundaries.blind_period_range.from}~${report.split_boundaries.blind_period_range.to}期，共${report.split_boundaries.blind_periods_count}期，起点写死不会随数据增长后移）===`
  );
  leaderboard.forEach((s) => {
    const b = s.segments.blind;
    if (!b) return console.log(`${s.strategy.padEnd(6)} 盲测集数据不足，跳过`);
    console.log(
      `${s.strategy.padEnd(6)} 均命中=${b.mean_hit} CI95=[${b.ci_95[0]}, ${b.ci_95[1]}] ` +
        `跑赢随机分布=${b.vs_random_percentile}%（样本量小，仅供参考，不构成"有效"结论）`
    );
  });

  console.log(`\n已写入 ${path.join(DATA_DIR, "report.json")}`);
}

main();
