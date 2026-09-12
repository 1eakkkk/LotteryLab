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

module.exports = { randomStrategy, hotStrategy, coldStrategy, allReds, allBlues };
