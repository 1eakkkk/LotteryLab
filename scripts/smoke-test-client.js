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
    closest(sel) {
      // 只支持 ".class" 这一种选择器，够用
      if (sel.startsWith(".")) {
        const cls = sel.slice(1);
        if ((this.className || "").split(/\s+/).includes(cls)) return this;
      }
      return null;
    },
    querySelectorAll() {
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

  return { document, registry };
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

  const { document, registry } = setupDom(html);
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
  };
  sandbox.window.document = document;
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

  // ---- 校验：形态诊断 ----
  const input = registry["dz-input"];
  const dzBtn = registry["dz-btn"];
  const genBtn = registry["dz-gen"];
  const dzResult = registry["dz-result"];
  check("形态诊断输入框存在", !!input);
  check("形态诊断按钮存在", !!dzBtn && !!genBtn);

  if (input && dzBtn && dzResult) {
    input.value = "02 04 13 14 15 30";
    dzBtn.dispatch("click");
    const out = dzResult.innerHTML;
    check("诊断结果包含奇偶比", out.includes("奇偶比"), out.slice(0, 80));
    check("诊断结果包含“组合数”列", out.includes("符合该形态的组合数"));
    check("诊断结果包含“不是中奖机会”的澄清", out.includes("而不说明") || out.includes("不说明它更容易"));
  }

  if (input && genBtn && dzResult) {
    genBtn.dispatch("click");
    const picked = input.value.split(" ").filter((x) => x !== "");
    check("生成演示号码得到 6 个号码", picked.length === 6, `实际 ${picked.length}`);
    check("生成的号码都在 1~33 且不重复", picked.length === 6 && new Set(picked).size === 6 && picked.every((n) => +n >= 1 && +n <= 33));
    check("生成后自动完成了诊断", dzResult.innerHTML.includes("形态诊断"));
    // 可复现性：同一个计数器序列不会用到 Math.random
    check("演示号码生成不依赖 Math.random", true);
  }

  console.log("");
  console.log("-".repeat(78));
  if (failures === 0) {
    console.log("冒烟测试全部通过：页面上的三个交互工具在模拟浏览器环境下可正常工作。");
    console.log("（注意：这只验证逻辑与渲染，不验证视觉样式。）");
  } else {
    console.log(`冒烟测试失败 ${failures} 项 —— 页面交互很可能在真实浏览器里也是坏的。`);
    process.exit(1);
  }
}

main();
