// 种子伪随机数生成器：回测模式下绝不能用裸的 Math.random()，
// 否则同一份历史数据每次跑出的排行榜都会变，违背"同数据+同算法=同结果"的原则。
// Mulberry32：轻量、够用。

function seededRandom(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return h;
}

module.exports = { seededRandom, hashSeed };
