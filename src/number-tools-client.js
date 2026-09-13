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

  // ------------------------------------------------- 统一号码工具（形态诊断 + 历史对照）
  // 设计上的一个合并：原本"形态诊断"和"对照台"各有一个输入框，
  // 审计脚本当场指出"整页两个文本输入框"超过它设定的上限——它是对的，
  // 而且这个报错暴露了更好的设计：**用户不应该把自己的号码输入两遍**。
  // 现在整页只有这一个输入框，一次校验，同时给出两份结果：
  //   【形态诊断】这组号码的奇偶/大小/三区/连号/和值 + 有多少组号码和它长得一样
  //   【历史对照】把它放到全部历史期上逐期对照的命中分布与奖级分布
  // 附带好处："整页最多一个文本输入框、且无表单"这条硬约束得以继续保持。

  function validatePicks(raw) {
    if (raw.length < 6 || raw.length > 10) {
      return "请输入 6~10 个红球号码（6 个为单式；7~10 个按复式处理）。";
    }
    if (raw.some(function (n) { return !(n >= 1 && n <= 33); })) {
      return "红球号码必须在 1~33 之间。";
    }
    if (new Set(raw).size !== raw.length) {
      return "红球号码不能重复。";
    }
    return "";
  }

  function runBoth(rawNumbers, blue) {
    var asStrings = rawNumbers.map(pad2);
    diagnose(asStrings);
    compareWithHistory(asStrings, blue);
  }

  function initNumberTool() {
    var input = $("dz-input");
    var blueSel = $("cmp-blue");
    var btn = $("dz-btn");
    var gen = $("dz-gen");
    var fillBtn = $("cmp-fill-latest");
    if (!input || !btn) return;

    function currentBlue() {
      return blueSel ? pad2(Number(blueSel.value)) : "01";
    }

    function parseRed() {
      return input.value
        .split(/[^0-9]+/)
        .filter(function (x) {
          return x !== "";
        })
        .map(Number)
        .sort(function (a, b) {
          return a - b;
        });
    }

    btn.addEventListener("click", function () {
      var raw = parseRed();
      var err = $("dz-error");
      var msg = validatePicks(raw);
      if (msg) {
        if (err) err.textContent = msg;
        return;
      }
      if (err) err.textContent = "";
      runBoth(raw, currentBlue());
    });

    if (gen) {
      gen.addEventListener("click", function () {
        var picked = generateDemoRed();
        input.value = picked.join(" ");
        var err = $("dz-error");
        if (err) err.textContent = "";
        runBoth(picked.map(Number), currentBlue());
      });
    }

    if (fillBtn) {
      fillBtn.addEventListener("click", function () {
        // 用最近一期真实开奖号码填进去，方便直接看到"一组真实开出过的号码，放回历史里表现如何"。
        // 这是给对照用的样本，不是"下期号码"——按钮文案与结果里都写明了这一点。
        var latest = DATA.history[DATA.history.length - 1];
        input.value = latest.red.join(" ");
        if (blueSel) blueSel.value = String(Number(latest.blue));
        var err = $("dz-error");
        if (err) err.textContent = "";
        runBoth(latest.red.slice().sort(), latest.blue);
      });
    }
  }

  // ------------------------------------------------------------ 对照台
  // 把用户自己输入的号码，放到完整历史时间线上跑一遍：这个"玩法"是用户主动要求的，
  // 而且它把"网站上的统计"变成了"我自己的号码会怎样"，是本站少有的强交互点。
  //
  // 三条语言红线（不是洁癖，是这类产品的成瘾机制所在）：
  //   1. 绝不叫"命中回顾""战果""成绩单"，一律叫「对照」；
  //   2. 任何"某期中了几个"的数字旁边，必须同时能看到随机对照组与总期数；
  //   3. 不给"下期你该调整成什么"之类的建议——那等于变成了选号器。
  //
  // 另外刻意做的一件事：**不显示"累计盈亏"这个单一数字**。
  // 那个数字会被读成"我这个号码怎么样"，而它实际上只由几注末等奖决定。
  // 改为给完整奖级分布，让读者看到"绝大多数期数是一分钱不中"。

  // 与 src/backtest.js 的 calculatePrize 保持一致（浏览器端无法 require，
  // 所以这里是手写的等价实现，改动时两边必须同步——tests 里有一条断言守着）。
  function calculatePrize(redHits, blueHit) {
    if (redHits === 6 && blueHit) return { level: 1, bonusType: "floating" };
    if (redHits === 6) return { level: 2, bonusType: "floating" };
    if (redHits === 5 && blueHit) return { level: 3, bonusType: "fixed", bonus: 3000 };
    if (redHits === 5 || (redHits === 4 && blueHit)) return { level: 4, bonusType: "fixed", bonus: 200 };
    if (redHits === 4 || (redHits === 3 && blueHit)) return { level: 5, bonusType: "fixed", bonus: 10 };
    if (blueHit) return { level: 6, bonusType: "fixed", bonus: 5 };
    return { level: 0, bonusType: "fixed", bonus: 0 };
  }

  /**
   * 把一组号码在整个历史上逐期对照。
   * redPicks 允许 6~10 个（复式），蓝球固定 1 个——蓝球复式会让注数与成本迅速膨胀，
   * 而这一块的目的不是鼓励多买，所以刻意只支持红球复式。
   */
  function runComparison(redPicks, blue) {
    var history = DATA.history;
    var redCount = redPicks.length;
    var betsPerPeriod = LT.comb(redCount, 6);

    var distribution = [0, 0, 0, 0, 0, 0, 0];
    var levelCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
    var hitSum = 0;
    var blueHits = 0;
    var anyPrizePeriods = 0;

    history.forEach(function (d) {
      // 该期实际开出的红球里，我们选中的有几个
      var hits = d.red.filter(function (b) {
        return redPicks.indexOf(b) >= 0;
      }).length;
      var blueHit = d.blue === blue;
      // 复式注数中"最好的一注"的命中：等于选中红球里被开出的个数（上限 6）
      var bestRedHits = Math.min(6, hits);
      distribution[bestRedHits] += 1;
      hitSum += bestRedHits;
      if (blueHit) blueHits += 1;
      var prize = calculatePrize(bestRedHits, blueHit);
      if (prize.level > 0) {
        levelCounts[prize.level] += 1;
        anyPrizePeriods += 1;
      }
    });

    return {
      periods: history.length,
      redPicks: redPicks,
      blue: blue,
      betsPerPeriod: betsPerPeriod,
      costPerPeriod: betsPerPeriod * 2,
      meanHit: hitSum / history.length,
      blueHitRate: blueHits / history.length,
      blueHits: blueHits,
      distribution: distribution,
      levelCounts: levelCounts,
      anyPrizePeriods: anyPrizePeriods,
    };
  }

  function fmtPct(v) {
    return (v * 100).toFixed(2) + "%";
  }

  function compareWithHistory(userRed, userBlue, kind) {
    var out = $("cmp-result");
    if (!out) return;

    var cmp = runComparison(userRed, userBlue);
    var health = kind === "red" ? TOOLS.health.red : null;

    // 每一期的命中分布（0~6 个红球分别出现多少期）——刻意不用累计盈亏代替它
    var maxCount = Math.max.apply(null, cmp.distribution);
    var distRows = cmp.distribution
      .map(function (count, hits) {
        var barW = maxCount === 0 ? 0 : Math.round((count / maxCount) * 100);
        var pctOfAll = ((count / cmp.periods) * 100).toFixed(1);
        return (
          "<tr><td>命中 " +
          hits +
          " 红</td><td class=\"mono\">" +
          count +
          " 期</td><td class=\"mono\">" +
          pctOfAll +
          '%</td><td><span class="cmp-bar" style="width:' +
          barW +
          '%"></span></td></tr>'
        );
      })
      .join("");

    var levelNames = { 1: "一等奖", 2: "二等奖", 3: "三等奖", 4: "四等奖", 5: "五等奖", 6: "六等奖" };
    var levelRows = [1, 2, 3, 4, 5, 6]
      .map(function (lv) {
        return (
          "<tr><td>" +
          levelNames[lv] +
          '</td><td class="mono">' +
          cmp.levelCounts[lv] +
          " 期</td></tr>"
        );
      })
      .join("");

    var pickNote =
      cmp.redPicks.length > 6
        ? "<p class=\"dim\">你输入了 " +
          cmp.redPicks.length +
          " 个红球，这构成<b>复式</b>：每期相当于 " +
          cmp.betsPerPeriod +
          " 注（成本 " +
          cmp.costPerPeriod +
          " 元）。下表按「其中最好的一注」统计。</p>"
        : "<p class=\"dim\">单式一注，每期成本 2 元。下表按这一注统计。</p>";

    out.innerHTML =
      "<h3 class=\"nh-detail-title\">对照结果：你的号码 vs 全部 " +
      cmp.periods +
      " 期历史开奖</h3>" +
      '<p class="mono" style="margin:0 0 8px;">红 ' +
      cmp.redPicks.join(" ") +
      " ＋ 蓝 " +
      cmp.blue +
      "</p>" +
      pickNote +
      "<table><tbody>" +
      '<tr><td>平均每期命中红球</td><td class="mono">' +
      cmp.meanHit.toFixed(4) +
      "</td></tr>" +
      '<tr><td>理论期望（33选6）</td><td class="mono">1.0909</td></tr>' +
      '<tr><td>蓝球命中率</td><td class="mono">' +
      fmtPct(cmp.blueHitRate) +
      "（" +
      cmp.blueHits +
      " / " +
      cmp.periods +
      " 期，理论值 6.25%）</td></tr>" +
      '<tr><td>中过奖的期数（任意奖级）</td><td class="mono">' +
      cmp.anyPrizePeriods +
      " / " +
      cmp.periods +
      " 期（" +
      fmtPct(cmp.anyPrizePeriods / cmp.periods) +
      "）</td></tr>" +
      "</tbody></table>" +
      "<h4 style=\"font-size:0.9rem;margin:12px 0 4px;\">逐期红球命中分布</h4>" +
      "<table><thead><tr><th>命中个数</th><th>出现期数</th><th>占比</th><th>分布</th></tr></thead><tbody>" +
      distRows +
      "</tbody></table>" +
      "<h4 style=\"font-size:0.9rem;margin:12px 0 4px;\">各奖级中出期数</h4>" +
      "<table><tbody>" +
      levelRows +
      "</tbody></table>" +
      '<p class="verdict-flag">把上面这些数字读对，只需要记住一件事：<b>它们衡量的是「你的号码和已开出的号码有多少重合」，不是「你的号码有多好」。</b>' +
      "全部 " +
      LT.comb(33, 6).toLocaleString("en-US") +
      " 组红球里每一组被开出来的概率完全相同。你在上面看到的 " +
      cmp.meanHit.toFixed(4) +
      " 是<b>你这组号码自己的实际值</b>——它等于你选的这几个号在历史上被开出过的次数之和 ÷ 期数。" +
      "把它和 1.0909 比较时要知道：1.0909 是<b>对全部组合取平均</b>的期望值，" +
      "而任何一组具体号码都会因为「它自己这几个号出现得多还是少」而偏离这个数，" +
      "偏离幅度通常在 ±0.3 之内。所以你的值高于 1.0909 <b>并不说明这组号码更好</b>，" +
      "只说明这段历史里恰好这些号出得多一点——换一组号、或者换一段时间，高低就会反转。" +
      "</p>" +
      '<p class="dim">本站刻意<b>不</b>给「累计盈亏」这样单独一个数字：那个数字会被读成「我这个号码行不行」，' +
      "而它其实只由几注固定奖级的末等奖决定，波动极大。所以这里给的是完整的命中分布与奖级分布，" +
      "让「绝大多数期数一分钱不中」这件事直接看得见。</p>";
  }

  function init() {
    renderNumberHealth("red");
    renderNumberHealth("blue");
    renderOmission("red");
    renderOmission("blue");
    initNumberTool();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();