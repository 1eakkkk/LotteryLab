/**
 * V4 第 1~3 层交互（方案 17.3）：数字体检 / 遗漏分布 / 形态诊断。
 *
 * 这段代码会被 build-site.js 原样内联进 public/index.html 的 <script> 标签，
 * 与 my-strategy-client.js 同一个理由：页面要求自包含、双击即可打开、不依赖服务器。
 *
 * 三条设计原则（都不是"顺便"写的，每一条都对应方案里的约束）：
 *
 *   1. 这些工具**不做任何号码生成决策**——它们只回答"这组号码落在多大的一堆里"。
 *      页面文案与交互里刻意没有"推荐""精选""更容易中"这类措辞。
 *
 *   2. 所有统计量在构建期已算好写死在 window.__LAB_DATA__.number_tools 里
 *      （见 src/number-health.js）。浏览器端只做"查表 + 展示"，
 *      不重新算统计量——否则页面显示的数字和 report.json 里的数字会有两套来源。
 *
 *   3. 每个数字旁边必须能立刻看到"怎么解读它"。这一层最容易出的错不是算错，
 *      而是把一个正常的随机波动展示成一个"发现"。
 */
(function () {
  "use strict";

  var DATA = window.__LAB_DATA__;
  if (!DATA || !DATA.numberTools) return;
  var TOOLS = DATA.numberTools;
  var LT = window.LotteryTools;
  if (!LT) return;

  function $(id) {
    return document.getElementById(id);
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  // ---------------------------------------------------------------- 数字体检
  function renderNumberHealth(kind) {
    var rows = kind === "red" ? TOOLS.health.red : TOOLS.health.blue;
    var container = $(kind === "red" ? "nh-grid-red" : "nh-grid-blue");
    if (!container) return;
    var html = rows
      .map(function (r) {
        var cls = r.covers_expected ? "" : " nh-drift";
        return (
          '<button type="button" class="nh-ball' +
          (kind === "blue" ? " nh-ball-blue" : "") +
          cls +
          '" data-kind="' +
          kind +
          '" data-number="' +
          r.number +
          '">' +
          r.number +
          "</button>"
        );
      })
      .join("");
    container.innerHTML = html;

    container.addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest(".nh-ball") : null;
      if (!btn) return;
      showNumberDetail(btn.dataset.kind, btn.dataset.number);
    });
  }

  function showNumberDetail(kind, number) {
    var rows = kind === "red" ? TOOLS.health.red : TOOLS.health.blue;
    var item = null;
    rows.forEach(function (r) {
      if (r.number === number) item = r;
    });
    if (!item) return;
    var out = $("nh-detail");
    if (!out) return;

    var mcb = TOOLS.multiple_comparison_baseline;
    var recentRows = item.recent
      .map(function (w) {
        return (
          "<tr><td>最近 " +
          w.window +
          " 期</td><td class=\"mono\">" +
          w.count +
          "</td><td class=\"mono\">" +
          w.expected +
          "</td><td>" +
          (w.covers_expected ? "落在正常波动内" : "在区间之外") +
          "</td></tr>"
        );
      })
      .join("");

    var verdictClass = item.covers_expected ? "verdict-normal" : "verdict-flag";
    var verdictText = item.covers_expected
      ? "该号码的出现次数与「每期等概率」一致，未表现出任何可利用的倾向。"
      : "该号码的出现次数落在 95% 区间之外。看起来像个「发现」，但请看下方第 3 条——" +
        "在完全随机的数据里，平均本来就会有 " +
        mcb.mean_outside_per_trial +
        " 个号码落在这条线外面。";

    out.innerHTML =
      '<h3 class="nh-detail-title">号码 ' +
      number +
      "（" +
      (kind === "red" ? "红球，每期出现概率 6/33 ≈ 18.18%" : "蓝球，每期出现概率 1/16 = 6.25%") +
      "）</h3>" +
      "<table><tbody>" +
      '<tr><td>出现次数</td><td class="mono">' +
      item.count +
      " 次 / 共 " +
      TOOLS.health.periods +
      " 期</td></tr>" +
      '<tr><td>理论期望次数</td><td class="mono">' +
      item.expected +
      " 次</td></tr>" +
      '<tr><td>95% 置信区间（Wilson）</td><td class="mono">[' +
      item.ci_95[0] +
      ", " +
      item.ci_95[1] +
      "] 次</td></tr>" +
      '<tr><td>理论期望是否落在区间内</td><td>' +
      (item.covers_expected ? "是" : "否") +
      "</td></tr>" +
      "</tbody></table>" +
      '<p class="' +
      verdictClass +
      '">' +
      verdictText +
      "</p>" +
      "<table><thead><tr><th>窗口</th><th>出现次数</th><th>理论期望</th><th>结论</th></tr></thead><tbody>" +
      recentRows +
      "</tbody></table>" +
      '<p class="dim">怎么看这个结果：唯一有意义的判断标准是「理论期望是否落在置信区间内」，' +
      "而不是「出现次数比别的号码多几个」。33 个号码一起做 95% 检验时，平均会有 " +
      mcb.mean_outside_per_trial +
      " 个号码落在区间外（蒙特卡洛 " +
      mcb.trials +
      " 次模拟）；本数据集实测就有 " +
      mcb.probability_at_least_2 +
      "% 的概率出现「至少 2 个号码偏离」——这正是多重比较的经典陷阱。</p>";
  }

  // ------------------------------------------------------------ 遗漏分布工具
  function renderOmission(kind) {
    var rows = kind === "red" ? TOOLS.omission.red : TOOLS.omission.blue;
    var container = $(kind === "red" ? "om-grid-red" : "om-grid-blue");
    if (!container) return;
    container.innerHTML = rows
      .map(function (r) {
        return (
          '<button type="button" class="nh-ball' +
          (kind === "blue" ? " nh-ball-blue" : "") +
          '" data-kind="' +
          kind +
          '" data-number="' +
          r.number +
          '">' +
          r.number +
          "</button>"
        );
      })
      .join("");

    container.addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest(".nh-ball") : null;
      if (!btn) return;
      showOmissionDetail(btn.dataset.kind, btn.dataset.number);
    });
  }

  function showOmissionDetail(kind, number) {
    var rows = kind === "red" ? TOOLS.omission.red : TOOLS.omission.blue;
    var item = null;
    rows.forEach(function (r) {
      if (r.number === number) item = r;
    });
    if (!item) return;
    var out = $("om-detail");
    if (!out) return;

    var p = kind === "red" ? "6/33" : "1/16";
    var longer = 0;
    rows.forEach(function (r) {
      if (r.current > item.current) longer++;
    });

    // 找出理论上"比当前遗漏更长"的那些长度里，实际数据中出现过的最长遗漏
    var maxHist = item.max_historical;

    out.innerHTML =
      '<h3 class="nh-detail-title">号码 ' +
      number +
      " 的遗漏情况</h3>" +
      "<table><tbody>" +
      '<tr><td>当前遗漏</td><td class="mono">' +
      item.current +
      " 期（即已经连续 " +
      item.current +
      " 期没有出现）</td></tr>" +
      '<tr><td>历史上最长遗漏过</td><td class="mono">' +
      maxHist +
      " 期</td></tr>" +
      '<tr><td>在 ' +
      rows.length +
      " 个" +
      (kind === "red" ? "红球" : "蓝球") +
      "中，当前遗漏比它更长的</td><td class=\"mono\">" +
      longer +
      " 个</td></tr>" +
      "</tbody></table>" +
      '<p class="verdict-normal">「遗漏 ' +
      item.current +
      " 期」听起来很久，但把它放进整份数据里看：在每期等概率（红球每期 " +
      p +
      "）的假设下，单个号码遗漏到 " +
      item.current +
      " 期及以上的概率是 <span class=\"mono\">" +
      item.probability_at_least_k +
      "</span>——听起来很小。可是这份数据里有 " +
      rows.length +
      " 个号码 × " +
      TOOLS.omission.periods +
      " 期 = " +
      rows.length * TOOLS.omission.periods +
      " 次「号码-期」的机会，按这个概率，这种长度的遗漏在整个数据集里<strong>本来就会出现约 " +
      item.expected_occurrences +
      " 次</strong>（平均每 " +
      item.one_in_number_periods +
      " 次机会出现一次）。</p>" +
      '<p class="verdict-flag">所以「它已经 ' +
      item.current +
      " 期没出了，该出了」这个念头错在哪里：你只看了概率很小，没有看机会有多少次。" +
      "每次开奖都是独立事件，它这一期的出现概率仍然是 " +
      p +
      "，和 252 期之前完全一样——不是「欠着」你的。</p>";
  }

  // ------------------------------------------------------------ 形态诊断器
  // 生成用于演示的号码：用确定性种子，保证同一期号每次得到同一组号码（可复现原则）。
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
    for (var i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    return h;
  }

  var demoCounter = 0;

  function generateDemoRed() {
    // 「再来一组」用的种子包含一个递增计数器，所以每点一次得到不同的一组；
    // 但同一组永远可复现（种子由期号 + 计数器决定，不依赖 Math.random）。
    demoCounter += 1;
    var nextPeriod = DATA.nextPeriod || DATA.history[DATA.history.length - 1].period;
    var rng = seededRandom(hashSeed("demo-set-" + nextPeriod + "-" + demoCounter));
    var pool = [];
    for (var i = 1; i <= 33; i++) pool.push(pad2(i));
    var picked = [];
    for (var k = 0; k < 6; k++) {
      var idx = Math.floor(rng() * pool.length);
      picked.push(pool[idx]);
      pool.splice(idx, 1);
    }
    return picked.sort(function (a, b) {
      return Number(a) - Number(b);
    });
  }

  function diagnose(redNumbers) {
    var table = TOOLS.pattern_table;
    var d = LT.diagnoseCombination(redNumbers, table);
    var out = $("dz-result");
    if (!out) return;

    function row(label, actual, combinations, share) {
      return (
        "<tr><td>" +
        label +
        '</td><td class="mono">' +
        actual +
        '</td><td class="mono">' +
        combinations.toLocaleString("en-US") +
        '</td><td class="mono">' +
        share.toFixed(3) +
        "%</td></tr>"
      );
    }

    out.innerHTML =
      '<h3 class="nh-detail-title">这组号码的形态诊断：红 ' +
      d.red.join(" ") +
      "</h3>" +
      "<table><thead><tr><th>检查项</th><th>这组号码</th><th>符合该形态的组合数</th><th>占全部组合</th></tr></thead><tbody>" +
      row("奇偶比", d.odd_even.actual, d.odd_even.combinations, d.odd_even.share_percent) +
      row("大小比（小1-16/大17-33）", d.big_small.actual, d.big_small.combinations, d.big_small.share_percent) +
      row("三区分布（1-11/12-22/23-33）", d.zones.actual, d.zones.combinations, d.zones.share_percent) +
      row("连号", d.consecutive.actual, d.consecutive.combinations, d.consecutive.share_percent) +
      row("和值（按每 10 分桶）", d.sum.actual + "（桶 " + d.sum.bucket + "）", d.sum.combinations, d.sum.share_percent) +
      "</tbody></table>" +
      '<p class="verdict-flag">请注意最后一列在说什么：它告诉你「有多少组号码和你这组长得一样」，' +
      "而不是「你这组号码中奖的机会有多大」。全部 " +
      d.total_combinations.toLocaleString("en-US") +
      " 组红球里，每一组被开出来的概率<strong>完全相同</strong>——" +
      "形态稀有只说明你这组号码长得比较特别，不说明它更容易或更不容易被开出来。</p>";
  }

  function initDiagnoser() {
    var input = $("dz-input");
    var btn = $("dz-btn");
    var gen = $("dz-gen");
    if (!input || !btn) return;

    btn.addEventListener("click", function () {
      var raw = input.value
        .split(/[^0-9]+/)
        .filter(function (x) {
          return x !== "";
        })
        .map(Number);
      var err = $("dz-error");
      if (raw.length !== 6) {
        if (err) err.textContent = "请输入正好 6 个号码（可用空格、逗号或顿号分隔）。";
        return;
      }
      if (raw.some(function (n) { return !(n >= 1 && n <= 33); })) {
        if (err) err.textContent = "红球号码必须在 1~33 之间。";
        return;
      }
      if (new Set(raw).size !== 6) {
        if (err) err.textContent = "6 个号码不能重复。";
        return;
      }
      if (err) err.textContent = "";
      diagnose(raw);
    });

    if (gen) {
      gen.addEventListener("click", function () {
        var picked = generateDemoRed();
        input.value = picked.join(" ");
        var err = $("dz-error");
        if (err) err.textContent = "";
        diagnose(picked);
      });
    }
  }

  function init() {
    renderNumberHealth("red");
    renderNumberHealth("blue");
    renderOmission("red");
    renderOmission("blue");
    initDiagnoser();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
