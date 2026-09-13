// ============================================================================
// 模板战报（方案第八节：AI 只解释已经算好的确定性结果，不参与号码生成）
// ----------------------------------------------------------------------------
// 第一版刻意**不接任何 LLM**，用模板文案生成。理由与方案一致：
//   · 引擎和数据管道先跑稳，再接模型，降低不确定性和成本；
//   · 模板文案的每一句话都可以追溯到具体数字，不存在"模型编了一句话"的可能。
// 将来接 LLM 时，输入就是这里产出的结构化 facts，且仍然禁止它决定号码。
//
// 【最重要的一条设计约束】方案 17.3 第 4 层第 5 条写死了：
//   「'上期我们预测中了 3 个红球'是本项目最危险的一句话，即使它 100% 属实。
//     因为随机对照组几乎每期也能中 2~3 个，抽掉对照组单独展示等于制造了一个假因果。」
// 所以这份战报的硬性规则是：
//   1. 标题必须是「上期各组表现（含随机对照组）」，绝不能叫"命中回顾/战果/预测战绩"；
//   2. **四组必须同时出现**，随机对照组不许被省略或放到末尾小字里；
//   3. 结论句必须解释"为什么这个数字证明不了任何事"，并且这段解释由规则生成，
//      不是手写的免责声明（手写的会被删，规则生成的不行）；
//   4. 不出现"翻车""暴击""应验""命中率提升"这类词——把随机波动描述成事件，
//      就是在制造成瘾机制。
// ============================================================================

const RED_PICK = 6;

// 历史重放需要用到与 build.js 完全相同的四个策略实现与参数，
// 否则"重放出来的号码"和"当期真正会发布的号码"就不是同一组了。
const { hotStrategy, coldStrategy, weightedStrategy, randomStrategy } = require("./strategies");
const HOT_WINDOW = 50; // 必须与 src/build.js 的 HOT_WINDOW 保持一致

/**
 * 用"最近一期真实开奖"对照四个观测组各自的号码，生成一期战报。
 *
 * 【时间顺序：这是本文件最容易犯、也最致命的错误】
 * 第一版实现直接拿了 `report.next_period_observation`——那是用**截至第 t 期**的全部数据
 * 为**第 t+1 期**生成的号码——去对照**第 t 期**的开奖结果。
 * 那等于"用已经看过答案的号码去预测答案"，而且会宣称一组从未发布过的号码是"上期给出的"。
 * （更讽刺的是：本文件抬头写的第一条禁令，就是这个。）
 *
 * 正确做法是**历史重放**，与 Walk-Forward 回测同一个口径：
 *   要对第 t 期做对照，就用 `history.slice(0, t)`（即截至第 t-1 期）重新构造
 *   "当时会发布的四组号码"，再与 history[t] 的真实开奖对照。
 * 这样每一组号码都只用到了它当时能看到的信息，命中数才是真的。
 */
function replayObservationsForPeriod(history, t, retrainCache) {
  const trainData = history.slice(0, t);
  const targetPeriod = history[t].period;
  return [
    { key: "hot", name: "热号规则", numbers: hotStrategy(trainData, targetPeriod, HOT_WINDOW) },
    { key: "cold", name: "遗漏规则", numbers: coldStrategy(trainData, targetPeriod) },
    {
      key: "balanced",
      name: "均衡倾向规则",
      numbers: weightedStrategy(trainData, targetPeriod, { hot: 40, cold: 40, random: 20 }, "recap-balanced"),
    },
    { key: "random", name: "纯随机对照组", numbers: randomStrategy(trainData, targetPeriod, "recap-random") },
  ];
}

/**
 * 生成一期战报：四组号码（历史重放得到）vs 最近一期真实开奖。
 * 四组的"长期均命中"与"证据等级"来自排行榜（那是全量 Walk-Forward 的结果，与本期无关）。
 */
function buildTemplateRecap(history, leaderboard, opts = {}) {
  if (!history || history.length < 2 || !leaderboard) return null;

  // 要做对照的那一期：默认最近一期（即"上一期发布的号码"刚刚被验证）
  const t = opts.targetIndex === undefined ? history.length - 1 : opts.targetIndex;
  if (t < 1 || t >= history.length) return null;

  const actual = history[t];
  const drawn = actual.red;

  // 历史重放：只用 history[0..t-1] 构造"当时会发布的"四组号码
  const replayed = replayObservationsForPeriod(history, t, opts.retrainCache);

  const rows = replayed.map((g) => {
    const hits = g.numbers.red.filter((b) => drawn.includes(b)).length;
    const lb = leaderboard.find((r) => r.strategy_key === g.key);
    return {
      key: g.key,
      name: g.name,
      red: g.numbers.red,
      blue: g.numbers.blue,
      hits,
      blueHit: g.numbers.blue === actual.blue,
      meanHit: lb ? lb.mean_hit : 0,
      evidence: lb ? lb.evidence.label : "—",
      evidenceLevel: lb ? lb.evidence.level : "none",
      isControl: g.key === "random",
    };
  });

  const best = rows.reduce((a, b) => (b.hits > a.hits ? b : a), rows[0]);
  const control = rows.find((r) => r.isControl);
  const spread = Math.max(...rows.map((r) => r.hits)) - Math.min(...rows.map((r) => r.hits));
  const anyPrizeLevel = rows.map((r) => (r.hits >= 4 ? "四等奖及以上可能" : r.blueHit ? "六等奖可能" : "未中奖"));

  // 单期命中数的理论分布（超几何），用来给"这期命中 3 个算多吗"提供参照。
  // 这是本战报最关键的防误读装置：不给出这个分布，读者会把"某组命中 3 个、别的组 0 个"
  // 直接读成"那组更准"——而实际上单期命中 3 个本来就有约 5.3% 的概率发生。
  const dist = (() => {
    const comb = (n, k) => {
      if (k < 0 || k > n) return 0;
      let r = 1;
      for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
      return Math.round(r);
    };
    const T = comb(33, RED_PICK);
    const out = [];
    for (let k = 0; k <= RED_PICK; k++) out.push((comb(RED_PICK, k) * comb(33 - RED_PICK, RED_PICK - k)) / T);
    return out;
  })();
  const probAtLeastBest = dist.slice(best.hits).reduce((a, b) => a + b, 0);
  const modalHits = dist.indexOf(Math.max(...dist));

  // 结论句：由规则生成，不是手写免责声明。
  // 逻辑：先给出"最好的一组"这个诱人的事实，立刻用"这期命中这么多有多常见"把它关掉。
  let verdict;
  if (best.isControl) {
    verdict =
      `本期表现最好的恰好是<b>纯随机对照组</b>（命中 ${best.hits} 个红球）。` +
      `这正好说明问题：如果"随机"都能排第一，那前三组的"规律"自然也就不成立。`;
  } else if (spread === 0) {
    verdict =
      `本期四组命中的红球数完全相同（都是 ${rows[0].hits} 个）——` +
      `规则组和随机对照组没有任何区别，这正是理论预期的结果。`;
  } else {
    verdict =
      `本期表现最好是 <b>${best.name}</b>（命中 ${best.hits} 个红球），比纯随机对照组` +
      `${best.hits > control.hits ? "多" : "少"} ${Math.abs(best.hits - control.hits)} 个。` +
      `看着像个发现，但请对照下面这句话再判断一次：<b>任意一组号码在一期里命中 ${best.hits} 个红球的概率是 ` +
      `${(probAtLeastBest * 100).toFixed(1)}%</b>（至少这么多），也就是平均每 ${Math.round(1 / probAtLeastBest)} 期就会出现一次——` +
      `而本站每期有四组号码在比，所以"某一期某一组命中得多"这件事，几乎必然会经常发生。`;
  }

  const paragraphs = [
    `第 ${actual.period} 期（${actual.date}）开奖号码：红 ${drawn.join(" ")}，蓝 ${String(actual.blue).padStart(2, "0")}。` +
      `下面把上一期给出的四组观测号码原样拿来对照——<b>包括那组纯随机号码</b>，它必须和其他三组一起看。`,
    rows
      .map(
        (r) =>
          `${r.isControl ? "<b>纯随机对照组</b>" : r.name}（红 ${r.red.join(" ")} 蓝 ${r.blue}）：` +
          `命中 ${r.hits} 个红球${r.blueHit ? "，蓝球也命中" : ""}` +
          `；该组长期均命中 ${r.meanHit.toFixed(4)}、证据等级「${r.evidence}」`
      )
      .join("<br>"),
    verdict,
    `顺手给一个参照：一组号码单期命中 0 个红球的概率约 ${(dist[0] * 100).toFixed(1)}%、命中 ${modalHits} 个约 ` +
      `${(dist[modalHits] * 100).toFixed(1)}%、命中 4 个及以上合计只有约 ${((dist[4] + dist[5] + dist[6]) * 100).toFixed(2)}%。` +
      `所以"某期某组命中 0 个"或"命中 3 个"都不是新闻，是常态。`,
    `为什么这不能说明"哪组更准"：四组号码的历史均命中差异极小（长期看四组几乎完全重合），` +
      `而本期这 ${spread === 0 ? "0" : spread} 个红球的差距，只是把"常态"抽了一期出来看而已。` +
      `要判断某组是否真的更强，需要的是<b>上百期的平均成绩 + 显著性检验</b>，不是任何一期的命中数。` +
      `本站不做"上期预测中了几个"这类战绩展示，正是因为那种叙事会让人把随机波动读成能力。`,
  ];

  return {
    period: actual.period,
    date: actual.date,
    // 记录"这组号码是基于哪一期之前的数据重放出来的"，供外部断言时间顺序：
    // 必须满足 based_on_through_period < period（用过去的数据预测当期），否则就是数据泄漏。
    based_on_through_period: history[t - 1].period,
    drawn_red: drawn,
    drawn_blue: actual.blue,
    rows,
    spread,
    best_key: best.key,
    best_is_control: best.isControl,
    any_prize_level_note: anyPrizeLevel,
    paragraphs,
    title: `上期各组表现（含随机对照组）：第 ${actual.period} 期`,
    generated_by: "template-v1（未接入任何 LLM，所有句子均由既有数字按规则生成）",
    guard_note:
      "本战报受方案 17.3 第 4 层第 5 条约束：禁止事后正确性叙事；四组必须同屏；" +
      "随机对照组不得省略；结论必须解释「为什么这个数字证明不了任何事」。",
  };
}

module.exports = { buildTemplateRecap };
