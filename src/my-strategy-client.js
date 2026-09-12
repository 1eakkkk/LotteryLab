/**
 * "我的策略"权重滑块交互（V1 新增，方案第五节第6条）。
 *
 * 这段代码会被 build-site.js 原样内联进 public/index.html 的 <script> 标签，
 * 和 src/strategies.js 里的 weightedStrategy 逻辑是「同一套算法的浏览器版本」——
 * 因为页面要求自包含、双击即可打开、不依赖 Node 的 require()，所以这里手写了
 * 一份不用 CommonJS 的等价实现，而不是直接复用 src/strategies.js。
 * 如果以后修改了打分逻辑，两边都要改，并在 PR 里互相提醒。
 *
 * 核心设计原则（和站内其它地方一致）：
 *   1. 同一组权重 + 同一份历史数据 = 永远同一组号码、同一个回测成绩。
 *      不用裸 Math.random()，噪声用「期号+runId」做种子的伪随机数。
 *   2. "历史回测成绩"（开发集，第 ${dev_period_range} 期）是用户调参时全程可见的，
 *      "盲测成绩"（第 ${blind_period_range} 期起）默认隐藏，点击按钮才揭晓——
 *      这是刻意的产品设计：用户可以随便拖滑块把开发集成绩调到全站第一，
 *      但那只是数据窥探，不构成"发现了规律"，只有盲测成绩才是相对公平的检验。
 */
(function () {
  "use strict";

  var DATA = window.__LAB_DATA__;
  if (!DATA) return;

  var history = DATA.history; // 已按期号升序：[{period, red:[...], blue}]
  var minTrainSize = DATA.minTrainSize;
  var blindStartPeriod = Number(DATA.boundaries.blindStart);
  var devDistribution = DATA.mcDevDistribution || [];
  var blindDistribution = DATA.mcBlindDistribution || [];

  function pad2(n) {
    return String(n).padStart(2, "0");
  }
  function allReds() {
    var a = [];
    for (var i = 1; i <= 33; i++) a.push(pad2(i));
    return a;
  }
  function allBlues() {
    var a = [];
    for (var i = 1; i <= 16; i++) a.push(pad2(i));
    return a;
  }
  var REDS = allReds();
  var BLUES = allBlues();

  // Mulberry32，和 src/rng.js 完全一致
  function seededRandom(seed) {
    var a = seed;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashSeed(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) {
      h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    }
    return h;
  }

  function normalizeMap(map) {
    var values = Object.keys(map).map(function (k) {
      return map[k];
    });
    var max = Math.max.apply(null, [1].concat(values));
    var out = {};
    Object.keys(map).forEach(function (k) {
      out[k] = map[k] / max;
    });
    return out;
  }

  function predict(trainData, targetPeriod, weights) {
    var hotW = weights.hot || 0;
    var coldW = weights.cold || 0;
    var randW = weights.random || 0;

    var window50 = trainData.slice(-50);
    var freq = {};
    REDS.forEach(function (b) {
      freq[b] = 0;
    });
    window50.forEach(function (d) {
      d.red.forEach(function (b) {
        freq[b] += 1;
      });
    });
    var hotFreq = normalizeMap(freq);

    var n = trainData.length;
    var lastSeen = {};
    REDS.forEach(function (b) {
      lastSeen[b] = -1;
    });
    trainData.forEach(function (d, idx) {
      d.red.forEach(function (b) {
        lastSeen[b] = idx;
      });
    });
    var omit = {};
    REDS.forEach(function (b) {
      omit[b] = n - 1 - lastSeen[b];
    });
    var coldOmit = normalizeMap(omit);

    var rng = seededRandom(hashSeed("my-strategy-" + targetPeriod));
    var noise = {};
    REDS.forEach(function (b) {
      noise[b] = rng();
    });

    var score = {};
    REDS.forEach(function (b) {
      score[b] = hotW * hotFreq[b] + coldW * coldOmit[b] + randW * noise[b];
    });
    var sortedReds = Object.keys(score).sort(function (a, b) {
      if (score[b] !== score[a]) return score[b] - score[a];
      return Number(a) - Number(b);
    });

    var blueFreqRaw = {};
    BLUES.forEach(function (b) {
      blueFreqRaw[b] = 0;
    });
    window50.forEach(function (d) {
      blueFreqRaw[d.blue] += 1;
    });
    var blueFreq = normalizeMap(blueFreqRaw);

    var lastSeenBlue = {};
    BLUES.forEach(function (b) {
      lastSeenBlue[b] = -1;
    });
    trainData.forEach(function (d, idx) {
      lastSeenBlue[d.blue] = idx;
    });
    var blueOmitRaw = {};
    BLUES.forEach(function (b) {
      blueOmitRaw[b] = n - 1 - lastSeenBlue[b];
    });
    var blueOmit = normalizeMap(blueOmitRaw);

    var blueRng = seededRandom(hashSeed("my-strategy-blue-" + targetPeriod));
    var blueNoise = {};
    BLUES.forEach(function (b) {
      blueNoise[b] = blueRng();
    });

    var blueScore = {};
    BLUES.forEach(function (b) {
      blueScore[b] = hotW * blueFreq[b] + coldW * blueOmit[b] + randW * blueNoise[b];
    });
    var sortedBlues = Object.keys(blueScore).sort(function (a, b) {
      if (blueScore[b] !== blueScore[a]) return blueScore[b] - blueScore[a];
      return Number(a) - Number(b);
    });

    return {
      red: sortedReds
        .slice(0, 6)
        .sort(function (a, b) {
          return Number(a) - Number(b);
        }),
      blue: sortedBlues[0],
    };
  }

  function walkForward(weights) {
    var records = [];
    for (var t = minTrainSize; t < history.length; t++) {
      var trainData = history.slice(0, t);
      var actual = history[t];
      var pred = predict(trainData, actual.period, weights);
      var redHits = actual.red.filter(function (b) {
        return pred.red.indexOf(b) !== -1;
      }).length;
      records.push({ period: actual.period, redHits: redHits });
    }
    return records;
  }

  function splitSegments(records) {
    var dev = [];
    var blind = [];
    records.forEach(function (r) {
      if (Number(r.period) < blindStartPeriod) dev.push(r);
      else blind.push(r);
    });
    return { dev: dev, blind: blind };
  }

  function summarize(records) {
    var n = records.length;
    if (n === 0) return null;
    var sum = 0;
    records.forEach(function (r) {
      sum += r.redHits;
    });
    var mean = sum / n;
    var variance = 0;
    if (n >= 2) {
      records.forEach(function (r) {
        variance += Math.pow(r.redHits - mean, 2);
      });
      variance /= n - 1;
    }
    var stderr = Math.sqrt(variance / n);
    return { n: n, mean: mean, ci95: [mean - 1.96 * stderr, mean + 1.96 * stderr] };
  }

  function percentileOf(dist, score) {
    if (!dist || !dist.length) return null;
    var below = 0;
    for (var i = 0; i < dist.length; i++) {
      if (dist[i] <= score) below++;
    }
    return (below / dist.length) * 100;
  }

  function fmt(v) {
    return v === null || v === undefined ? "—" : v.toFixed(4);
  }
  function pct(v) {
    return v === null || v === undefined ? "—" : v.toFixed(1) + "%";
  }

  // ---- DOM 绑定 ----
  var $hot = document.getElementById("ms-hot");
  var $cold = document.getElementById("ms-cold");
  var $rand = document.getElementById("ms-random");
  var $hotVal = document.getElementById("ms-hot-val");
  var $coldVal = document.getElementById("ms-cold-val");
  var $randVal = document.getElementById("ms-random-val");
  var $numbers = document.getElementById("ms-numbers");
  var $devMean = document.getElementById("ms-dev-mean");
  var $devCi = document.getElementById("ms-dev-ci");
  var $devPct = document.getElementById("ms-dev-pct");
  var $blindBtn = document.getElementById("ms-reveal-btn");
  var $blindResult = document.getElementById("ms-blind-result");
  var $blindMean = document.getElementById("ms-blind-mean");
  var $blindCi = document.getElementById("ms-blind-ci");
  var $blindPct = document.getElementById("ms-blind-pct");

  if (!$hot || !$cold || !$rand) return; // 页面结构缺失时安全退出，不报错

  var debounceTimer = null;
  function currentWeights() {
    return {
      hot: Number($hot.value),
      cold: Number($cold.value),
      random: Number($rand.value),
    };
  }

  function render() {
    var weights = currentWeights();
    $hotVal.textContent = weights.hot;
    $coldVal.textContent = weights.cold;
    $randVal.textContent = weights.random;

    var records = walkForward(weights);
    var seg = splitSegments(records);
    var devStats = summarize(seg.dev);
    var devPercentile = devStats ? percentileOf(devDistribution, devStats.mean) : null;

    $devMean.textContent = devStats ? fmt(devStats.mean) : "—";
    $devCi.textContent = devStats ? "[" + devStats.ci95[0].toFixed(3) + ", " + devStats.ci95[1].toFixed(3) + "]" : "—";
    $devPct.textContent = pct(devPercentile);

    // 当前展示的号码：用最新一期之后（即"下一期"）为目标种子，保证和用户当前权重一一对应
    var lastPeriod = history[history.length - 1].period;
    var nextSeed = String(Number(lastPeriod) + 1);
    var pred = predict(history, nextSeed, weights);
    $numbers.innerHTML =
      pred.red
        .map(function (b) {
          return '<span class="ball ball-red">' + b + "</span>";
        })
        .join("") + '<span class="ball ball-blue">' + pred.blue + "</span>";

    // 权重一变，之前揭晓的盲测成绩就作废，必须重新点击才能看新一组权重的盲测表现——
    // 否则用户会看着"上一组权重"的盲测数字，误以为是当前权重的结果。
    $blindResult.style.display = "none";
    $blindBtn.disabled = false;
    $blindBtn.textContent = "揭晓当前权重的盲测成绩";
    $blindBtn.dataset.weights = JSON.stringify(weights);
  }

  function revealBlind() {
    var weights = JSON.parse($blindBtn.dataset.weights || "{}");
    var records = walkForward(weights);
    var seg = splitSegments(records);
    var blindStats = summarize(seg.blind);
    if (!blindStats) return;
    var blindPercentile = percentileOf(blindDistribution, blindStats.mean);
    $blindMean.textContent = fmt(blindStats.mean);
    $blindCi.textContent = "[" + blindStats.ci95[0].toFixed(3) + ", " + blindStats.ci95[1].toFixed(3) + "]";
    $blindPct.textContent = pct(blindPercentile);
    $blindResult.style.display = "block";
    $blindBtn.disabled = true;
    $blindBtn.textContent = "已揭晓（改动滑块后可重新揭晓）";
  }

  function onSliderInput() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(render, 60);
  }

  [$hot, $cold, $rand].forEach(function (el) {
    el.addEventListener("input", onSliderInput);
  });
  $blindBtn.addEventListener("click", revealBlind);

  render();
})();
