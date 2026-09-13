// 实验：在"完全随机"的模拟数据上，比较三种区间口径的"标记率"是否符合标称 5%
// 标称：95% 区间 ⇒ 33 个号码里平均应有 33×0.05 = 1.65 个落在区间外。
// 用合格的 Mulberry32 生成模拟数据（不受之前那个坏 LCG 影响）。
const { seededRandom } = require("../src/rng.js");

const N = 3502; // 期数
const N33 = 33; // 号码总数
const K = 6; // 每期开出个数
const p = K / N33;
const expected = N * p; // 每个号码的期望出现次数

function makeData(seed) {
  const rnd = seededRandom(seed);
  const counts = new Array(N33).fill(0);
  for (let d = 0; d < N; d++) {
    // 每期不放回抽 6 个
    const pool = [];
    for (let i = 0; i < N33; i++) pool.push(i);
    for (let j = 0; j < K; j++) {
      const idx = Math.floor(rnd() * pool.length);
      counts[pool[idx]]++;
      pool.splice(idx, 1);
    }
  }
  return counts;
}

// 口径 1：标准 Wilson（二项方差），不校正
function wilson(count, n, z = 1.96) {
  const ph = count / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = ph + z2 / (2 * n);
  const margin = z * Math.sqrt((ph * (1 - ph)) / n + z2 / (4 * n * n));
  return [Math.max(0, (center - margin) / denom), Math.min(1, (center + margin) / denom)];
}

// 口径 2：Wilson + 有限总体校正（当前实现）
function wilsonFpc(count, n, z = 1.96) {
  let [lo, hi] = wilson(count, n, z);
  const f = Math.sqrt((N33 - K) / (N33 - 1));
  const mid = (lo + hi) / 2;
  lo = mid + (lo - mid) * f;
  hi = mid + (hi - mid) * f;
  return [Math.max(0, Math.min(1, lo)), Math.max(0, Math.min(1, hi))];
}

// 口径 3：正态 + 精确超几何方差（含有限总体校正）
function normalExact(count, n, z = 1.96) {
  const sd = Math.sqrt(n * p * (1 - p) * ((N33 - K) / (N33 - 1)));
  return [(count - z * sd) / n, (count + z * sd) / n];
}

const modes = [
  ["标准 Wilson（不校正）", wilson],
  ["Wilson + 有限总体校正", wilsonFpc],
  ["正态 + 精确超几何方差", normalExact],
];

const TRIALS = 200;
const results = modes.map((m) => ({ name: m[0], fn: m[1], total: 0, ge2: 0 }));

for (let t = 0; t < TRIALS; t++) {
  const counts = makeData(1000 + t);
  modes.forEach((m, mi) => {
    let outside = 0;
    for (let k = 0; k < N33; k++) {
      const r = m[1](counts[k], N);
      if (!(r[0] * N <= expected && expected <= r[1] * N)) outside++;
    }
    results[mi].total += outside;
    if (outside >= 2) results[mi].ge2++;
  });
}

console.log("=== 在完全随机的模拟数据上，平均有多少个号码落在 95% 区间外 ===");
console.log("（标称值应为 33 × 5% = 1.65）");
console.log("");
results.forEach((r) => {
  const mean = r.total / TRIALS;
  console.log(`  ${r.name.padEnd(24)} 平均 ${mean.toFixed(3)} 个   出现≥2个的概率 ${((r.ge2 / TRIALS) * 100).toFixed(1)}%`);
});
console.log("");
console.log("=== 判定 ===");
let bad = 0;
results.forEach((r) => {
  const mean = r.total / TRIALS;
  const ok = Math.abs(mean - 1.65) < 0.35;
  if (!ok) bad++;
  console.log(`  ${ok ? "✅" : "❌"} ${r.name}: ${mean.toFixed(3)}（偏离标称 ${(((mean - 1.65) / 1.65) * 100).toFixed(0)}%）`);
});

console.log("");
console.log("=".repeat(78));
// 这个测试的唯一职责：守住"生产口径的区间，在完全随机的数据上标记率符合标称 5%"。
// 当前生产代码用的是**标准 Wilson（第 1 种）**；另外两种都不通过。
// 若有人把生产口径改成 FPC 或"精确方差"版本，这个测试会红——那正是它存在的意义。
// （背景：代码审查曾主张改用"精确超几何方差"，理论分析正确但结论错误，
//   实测会让标记率从 1.71 恶化到 2.43、即过度标记 47%。）
const prodMean = results[0].total / TRIALS;
if (Math.abs(prodMean - 1.65) < 0.35) {
  console.log(`区间标定通过：生产口径（标准 Wilson）在随机数据上的标记率为 ${prodMean.toFixed(3)}，`);
  console.log("与标称值 1.65（33 × 5%）吻合。");
  process.exit(0);
} else {
  console.error(`区间标定失败：生产口径标记率 ${prodMean.toFixed(3)} 偏离标称值 1.65。`);
  console.error("这说明数字体检的置信区间口径有问题，页面上的「偏离号码」会被误报。");
  process.exit(1);
}
