// ============================================================================
// 页面内联脚本的浏览器行为冒烟测试
// ----------------------------------------------------------------------------
// 为什么需要这个文件：
//   页面上那三个交互工具（数字体检 / 遗漏分布 / 形态诊断）的代码是**内联进 HTML** 的，
//   平时没有任何东西会去执行它——构建脚本只负责把它塞进页面。
//   也就是说：里面写错一个变量名，构建照样全绿、审计照样通过，而用户点下去是白屏。
//   "构建通过"和"功能可用"是两件不同的事，这个脚本就是为了补上这个缺口。
//
// 做法：用一段极简 DOM 桩（不引第三方依赖）把页面里的 <script> 抽出来真跑一遍，
//   然后模拟"点一个号码""点诊断按钮"，检查渲染出来的内容是否符合预期。
//
// 用法：node scripts/smoke-test-client.js
// ============================================================================

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const HTML_PATH = path.join(ROOT, "public", "index.html");

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  [pass] ${name}`);
  } else {
    failures++;
    console.log(`  [FAIL] ${name}${detail ? " —— " + detail : ""}`);
  }
}

// ---------------------------------------------------------------- 极简 DOM 桩
// 说明：模块化标签页用到了 classList / location / history / window.scrollTo，
// 所以桩里必须提供这些，否则"标签页脚本一跑就抛错"，
// 而真实浏览器里是好的——这种"测试环境缺件导致的假失败"会掩盖真问题。
function makeElement(id, tagName) {
  const el = {
    id: id,
    tagName: (tagName || "div").toUpperCase(),
    innerHTML: "",
    textContent: "",
    value: "",
    dataset: {},
    style: {},
    children: [],
    _listeners: {},
    _attrs: {},
    _classes: new Set(),
    className: "",
    addEventListener(type, fn) {
      (this._listeners[type] = this._listeners[type] || []).push(fn);
    },
    dispatch(type, ev) {
      const fns = this._listeners[type] || [];
      fns.forEach((fn) => fn(ev || { target: this }));
    },
    setAttribute(k, v) {
      this._attrs[k] = v;
    },
    getAttribute(k) {
      return this._attrs[k];
    },
    focus() {
      this._focused = true;
    },
    classList: {
      add(c) {
        el._classes.add(c);
      },
      remove(c) {
        el._classes.delete(c);
      },
      contains(c) {
        return el._classes.has(c);
      },
      toggle(c, force) {
        const want = force === undefined ? !el._classes.has(c) : !!force;
        if (want) el._classes.add(c);
        else el._classes.delete(c);
        return want;
      },
    },
    closest(sel) {
      if (sel.startsWith(".")) {
        const cls = sel.slice(1);
        if (el._classes.has(cls) || (el.className || "").split(/\s+/).includes(cls)) return el;
      }
      return null;
    },
    querySelector(sel) {
      if (sel === ".tab.is-active") {
        return (el._tabs || []).find((t) => t._classes.has("is-active")) || null;
      }
      return null;
    },
    querySelectorAll(sel) {
      if (sel === ".tab") return el._tabs || [];
      return [];
    },
    appendChild(c) {
      this.children.push(c);
      return c;
    },
  };
  return el;
}

/**
 * 建立 DOM 桩。关键点：交互脚本会先 container.innerHTML = "..." 再在 container 上
 * 绑 click 监听。桩里要把 innerHTML 里生成的 .nh-ball 按钮解析出来，
 * 这样我们才能真的"点"其中一个。
 */
function setupDom(html) {
  const ids = new Set();
  const re = /id="([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) ids.add(m[1]);

  const elements = {};
  ids.forEach((id) => {
    const isInput = new RegExp(`<input[^>]*id="${id}"`).test(html);
    elements[id] = makeElement(id, isInput ? "input" : "div");
  });

  const registry = elements;

  // innerHTML 赋值时，解析出里面带 data-number 的按钮，便于后续模拟点击
  Object.values(registry).forEach((el) => {
    let _html = "";
    Object.defineProperty(el, "innerHTML", {
      get() {
        return _html;
      },
      set(v) {
        _html = v;
        el._parsedBalls = [];
        const bre = /<button[^>]*data-number="(\d+)"[^>]*>/g;
        let bm;
        while ((bm = bre.exec(v)) !== null) {
          const ball = makeElement("", "button");
          ball.className = "nh-ball";
          ball.dataset.number = bm[1];
          const kindMatch = bm[0].match(/data-kind="(\w+)"/);
          ball.dataset.kind = kindMatch ? kindMatch[1] : "";
          el._parsedBalls.push(ball);
        }
      },
    });
  });

  // 从 HTML 里解析出标签导航的按钮（模块化标签页需要它们才能被测试）
  const navMatch = html.match(/<nav class="tabs"[^>]*>([\s\S]*?)<\/nav>/);
  const tabs = [];
  if (navMatch) {
    const btnRe = /<button([^>]*)>([\s\S]*?)<\/button>/g;
    let bm;
    while ((bm = btnRe.exec(navMatch[1])) !== null) {
      const attrs = bm[1];
      const target = (attrs.match(/data-target="([^"]+)"/) || [])[1];
      if (!target) continue;
      const tab = makeElement("", "button");
      tab.className = "tab" + (/is-active/.test(attrs) ? " is-active" : "");
      if (/is-active/.test(attrs)) tab._classes.add("is-active");
      tab.dataset.target = target;
      tab.dataset.label = bm[2].trim();
      tabs.push(tab);
    }
  }
  if (registry["main-tabs"]) registry["main-tabs"]._tabs = tabs;

  const document = {
    readyState: "complete",
    getElementById(id) {
      return registry[id] || null;
    },
    addEventListener() {},
    querySelectorAll() {
      return [];
    },
  };

  return { document, registry, tabs };
}

// ---------------------------------------------------------------- 主流程
function main() {
  console.log("=".repeat(78));
  console.log("页面内联脚本冒烟测试（模拟浏览器行为）");
  console.log("=".repeat(78));

  if (!fs.existsSync(HTML_PATH)) {
    console.error(`[fail] 找不到 ${HTML_PATH}，请先运行 node src/build-site.js`);
    process.exit(1);
  }
  const html = fs.readFileSync(HTML_PATH, "utf-8");

  // 抽出所有内联 <script>（没有 src 属性的）
  const scripts = [];
  const sre = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let sm;
  while ((sm = sre.exec(html)) !== null) scripts.push(sm[1]);
  console.log(`\n共抽出 ${scripts.length} 段内联脚本`);
  check("内联脚本段数 ≥ 3（数据 + 计算模块 + 交互 + 我的策略）", scripts.length >= 3, `实际 ${scripts.length}`);

  const { document, registry, tabs } = setupDom(html);
  // location / history / scrollTo：模块化标签页会用到它们。
  // 桩里必须提供，否则标签页脚本一执行就抛错——而真实浏览器里是好的。
  // 这种"测试环境缺件导致的假失败"比真失败更糟：它会掩盖真正的问题。
  const fakeLocation = { hash: "" };
  const fakeHistory = {
    replaceState(_a, _b, url) {
      if (typeof url === "string" && url.startsWith("#")) fakeLocation.hash = url;
    },
  };
  const sandbox = {
    document: document,
    window: {},
    console: { log: () => {}, warn: () => {}, error: () => {} },
    Math: Math,
    JSON: JSON,
    Number: Number,
    String: String,
    Array: Array,
    Object: Object,
    Set: Set,
    isNaN: isNaN,
    location: fakeLocation,
    history: fakeHistory,
  };
  sandbox.window.document = document;
  sandbox.window.scrollTo = () => {};
  sandbox.window.addEventListener = () => {};
  sandbox.globalThis = sandbox;

  // 逐段执行
  const vm = require("vm");
  const ctx = vm.createContext(sandbox);
  scripts.forEach((code, i) => {
    try {
      vm.runInContext(code, ctx, { timeout: 15000 });
    } catch (e) {
      failures++;
      console.log(`  [FAIL] 第 ${i + 1} 段内联脚本执行抛错：${e.message}`);
    }
  });
  if (failures === 0) console.log("  [pass] 全部内联脚本执行无异常");

  // ---- 校验：页面顶部的「下一期观测」区块（V4 第 4 层）----
  // 这一块是纯服务端渲染的，但它承载着"号码 + 证据等级 + 随机对照"三件套，
  // 一旦某次改动漏掉其中一样（比如把随机对照组弄丢了），页面看起来照样正常——
  // 所以这里把它当成必须存在的契约来检查。
  const obsGroups = ["热号规则", "遗漏规则", "均衡倾向规则", "纯随机对照组"];
  obsGroups.forEach((n) => {
    check(`顶部观测区含「${n}」`, html.includes(n));
  });
  check("顶部观测区含随机对照组标记", html.includes("obs-card-random"), "缺少对照组卡片样式");
  check("顶部观测区含「先把话说清楚，再给号码」", html.includes("先把话说清楚，再给号码"));
  check("顶部观测区含证据等级徽标", /class="ev ev-(insufficient|none|weak|moderate)"/.test(html));
  check("顶部观测区含一等奖概率", html.includes("1 / 17,721,088") || /1 \/ [\d,]{7,}/.test(html));
  check("顶部观测区说明号码是参数化产物而非预测", html.includes("不是预测结论") || html.includes("本站没有、也不提供"), "缺少免责说明");

  // 位置断言：号码区块必须排在"排行榜"之前（用户要求：号码相关放最上面）
  const posObs = html.indexOf("下一期观测");
  const posTools = html.indexOf("数字体检：每个号码的出现次数");
  const posRank = html.indexOf("<h2>排行榜</h2>");
  check(
    "顺序：下一期观测 → 数字体检 → 排行榜",
    posObs > 0 && posTools > posObs && posRank > posTools,
    `实际位置 obs=${posObs} tools=${posTools} rank=${posRank}`
  );

  // ---- 校验：数据确实挂上了 ----
  const lab = sandbox.window.__LAB_DATA__;
  check("window.__LAB_DATA__ 已注入", !!lab);
  check("labData 含 numberTools", !!(lab && lab.numberTools));
  check("labData 含 nextPeriod", !!(lab && lab.nextPeriod), lab && lab.nextPeriod);
  check("window.LotteryTools 可用", !!sandbox.window.LotteryTools);
  const nt = lab && lab.numberTools;

  // ---- 校验：数字体检网格渲染 ----
  const gridRed = registry["nh-grid-red"];
  const gridBlue = registry["nh-grid-blue"];
  const omRed = registry["om-grid-red"];
  check("红球体检网格已渲染 33 个按钮", gridRed && gridRed._parsedBalls && gridRed._parsedBalls.length === 33,
    gridRed && gridRed._parsedBalls ? `实际 ${gridRed._parsedBalls.length}` : "未渲染");
  check("蓝球体检网格已渲染 16 个按钮", gridBlue && gridBlue._parsedBalls && gridBlue._parsedBalls.length === 16,
    gridBlue && gridBlue._parsedBalls ? `实际 ${gridBlue._parsedBalls.length}` : "未渲染");
  check("遗漏网格已渲染 33 个按钮", omRed && omRed._parsedBalls && omRed._parsedBalls.length === 33,
    omRed && omRed._parsedBalls ? `实际 ${omRed._parsedBalls.length}` : "未渲染");

  // ---- 校验：点击一个号码后详情是否渲染出正确的数字 ----
  const detail = registry["nh-detail"];
  const ball17 = gridRed && gridRed._parsedBalls.find((b) => b.dataset.number === "17");
  check("能在红球网格里找到 17 号", !!ball17);
  if (ball17 && detail) {
    gridRed.dispatch("click", { target: ball17 });
    const expected = nt.health.red.find((x) => x.number === "17");
    const out = detail.innerHTML;
    check("点击 17 号后详情渲染了出现次数", out.includes(String(expected.count)), `期望包含 ${expected.count}`);
    check("点击 17 号后详情渲染了 Wilson 置信区间", out.includes(String(expected.ci_95[0])), `期望包含 [${expected.ci_95[0]}, ${expected.ci_95[1]}]`);
    check("点击 17 号后详情包含多重比较提醒", out.includes("多重比较") || out.includes("区间外"), "缺少防误读说明");
  }

  // ---- 校验：遗漏详情 ----
  const omDetail = registry["om-detail"];
  const omBall = omRed && omRed._parsedBalls[0];
  if (omBall && omDetail) {
    omRed.dispatch("click", { target: omBall });
    const omExpected = nt.omission.red.find((x) => x.number === omBall.dataset.number);
    check("遗漏详情渲染了当前遗漏期数", omDetail.innerHTML.includes(String(omExpected.current)));
    check("遗漏详情渲染了理论出现次数", omDetail.innerHTML.includes(String(omExpected.expected_occurrences)));
    check("遗漏详情包含“该出了”的纠正说明", omDetail.innerHTML.includes("该出了"));
  }

  // ---- 校验：统一号码工具（形态诊断 + 历史对照，共用一个输入框）----
  // 设计说明：这个工具原本是两个独立工具、两个输入框，审计脚本指出"整页两个文本输入框"
  // 超过它设定的上限——它是对的，而且暴露了更好的设计：用户不该把自己的号码输入两遍。
  // 现在整页只有一个输入框，一次点击同时产出两份结果，下面同时断言两者都渲染出来。
  const input = registry["dz-input"];
  const dzBtn = registry["dz-btn"];
  const genBtn = registry["dz-gen"];
  const dzResult = registry["dz-result"];
  const cmpResult = registry["cmp-result"];
  const cmpBlue = registry["cmp-blue"];
  const cmpFill = registry["cmp-fill-latest"];
  check("号码工具输入框存在", !!input);
  check("号码工具按钮存在", !!dzBtn && !!genBtn);
  check("蓝球选择器存在", !!cmpBlue);
  check("两份结果容器都存在（诊断 + 对照）", !!dzResult && !!cmpResult);
  check("整页只有一个文本输入框", (html.match(/<input[^>]*type="text"/g) || []).length === 1);
  check("整页没有 form 元素", !/<form[\s>]/i.test(html));

  if (input && dzBtn && dzResult && cmpResult) {
    input.value = "02 04 13 14 15 30";
    if (cmpBlue) cmpBlue.value = "08";
    dzBtn.dispatch("click");
    const dzHtml = dzResult.innerHTML;
    const cmpHtml = cmpResult.innerHTML;
    check("一次点击同时产出形态诊断", dzHtml.includes("奇偶比"), dzHtml.slice(0, 80));
    check("一次点击同时产出历史对照", cmpHtml.includes("对照结果"), cmpHtml.slice(0, 80));
    check("诊断结果包含「组合数」列", dzHtml.includes("符合该形态的组合数"));
    check("诊断结果包含「不是中奖机会」的澄清", dzHtml.includes("不说明它更容易") || dzHtml.includes("而不说明"));
    check("对照结果包含逐期命中分布", cmpHtml.includes("逐期红球命中分布"));
    check("对照结果包含各奖级中出期数", cmpHtml.includes("各奖级中出期数"));

    // 真正的恒等式（第一版这里我写错了断言，值得记下来）：
    //   ✗ 错的写法：固定 6 个号的均命中应当恒等于 6×6/33 = 1.0909
    //     1.0909 是"对随机号码集取平均"的期望值，**不是**某一个具体号码集的取值。
    //   ✓ 对的写法：均命中 = 这 6 个号在**同一段历史**里出现次数之和 ÷ 该段期数。
    //
    // V4.5 补充：浏览器端只内嵌最近 CLIENT_HISTORY_PERIODS 期（目前 600 期），
    // 所以"出现次数"必须用嵌入区间内的次数来反推，不能用全量 3502 期的数字体检结果。
    // 这条断言因此要自己算一遍嵌入区间内的频次——这反而更严格：
    // 它同时验证了"编码/解码没错"和"命中统计口径没错"。
    const embedded = (() => {
      const raw = lab && lab.historyCompact;
      if (!raw) return null;
      return raw.split("\n").map((line) => {
        const p = line.split("|");
        return { period: p[0], red: p[1].split(" "), blue: p[2] };
      });
    })();
    check("labData 提供紧凑编码的历史数据", !!embedded && embedded.length > 0, embedded ? embedded.length + " 期" : "缺失");

    if (embedded) {
      const testSet = ["02", "04", "13", "14", "15", "30"];
      const expectedTotalHits = embedded.reduce(
        (s, d) => s + d.red.filter((b) => testSet.includes(b)).length,
        0
      );
      const expectedMean = expectedTotalHits / embedded.length;
      const m = cmpHtml.match(/平均每期命中红球<\/td><td class="mono">([\d.]+)</);
      const meanHit = m ? Number(m[1]) : NaN;
      check(
        "对照均命中 = 各号码在嵌入区间内的出现次数之和 ÷ 该区间期数",
        !Number.isNaN(meanHit) && Math.abs(meanHit - expectedMean) < 0.0002,
        `对照算得 ${meanHit}，由嵌入区间的频次反推应为 ${expectedMean.toFixed(4)}（${expectedTotalHits} 次 / ${embedded.length} 期）`
      );
      const distNums = [...cmpHtml.matchAll(/<td class="mono">(\d+) 期<\/td><td class="mono">[\d.]+%<\/td>/g)].map((x) => Number(x[1]));
      check(
        "对照命中分布之和等于嵌入区间期数",
        distNums.reduce((a, b) => a + b, 0) === embedded.length,
        `各档合计 ${distNums.reduce((a, b) => a + b, 0)}，期望 ${embedded.length}`
      );
    }

    check("对照结果同时给出理论期望 1.0909 作参照", cmpHtml.includes("1.0909"));
    check("对照结果含蓝球命中率与理论值", cmpHtml.includes("理论值 6.25%"));
    check("对照结果明确区分「重合」与「号码有多好」", cmpHtml.includes("重合") && cmpHtml.includes("不是"));
  }

  // 生成演示号码 / 填入最近一期：两条快捷路径都应同时触发两份结果
  if (input && genBtn && dzResult && cmpResult) {
    genBtn.dispatch("click");
    const picked = input.value.split(/\s+/).filter(Boolean);
    check("生成演示号码得到 6 个号码", picked.length === 6, `实际 ${picked.length}`);
    check("生成的号码都在 1~33 且不重复", new Set(picked).size === 6 && picked.every((n) => +n >= 1 && +n <= 33));
    check("生成后同时完成诊断与对照", dzResult.innerHTML.includes("形态诊断") && cmpResult.innerHTML.includes("对照结果"));
  }
  if (cmpFill && input && cmpResult) {
    cmpFill.dispatch("click");
    const filled = input.value.split(/\s+/).filter(Boolean);
    const last = lab && lab.history ? lab.history[lab.history.length - 1] : null;
    check("填入最近一期后得到 6 个号码", filled.length === 6, input.value);
    if (last) {
      check(
        "填入的确实是最近一期的开奖号码",
        last.red.slice().sort().join(" ") === filled.slice().sort().join(" "),
        `填入 ${filled.join(" ")} / 最近一期 ${last.red.join(" ")}`
      );
    }
    check("填入后自动完成对照", cmpResult.innerHTML.includes("对照结果"));
  }

  // ---- 校验：策略回测的参数没有被静默丢弃（防 S1 类回归）----
  // 背景：本项目真实发生过一次严重事故——build.js 把 hotStrategy **直接**当回调传给
  // walkForwardBacktest，于是回测传入的第三个参数（ctx 对象）落到了 hotStrategy 的
  // 第三形参 windowSize 上，`slice(-{})` → `slice(-NaN)` → 返回整个历史数组。
  // 结果："近 50 期热号"实际跑成了"全历史热号"，页面文案、排行榜、功效分析全部按
  // "近50期"解读，而代码从来没这么做过——**不报错、不让任何门禁变红、3402 期里
  // 选出的号码与原意没有一期相同**。
  // 这类"参数被静默吞掉"的错误只能靠断言守住，所以这里直接测"窗口是否真的生效"。
  {
    const { hotStrategy } = require("../src/strategies.js");
    const hist = lab && lab.historyCompact
      ? lab.historyCompact.split("\n").map((l) => {
          const p = l.split("|");
          return { period: p[0], red: p[1].split(" "), blue: p[2] };
        })
      : null;
    if (hist && hist.length > 120) {
      const withWindow = hotStrategy(hist, "99999", 50).red.join(" ");
      const withObject = hotStrategy(hist, "99999", {}).red.join(" ");
      check(
        "hotStrategy 的窗口参数真的生效（传入对象与传入 50 结果必须不同）",
        withWindow !== withObject,
        `window=50 → [${withWindow}]，window={} → [${withObject}]`
      );
      // 更直接：传 50 与传 全量长度 必须不同（否则说明窗口被忽略）
      const withFull = hotStrategy(hist, "99999", hist.length).red.join(" ");
      check(
        "hotStrategy 传 50 与传全量历史结果不同（确认没有退化成全历史）",
        withWindow !== withFull,
        `window=50 → [${withWindow}]，window=全量 → [${withFull}]`
      );
    } else {
      check("hotStrategy 窗口回归测试", false, "拿不到历史数据，无法测试");
    }
    // 顺带断言：页面文案里的窗口数字与代码里的 HOT_WINDOW 一致
    check(
      "页面文案声明的热号窗口与代码一致（近50期）",
      html.includes("近50期") || html.includes("近 50 期"),
      "页面没有出现「近50期」字样"
    );
  }

  // ---- 校验：ML 策略区块（V4.5 新增，项目名称承诺的那个检验）----
  // 这一块的价值全在"模型自己学会了忽略历史"这个证据上，而证据由两样东西组成：
  //   权重（全接近 0）+ 成绩（覆盖理论期望、FDR 后不显著）
  // 少任何一样，这一块就会退化成"我们也有个 AI 模型"这种话术，所以都要断言。
  check("页面含 ML 策略区块", html.includes("ML 策略：模型自己"));
  check("页面含模型权重表", html.includes("权重全部接近 0") && html.includes("ml-bar"));
  check("页面给出模型权重数值", /[+-]\d+\.\d{5}/.test(html));
  check(
    "页面明确写出「模型学会了忽略历史」这一结论",
    html.includes("学会了忽略历史") || html.includes("忽略历史"),
    "缺少核心结论"
  );
  check(
    "页面给出 ML 的成绩与证据等级（不只有权重）",
    html.includes("ML逻辑回归") && /ev-(none|insufficient|weak|moderate)/.test(html),
    "缺少成绩或证据等级"
  );
  check(
    "页面说明 ML 走的是相同流程（不给优待）",
    html.includes("没给它任何优待") || html.includes("完全相同"),
    "缺少公平性说明"
  );

  // ---- 校验：模块化标签页（V4.5 结构重构）----
  // 页面内容太多（21 个区块），改成模块 + 标签导航。这里断言切换真的有效，
  // 而不是"模板里有 nav 就算通过"——藏起来的模块必须能被点开。
  check("存在标签导航", !!registry["main-tabs"]);
  check("解析出至少 4 个标签", tabs.length >= 4, `实际 ${tabs.length}`);
  const moduleIds = [...html.matchAll(/<section class="module[^"]*" id="([^"]+)">/g)].map((m) => m[1]);
  check("页面中存在 5 个模块", moduleIds.length === 5, moduleIds.join(", "));
  check(
    "每个标签都指向一个真实存在的模块",
    tabs.every((t) => moduleIds.includes(t.dataset.target)),
    tabs.map((t) => t.dataset.target).join(", ") + " vs " + moduleIds.join(", ")
  );
  check(
    "初始恰好一个模块处于激活态",
    moduleIds.filter((id) => registry[id] && registry[id]._classes.has("is-active")).length === 1,
    moduleIds.map((id) => id + ":" + (registry[id] && registry[id]._classes.has("is-active"))).join(" ")
  );

  // 逐个点击每个标签，验证"点到哪个就只有哪个是激活的"
  let switchOk = true;
  const switchDetail = [];
  tabs.forEach((t) => {
    t.dispatch("click");
    const activeModules = moduleIds.filter((id) => registry[id] && registry[id]._classes.has("is-active"));
    const activeTabs = tabs.filter((x) => x._classes.has("is-active"));
    const ok = activeModules.length === 1 && activeModules[0] === t.dataset.target && activeTabs.length === 1;
    if (!ok) {
      switchOk = false;
      switchDetail.push(`${t.dataset.label}→[${activeModules.join(",")}]`);
    }
  });
  check("点击任一标签都能正确切换（且只有一个模块可见）", switchOk, switchDetail.join("; "));
  check("切换后 URL hash 同步更新（可分享/可刷新保持）", fakeLocation.hash.startsWith("#mod-"), fakeLocation.hash);
  check(
    "标签文案与模块内容对得上（号码 / 概率 / 策略 / 数据）",
    tabs.some((t) => /号码/.test(t.dataset.label)) &&
      tabs.some((t) => /概率/.test(t.dataset.label)) &&
      tabs.some((t) => /策略/.test(t.dataset.label)) &&
      tabs.some((t) => /数据/.test(t.dataset.label)),
    tabs.map((t) => t.dataset.label).join(" | ")
  );

  console.log("");
  console.log("-".repeat(78));
  if (failures === 0) {
    console.log("冒烟测试全部通过：页面上的交互工具在模拟浏览器环境下可正常工作。");
    console.log("（注意：这只验证逻辑与渲染，不验证视觉样式。）");
  } else {
    console.log(`冒烟测试失败 ${failures} 项 —— 页面交互很可能在真实浏览器里也是坏的。`);
    process.exit(1);
  }
}

main();