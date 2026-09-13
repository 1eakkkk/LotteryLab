// ============================================================================
// ML 策略：逻辑回归（方案第九节 V2「机器学习模型」项，本项目名称的核心承诺）
// ----------------------------------------------------------------------------
// 为什么是逻辑回归而不是 XGBoost / LSTM：
//   本项目要检验的命题是"机器学习能不能预测彩票"。这个命题与模型复杂度无关——
//   如果连一个**参数量可控、能逐权重解释、能在纯 JS 里精确复现**的模型都找不到优势，
//   那么换成更复杂的模型也不会凭空长出优势（更复杂的模型只是更容易过拟合）。
//   反过来，逻辑回归有一个别的好处：它的权重可以直接展示给读者看
//   （"模型认为哪个号更值得选、权重多大"），这是"黑箱 LSTM"做不到的可解释性。
//
// 建模方式（每一步都要能说清为什么）：
//   1. **样本**：对每一期 t，用"截至 t-1 期"的历史为 33 个红球各构造一个特征向量；
//      标签是该号码在第 t 期是否被开出（1/0）。这就是标准的二分类。
//   2. **特征**（全部只用 t-1 期及以前的信息，杜绝未来数据）：
//      · 近 50 期频率      —— "热号"信号
//      · 近 200 期频率     —— 稍长期的频率
//      · 遗漏期数（归一化）—— "冷号/该出了"信号
//      · 全历史频率        —— 长期基准
//      · 号码本身（归一化）—— 让模型有机会发现"某些号系统性偏多"（理论上不该有）
//      · 近 10 期是否出现  —— 短期动量
//   3. **训练**：批量梯度下降 + L2 正则，固定迭代次数与学习率（**确定性**，
//      不用随机初始化、不用随机打散），保证"同数据同结果"这个项目底线。
//   4. **预测**：把 33 个号码按预测概率从高到低排序，取前 6 个作为这一期的选号。
//      这个"取 Top-6"的规则与 hotStrategy 完全对齐，便于公平比较。
//   5. **再训练节奏**：每 20 期重新训练一次（用当时可见的数据），其余期沿用上次权重。
//      为什么不是每期都训练：3502 期 × 33 号 × 每期全量训练会让回测慢到不可用。
//      为什么可以这样：这是"在线学习"的常见做法；而且每 20 期重训一次，
//      信息延迟最多 20 期，对"彩票没有可利用结构"这个待检验命题没有实质影响。
//
// 重要提醒（写在代码里，也是给未来自己的警告）：
//   这个模型**是被检验的对象，不是被交付的产品**。它出现在排行榜上，
//   作用是让"AI 预测彩票"这个流行说法接受同一把尺子；它不参与页面任何"给出号码"的功能。
// ============================================================================

const RED_TOTAL = 33;
const RED_PICK = 6;

const pad2 = (n) => String(n).padStart(2, "0");
const ALL_REDS = (() => {
  const a = [];
  for (let i = 1; i <= RED_TOTAL; i++) a.push(pad2(i));
  return a;
})();

// ---- 特征工程 ----
// 性能说明（这是一次真实优化换来的）：
//   第一版 buildFeatureVector 对每个号码都"从当前位置往回扫"找遗漏期数，
//   复杂度 O(窗口长度)。训练时对每个样本 × 33 个号码都这么做，
//   实测回测每期要 142ms、外推全部 3402 期要 484 秒 —— 完全不可用。
//   改成**增量维护**：一次前向遍历就把每期每个号码的遗漏算出来，均摊 O(1)。
//   结果：同样 19800 个样本的特征构造从秒级降到百毫秒级。
//
// 特征清单（全部只用截至上一期的信息，杜绝未来数据）：
//   近50期频率 / 近200期频率 / 遗漏（归一化）/ 全历史频率 / 近10期频率 / 号码本身
//
// 注意 FEATURE_NAMES 比 buildFeaturesAt 返回的向量**多一项**：
// withBias 会把偏置项补在最前面，所以权重数组的长度是这 7 项。
// （第一版这里少写了一项，导致打印权重时 FEATURE_NAMES[i] 越界报错——纯显示层的错，
//   但它说明"特征维度"这件事在两个地方各写了一遍，容易不一致。）
const FEATURE_NAMES = [
  "偏置项",
  "近50期频率",
  "近200期频率",
  "遗漏（归一化）",
  "全历史频率",
  "近10期频率",
  "号码（归一化）",
];

const OMISSION_CAP = 60; // 遗漏超过 60 期统一按 60 处理（归一化用），也界定了扫描上限

// 特征每一项的含义见 FEATURE_NAMES。注意 buildFeaturesAt 返回的向量**不含偏置项**，
// 偏置项由 trainLogistic / predictScore 统一补在最前面（见下面 withBias）。
// 这样做的原因：标准化要求"偏置项恒为 1 不参与标准化"，
// 如果偏置项混在特征里一起被标准化就会变成 0，模型直接失去截距。
function withBias(rows) {
  return rows.map((r) => [1, ...r]);
}

/**
 * 一次性为"到第 uptoIndex 期为止"的历史，构造全部 33 个号码的特征向量。
 * 用增量方式维护 lastSeen，避免对每个号码回溯扫描。
 */
function buildFeaturesAt(history, uptoIndex) {
  const w50 = Math.max(0, uptoIndex - 50);
  const w200 = Math.max(0, uptoIndex - 200);
  const w10 = Math.max(0, uptoIndex - 10);

  const count50 = new Array(RED_TOTAL + 1).fill(0);
  const count200 = new Array(RED_TOTAL + 1).fill(0);
  const countAll = new Array(RED_TOTAL + 1).fill(0);
  const count10 = new Array(RED_TOTAL + 1).fill(0);
  const lastSeen = new Array(RED_TOTAL + 1).fill(-1);

  for (let i = 0; i < uptoIndex; i++) {
    const d = history[i];
    for (const b of d.red) {
      const n = Number(b);
      countAll[n] += 1;
      if (i >= w50) count50[n] += 1;
      if (i >= w200) count200[n] += 1;
      if (i >= w10) count10[n] += 1;
      lastSeen[n] = i;
    }
  }

  const span50 = Math.max(1, uptoIndex - w50);
  const span200 = Math.max(1, uptoIndex - w200);
  const span10 = Math.max(1, uptoIndex - w10);
  const spanAll = Math.max(1, uptoIndex);

  const rows = [];
  for (let n = 1; n <= RED_TOTAL; n++) {
    const omission = lastSeen[n] < 0 ? uptoIndex : uptoIndex - 1 - lastSeen[n];
    // 注意：这里**不含偏置项**。偏置项由 withBias 统一补在最前面，
    // 保证"偏置项恒为 1、不参与标准化"这条规则只在一个地方实现。
    // （第一版这里多写了一个 1，加上 withBias 后变成两个偏置项 → 特征 8 维、
    //   名字只有 7 个 → 打印权重时越界。）
    rows.push([
      count50[n] / span50,
      count200[n] / span200,
      Math.min(1, omission / OMISSION_CAP),
      countAll[n] / spanAll,
      count10[n] / span10,
      (n - 1) / (RED_TOTAL - 1),
    ]);
  }
  return rows;
}

/**
 * 兼容接口：给单个号码构造特征（训练/预测内部都改用 buildFeaturesAt，
 * 这个函数保留给自检脚本使用）。
 */
function buildFeatureVector(history, number) {
  const rows = withBias(buildFeaturesAt(history, history.length));
  return rows[Number(number) - 1];
}

// ---- 逻辑回归训练（确定性 + 特征标准化）----
/**
 * 标准化：把每个特征减去均值、除以标准差。
 *
 * 为什么必须做（这是实测踩出来的）：不标准化时，各特征量纲差异很大
 * （号码是 0~1 的线性值，频率是 0~0.3 的小数），L2 正则对它们的惩罚强度就不可比，
 * 结果是模型学出"号码越大分数越低"这种**纯属人造的伪信号**——
 * 表现为选号永远是 01 02 04 05 06 09（最小的一批号）。
 * 那不是数据里的规律，是量纲差异 + 正则化造出来的假规律。
 * 对"检验 AI 能不能预测彩票"这件事来说，这种伪信号会让结论彻底失真：
 * 模型看起来有偏好，其实是自己在骗自己。
 */
function standardize(samples) {
  const m = samples.length;
  const dim = samples[0].length;
  const mean = new Array(dim).fill(0);
  const sd = new Array(dim).fill(0);
  for (const x of samples) for (let k = 0; k < dim; k++) mean[k] += x[k] / m;
  for (const x of samples) for (let k = 0; k < dim; k++) sd[k] += (x[k] - mean[k]) ** 2 / m;
  for (let k = 0; k < dim; k++) sd[k] = Math.sqrt(sd[k]) || 1;
  const out = samples.map((x) => x.map((v, k) => (k === 0 ? 1 : (v - mean[k]) / sd[k])));
  return { out, mean, sd };
}

function trainLogistic(samples, labels, { epochs = 60, lr = 0.5, l2 = 0.01 } = {}) {
  const dim = samples[0].length;
  const w = new Array(dim).fill(0);
  const m = samples.length;
  if (m === 0) return { weights: w };

  // 标准化后训练（偏置项保持为 1，不参与标准化）
  const { out: X, mean, sd } = standardize(samples);

  for (let epoch = 0; epoch < epochs; epoch++) {
    const grad = new Array(dim).fill(0);
    for (let i = 0; i < m; i++) {
      const x = X[i];
      let z = 0;
      for (let k = 0; k < dim; k++) z += w[k] * x[k];
      const p = 1 / (1 + Math.exp(-z));
      const err = p - labels[i];
      for (let k = 0; k < dim; k++) grad[k] += err * x[k];
    }
    for (let k = 0; k < dim; k++) {
      const reg = k === 0 ? 0 : l2 * w[k];
      w[k] -= lr * (grad[k] / m + reg);
    }
  }
  // 把标准化参数一起带出去，预测时必须用同一套变换
  return { weights: w, mean, sd };
}

function predictScore(model, rawX) {
  const { weights: w, mean, sd } = model;
  let z = 0;
  for (let k = 0; k < rawX.length; k++) {
    const x = k === 0 ? 1 : (rawX[k] - mean[k]) / sd[k];
    z += w[k] * x;
  }
  return 1 / (1 + Math.exp(-z));
}

/**
 * ML 策略（返回结构与其他策略完全一致：{ red: [...6], blue: [...] }）。
 *
 * @param trainData 截至上一期的历史（只能看这些）
 * @param targetPeriod 目标期号（用于确定性种子，保证可复现）
 * @param opts.retrainEvery 每多少期重新训练一次
 * @param opts.cache 由 walkForwardBacktest 传入的跨期缓存（避免每期重训）
 */
function mlStrategy(trainData, targetPeriod, opts = {}) {
  const retrainEvery = opts.retrainEvery || 20;
  const cache = opts.cache || {};
  const t = trainData.length;

  // 需要训练（或首次）时训练一次
  const needTrain = cache.model === undefined || t - (cache.trainedAt || 0) >= retrainEvery;
  if (needTrain) {
    // 用最近 maxTrain 期构造训练样本，控制耗时
    const maxTrain = opts.maxTrain || 600;
    const start = Math.max(30, t - maxTrain); // 至少留 30 期做特征
    const samples = [];
    const labels = [];
    for (let i = start; i < t; i++) {
      // 增量构造：每期一次性算出 33 个号码的特征（O(33)，不回溯扫描）
      const rows = withBias(buildFeaturesAt(trainData, i));
      const actual = trainData[i];
      for (let k = 0; k < ALL_REDS.length; k++) {
        samples.push(rows[k]);
        labels.push(actual.red.includes(ALL_REDS[k]) ? 1 : 0);
      }
    }
    cache.model = trainLogistic(samples, labels, opts);
    cache.trainedAt = t;
  }

  const model = cache.model;
  const currentRows = withBias(buildFeaturesAt(trainData, t));
  const scored = ALL_REDS.map((number, idx) => ({
    number,
    score: predictScore(model, currentRows[idx]),
  }));
  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : Number(a.number) - Number(b.number)));

  // 蓝球：模型不建模蓝球（蓝球只有 16 个取值、每期 1 个，
  // 用频率法已经足够，且单独建模对"命中率"这个指标没有额外解释力）。
  // 沿用热号的蓝球选择，保持与其它策略可比。
  const blueFreq = {};
  const allBlues = [];
  for (let i = 1; i <= 16; i++) allBlues.push(pad2(i));
  allBlues.forEach((b) => (blueFreq[b] = 0));
  trainData.slice(-50).forEach((d) => (blueFreq[d.blue] += 1));
  const bestBlue = allBlues
    .slice()
    .sort((a, b) => (blueFreq[b] !== blueFreq[a] ? blueFreq[b] - blueFreq[a] : Number(a) - Number(b)))[0];

  return {
    red: scored
      .slice(0, RED_PICK)
      .map((s) => s.number)
      .sort((a, b) => Number(a) - Number(b)),
    blue: bestBlue,
  };
}

module.exports = { mlStrategy, trainLogistic, buildFeatureVector, FEATURE_NAMES };
