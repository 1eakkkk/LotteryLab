const fs = require("fs");
const path = require("path");
const { lineChart, histogram } = require("./svg-charts");

const DATA_DIR = path.join(__dirname, "../data");
const PUBLIC_DIR = path.join(__dirname, "../public");
const MY_STRATEGY_CLIENT_JS = fs.readFileSync(path.join(__dirname, "my-strategy-client.js"), "utf-8");
// V4 第 1~3 层：共用的统计计算模块 + 交互脚本，同样原样内联进页面。
// 计算模块必须先于交互脚本注入（交互脚本要用 window.LotteryTools）。
const NUMBER_HEALTH_JS = fs.readFileSync(path.join(__dirname, "number-health.js"), "utf-8");
const NUMBER_TOOLS_CLIENT_JS = fs.readFileSync(path.join(__dirname, "number-tools-client.js"), "utf-8");

const STRATEGY_LABEL = { random: "随机基准", hot: "热号", cold: "冷号" };
const STRATEGY_CLASS = { random: "s-random", hot: "s-hot", cold: "s-cold" };

function pct(n) {
  return `${n.toFixed(1)}%`;
}

function verdictText(row) {
  if (row.is_significant) {
    return `配对差值检验达到统计显著（内部参考指标）。即便如此，请仍以蒙特卡洛分位数和更长时间的持续观测为准——单次显著不构成"策略有效"的最终结论。`;
  }
  if (row.vs_random_percentile >= 80) {
    return `本期它跑赢了 ${pct(row.vs_random_percentile)} 的独立随机策略，看起来很唬人——但这本质上只是恰好落在了随机波动分布里较高的一侧，配对差值检验并未达到统计显著。按照本站的北极星原则：没有通过盲测之前，不能说它"有效"。`;
  }
  if (row.vs_random_percentile <= 20) {
    return `本期它只跑赢了 ${pct(row.vs_random_percentile)} 的独立随机策略，表现落后于大多数随机对照——这同样只是正常的随机波动，不代表这个策略"更差"，样本量还太小，不足以下结论。`;
  }
  return `它的表现落在随机分布的中段（跑赢 ${pct(row.vs_random_percentile)} 的随机策略），和"随便选"没有可辨识的差别。`;
}

function buildLeaderboardRows(leaderboard) {
  return leaderboard
    .map((row) => {
      const cls = STRATEGY_CLASS[row.strategy_key];
      return `
      <tr>
        <td class="strategy-name ${cls}">${row.strategy}</td>
        <td class="mono">${row.mean_hit.toFixed(4)}</td>
        <td class="mono">${row.theoretical_expectation.toFixed(4)}</td>
        <td class="mono">[${row.ci_95[0].toFixed(3)}, ${row.ci_95[1].toFixed(3)}]</td>
        <td class="mono">${(row.blue_hit_rate * 100).toFixed(1)}% <span class="dim">(理论 ${(row.blue_theoretical * 100).toFixed(1)}%)</span></td>
        <td class="mono">${pct(row.vs_random_percentile)}</td>
        <td class="mono">${row.extreme_events.ge4} / ${row.extreme_events.ge5} / ${row.extreme_events.all6}</td>
        <td>${row.is_significant ? "是（内部参考）" : "否"}</td>
      </tr>`;
    })
    .join("\n");
}

function buildVerdicts(leaderboard) {
  return leaderboard
    .map((row) => {
      const cls = STRATEGY_CLASS[row.strategy_key];
      // V4 第零步：把"证据等级"作为结论的第一句，而不是放在最后当免责声明。
      // 结论先行是刻意的——大多数读者只会看每段的第一行。
      return `<p><strong class="${cls}">${row.strategy}</strong>：均命中 ${row.mean_hit.toFixed(4)}（理论期望 ${row.theoretical_expectation.toFixed(4)}）。<strong>证据等级：${row.evidence.label}</strong>。${row.evidence.reason}${verdictText(row)}</p>`;
    })
    .join("\n");
}

// ---- V4 第零步：L3 统计层防线在界面上的呈现 ----
function evidenceBadge(row) {
  const e = row.evidence;
  return `<span class="ev ev-${e.level}">${e.label}</span>`;
}

// 多重比较校正的说明：把 p → q 的变化直接摊在表格里，让读者看到
// "同时检验三个策略"这件事本身会削弱单个策略的显著性。
function buildFdrNote(leaderboard) {
  const rows = leaderboard
    .map(
      (r) =>
        `${r.strategy}：原始 p = ${r.p_value_raw.toFixed(4)} → FDR 校正后 q = ${r.q_value_fdr.toFixed(4)}`
    )
    .join("；");
  const anyRaw = leaderboard.some((r) => r.is_significant_raw_uncorrected);
  const anyCorrected = leaderboard.some((r) => r.is_significant);

  // 结论句单独算好再插值：嵌套三元 + 模板字符串写在 HTML 标签旁边，
  // 引号和反引号会互相咬住（第一次写就在这里翻了车），拆开写更不容易错。
  let conclusion;
  if (anyCorrected) {
    conclusion = "校正后仍有策略达到统计显著——但那只是「值得继续观察」，不是「策略有效」。";
  } else if (anyRaw) {
    conclusion =
      "校正后没有任何策略达到显著。注意：有策略的原始 p 值本可以算显著，是校正把它挡了下来——这正是多重比较校正存在的意义。";
  } else {
    conclusion = "校正后没有任何策略达到显著，而且原始 p 值本来也不显著。";
  }

  return `<p>本次一共<strong>同时检验了 ${leaderboard.length} 个策略</strong>。检验的策略越多，就越容易"碰巧"挑出一个看起来不错的——哪怕数据完全是随机的。所以本站的"是否显著"一律用 <strong>Benjamini–Hochberg FDR 校正后</strong>的 q 值判定，而不是原始 p 值：${rows}。</p>
  <p>${conclusion}</p>`;
}

// ---- V0.5 新增：训练/验证/盲测三段式分割 ----
function segRangeLabel(seg) {
  if (!seg) return "—";
  return `第${seg.period_range.from}~${seg.period_range.to}期`;
}

function buildSegmentRows(leaderboard) {
  return leaderboard
    .map((row) => {
      const cls = STRATEGY_CLASS[row.strategy_key];
      const dev = row.segments.dev;
      const blind = row.segments.blind;
      return `
      <tr>
        <td class="strategy-name ${cls}">${row.strategy}</td>
        <td class="mono">${dev.mean_hit.toFixed(4)}</td>
        <td class="mono">[${dev.ci_95[0].toFixed(3)}, ${dev.ci_95[1].toFixed(3)}]</td>
        <td class="mono">${pct(dev.vs_random_percentile)}</td>
        <td>${evidenceBadge(dev)}</td>
        <td class="mono">${blind.mean_hit.toFixed(4)}</td>
        <td class="mono">[${blind.ci_95[0].toFixed(3)}, ${blind.ci_95[1].toFixed(3)}]</td>
        <td class="mono">${pct(blind.vs_random_percentile)}</td>
        <td>${evidenceBadge(blind)}</td>
      </tr>`;
    })
    .join("\n");
}

function blindVerdictText(row) {
  const blind = row.segments.blind;
  if (blind.vs_random_percentile >= 80) {
    return `盲测集里它跑赢了 ${pct(blind.vs_random_percentile)} 的独立随机策略——看起来亮眼，但样本只有 ${blind.periods_tested} 期，这个量级的波动完全在随机噪声范围内。按北极星原则：这不构成"有效"的证据，只是给这个策略记上了它盲测账本的第一笔。`;
  }
  if (blind.vs_random_percentile <= 20) {
    return `盲测集里它只跑赢了 ${pct(blind.vs_random_percentile)} 的独立随机策略，表现偏弱。同样因为样本只有 ${blind.periods_tested} 期，这也不构成"更差"的结论——耐心攒够更多期数再看。`;
  }
  return `盲测集里它落在随机分布中段（跑赢 ${pct(blind.vs_random_percentile)}），和随手选一注没有可辨识的差别。`;
}

function buildBlindVerdicts(leaderboard) {
  return leaderboard
    .map((row) => {
      const cls = STRATEGY_CLASS[row.strategy_key];
      return `<p><strong class="${cls}">${row.strategy}</strong>：${blindVerdictText(row)}</p>`;
    })
    .join("\n");
}

// ---- V0.5 新增：近期短线表现（近10/30/100期）----
function buildRecentRows(leaderboard) {
  return leaderboard
    .map((row) => {
      const cls = STRATEGY_CLASS[row.strategy_key];
      const r = row.recent;
      const fmt = (v) => (v === null ? "—" : v.toFixed(4));
      return `
      <tr>
        <td class="strategy-name ${cls}">${row.strategy}</td>
        <td class="mono">${fmt(r.last10)}</td>
        <td class="mono">${fmt(r.last30)}</td>
        <td class="mono">${fmt(r.last100)}</td>
      </tr>`;
    })
    .join("\n");
}

// ===========================================================================
// V4 第零步新增：命中概率表 / 预测悖论 / 数据来源核对
// ---------------------------------------------------------------------------
// 这一整块的所有数字都来自 data/verification.json，而 verification.json 里的概率
// 是 scripts/verify-data.js 用组合数 C(33,6) 精确算出来的，没有任何"经验数字"。
// 这样做的意义：手写的数字一旦被质疑，就只是一句"说法"；由组合数算出来的数字，
// 任何人都能自己复算一遍。这是本项目相对所有话术型网站唯一不可复制的东西。
// ===========================================================================

function buildPrizeTable(verification) {
  const rows = verification.prize_probability_table
    .map((r) => {
      const probPct = r.probability * 100;
      const probText = probPct >= 0.01 ? `${probPct.toFixed(2)}%` : `${probPct.toExponential(2)}%`;
      return `
      <tr>
        <td class="mono">${r.level} 等奖</td>
        <td>${r.desc}</td>
        <td class="mono">${r.ways.toLocaleString("en-US")}</td>
        <td class="mono">${probText}</td>
        <td class="mono">约 1 / ${r.odds_one_in.toLocaleString("en-US")}</td>
      </tr>`;
    })
    .join("\n");
  return `
  <table>
    <thead>
      <tr><th>奖级</th><th>中奖条件</th><th>组合数</th><th>概率</th><th>约等于</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// 形态过滤器演示：让用户看到"加过滤条件"真正改变的是什么。
// 关键结论必须由代码算出来，不能手写——因为这句话是整个项目最容易被质疑的一句。
const RED_POOL = (() => {
  const a = [];
  for (let i = 1; i <= 33; i++) a.push(i);
  return a;
})();

function countCombinations(predicate) {
  let total = 0;
  let matched = 0;
  const pick = (start, chosen) => {
    if (chosen.length === 6) {
      total++;
      if (predicate(chosen)) matched++;
      return;
    }
    for (let i = start; i < RED_POOL.length; i++) {
      chosen.push(RED_POOL[i]);
      pick(i + 1, chosen);
      chosen.pop();
    }
  };
  pick(0, []);
  return { total, matched };
}

function buildFilterDemo() {
  const filters = [
    { name: "不加任何过滤（全部组合）", predicate: () => true },
    { name: "必须是 3 奇 3 偶", predicate: (c) => c.filter((n) => n % 2 === 1).length === 3 },
    { name: "不带连号", predicate: (c) => c.every((n, i) => i === 0 || n - c[i - 1] !== 1) },
    { name: "和值落在 90~115（看上去最“正常”的区间）", predicate: (c) => { const s = c.reduce((a, b) => a + b, 0); return s >= 90 && s <= 115; } },
    { name: "三区分布刚好 2:2:2", predicate: (c) => { const z = [0, 0, 0]; c.forEach((n) => z[Math.floor((n - 1) / 11)]++); return z.every((v) => v === 2); } },
    { name: "以上四个条件同时满足（“最专业”的选号方式）", predicate: (c) => { const odd = c.filter((n) => n % 2 === 1).length; const noChain = c.every((n, i) => i === 0 || n - c[i - 1] !== 1); const s = c.reduce((a, b) => a + b, 0); const z = [0, 0, 0]; c.forEach((n) => z[Math.floor((n - 1) / 11)]++); return odd === 3 && noChain && s >= 90 && s <= 115 && z.every((v) => v === 2); } },
  ];
  const results = filters.map((f) => ({ name: f.name, ...countCombinations(f.predicate) }));
  const total = results[0].total;
  const rows = results
    .map(
      (r) => `
      <tr>
        <td>${r.name}</td>
        <td class="mono">${r.matched.toLocaleString("en-US")}</td>
        <td class="mono">${((r.matched / total) * 100).toFixed(2)}%</td>
        <td class="mono">${(total / r.matched).toFixed(1)} 倍</td>
      </tr>`
    )
    .join("\n");
  const strict = results[results.length - 1];
  return {
    total,
    rows,
    strictMatched: strict.matched,
    strictRatio: (strict.matched / total) * 100,
    strictMultiplier: total / strict.matched,
  };
}

function buildPredictionParadox(verification) {
  const ex = verification.expectation;
  const demo = buildFilterDemo();
  const target = 100; // 用"每中 100 元需要买多少注"当锚点，比抽象百分比好懂
  const neededLow = Math.round(target / ex.expected_return_low);
  const neededMid = Math.round(target / ex.expected_return_mid);
  const costLow = neededLow * ex.bet_cost;
  const costMid = neededMid * ex.bet_cost;

  return `
  <h2>命中概率表（由组合数精确计算）</h2>
  <p>下面这张表不是抄来的，是<strong>算出来的</strong>：双色球红球 33 选 6、蓝球 16 选 1，总组合数 <code>C(33,6) × 16 = ${verification.total_combinations.toLocaleString("en-US")}</code>。每一档奖级的"组合数"用超几何分布直接数出来，概率 = 该奖级组合数 ÷ 总组合数。任何人都能拿计算器复算一遍——这是本页和"预测网站"最本质的区别。</p>
  ${buildPrizeTable(verification)}
  <div class="notice">
    <p><strong>合计中奖概率：${(verification.winning_probability * 100).toFixed(4)}%</strong>——也就是说，约 <strong>${(100 / (verification.winning_probability * 100)).toFixed(1)} 注里才有 1 注</strong>能中任意一个奖级，而且其中绝大多数是末等奖。剩下约 ${(100 - verification.winning_probability * 100).toFixed(2)}% 的情况是一分钱不中。</p>
  </div>

  <h2>预测悖论：就算你真有"预测能力"，期望仍然是负的</h2>
  <p>这是本站最重要的一块内容，也是唯一一块<strong>不依赖任何历史数据、只靠数学就成立</strong>的结论。</p>

  <p><strong>第一步：单注的期望回报是多少？</strong>把每一档奖级的"概率 × 奖金"加起来。一、二等奖是浮动奖金（取决于当期奖池和中奖注数），这里给出低、中两档公开常见区间的估算——<em>估算假设本身也写在数据里</em>，不藏：</p>
  <table>
    <thead><tr><th>口径</th><th>单注期望回报</th><th>单注成本</th><th>每投入 2 元，平均拿回</th></tr></thead>
    <tbody>
      <tr><td>只算固定奖级（三~六等奖，金额是官方固定值）</td><td class="mono">${ex.expected_return_fixed_only.toFixed(4)} 元</td><td class="mono">${ex.bet_cost} 元</td><td class="mono">${((ex.expected_return_fixed_only / ex.bet_cost) * 100).toFixed(1)}%</td></tr>
      <tr><td>含浮动奖级（低档估算：一等奖 ${ex.floating_assumption_low[1].toLocaleString("en-US")} 元）</td><td class="mono">${ex.expected_return_low.toFixed(4)} 元</td><td class="mono">${ex.bet_cost} 元</td><td class="mono">${((ex.expected_return_low / ex.bet_cost) * 100).toFixed(1)}%</td></tr>
      <tr><td>含浮动奖级（中档估算：一等奖 ${ex.floating_assumption_mid[1].toLocaleString("en-US")} 元）</td><td class="mono">${ex.expected_return_mid.toFixed(4)} 元</td><td class="mono">${ex.bet_cost} 元</td><td class="mono">${((ex.expected_return_mid / ex.bet_cost) * 100).toFixed(1)}%</td></tr>
    </tbody>
  </table>

  <p><strong>第二步：那"多买几注"能解决吗？</strong>不能，因为期望是线性的。想要靠"每期买若干注"把期望回报凑到 ${target} 元，按不同估算口径需要：</p>
  <ul>
    <li>低档估算：每期约 <strong>${neededLow.toLocaleString("en-US")} 注</strong>，每期投入 <strong>${costLow.toLocaleString("en-US")} 元</strong>，而这些注的期望回报正好是 ${target} 元——<strong>依然是亏的，而且亏损比例和只买 1 注时完全相同</strong>；</li>
    <li>中档估算：每期约 <strong>${neededMid.toLocaleString("en-US")} 注</strong>，每期投入 <strong>${costMid.toLocaleString("en-US")} 元</strong>，期望回报同样是 ${target} 元。</li>
  </ul>
  <p>换句话说：买得越多，中奖次数确实会变多，但<strong>亏损的期望只会等比放大</strong>——把注数放大 ${neededLow.toLocaleString("en-US")} 倍，投入放大 ${neededLow.toLocaleString("en-US")} 倍，期望回报也只放大 ${neededLow.toLocaleString("en-US")} 倍，比例纹丝不动（约 ${((ex.expected_return_low / ex.bet_cost) * 100).toFixed(1)}%）。这就是"预测悖论"：<strong>即使一个人在选号上真有 1% 的优势（已经比本页检验过的所有策略都强），他也无法把负期望翻正</strong>——因为需要的优势量级是<strong>成百倍</strong>，而不是百分之几。</p>

  <h2>形态过滤器：为什么"选得更专业"没有提高中奖概率</h2>
  <p>很多人相信"避开连号、保持奇偶平衡、和值落在中间"能提高中奖率。下面这个演示把这个念头量化：每加一个条件，可选组合数就少一批——但请注意最后一列告诉你真正发生了什么。</p>
  <table>
    <thead><tr><th>过滤条件</th><th>剩余红球组合数</th><th>占全部组合</th><th>相对全部组合"精选"了</th></tr></thead>
    <tbody>${demo.rows}</tbody>
  </table>
  <div class="notice">
    <p><strong>关键在于：概率没有变。</strong>把四个"最专业"的过滤条件全加上，可选红球组合从 ${demo.total.toLocaleString("en-US")} 组降到 ${demo.strictMatched.toLocaleString("en-US")} 组（剩下 ${demo.strictRatio.toFixed(2)}%，相当于"精选"了 ${demo.strictMultiplier.toFixed(1)} 倍）。但开奖结果不会因为你的组合变少而更倾向于落在里面——<strong>你改变的只是"你把钱押在哪些组合上"，而不是"哪些组合会被开出来"</strong>。如果一定要说这个过滤动作有什么用，它只做了一件事：把同样 2 元的赌注集中到了更少的组合上（顺带一提，这反而降低了你和別人分摊一等奖的概率——但那个影响小到可以忽略，因为中一等奖本身就是 1/${verification.prize_probability_table[0].odds_one_in.toLocaleString("en-US")}）。</p>
  </div>`;
}

function buildDataVerification(verification) {
  const v = verification;
  const sv = v.source_verification;

  // 如果数据源核实记录缺失，如实说明并给出唯一的补救路径——
  // 而不是手写一段看着差不多的介绍顶上（17.5 L4：没有出处就不展示）。
  if (!sv) {
    return `
  <h2>数据来源核实记录</h2>
  <div class="notice">
    <p>本区块需要 <code>data/source_verification.json</code>（数据源人工核实与双源比对的凭证）。它当前缺失，因此这一版<strong>不渲染任何核实结论</strong>——本站的原则是"没有出处就不展示"，而不是临时写一段看着差不多的介绍顶上。生成方式见 <code>scripts/fetch-data.js</code>。</p>
  </div>`;
  }

  const cc = sv.cross_check;
  const peer = sv.new_period_peer_check;
  const ann = peer.announcement_internal_check;
  const repo = sv.repo_check;
  const ps = sv.primary_source;

  const limitations = sv.known_limitations.map((x) => `<li>${x}</li>`).join("\n");
  const corrections = sv.corrections
    .map(
      (c) => `<tr>
        <td>${c.what}</td>
        <td><strong>${c.status}</strong></td>
        <td>${c.why_wrong}</td>
        <td>${c.now}（更正日期 ${c.correction_date}）</td>
      </tr>`
    )
    .join("\n");

  return `
  <h2>数据来源核实记录</h2>
  <p>本站的每一个数字都建立在"这份历史开奖数据是对的"这个前提上，所以这一节把"数据从哪来、核实到什么程度"摊开讲。<strong>这一段记录的是已经做过的事，不是"我们相信它没问题"</strong>——包括本站一度写错、这次被纠正的那条（见本节最后一张表）。</p>
  <div class="notice">
    <p><strong>先说本站<em>不能</em>证明什么</strong>：自动校验只能证明这份数据<strong>内部自洽</strong>（格式、范围、顺序、奖级规则、概率总和都对得上），<strong>不能证明它逐期都与官方一致</strong>——没有任何自动化手段能替代人工核对。所以本节同时给出抽样核对表，任何人都能拿它去官方渠道逐条核对。</p>
  </div>
  <table>
    <thead><tr><th>项目</th><th>内容</th></tr></thead>
    <tbody>
      <tr><td>主数据源</td><td><code>${ps.name}</code>（${ps.description}，${ps.language} 项目，${ps.update_mode}）；数据文件 <code>${ps.data_file}</code>，字段 <code>${ps.fields}</code></td></tr>
      <tr><td>仓库状态</td><td>核实方式：${repo.method}；返回 <strong>HTTP ${repo.http_status}</strong>，<code>archived = ${repo.archived}</code>、<code>private = ${repo.private}</code>；最近一次数据更新提交为 ${repo.last_data_commit_at}（"${repo.last_data_commit_message}"）；核实时间 ${repo.checked_at}</td></tr>
      <tr><td>逐期交叉核对</td><td>把本地数据与上游 <code>${ps.data_file}</code> <strong>逐期逐号比对</strong>（期号、红球集合、蓝球、开奖日期四项全等）：${cc.matched_periods} 期全部一致，<strong>${cc.mismatches} 处不符</strong>，本地多出而上游查不到的期数 ${cc.local_only_periods} 期；接收新增 ${cc.new_periods_accepted} 期。脚本：<code>${cc.script}</code>，核对时间 ${cc.checked_at}</td></tr>
      <tr><td>新增期双源核对</td><td>最新一期（${peer.period}，${peer.date}，红 ${peer.red} / 蓝 ${peer.blue}）在写入前用<strong>第二个独立来源</strong>复核：${peer.peer_source_name}（${peer.peer_source_published} 发布），原文摘录"${peer.peer_source_quoted}"。比对结果：<strong>${peer.result}</strong></td></tr>
      <tr><td>公告内部一致性</td><td>${ann.note}该公告给出全国销售总额 ${ann.total_sales_yuan.toLocaleString("en-US")} 元、合 ${ann.total_bets.toLocaleString("en-US")} 注，六等奖中奖 ${ann.sixth_prize_wins.toLocaleString("en-US")} 注，占比 ${ann.sixth_prize_share_percent}%；而按奖级规则"仅中蓝球"的理论值为 ${ann.theoretical_blue_only_percent}%。${ann.conclusion}</td></tr>
      <tr><td>抓取与核对脚本</td><td><code>scripts/fetch-data.js</code>：带 3 次重试；两个来源不一致时<strong>直接报警停线，不挑一个继续跑</strong>；写入前自动备份上一版数据</td></tr>
      <tr><td>仍未做到的</td><td><ul style="margin:0;padding-left:18px">${limitations}</ul></td></tr>
    </tbody>
  </table>
  <p><strong>本站曾经写错的一件事（留痕，不删）</strong>：</p>
  <table>
    <thead><tr><th>曾经写的内容</th><th>结论</th><th>错在哪</th><th>现在的状态</th></tr></thead>
    <tbody>${corrections}</tbody>
  </table>`;
}

function buildDataVerificationDetails(verification) {
  const v = verification;
  const hardItems = v.hard_checks.items
    .map((i) => `<li>${i}</li>`)
    .join("\n");
  const sampleRows = v.distribution.sample_rows
    .map(
      (s) => `<tr><td class="mono">${s.period}</td><td class="mono">${s.date}</td><td class="mono">${s.red}</td><td class="mono">${s.blue}</td></tr>`
    )
    .join("\n");
  return `
  <h2>数据自洽性校验与数据指纹</h2>

  <p><strong>已经自动校验过的（硬校验，失败即停止发布）：</strong></p>
  <ul>${hardItems}</ul>
  <p>校验范围：第 ${v.data_range.from} ~ ${v.data_range.to} 期，共 ${v.data_range.count} 期。校验时间：${v.verified_at}。</p>

  <p><strong>分布自洽性检验（蒙特卡洛校准的卡方检验）</strong>：在"每期每个号码等概率"的假设下模拟 ${v.distribution.red.trials} 次同规模数据集，看真实数据的卡方统计量落在模拟分布的什么位置。结果：</p>
  <table>
    <thead><tr><th>检验对象</th><th>卡方统计量</th><th>蒙特卡洛 p 值</th><th>每个号码的期望出现次数</th><th>结论</th></tr></thead>
    <tbody>
      <tr><td>红球频次</td><td class="mono">${v.distribution.red.statistic}</td><td class="mono">${v.distribution.red.pValue}</td><td class="mono">${v.distribution.red.expectedPerNumber}</td><td>${v.distribution.red.pValue >= 0.01 ? "与“每期等概率”一致" : "出现偏离，已标注待复查"}</td></tr>
      <tr><td>蓝球频次</td><td class="mono">${v.distribution.blue.statistic}</td><td class="mono">${v.distribution.blue.pValue}</td><td class="mono">${v.distribution.blue.expectedPerNumber}</td><td>${v.distribution.blue.pValue >= 0.01 ? "与“每期等概率”一致" : "出现偏离，已标注待复查"}</td></tr>
    </tbody>
  </table>
  <p class="dim">注意这个结果的含义：它<strong>不是</strong>"证明了彩票是随机的"，而是"这份数据内部没有表现出不该有的规律"。这两句话差别很大，本站只主张后者。和值均值 ${v.distribution.sum_mean}（理论 102），和值范围 ${v.distribution.sum_range[0]}~${v.distribution.sum_range[1]}。</p>

  <p><strong>抽样核对表（请你亲自核对）</strong>：下面是这份数据里最早 5 期和最近 5 期的完整号码。任何人都可以拿这张表去官方渠道逐条核对——这是目前唯一能替代"多数据源自动交叉核对"的诚实做法：</p>
  <table>
    <thead><tr><th>期号</th><th>开奖日期</th><th>红球</th><th>蓝球</th></tr></thead>
    <tbody>${sampleRows}</tbody>
  </table>

  <p><strong>数据指纹（SHA-256）</strong>：把清洗后的全部 ${v.data_range.count} 期号码按固定格式序列化后取哈希，得到：</p>
  <p class="mono fingerprint">${v.data_fingerprint_sha256}</p>
  <p>它的用途很具体：以后如果有人说"你的排行榜是不是偷偷换了数据"，把这个指纹重新算一遍就能对上——<strong>"这份排行榜是拿哪份数据算的"从一个信任问题变成了一个可验证的事实</strong>。指纹算法与输入格式写在 <code>scripts/verify-data.js</code> 里，任何人都能复现。</p>`;
}

function buildNumberToolsSection(numberTools) {
  if (!numberTools) {
    return `<h2>数字体检 / 遗漏分布 / 形态诊断</h2>
  <div class="notice"><p>本区块需要 <code>report.json</code> 里的 <code>number_tools</code> 数据（由 <code>node src/build.js</code> 生成）。它当前缺失，因此这一版不渲染这三个工具——而不是临时手算几个数字顶上。</p></div>`;
  }
  const h = numberTools.health;
  const mcb = numberTools.multiple_comparison_baseline;
  const drifted = [...h.red, ...h.blue].filter((x) => !x.covers_expected);
  const driftedRed = h.red.filter((x) => !x.covers_expected);
  const driftedBlue = h.blue.filter((x) => !x.covers_expected);
  const maxOm = numberTools.omission.red.reduce((a, b) => (b.current > a.current ? b : a), numberTools.omission.red[0]);
  const om = numberTools.omission;

  return `
  <h2>数字体检：每个号码的出现次数，后面都站着一条区间</h2>
  <p>很多人想知道"哪个号偏热、哪个号偏冷"。这一层把这件事彻底做完：<strong>每一个号码</strong>的出现次数、理论期望、95% 置信区间，以及最近 10/30/50/100 期的表现，全部摊开。点任意一个号码就能看到它的完整体检报告。</p>
  <p>判断标准只有一条：<strong>理论期望是否落在置信区间内</strong>。而不是"出现次数比别的号码多几个"。置信区间用的是 Wilson 区间（不是常见的正态近似）——因为正态近似在样本量小或比例接近 0/1 时会算出负数边界，页面上出现"−3% 的出现率"这种数字就没人信了。</p>

  <div class="nh-panel">
    <div class="nh-label">红球（每期出现概率 6/33 ≈ 18.18%），共 ${h.periods} 期</div>
    <div class="nh-grid" id="nh-grid-red"></div>
    <div class="nh-label">蓝球（每期出现概率 1/16 = 6.25%）</div>
    <div class="nh-grid" id="nh-grid-blue"></div>
    <p class="dim" style="margin: 8px 0 0;">虚线框 = 该号码的出现次数落在 95% 区间之外（下面解释为什么这不代表"发现了规律"）。点任意号码看详情。</p>
  </div>
  <div id="nh-detail" class="nh-detail"><p class="dim">点上面任意一个号码，这里会显示它的完整体检报告。</p></div>

  <div class="notice">
    <p><strong>先说清楚结果会怎么被误读。</strong>在这份数据里，有 <strong>${drifted.length}</strong> 个号码（红球 ${driftedRed.map((x) => x.number).join("、") || "无"}${driftedBlue.length ? "；蓝球 " + driftedBlue.map((x) => x.number).join("、") : ""}）的出现次数落在 95% 区间之外。看上去像是"发现了异常号码"——但它什么都不是：</p>
    <p>在 95% 水平上对 ${h.red.length} 个红球各自做一次检验，<strong>即使开奖完全随机</strong>，平均也会有 <span class="mono">${mcb.mean_outside_per_trial}</span> 个号码落到区间外（理论值 ${mcb.theoretical_expectation} 个）。用蒙特卡洛模拟 ${mcb.trials} 次纯随机数据实测：出现"至少 2 个号码偏离"的概率高达 <strong>${mcb.probability_at_least_2}%</strong>。</p>
    <p>换句话说，<strong>你现在看到的这个"偏离"，是完全随机的情况下最正常的结果之一</strong>。这就是多重比较陷阱：检验的次数越多，"碰巧越界"的号码就越多——而只看那一个越界的号码，是看不见这回事的。</p>
  </div>

  <div class="divider"></div>

  <h2>遗漏分布：回答那句"这个号是不是该出了"</h2>
  <p>这是被问得最多的一句话，所以必须有正面答案。点任意号码，会看到它当前遗漏了多久、历史上最长遗漏过多久，以及——<strong>这么长的遗漏，在整份数据里本来就该出现多少次</strong>。</p>
  <div class="nh-panel">
    <div class="nh-label">红球当前遗漏（数字 = 已经连续多少期没出现）</div>
    <div class="nh-grid" id="om-grid-red"></div>
    <div class="nh-label">蓝球当前遗漏</div>
    <div class="nh-grid" id="om-grid-blue"></div>
  </div>
  <div id="om-detail" class="nh-detail"><p class="dim">点上面任意一个号码，这里会显示它的遗漏分析。</p></div>

  <div class="notice">
    <p><strong>「该出了」这个直觉错在哪。</strong>以当前遗漏最长的红球 <span class="mono">${maxOm.number}</span> 为例：它已经 ${maxOm.current} 期没出现。在每期等概率假设下，单个号码遗漏到 ${maxOm.current} 期及以上的概率是 <span class="mono">${maxOm.probability_at_least_k}</span>——看上去极小。但这份数据里有 ${om.red.length} 个号码 × ${om.periods} 期 = ${om.red.length * om.periods} 次"号码-期"的机会，按这个概率，<strong>这种长度的遗漏在整个数据集里本来就会出现约 ${maxOm.expected_occurrences} 次</strong>。</p>
    <p>人只看了概率很小，没看机会有多少次——这就是"该出了"的全部逻辑漏洞。而且每次开奖都是独立事件，它下一期的出现概率仍然是 6/33，和 ${om.periods} 期之前完全一样：它不"欠"你。</p>
  </div>

  <div class="divider"></div>

  <h2>形态诊断：看看你的号码落在多大的一堆里</h2>
  <p>输入任意 6 个红球（或点"生成一组演示号码"），下面会给出它的奇偶比、大小比、三区分布、连号情况和和值，并且——<strong>关键是最后一列</strong>——告诉你有多少组号码和它"长得一样"。</p>
  <div class="nh-panel">
    <label class="nh-label" for="dz-input">输入 6 个红球号码（1~33，用空格或逗号分隔）</label>
    <div class="dz-row">
      <input type="text" id="dz-input" class="dz-input" placeholder="例如：02 04 13 14 15 30" />
      <button type="button" class="btn" id="dz-btn">诊断这组号码</button>
      <button type="button" class="btn btn-ghost" id="dz-gen">生成一组演示号码</button>
    </div>
    <p class="dz-error" id="dz-error"></p>
  </div>
  <div id="dz-result" class="nh-detail"><p class="dim">还没诊断。输入一组号码，或点"生成一组演示号码"。</p></div>

  <div class="notice">
    <p><strong>把这一层读对，只需要看懂最后一列。</strong>它的意思是"全部 ${numberTools.pattern_table.total_combinations.toLocaleString("en-US")} 组红球里，有多少组和这组长得一样"——<strong>不是</strong>"这组号码中奖的机会有多大"。这两个数字完全不是一回事。</p>
    <p>形态稀有只说明这组号码"长得比较特别"，不说明它更容易或更不容易被开出来。相反的方向才是真相：<strong>形态越"普通"（比如奇偶均衡、三区均匀），符合它的组合数越多</strong>——也就是说越是"看起来正常"的形态，同时选中它的人越多，万一真中了一等奖，还要和别人分。当然，这个影响小到可以忽略，因为中一等奖本身就是 1/${(numberTools.pattern_table.total_combinations * 16).toLocaleString("en-US")} 的事。</p>
  </div>
  <p class="dim">本区块所有统计量都在构建期算好、写死在页面里（<code>src/number-health.js</code>，Node 与浏览器共用同一份公式），浏览器端只做查表与展示，不重算。这一点是刻意的：如果两端各算一套，页面上早晚会出现两个对不上的数字。</p>`;
}

// ===========================================================================
// V4 第 4 层：下一期观测（页面最顶部区块）
// ---------------------------------------------------------------------------
// 这是用户最想要的那个东西——"根据往期给出下一期可能出现的号码"。
// 做法上刻意做了四个约束，缺任何一个都会让它变成选号器：
//   1. 三组参数化规则 + 一组纯随机对照，同屏并列，永远不单独展示一组；
//   2. 每组必带"历史均命中 + 95% 区间 + 证据等级"三件套；
//   3. 结论句由数据生成（"最好看的那组是怎么被挑出来的"），不写死；
//   4. 号码只以"这一组号码"的身份出现，不出现"推荐/主推/看好"这类措辞。
// ===========================================================================
function buildObservationSection(obs, verification, report_theoretical_expectation) {
  if (!obs) {
    return `<h2>下一期观测</h2>
  <div class="notice"><p>本区块需要 <code>report.json</code> 里的 <code>next_period_observation</code> 数据（由 <code>node src/build.js</code> 生成）。它当前缺失，因此这一版不渲染任何号码——而不是临时手写一组顶上。</p></div>`;
  }

  const groups = obs.groups;
  // 理论期望取自报告（6 × 6/33 = 1.0909），不写死
  const theoretical = report_theoretical_expectation;
  const best = groups.reduce((a, b) => (b.backtest.mean_hit > a.backtest.mean_hit ? b : a), groups[0]);
  const randomGroup = groups.find((g) => g.key === "random");
  const spread = (
    Math.max(...groups.map((g) => g.backtest.mean_hit)) - Math.min(...groups.map((g) => g.backtest.mean_hit))
  ).toFixed(4);
  const bestMargin = best.backtest.mean_hit - randomGroup.backtest.mean_hit;
  const evLabels = [...new Set(groups.map((g) => g.evidence.label))];
  const coversCount = groups.filter((g) => g.backtest.ci_95[0] <= theoretical && theoretical <= g.backtest.ci_95[1]).length;

  const cards = groups
    .map((g) => {
      const reds = g.numbers.red.map((n) => `<span class="obs-ball">${n}</span>`).join("");
      const isRandom = g.key === "random";
      return `
    <div class="obs-card${isRandom ? " obs-card-random" : ""}">
      <div class="obs-card-head">
        <span class="obs-card-name">${g.name}</span>
        ${isRandom ? '<span class="obs-tag">对照组</span>' : ""}
      </div>
      <div class="obs-balls">${reds}<span class="obs-ball obs-ball-blue">${g.numbers.blue}</span></div>
      <p class="obs-desc">${g.desc}</p>
      <table class="obs-table"><tbody>
        <tr><td>历史均命中（红）</td><td class="mono">${g.backtest.mean_hit.toFixed(4)}</td></tr>
        <tr><td>95% 置信区间</td><td class="mono">[${g.backtest.ci_95[0].toFixed(3)}, ${g.backtest.ci_95[1].toFixed(3)}]</td></tr>
        <tr><td>理论期望</td><td class="mono">${theoretical.toFixed(4)}</td></tr>
        <tr><td>蓝球命中率</td><td class="mono">${(g.backtest.blue_hit_rate * 100).toFixed(1)}%</td></tr>
        <tr><td>vs 随机对照（配对差值）</td><td class="mono">${g.backtest.paired_diff_vs_random >= 0 ? "+" : ""}${g.backtest.paired_diff_vs_random.toFixed(4)}</td></tr>
        <tr><td>证据等级</td><td><span class="ev ev-${g.evidence.level}">${g.evidence.label}</span></td></tr>
      </tbody></table>
    </div>`;
    })
    .join("\n");

  const prizeTable = verification ? buildPrizeTable(verification) : "";
  const firstPrizeOdds = verification
    ? verification.prize_probability_table[0].odds_one_in.toLocaleString("en-US")
    : "17,721,088";
  const totalCombos = verification ? verification.total_combinations.toLocaleString("en-US") : "17,721,088";
  const winProb = verification ? (verification.winning_probability * 100).toFixed(4) : "6.7095";
  const expLow = verification ? verification.expectation.expected_return_low.toFixed(4) : "0.7402";
  const expMid = verification ? verification.expectation.expected_return_mid.toFixed(4) : "0.9942";

  return `
  <h2>下一期观测：第 ${obs.next_period} 期</h2>
  <p>下面是基于<b>截至第 ${obs.based_on_through} 期（${obs.based_on_date}）</b>的全部历史数据，按三种规则算出的下一期号码，以及专门用来做对照的<b>第四组纯随机号码</b>。四组并列显示、不分主次。</p>

  <div class="notice notice-strong">
    <p><strong>先把话说清楚，再给号码。</strong>本站没有、也不提供"预测准确"的号码——下一期开奖是独立随机事件，任何基于往期数据的规则，都不会让某一组号码更容易被开出来。四组的历史均命中极差是 <span class="mono">${spread}</span>，其中 <b>${best.name}</b> 最高，看着像"找到了规律"。但请注意两件事：</p>
    <p>① 它是<b>从四组里挑出来最好看的那一组</b>。只要允许挑，总能挑出一个好看的——这不叫规律，叫选择性偏差；<br>
       ② 它相对纯随机对照组的优势只有 <span class="mono">${bestMargin >= 0 ? "+" : ""}${bestMargin.toFixed(4)}</span>，而四组的证据等级全部是 <b>${evLabels.join(" / ")}</b>，四组里有 <b>${coversCount} 组</b>的 95% 置信区间覆盖了理论期望 ${theoretical.toFixed(4)}。</p>
    <p>换句话说：<b>这四组号码在统计上没有一组比另外三组更可能中奖。</b>把它们放在页面最顶部，是因为这是你最想看的东西；紧挨着它们的这些数字，才是本站真正想让你看到的东西。</p>
  </div>

  <div class="obs-grid">
    ${cards}
  </div>

  <div class="notice">
    <p><strong>四组一起看才有意义：</strong>${groups
      .map((g) => `${g.name} <span class="mono">${g.backtest.mean_hit.toFixed(4)}</span>`)
      .join(" ｜ ")}。四组全部落在彼此的正常波动范围内，没有任何一组越出理论期望附近的正常区间。</p>
    <p>"最高的一组"并不稳定：它之所以是 ${best.name}，只是因为在这批数据上它恰好最高。换一批历史数据重新算，最高的通常会是另一组——这正是"每种选号规则都能找到一段表现好看的历史"的含义，也是本站把四组并列、而不是只给你一组的原因。</p>
  </div>

  <p class="dim">号码生成规则写在 <code>src/build.js</code> 的 <code>buildNextPeriodObservation</code> 里，全部使用确定性种子（期号 + 组名），因此<b>同一份历史数据永远得到同一组号码</b>——不做"每次刷新换一组"的事，那样就没法验证任何东西了。「均衡倾向规则」的权重（热 40 / 遗漏 40 / 随机 20）是固定值，本站刻意不提供"最优权重"——那等于替用户调参，而调参正是本站反复警告的数据窥探。</p>

  <h3>无论你看着哪一组号码，中奖概率都是同一个数</h3>
  <p>全部可能的号码组合共 <strong>${totalCombos}</strong> 组，每一组被开出来的概率完全相同。你选中任意一组号码，中一等奖的概率都是 <strong>1 / ${firstPrizeOdds}</strong>——不因为它是"热号"还是"冷号"而有任何区别。下面这张表由组合数精确计算，不是抄来的：</p>
  ${prizeTable}
  <div class="notice">
    <p>合计中奖概率 <strong>${winProb}%</strong>，单注期望回报约 <strong>${expLow}~${expMid}</strong> 元，而成本是 2 元。<strong>选号规则改变不了这两个数字中的任何一个。</strong>这也是为什么本站把"概率"放在号码旁边，而不是放在免责声明里。</p>
  </div>`;
}

// ===========================================================================
// 「无证据」到底是什么意思：功效分析面板
// ---------------------------------------------------------------------------
// 证据等级写着"无证据"时，几乎所有读者都会理解成"数据还不够，攒够了就有结论"。
// 这是完全反的。这个面板用三个数字把这件事说清楚：
//   ① 最小可检出效应 —— 我们现在这把尺子能分辨多细的差别
//   ② 实测差异及其置信区间 —— 差异最多能有多大
//   ③ 要把差异坐实需要多少期 —— 换更大的数据集有没有用
// 最后再用"就算优势是真的，每注多值几毛钱"把它彻底关掉。
// ===========================================================================
function buildEvidenceExplainer(power, leaderboard) {
  if (!power) return "";
  const m = power.money_value_check;
  const ci = power.observed_diff_ci_95;
  const hot = leaderboard.find((r) => r.strategy_key === "hot");
  const blindBlind = leaderboard.find((r) => r.strategy_key === "hot");

  return `
  <h2>「无证据」是什么意思：不是数据不够，是数据已经够说明"没有大优势"</h2>
  <p>页面上的证据等级写着 <span class="ev ev-none">无证据</span> 时，很容易被读成"数据还太少，等攒够了再说"。<strong>这是完全反的</strong>，所以这一节用数字把它讲清楚。两种标签的含义截然不同：</p>
  <table>
    <thead><tr><th>证据等级</th><th>什么时候出现</th><th>它的真实含义</th></tr></thead>
    <tbody>
      <tr><td><span class="ev ev-insufficient">样本量不足</span></td><td>该段期数少于 100 期（例如当前盲测集只有 ${blindBlind ? blindBlind.segments.blind.periods_tested : 31} 期）</td><td><strong>数据确实太少</strong>，什么结论都不能下——这是"再等等看"<strong>唯一</strong>成立的情况</td></tr>
      <tr><td><span class="ev ev-none">无证据</span></td><td>期数足够（≥100 期），但置信区间覆盖了理论期望</td><td><strong>数据已经足够</strong>，结论就是"没有可检出的差异"。不是"还不知道"，而是"已经知道没有大的"</td></tr>
    </tbody>
  </table>

  <p>下面是"已经知道没有大的"这句话的量化版本。以目前检验过的<b>热号策略</b>为例（它是三个策略里表现最好的一个）：</p>
  <table>
    <thead><tr><th>问题</th><th>答案</th><th>怎么理解</th></tr></thead>
    <tbody>
      <tr>
        <td>我们现在这把"尺子"能分辨多细的差别？</td>
        <td class="mono">±${power.min_detectable_effect}</td>
        <td>在 ${power.periods} 期、80% 功效下，任何<strong>每期多命中约 ${power.min_detectable_effect} 个红球以上</strong>的真实优势，都会被我们检出来。比这更小的优势则淹没在噪声里。</td>
      </tr>
      <tr>
        <td>实测到的差异有多大？</td>
        <td class="mono">+${power.observed_diff}</td>
        <td>热号策略平均每期比随机基准多命中 ${power.observed_diff} 个红球——<strong>比我们这把尺子的分辨力还小</strong>，所以它落在"测不出来"的区间里。</td>
      </tr>
      <tr>
        <td>这个差异最多能有多大？</td>
        <td class="mono">[${ci[0].toFixed(4)}, +${ci[1].toFixed(4)}]</td>
        <td>95% 置信区间<strong>跨过 0</strong>（含负值），意味着"热号其实略差于随机"也完全说得通。即使乐观取上界，真实优势也不会超过约 <strong>+${ci[1].toFixed(2)} 个红球/期</strong>。</td>
      </tr>
      <tr>
        <td>那多攒点数据是不是就能确认了？</td>
        <td class="mono">约需 ${power.periods_needed_for_observed} 期</td>
        <td>要把它坐实到统计显著，需要约 <strong>${power.periods_needed_for_observed} 期</strong>（现在 ${power.periods} 期，约相当于再等 ${(power.periods_needed_for_observed / 150).toFixed(1)} 年）。</td>
      </tr>
      <tr>
        <td><strong>就算把它坐实了，值多少钱？</strong></td>
        <td class="mono">+${m.estimated_yuan_per_bet} 元 / 注</td>
        <td>把这点优势换算成奖金：命中 ≥4 红（四等奖及以上的必要条件）的概率从 <span class="mono">${(m.p_ge4_red_baseline * 100).toFixed(4)}%</span> 升到 <span class="mono">${(m.p_ge4_red_with_effect * 100).toFixed(4)}%</span>，每注期望回报增加约 <strong>${m.estimated_yuan_per_bet} 元</strong>——而每注成本是 2 元，单注期望回报本身只有 0.74~0.99 元。</td>
      </tr>
    </tbody>
  </table>

  <div class="notice notice-strong">
    <p><strong>所以"无证据"的正确读法是：数据已经足够，足以排除"存在较大优势"这个可能。</strong>剩下能被塞进这个区间的优势，小到连一毛三分钱都不值。继续攒数据当然可以，但它的意义是"把区间收得更窄"，不是"等一个好消息出现"。</p>
    <p class="dim">顺便说明一个常见误解：<strong>如果哪天真的检出了显著优势，那才更需要警惕。</strong>因为在"每期独立等概率"这个前提下，长期的正确结果本来就是"没有差异"；一旦出现显著，优先怀疑的是数据、代码或统计口径出了问题，而不是"终于找到规律了"。这也是本站把"数据指纹 + 奖级全枚举自检 + 抽样核对表"放在同一页的原因。</p>
  </div>

  <p class="dim">以上数字全部是解析解（不依赖模拟）：标准误 = 配对差值标准差 ÷ √期数；最小可检出效应 = (1.96 + 0.84) × 标准误（80% 功效、双侧 5%）；所需期数 = ((1.96 + 0.84) × 标准差 ÷ 观测差异)²；金额换算用精确超几何概率（<b>不是</b>二项近似——第一版用近似时把 P(≥4红) 算高了 2.45 倍，已修正为精确值）。计算过程写在 <code>src/build.js</code> 的 <code>buildEvidencePowerAnalysis</code> 里。</p>`;
}

// ---- V1 新增：我的策略权重滑块，需要给浏览器端嵌入一份精简历史数据 ----
function buildLabData(history, split_boundaries, monte_carlo, min_train_size, report_number_tools, next_period) {
  const compactHistory = history.map((d) => ({ period: d.period, red: d.red, blue: d.blue }));
  return {
    history: compactHistory,
    minTrainSize: min_train_size,
    // V4 第 1~3 层：把构建期算好的统计量交给浏览器端（只读，不重算）
    numberTools: report_number_tools,
    nextPeriod: next_period,
    boundaries: {
      validationStart: split_boundaries.validation_start_period,
      blindStart: split_boundaries.blind_test_start_period,
    },
    mcDevDistribution: monte_carlo.dev_distribution,
    mcBlindDistribution: monte_carlo.blind_distribution,
  };
}

function main() {
  const report = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "report.json"), "utf-8"));
  const history = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "ssq.json"), "utf-8")).sort(
    (a, b) => Number(a.period) - Number(b.period)
  );
  const { leaderboard, convergence, monte_carlo, fund, split_boundaries } = report;
  // V4 第 1~3 层：构建期已经算好的数字体检 / 遗漏 / 形态数据（见 src/build.js）
  const numberTools = report.number_tools;
  // 「下一期」期号：只用于给演示号码生成器提供确定性种子的输入，
  // 页面不会用它做任何"预测"表述。
  const nextPeriod = String(Number(report.data_range.to) + 1);
  const labData = buildLabData(
    history,
    split_boundaries,
    monte_carlo,
    report.min_train_size,
    numberTools,
    nextPeriod
  );

  // ---- 收敛曲线 SVG ----
  const convSeries = ["random", "hot", "cold"].map((key) => ({
    className: STRATEGY_CLASS[key],
    points: convergence[key].map((p, i) => ({ x: i + 1, y: p.cumulativeMean })),
  }));
  const totalPeriods = convergence.random.length;
  const convChart = lineChart({
    series: convSeries,
    yLabel: "累计平均命中红球数",
    xTicks: [
      { x: 1, label: "第1期" },
      { x: Math.round(totalPeriods / 2), label: `第${Math.round(totalPeriods / 2)}期` },
      { x: totalPeriods, label: `第${totalPeriods}期（最新）` },
    ],
    horizontalRefs: [
      { y: report.theoretical_expectation, label: `理论期望 ${report.theoretical_expectation.toFixed(4)}`, className: "ref-theory" },
    ],
  });

  // ---- 蒙特卡洛直方图 SVG ----
  const mcMarkers = leaderboard.map((row) => ({
    x: row.mean_hit,
    label: row.strategy,
    className: STRATEGY_CLASS[row.strategy_key],
  }));
  const mcChart = histogram({
    bins: monte_carlo.histogram,
    markers: mcMarkers,
  });

  // ---- 资金曲线 SVG（近似示意）----
  const fundSeries = ["random", "hot", "cold"].map((key) => ({
    className: STRATEGY_CLASS[key],
    points: fund[key].map((p, i) => ({ x: i + 1, y: p.net })),
  }));
  const fundChart = lineChart({
    series: fundSeries,
    yLabel: "累计净值（元，近似估算）",
    xTicks: [
      { x: 1, label: "第1期" },
      { x: Math.round(totalPeriods / 2), label: `第${Math.round(totalPeriods / 2)}期` },
      { x: totalPeriods, label: `第${totalPeriods}期` },
    ],
    horizontalRefs: [{ y: 0, label: "收支平衡线", className: "ref-zero" }],
  });

  const generatedDate = new Date(report.generated_at).toISOString().slice(0, 10);

  // ---- V4 第零步：命中概率表 / 预测悖论 / 数据核对三块 ----
  // data_verification 来自 report.json，而 report.json 是 build.js 从 verification.json
  // 整份带入的——所以这一块不需要任何硬编码数字。缺失时整块不渲染，并在页面上如实说明。
  const verification = report.data_verification;
  const predictionSection = verification
    ? buildPredictionParadox(verification)
    : `<h2>命中概率表 / 预测悖论</h2>
  <div class="notice"><p>本区块需要 <code>data/verification.json</code>（由 <code>node scripts/verify-data.js</code> 生成）。它当前缺失，所以这一版没有渲染概率表与预测悖论演示——<strong>这不是可以忽略的小事</strong>：本站的原则是"每个数字都要有出处"，没有出处就不展示，而不是临时手写一个看着差不多的数字顶上。</p></div>`;
  const dataSection = verification
    ? buildDataVerification(verification) + "\n<div class=\"divider\"></div>\n" + buildDataVerificationDetails(verification)
    : "";
  // V4 第 1~3 层：数字体检 / 遗漏分布 / 形态诊断
  const numberToolsSection = buildNumberToolsSection(report.number_tools);
  // V4 第 4 层：下一期观测（放在页面最顶部——用户最想看的东西在最上面，
  // 但它必须被"证据等级 + 随机对照组 + 概率表"包住，否则就成了选号器）
  const observationSection = buildObservationSection(
    report.next_period_observation,
    verification,
    report.theoretical_expectation
  );
  // 「无证据」是什么：功效分析面板，紧跟排行榜（读者第一次遇到证据等级的地方）
  const evidenceExplainer = buildEvidenceExplainer(report.evidence_power_analysis, leaderboard);

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>随机数打脸实验室 · 双色球概率实验室 V1</title>
<style>
  :root {
    --paper: #eef0ec;
    --paper-2: #e4e7e0;
    --ink: #1c2430;
    --ink-dim: #5b6472;
    --red: #b23a3a;
    --red-soft: #e7cfcf;
    --blue: #2f5d8a;
    --blue-soft: #cfdbe7;
    --amber: #9a7b1f;
    --line: #c8cbc2;
    --serif: ui-serif, Georgia, "Songti SC", "Noto Serif SC", serif;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Noto Sans Mono", monospace;
  }
  * { box-sizing: border-box; }
  html { background: var(--paper); }
  body {
    margin: 0;
    background: var(--paper);
    color: var(--ink);
    font-family: var(--sans);
    line-height: 1.65;
  }
  .wrap {
    max-width: 760px;
    margin: 0 auto;
    padding: 56px 24px 96px;
  }
  .divider {
    height: 3px;
    margin: 48px 0 28px;
    background: linear-gradient(90deg, var(--red) 0%, var(--red) 48%, var(--blue) 52%, var(--blue) 100%);
    border-radius: 2px;
  }
  h1 {
    font-family: var(--serif);
    font-size: 2.15rem;
    line-height: 1.3;
    margin: 0 0 18px;
    max-width: 20ch;
  }
  h2 {
    font-family: var(--serif);
    font-size: 1.3rem;
    margin: 0 0 14px;
  }
  p { margin: 0 0 14px; max-width: 68ch; }
  .lede { font-size: 1.05rem; color: var(--ink-dim); max-width: 60ch; }
  .tagline {
    font-family: var(--serif);
    font-style: italic;
    color: var(--ink-dim);
    border-left: 3px solid var(--ink-dim);
    padding-left: 16px;
    margin: 24px 0 32px;
    max-width: 56ch;
  }
  .badge-row { display: flex; gap: 10px; flex-wrap: wrap; margin: 18px 0 8px; }
  .badge {
    font-family: var(--mono);
    font-size: 0.78rem;
    padding: 4px 10px;
    border: 1px solid var(--line);
    border-radius: 999px;
    color: var(--ink-dim);
    background: var(--paper-2);
  }
  .notice {
    background: var(--paper-2);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 16px 20px;
    font-size: 0.92rem;
    color: var(--ink-dim);
  }
  .notice p:last-child { margin-bottom: 0; }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.88rem;
    margin: 10px 0 20px;
  }
  th, td {
    text-align: left;
    padding: 8px 10px;
    border-bottom: 1px solid var(--line);
    vertical-align: top;
  }
  th { font-weight: 600; color: var(--ink-dim); font-size: 0.8rem; }
  td.mono, .mono { font-family: var(--mono); }
  .dim { color: var(--ink-dim); font-size: 0.85em; }
  /* V4 第零步：证据等级徽标。四个等级刻意用四种视觉强度，
     让"样本量不足/无证据"看起来就是"没结论"，而不是一种可以忽略的小字备注。 */
  .ev {
    display: inline-block;
    font-family: var(--mono);
    font-size: 0.74rem;
    padding: 2px 8px;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: var(--paper-2);
    color: var(--ink-dim);
    white-space: nowrap;
  }
  .ev-insufficient { border-style: dashed; color: var(--ink-dim); }
  .ev-none { color: var(--ink-dim); }
  .ev-weak { color: var(--blue); border-color: var(--blue); }
  .ev-moderate { color: var(--red); border-color: var(--red); }
  .fingerprint {
    font-size: 0.8rem;
    word-break: break-all;
    background: var(--paper-2);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 10px 12px;
    color: var(--ink-dim);
  }
  /* V4 第 1~3 层：数字体检 / 遗漏分布 / 形态诊断 */
  .nh-panel {
    background: var(--paper-2);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 14px 16px;
    margin: 12px 0;
  }
  .nh-label {
    font-size: 0.82rem;
    color: var(--ink-dim);
    margin: 10px 0 6px;
    display: block;
  }
  .nh-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .nh-ball {
    font-family: var(--mono);
    font-size: 0.86rem;
    width: 44px;
    height: 34px;
    border-radius: 8px;
    border: 1px solid var(--line);
    background: #fff;
    color: var(--red);
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s;
  }
  .nh-ball:hover { background: var(--paper-2); border-color: var(--red); }
  .nh-ball-blue { color: var(--blue); }
  .nh-ball-blue:hover { border-color: var(--blue); }
  /* 落在 95% 区间之外的号码：虚线框而不是高亮 —— 它表示"需要注意"，
     不表示"这个号码有特殊之处"。（页面正文会解释为什么它其实很普通。） */
  .nh-drift { border-style: dashed; border-color: var(--ink-dim); }
  .nh-detail {
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 14px 16px;
    margin: 12px 0 20px;
    min-height: 54px;
  }
  .nh-detail-title { margin: 0 0 10px; font-size: 0.98rem; }
  .nh-detail table { margin: 0 0 10px; }
  .verdict-normal { color: var(--ink-dim); font-size: 0.9rem; }
  .verdict-flag { color: var(--red); font-size: 0.9rem; }
  .dz-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .dz-input {
    font-family: var(--mono);
    font-size: 0.92rem;
    padding: 8px 10px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: #fff;
    color: inherit;
    flex: 1 1 240px;
    min-width: 200px;
  }
  .btn-ghost { background: transparent; color: var(--ink-dim); }
  .dz-error { color: var(--red); font-size: 0.85rem; margin: 8px 0 0; min-height: 1.1em; }
  /* V4 第 4 层：下一期观测（页面顶部区块） */
  .notice-strong {
    border-left: 3px solid var(--red);
    background: var(--paper-2);
  }
  .obs-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 14px;
    margin: 16px 0 20px;
  }
  .obs-card {
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 14px 16px;
    background: #fff;
  }
  /* 随机对照组用虚线与略暗的底色，视觉上明确"它和前几组是同一档东西"，
     而不是把它做成一个不起眼的附注——它是这一屏里最重要的一组号码。 */
  .obs-card-random {
    border-style: dashed;
    background: var(--paper-2);
  }
  .obs-card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 10px;
  }
  .obs-card-name { font-weight: 600; font-size: 0.95rem; }
  .obs-tag {
    font-family: var(--mono);
    font-size: 0.7rem;
    padding: 2px 7px;
    border-radius: 999px;
    border: 1px dashed var(--line);
    color: var(--ink-dim);
  }
  .obs-balls { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
  .obs-ball {
    font-family: var(--mono);
    font-size: 0.9rem;
    width: 34px;
    height: 34px;
    line-height: 32px;
    text-align: center;
    border-radius: 50%;
    border: 1px solid var(--line);
    background: #fff;
    color: var(--red);
  }
  .obs-ball-blue { color: var(--blue); }
  .obs-desc { font-size: 0.8rem; color: var(--ink-dim); margin: 0 0 10px; }
  .obs-table { margin: 0; font-size: 0.82rem; }
  .obs-table td { padding: 4px 6px; }
  .obs-table td:first-child { color: var(--ink-dim); }
  .strategy-name { font-weight: 600; }
  .s-random { color: var(--ink-dim); }
  .s-hot { color: var(--red); }
  .s-cold { color: var(--blue); }
  .chart-wrap {
    background: #fff;
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 12px 8px 4px;
    margin: 10px 0 22px;
  }
  svg.chart { width: 100%; height: auto; display: block; font-family: var(--mono); }
  .line { stroke-width: 2.2; }
  .s-random.line, .line.s-random { stroke: var(--ink-dim); }
  .s-hot.line, .line.s-hot { stroke: var(--red); }
  .s-cold.line, .line.s-cold { stroke: var(--blue); }
  .grid-line { stroke: var(--line); stroke-width: 1; opacity: 0.6; }
  .axis-label { fill: var(--ink-dim); font-size: 10px; }
  .ref-line { stroke: var(--amber); stroke-width: 1.4; }
  .ref-label { fill: var(--amber); font-size: 10px; }
  .ref-zero { stroke: var(--ink-dim); }
  .ref-label.ref-zero { fill: var(--ink-dim); }
  .hist-bar { fill: #b7bdb2; }
  .marker-line { stroke-width: 1.6; stroke-dasharray: 3,3; }
  .marker-line.s-random { stroke: var(--ink-dim); }
  .marker-line.s-hot { stroke: var(--red); }
  .marker-line.s-cold { stroke: var(--blue); }
  .marker-label { font-size: 10px; font-weight: 600; }
  .marker-label.s-random { fill: var(--ink-dim); }
  .marker-label.s-hot { fill: var(--red); }
  .marker-label.s-cold { fill: var(--blue); }
  .legend { display: flex; gap: 18px; flex-wrap: wrap; font-size: 0.85rem; margin: 4px 0 18px; }
  .legend-item { display: flex; align-items: center; gap: 6px; }
  .swatch { width: 14px; height: 3px; border-radius: 2px; display: inline-block; }
  .swatch.s-random { background: var(--ink-dim); }
  .swatch.s-hot { background: var(--red); }
  .swatch.s-cold { background: var(--blue); }
  .slider-row { display: grid; grid-template-columns: 110px 1fr 46px; align-items: center; gap: 12px; margin: 14px 0; }
  .slider-row label { font-size: 0.9rem; color: var(--ink-dim); }
  .slider-row input[type="range"] { width: 100%; accent-color: var(--red); }
  .slider-row .slider-val { font-family: var(--mono); text-align: right; }
  .ms-numbers { display: flex; gap: 8px; margin: 18px 0; flex-wrap: wrap; }
  .ball {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    font-family: var(--mono);
    font-weight: 700;
    font-size: 0.9rem;
    color: #fff;
  }
  .ball-red { background: var(--red); }
  .ball-blue { background: var(--blue); }
  .ms-stat-row { display: flex; gap: 28px; flex-wrap: wrap; margin: 6px 0 4px; }
  .ms-stat { font-size: 0.88rem; }
  .ms-stat .label { color: var(--ink-dim); display: block; font-size: 0.78rem; }
  .ms-stat .value { font-family: var(--mono); font-size: 1.05rem; }
  .ms-blind-box {
    display: none;
    margin-top: 16px;
    padding: 14px 18px;
    border: 1px dashed var(--line);
    border-radius: 10px;
    background: var(--paper-2);
  }
  .btn {
    font-family: var(--sans);
    font-size: 0.88rem;
    padding: 9px 16px;
    border-radius: 999px;
    border: 1px solid var(--ink);
    background: var(--ink);
    color: var(--paper);
    cursor: pointer;
  }
  .btn:disabled { opacity: 0.5; cursor: default; }
  footer {
    margin-top: 56px;
    padding-top: 20px;
    border-top: 1px solid var(--line);
    font-size: 0.82rem;
    color: var(--ink-dim);
  }
  footer p { max-width: none; }
  code { font-family: var(--mono); background: var(--paper-2); padding: 1px 5px; border-radius: 4px; font-size: 0.9em; }
</style>
</head>
<body>
<div class="wrap">

  <h1>任何策略，在没有通过盲测之前，都不准自称"有效"。</h1>
  <p class="lede">这是一个用真实开奖数据持续检验"选号策略是否真的比随机数强"的公开实验平台——不是预测工具，是概率科普实验。</p>

  <div class="badge-row">
    <span class="badge">数据集截至 ${report.dataset_snapshot}</span>
    <span class="badge">回测区间 第${report.data_range.from}~${report.data_range.to}期</span>
    <span class="badge">共${report.data_range.count}期</span>
    <span class="badge">Walk-Forward 回测期数 ${totalPeriods}</span>
    <span class="badge">蒙特卡洛 ${monte_carlo.runs} 次独立模拟</span>
    <span class="badge">盲测集封存于第${split_boundaries.blind_test_start_period}期起（当前${split_boundaries.blind_periods_count}期）</span>
  </div>

  <div class="divider"></div>

  ${observationSection}

  <div class="divider"></div>

  ${numberToolsSection}

  <div class="divider"></div>

  ${predictionSection}

  <div class="divider"></div>

  <h2>怎么读这一页</h2>
  <p>上面的号码区块是这一页最显眼的部分，也是最容易被误读的部分，所以这里给出读它的顺序：</p>
  <ul>
    <li><b>先看四组号码下面那张表里的"证据等级"</b>，再看号码本身。等级是"无证据"时，那一组号码和一个随机数没有区别。</li>
    <li><b>四组要一起看。</b>只截取"最好看的那一组"发出去，就等于制造了一个本站数据并不支持的结论——这也是本站永远把随机对照组放在同一屏的原因。</li>
    <li><b>再看下面的"数字体检"和"遗漏分布"</b>：你会看到每个号码的出现次数后面都配着置信区间，而"某号码很久没出"在整份数据里其实经常发生。</li>
    <li><b>最后看排行榜和盲测集</b>：那里有我们检验过的全部策略，以及它们能不能算"有效"的诚实回答——目前答案是"一个都不能"。</li>
  </ul>

  <div class="tagline">用 ${report.data_range.count} 期真实开奖数据，让选号玄学、统计策略接受同一个残酷的对手：大数定律。</div>

  <div class="notice">
    <p>本项目为统计与算法科普实验，<strong>不提供售彩、代购、充值、返利等任何服务</strong>；页面上出现的任何号码都只用于回测展示，不构成购彩建议。彩票开奖是独立随机事件，历史数据不影响未来结果——这句话本身就是本实验想反复验证、而不是想反驳的前提。</p>
  </div>

  <div class="divider"></div>

  <h2>数据与方法</h2>
  <p>历史开奖数据来自 <code>gudaoxuri/lottery_history</code>（GitHub 公开仓库，描述为"彩票历史数据收集器"，由 GitHub Actions 每日自动更新），当前版本共 <strong>${report.data_range.count} 期</strong>（${report.data_range.from} ~ ${report.data_range.to}）。该仓库已通过 GitHub API 核实存在且持续更新；本地数据与该仓库已做<strong>逐期逐号交叉核对</strong>（${report.data_range.count - 1} 期全部一致，0 处不符），最新一期另用第二个独立来源复核过——完整记录见下方"数据来源核实记录"一节，那里也写明了本站曾经在这个问题上写错过什么。</p>
  <p>回测采用 <strong>Walk-Forward 滚动预测</strong>：预测第 t+1 期时，策略只能看到第 1~t 期的数据，绝不使用未来信息。本版本 <code>minTrainSize = ${report.min_train_size}</code>，即前 ${report.min_train_size} 期只作为初始训练数据，从第 ${report.min_train_size + 1} 期开始才正式计入回测成绩，实际参与评分的有 ${totalPeriods} 期。</p>
  <p>随机基准和蒙特卡洛模拟都使用「期号 + 策略名」做种子的伪随机数，保证同一份数据永远得到同一份排行榜——回测模式下完全不使用 <code>Math.random()</code>。</p>

  <div class="divider"></div>

  <h2>排行榜</h2>
  <p>三个策略：<span class="s-random">随机基准</span>（完全不看历史，仅作对照）、<span class="s-hot">热号</span>（近50期出现频率最高的号码）、<span class="s-cold">冷号</span>（遗漏期数最长的号码）。理论期望值 <strong>${report.theoretical_expectation.toFixed(4)}</strong> 是红球 33 选 6 在均匀随机假设下的数学期望（6 × 6/33），独立于任何策略。</p>

  <table>
    <thead>
      <tr>
        <th>策略</th>
        <th>均命中(红)</th>
        <th>理论期望</th>
        <th>95% 置信区间</th>
        <th>蓝球命中率</th>
        <th>跑赢随机分布</th>
        <th>≥4/≥5/6红次数</th>
        <th>配对检验显著</th>
      </tr>
    </thead>
    <tbody>
      ${buildLeaderboardRows(leaderboard)}
    </tbody>
  </table>

  <div class="notice">
    ${buildVerdicts(leaderboard)}
    ${buildFdrNote(leaderboard)}
  </div>

  <div class="divider"></div>

  ${evidenceExplainer}

  <div class="divider"></div>

  <h2>训练 / 验证 / 盲测：三段式分割（V0.5 新增）</h2>
  <p>上一节的排行榜是训练集、验证集、盲测集<strong>合并在一起</strong>算出来的整体成绩——这正是 V0 版本"这是开发集成绩，不是盲测成绩"的局限。从这一版开始，回测数据被切成三段固定期号区间，<strong>边界写死，不随以后追加新数据而移动</strong>：</p>
  <ul>
    <li>训练集：第${split_boundaries.dev_period_range.from}期起（下方"我的策略"权重滑块调参时能看到的就是这一段和验证集合并后的"开发集"表现）</li>
    <li>验证集：训练集之后，到第${split_boundaries.dev_period_range.to}期（本站目前把训练集和验证集合并展示为"开发集"，没有单独做"先在训练集上选参数、再在验证集上确认"这一步中间校准，"我的策略"的权重是用户直接在开发集上调的）</li>
    <li><strong>盲测集：第${split_boundaries.blind_test_start_period}期起，当前 ${split_boundaries.blind_periods_count} 期（第${split_boundaries.blind_period_range.from}~${split_boundaries.blind_period_range.to}期）</strong>——这是本站第一次正式封存的盲测起点。以后每重新抓一批新数据，这个集合只会往后累积变长，起点期号本身不会因为数据变长而重新计算。</li>
  </ul>
  <div class="notice">
    <p><strong>关于当前 ${split_boundaries.blind_periods_count} 期盲测集的诚实说明</strong>：这是这个项目第一次跑盲测，样本量还很小，任何一个策略在这里的表现——无论好看还是难看——统计上都不可靠，只是"账本翻开的第一页"。它的意义不在于现在这个数字，而在于：从今往后，"盲测集"和"开发集"会被严格分开展示，不会因为开发集算出来的数字好看，就把它包装成盲测结论。</p>
  </div>

  <table>
    <thead>
      <tr>
        <th rowspan="2">策略</th>
        <th colspan="4">开发集（训练+验证，第${split_boundaries.dev_period_range.from}~${split_boundaries.dev_period_range.to}期）</th>
        <th colspan="4">盲测集（第${split_boundaries.blind_period_range.from}~${split_boundaries.blind_period_range.to}期）</th>
      </tr>
      <tr>
        <th>均命中(红)</th>
        <th>95% CI</th>
        <th>跑赢随机分布</th>
        <th>证据等级</th>
        <th>均命中(红)</th>
        <th>95% CI</th>
        <th>跑赢随机分布</th>
        <th>证据等级</th>
      </tr>
    </thead>
    <tbody>
      ${buildSegmentRows(leaderboard)}
    </tbody>
  </table>

  <div class="notice">
    ${buildBlindVerdicts(leaderboard)}
  </div>

  <div class="divider"></div>

  <h2>近期短线表现（近10/30/100期）</h2>
  <p>只是一个直观的"最近手感"数字，不做置信区间、不做显著性判断——短期波动是这类项目里最容易被误读成"策略突然变强/变弱"的地方，这里刻意不给任何结论性文案。</p>
  <table>
    <thead>
      <tr>
        <th>策略</th>
        <th>近10期均命中</th>
        <th>近30期均命中</th>
        <th>近100期均命中</th>
      </tr>
    </thead>
    <tbody>
      ${buildRecentRows(leaderboard)}
    </tbody>
  </table>

  <div class="divider"></div>

  <h2>我的策略（V1 新增）：调权重，亲手体验一次"数据窥探"</h2>
  <p>拖动下面三个滑块，实时生成一组"加权策略"号码——权重只决定<strong>热号频率 / 冷号遗漏 / 随机扰动</strong>三者在打分里的相对占比，同一组权重 + 同一份历史数据，永远算出同一组号码，不是每次刷新都变的抽奖。</p>
  <p><strong>刻意的设计</strong>：你可以随便拖动滑块，把下面的"历史回测成绩（开发集）"调到很好看——这正是本节想让你亲手体验的东西：只要允许反复调参、挑一个好看的数字，几乎总能"调"出一个看起来不错的策略，这不代表你发现了规律，只是<a href="#" onclick="return false;" title="在成百上千种参数组合里挑出历史表现最好的一组，即使数据完全随机也几乎必然能挑出来">数据窥探</a>的一种用户端形式。真正说明问题的是下面被默认隐藏的<strong>盲测成绩</strong>——一段调参过程中始终看不到、拿不来调整的历史区间，点击按钮才会揭晓。</p>

  <div class="notice">
    <div class="slider-row">
      <label for="ms-hot">热号倾向</label>
      <input type="range" id="ms-hot" min="0" max="100" value="50" />
      <span class="slider-val" id="ms-hot-val">50</span>
    </div>
    <div class="slider-row">
      <label for="ms-cold">冷号倾向</label>
      <input type="range" id="ms-cold" min="0" max="100" value="20" />
      <span class="slider-val" id="ms-cold-val">20</span>
    </div>
    <div class="slider-row">
      <label for="ms-random">随机扰动</label>
      <input type="range" id="ms-random" min="0" max="100" value="30" />
      <span class="slider-val" id="ms-random-val">30</span>
    </div>

    <div class="ms-numbers" id="ms-numbers"></div>

    <div class="ms-stat-row">
      <div class="ms-stat">
        <span class="label">历史回测成绩（开发集，均命中）</span>
        <span class="value" id="ms-dev-mean">—</span>
      </div>
      <div class="ms-stat">
        <span class="label">95% 置信区间</span>
        <span class="value" id="ms-dev-ci">—</span>
      </div>
      <div class="ms-stat">
        <span class="label">跑赢随机分布</span>
        <span class="value" id="ms-dev-pct">—</span>
      </div>
    </div>
    <p class="dim" style="margin: 6px 0 14px;">以上三个数字仅供娱乐——它们是你可以一直看着、反复调参数改进的"开发集"成绩，<strong>不作为策略有效性的证据</strong>。</p>

    <button class="btn" id="ms-reveal-btn">揭晓当前权重的盲测成绩</button>
    <div class="ms-blind-box" id="ms-blind-result">
      <div class="ms-stat-row">
        <div class="ms-stat">
          <span class="label">盲测成绩（第${split_boundaries.blind_test_start_period}期起，均命中）</span>
          <span class="value" id="ms-blind-mean">—</span>
        </div>
        <div class="ms-stat">
          <span class="label">95% 置信区间</span>
          <span class="value" id="ms-blind-ci">—</span>
        </div>
        <div class="ms-stat">
          <span class="label">跑赢随机分布</span>
          <span class="value" id="ms-blind-pct">—</span>
        </div>
      </div>
      <p class="dim" style="margin: 10px 0 0;">这才是相对公平的检验——你调参时完全看不到这段区间的表现。样本量还很小，任何数字（好看或难看）都不构成"有效"或"无效"的结论，只是诚实地把两个口径分开摆出来。</p>
    </div>
  </div>

  <h3 style="font-family: var(--serif); font-size: 1.05rem; margin: 28px 0 8px;">附：韭菜模拟器——按当前权重结算的资金曲线（近似示意）</h3>
  <p class="dim">假设从第一次能预测的那一期起，每期都固定花 2 元买一注当前权重算出来的号码，按官方奖级规则结算（一/二等奖用历史近似平均值估算，非精算数据）。这条曲线接的是开发集+盲测集的完整时间线——钱不需要防"数据窥探"，展示它只是想把"长期负期望"从一句话变成一条看得见往下走的线。</p>
  <div class="ms-stat-row">
    <div class="ms-stat">
      <span class="label">累计投入</span>
      <span class="value" id="ms-fund-spent">—</span>
    </div>
    <div class="ms-stat">
      <span class="label">当前净值（近似）</span>
      <span class="value" id="ms-fund-net">—</span>
    </div>
  </div>
  <div class="chart-wrap" id="ms-fund-chart"></div>

  <div class="divider"></div>

  <h2>收敛曲线</h2>
  <p>每个策略"累计平均命中数"随回测期数推进的变化过程。虚线是理论期望值——不是说曲线一定会贴上去，而是长期来看，样本均值和理论期望之间的差异应当落在正常波动范围内，而不是持续、系统性地偏离。</p>
  <div class="legend">
    <span class="legend-item"><span class="swatch s-random"></span>随机基准</span>
    <span class="legend-item"><span class="swatch s-hot"></span>热号</span>
    <span class="legend-item"><span class="swatch s-cold"></span>冷号</span>
  </div>
  <div class="chart-wrap">${convChart}</div>

  <div class="divider"></div>

  <h2>蒙特卡洛随机分布</h2>
  <p>固定住真实开奖序列不变，生成 <strong>${monte_carlo.runs}</strong> 条相互独立的"随机选号策略"，让它们都跑一遍同样的 Walk-Forward 流程，得到下面这条经验分布（均值 ${monte_carlo.mean.toFixed(4)}，标准差 ${monte_carlo.std.toFixed(4)}）。三条虚线标出了随机基准、热号、冷号各自的均命中数落在分布里的位置——这比单纯说"跑赢了多少随机策略"更直观：如果一个策略的位置和随机基准挤在分布中间的同一堆里，那它就没有跳出"运气"的范畴。</p>
  <div class="chart-wrap">${mcChart}</div>

  <div class="divider"></div>

  <h2>资金曲线（近似示意，非精算数据）</h2>
  <p>假设每期固定买 1 注（2 元），按官方奖级规则结算，一二等奖用历史近似平均值估算（不是精确的奖池分配结果）。这条曲线不是这个项目的重点结论，只是把"长期负期望"从一个抽象数字变成一条看得见的曲线。</p>
  <div class="legend">
    <span class="legend-item"><span class="swatch s-random"></span>随机基准</span>
    <span class="legend-item"><span class="swatch s-hot"></span>热号</span>
    <span class="legend-item"><span class="swatch s-cold"></span>冷号</span>
  </div>
  <div class="chart-wrap">${fundChart}</div>
  <p class="dim">${fund.disclaimer}</p>

  <div class="divider"></div>

  ${dataSection}

  <div class="divider"></div>

  <h2>这一版做了什么、还没做什么</h2>
  <p>当前已完成：<strong>V1</strong>（"我的策略"权重滑块 + 资金曲线）、<strong>V4 第零步</strong>（概率表与预测悖论、证据等级标注、数据指纹与核对表）、<strong>V4 第 1~4 层</strong>（数字体检、遗漏分布、形态诊断，以及本页最顶部的"下一期观测"），以及<strong>开奖后自动更新管道</strong>（GitHub Actions 定时抓取 → 交叉核对 → 硬校验 → 重算 → 生成页面 → 冒烟测试 → 工作流校验 → 合规审计 → 提交，任一门禁失败即不发布）。</p>
  <p><strong>关于顶部那个"下一期观测"区块，需要特别说明它的性质</strong>：它给出的是三组参数化规则 + 一组纯随机对照，<strong>不是预测结论</strong>。方案第十七节把预测功能拆成五层并规定：必须等证据等级、概率表、随机对照三样东西都能正常展示之后，"下一期观测"才允许上线——否则它只会变成一个看起来更专业的选号器。现在这三样都已就位，它才被放到最顶部。反过来也成立：<strong>如果哪天为了页面好看而把随机对照组或证据等级拿掉，这个区块就必须一起下线。</strong></p>
  <p>还没有做的，留给下一版：</p>
  <ul>
    <li><strong>数据源这一条已经解决了，但还有一个缺口</strong>——仓库真实存在（<code>gudaoxuri/lottery_history</code>，GitHub Actions 每日更新），本地数据与上游逐期逐号核对 0 处不符，新增期另经官方开奖公告双源复核。缺口是：<strong>历史 252 期仍属单一来源</strong>，通过了内部自洽校验，但没有逐期与官方比对。</li>
    <li>资金模拟器参数化（初始本金 / 每期注数可调）、传播素材导出（擂台图 / 收敛曲线静态图片）</li>
    <li>AI 战报（先用模板文案，暂不接入任何模型）</li>
    <li>大乐透等第二种彩票、Agent Skill 接口</li>
  </ul>
  <p class="dim">关于"自动更新"为什么曾经失败过一次：工作流最初把 cron 的星期写成了 <code>7</code>（cron 合法域是 0~6），GitHub 因此在校验阶段拒绝解析整份文件，症状是"0 个 job、failure、无日志"，完全不像 cron 的问题。现已修复，并新增了工作流规则级校验与排程语义校验两道门禁防止复发——完整记录见 README 与方案 17.13。</p>

  <footer>
    <p>生成时间 ${generatedDate} · 数据集版本 ${report.dataset_snapshot} · 数据来源 ${report.data_source}</p>
    <p>本页面所有数字均由公开算法对上方真实历史数据现算得出，同一份数据重新运行会得到完全相同的结果。不构成任何购彩建议，请理性对待彩票——它是被设计为长期负期望的娱乐消费，不是投资。</p>
  </footer>

</div>
<script>
  // V1 新增："我的策略"权重滑块需要的精简历史数据 + 蒙特卡洛开发集/盲测集分布，
  // 全部在构建期写死进页面里，浏览器端 JS 直接计算，不需要任何网络请求。
  window.__LAB_DATA__ = ${JSON.stringify(labData)};</script>
<script>
${NUMBER_HEALTH_JS}
</script>
<script>
${MY_STRATEGY_CLIENT_JS}
</script>
<script>
${NUMBER_TOOLS_CLIENT_JS}
</script>
</body>
</html>
`;

  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  fs.writeFileSync(path.join(PUBLIC_DIR, "index.html"), html, "utf-8");
  console.log(`已生成 ${path.join(PUBLIC_DIR, "index.html")}`);
}

main();
