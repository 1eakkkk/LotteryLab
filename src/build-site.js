const fs = require("fs");
const path = require("path");
const { lineChart, histogram } = require("./svg-charts");

const DATA_DIR = path.join(__dirname, "../data");
const PUBLIC_DIR = path.join(__dirname, "../public");

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
      return `<p><strong class="${cls}">${row.strategy}</strong>：均命中 ${row.mean_hit.toFixed(4)}（理论期望 ${row.theoretical_expectation.toFixed(4)}）。${verdictText(row)}</p>`;
    })
    .join("\n");
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
        <td class="mono">${blind.mean_hit.toFixed(4)}</td>
        <td class="mono">[${blind.ci_95[0].toFixed(3)}, ${blind.ci_95[1].toFixed(3)}]</td>
        <td class="mono">${pct(blind.vs_random_percentile)}</td>
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

function main() {
  const report = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "report.json"), "utf-8"));
  const { leaderboard, convergence, monte_carlo, fund, split_boundaries } = report;

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

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>随机数打脸实验室 · 双色球概率实验室 V0.5</title>
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

  <div class="tagline">用 ${report.data_range.count} 期真实开奖数据，让选号玄学、统计策略接受同一个残酷的对手：大数定律。</div>

  <div class="notice">
    <p>本项目为统计与算法科普实验，<strong>不提供售彩、代购、充值、返利等任何服务</strong>；页面上出现的任何号码都只用于回测展示，不构成购彩建议。彩票开奖是独立随机事件，历史数据不影响未来结果——这句话本身就是本实验想反复验证、而不是想反驳的前提。</p>
  </div>

  <div class="divider"></div>

  <h2>数据与方法</h2>
  <p>历史开奖数据来自 <code>gudaoxuri/lottery_history</code>（GitHub 公开镜像），当前版本共 <strong>${report.data_range.count} 期</strong>（${report.data_range.from} ~ ${report.data_range.to}）。这是 V0 版本的已知限制：还没有接入更长的历史区间，也还没有做多数据源交叉核对——按方案规则，一旦发现数据源不一致，后续版本会暂停自动发布并报警，而不是随便选一个继续跑。</p>
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
  </div>

  <div class="divider"></div>

  <h2>训练 / 验证 / 盲测：三段式分割（V0.5 新增）</h2>
  <p>上一节的排行榜是训练集、验证集、盲测集<strong>合并在一起</strong>算出来的整体成绩——这正是 V0 版本"这是开发集成绩，不是盲测成绩"的局限。从这一版开始，回测数据被切成三段固定期号区间，<strong>边界写死，不随以后追加新数据而移动</strong>：</p>
  <ul>
    <li>训练集：第${split_boundaries.dev_period_range.from}期起（供以后"我的策略"调参数用，当前三个基线策略没有可调参数，暂时空跑）</li>
    <li>验证集：训练集之后，到第${split_boundaries.dev_period_range.to}期（用于挑选/校准参数，当前同样未使用）</li>
    <li><strong>盲测集：第${split_boundaries.blind_test_start_period}期起，当前 ${split_boundaries.blind_periods_count} 期（第${split_boundaries.blind_period_range.from}~${split_boundaries.blind_period_range.to}期）</strong>——这是本站第一次正式封存的盲测起点。以后每重新抓一批新数据，这个集合只会往后累积变长，起点期号本身不会因为数据变长而重新计算。</li>
  </ul>
  <div class="notice">
    <p><strong>关于当前 ${split_boundaries.blind_periods_count} 期盲测集的诚实说明</strong>：这是这个项目第一次跑盲测，样本量还很小，任何一个策略在这里的表现——无论好看还是难看——统计上都不可靠，只是"账本翻开的第一页"。它的意义不在于现在这个数字，而在于：从今往后，"盲测集"和"开发集"会被严格分开展示，不会因为开发集算出来的数字好看，就把它包装成盲测结论。</p>
  </div>

  <table>
    <thead>
      <tr>
        <th rowspan="2">策略</th>
        <th colspan="3">开发集（训练+验证，第${split_boundaries.dev_period_range.from}~${split_boundaries.dev_period_range.to}期）</th>
        <th colspan="3">盲测集（第${split_boundaries.blind_period_range.from}~${split_boundaries.blind_period_range.to}期）</th>
      </tr>
      <tr>
        <th>均命中(红)</th>
        <th>95% CI</th>
        <th>跑赢随机分布</th>
        <th>均命中(红)</th>
        <th>95% CI</th>
        <th>跑赢随机分布</th>
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

  <h2>这是 V0.5：还没做的事</h2>
  <p>这一版在 V0 的地基上，把"开发集"和"盲测集"正式分开，加了短期窗口表现。还没有做的，留给下一版：</p>
  <ul>
    <li>更长的历史区间 + 多数据源交叉核对（当前仍是单一数据源，251 期）</li>
    <li>"我的策略"权重滑块交互——目前训练/验证集的分割边界已经就位，但还没有可调参数的策略去使用它</li>
    <li>GitHub Actions 自动抓取新一期数据、自动重算、自动部署，并在数据源不一致时自动暂停发布</li>
    <li>AI 战报（先用模板文案，暂不接入任何模型）</li>
    <li>大乐透等第二种彩票、Agent Skill 接口</li>
  </ul>

  <footer>
    <p>生成时间 ${generatedDate} · 数据集版本 ${report.dataset_snapshot} · 数据来源 ${report.data_source}</p>
    <p>本页面所有数字均由公开算法对上方真实历史数据现算得出，同一份数据重新运行会得到完全相同的结果。不构成任何购彩建议，请理性对待彩票——它是被设计为长期负期望的娱乐消费，不是投资。</p>
  </footer>

</div>
</body>
</html>
`;

  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  fs.writeFileSync(path.join(PUBLIC_DIR, "index.html"), html, "utf-8");
  console.log(`已生成 ${path.join(PUBLIC_DIR, "index.html")}`);
}

main();
