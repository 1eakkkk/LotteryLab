const { seededRandom, hashSeed } = require("./rng");

const RED_MIN = 1;
const RED_MAX = 33;
const BLUE_MIN = 1;
const BLUE_MAX = 16;

const pad2 = (n) => String(n).padStart(2, "0");
const allReds = () => {
  const arr = [];
  for (let i = RED_MIN; i <= RED_MAX; i++) arr.push(pad2(i));
  return arr;
};
const allBlues = () => {
  const arr = [];
  for (let i = BLUE_MIN; i <= BLUE_MAX; i++) arr.push(pad2(i));
  return arr;
};

/**
 * 随机策略（回测模式）：均匀随机选 6 个不重复红球 + 1 个蓝球。
 * 关键：种子必须由「期号 + 策略名/运行编号」决定，保证同一份数据永远得到同一份结果。
 * 不使用 trainData（这是"随机基准"的定义所在：完全不看历史）。
 */
function randomStrategy(trainData, targetPeriod, runId = "random") {
  const rng = seededRandom(hashSeed(`${runId}-${targetPeriod}`));
  const pool = allReds();
  const red = [];
  for (let i = 0; i < 6; i++) {
    const total = pool.length;
    const idx = Math.floor(rng() * total);
    red.push(pool[idx]);
    pool.splice(idx, 1);
  }
  const bluePool = allBlues();
  const blue = bluePool[Math.floor(rng() * bluePool.length)];
  return {
    red: red.sort((a, b) => Number(a) - Number(b)),
    blue,
  };
}

/**
 * 热号策略（确定性，无随机成分）：取最近 windowSize 期内出现频率最高的 6 个红球
 * + 出现频率最高的 1 个蓝球。分值相同时按球号升序打破平局，保证结果唯一确定。
 */
function hotStrategy(trainData, targetPeriod, windowSize = 50) {
  const windowData = trainData.slice(-windowSize);
  const freq = {};
  allReds().forEach((b) => (freq[b] = 0));
  windowData.forEach((draw) => draw.red.forEach((b) => (freq[b] += 1)));

  const sortedReds = Object.keys(freq).sort((a, b) => {
    if (freq[b] !== freq[a]) return freq[b] - freq[a];
    return Number(a) - Number(b);
  });

  const blueFreq = {};
  allBlues().forEach((b) => (blueFreq[b] = 0));
  windowData.forEach((draw) => (blueFreq[draw.blue] += 1));
  const sortedBlues = Object.keys(blueFreq).sort((a, b) => {
    if (blueFreq[b] !== blueFreq[a]) return blueFreq[b] - blueFreq[a];
    return Number(a) - Number(b);
  });

  return {
    red: sortedReds.slice(0, 6).sort((a, b) => Number(a) - Number(b)),
    blue: sortedBlues[0],
  };
}

/**
 * 冷号策略（确定性，无随机成分）：取"遗漏期数"（距离上次出现已经过去了多少期）
 * 最长的 6 个红球 + 遗漏期数最长的 1 个蓝球。从未出现过的球遗漏期数记为
 * trainData.length（相当于"从有数据以来就没出现过"），球号升序打破平局。
 */
function coldStrategy(trainData, targetPeriod) {
  const n = trainData.length;

  const lastSeenRed = {};
  allReds().forEach((b) => (lastSeenRed[b] = -1));
  trainData.forEach((draw, idx) => draw.red.forEach((b) => (lastSeenRed[b] = idx)));
  const omissionRed = {};
  allReds().forEach((b) => (omissionRed[b] = n - 1 - lastSeenRed[b]));

  const sortedReds = Object.keys(omissionRed).sort((a, b) => {
    if (omissionRed[b] !== omissionRed[a]) return omissionRed[b] - omissionRed[a];
    return Number(a) - Number(b);
  });

  const lastSeenBlue = {};
  allBlues().forEach((b) => (lastSeenBlue[b] = -1));
  trainData.forEach((draw, idx) => (lastSeenBlue[draw.blue] = idx));
  const omissionBlue = {};
  allBlues().forEach((b) => (omissionBlue[b] = n - 1 - lastSeenBlue[b]));
  const sortedBlues = Object.keys(omissionBlue).sort((a, b) => {
    if (omissionBlue[b] !== omissionBlue[a]) return omissionBlue[b] - omissionBlue[a];
    return Number(a) - Number(b);
  });

  return {
    red: sortedReds.slice(0, 6).sort((a, b) => Number(a) - Number(b)),
    blue: sortedBlues[0],
  };
}

function normalizeMap(map) {
  const values = Object.values(map);
  const max = Math.max(1, ...values);
  const out = {};
  Object.keys(map).forEach((k) => (out[k] = map[k] / max));
  return out;
}

function hotFreqMap(trainData, windowSize = 50) {
  const windowData = trainData.slice(-windowSize);
  const freq = {};
  allReds().forEach((b) => (freq[b] = 0));
  windowData.forEach((draw) => draw.red.forEach((b) => (freq[b] += 1)));
  return freq;
}

function coldOmissionMap(trainData) {
  const n = trainData.length;
  const lastSeen = {};
  allReds().forEach((b) => (lastSeen[b] = -1));
  trainData.forEach((draw, idx) => draw.red.forEach((b) => (lastSeen[b] = idx)));
  const omission = {};
  allReds().forEach((b) => (omission[b] = n - 1 - lastSeen[b]));
  return omission;
}

/**
 * "我的策略"（V1 新增，方案第五节第6条）：用户可调权重的加权策略。
 * weights = { hot, cold, random }，每项建议 0~100，表示三种倾向的相对强度：
 *   hot    —— 越大越偏向"近50期出现频率高"的号码（热号倾向）
 *   cold   —— 越大越偏向"遗漏期数长"的号码（冷号倾向）
 *   random —— 越大，"期号+random-strategy"派生的确定性噪声在打分里占比越高（随机扰动）
 * 关键设计：噪声本身是「期号+runId」做种子的伪随机数，不是裸 Math.random()——
 * 保证同一组权重 + 同一份历史数据，永远打出同一组号码，不是每次刷新都变的抽奖，
 * 这样用户拖动滑块看到的"历史回测成绩"变化，只反映权重变化本身，不掺杂运气噪声。
 */
function weightedStrategy(trainData, targetPeriod, weights = {}, runId = "my-strategy") {
  const hotW = weights.hot || 0;
  const coldW = weights.cold || 0;
  const randW = weights.random || 0;

  const hotFreq = normalizeMap(hotFreqMap(trainData));
  const coldOmit = normalizeMap(coldOmissionMap(trainData));
  const rng = seededRandom(hashSeed(`${runId}-${targetPeriod}`));
  const noise = {};
  allReds().forEach((b) => (noise[b] = rng()));

  const score = {};
  allReds().forEach((b) => {
    score[b] = hotW * hotFreq[b] + coldW * coldOmit[b] + randW * noise[b];
  });
  const sortedReds = Object.keys(score).sort((a, b) => {
    if (score[b] !== score[a]) return score[b] - score[a];
    return Number(a) - Number(b);
  });

  const blueFreqRaw = {};
  allBlues().forEach((b) => (blueFreqRaw[b] = 0));
  trainData.slice(-50).forEach((draw) => (blueFreqRaw[draw.blue] += 1));
  const blueFreq = normalizeMap(blueFreqRaw);

  const n = trainData.length;
  const lastSeenBlue = {};
  allBlues().forEach((b) => (lastSeenBlue[b] = -1));
  trainData.forEach((draw, idx) => (lastSeenBlue[draw.blue] = idx));
  const blueOmitRaw = {};
  allBlues().forEach((b) => (blueOmitRaw[b] = n - 1 - lastSeenBlue[b]));
  const blueOmit = normalizeMap(blueOmitRaw);

  const blueRng = seededRandom(hashSeed(`${runId}-blue-${targetPeriod}`));
  const blueNoise = {};
  allBlues().forEach((b) => (blueNoise[b] = blueRng()));

  const blueScore = {};
  allBlues().forEach((b) => {
    blueScore[b] = hotW * blueFreq[b] + coldW * blueOmit[b] + randW * blueNoise[b];
  });
  const sortedBlues = Object.keys(blueScore).sort((a, b) => {
    if (blueScore[b] !== blueScore[a]) return blueScore[b] - blueScore[a];
    return Number(a) - Number(b);
  });

  return {
    red: sortedReds.slice(0, 6).sort((a, b) => Number(a) - Number(b)),
    blue: sortedBlues[0],
  };
}

module.exports = {
  randomStrategy,
  hotStrategy,
  coldStrategy,
  weightedStrategy,
  allReds,
  allBlues,
};
