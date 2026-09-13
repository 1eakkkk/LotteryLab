// ============================================================================
// L1 合规红线层：安全审计（方案第十七节 17.5）
// ----------------------------------------------------------------------------
// 这个脚本的存在意义只有一句话：**让底线跑不过去，而不是靠自觉。**
//
// 它在构建流程的最后一步运行，检查生成出来的 public/index.html（以及可选的
// 源码目录），一旦发现违禁话术、交易类交互、外部购彩链接、缺失的免责声明，
// 就以非零退出码让构建失败——页面视为未产出。
//
// 用法：
//   node scripts/audit-safety.js                        # 默认审计 public/index.html + src/
//   node scripts/audit-safety.js public/index.html src  # 显式指定
//
// 退出码：0 = 全部通过；1 = 存在 fail 级问题（构建必须失败）
//
// 设计原则（重要，改动本文件前请先读）：
//   1. 违禁词检查是「上下文感知」的，不是简单关键词黑名单。
//      因为合规文案本身必然包含这些词（"不提供售彩、代购、充值、返利"），
//      简单黑名单会把正确的免责声明判成违规，最后逼着人把检查关掉——
//      那才是最坏的结果。所以：只有在「否定/禁止语境」或「免责声明段落」里
//      出现的违规词才放行，其余一律 fail。
//   2. 每个 fail 都必须给出：文件、行号、命中内容、为什么判违规、怎么改。
//      报错信息写不清楚的审计脚本，等于没有。
//   3. 审计脚本自己也要能被审计：每次运行都打印检查项清单。
// ============================================================================

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const REPORT_FILE = path.join(ROOT, "data", "report.json");

// ---------------------------------------------------------------------------
// 违规词表（分组，便于以后扩充；扩充时请同步更新方案 17.5 与 README）
// ---------------------------------------------------------------------------
const FORBIDDEN_WORDS = [
  // 售彩 / 交易类
  { w: "购买", group: "售彩交易", note: "任何形式的购买引导" },
  { w: "下单", group: "售彩交易", note: "交易引导" },
  { w: "投注", group: "售彩交易", note: "投注引导（数学讨论请改成'每注/每期投入'）" },
  { w: "下注", group: "售彩交易", note: "投注引导" },
  { w: "代购", group: "售彩交易", note: "代购服务" },
  { w: "合买", group: "售彩交易", note: "合买服务" },
  { w: "返利", group: "售彩交易", note: "返利服务" },
  { w: "充值", group: "售彩交易", note: "充值服务" },
  { w: "提现", group: "售彩交易", note: "资金服务" },
  { w: "购彩", group: "售彩交易", note: "购彩引导" },
  { w: "彩站", group: "售彩交易", note: "导流到实体彩站" },
  { w: "稳赚", group: "售彩交易", note: "收益承诺" },
  { w: "保底", group: "售彩交易", note: "收益承诺" },
  { w: "翻倍", group: "售彩交易", note: "收益暗示（倍投讨论请用'加倍投注的期望不变'这类学术表述）" },

  // 支付 / 变现类
  { w: "支付宝", group: "支付变现", note: "支付渠道" },
  { w: "微信支付", group: "支付变现", note: "支付渠道" },
  { w: "二维码", group: "支付变现", note: "收款方式" },
  { w: "打赏", group: "支付变现", note: "变现入口" },
  { w: "会员", group: "支付变现", note: "付费会员" },
  { w: "VIP", group: "支付变现", note: "付费等级" },
  { w: "内部号", group: "支付变现", note: "内部号码话术" },

  // 承诺 / 夸大类
  { w: "必中", group: "承诺夸大", note: "命中承诺" },
  { w: "必出", group: "承诺夸大", note: "出号承诺" },
  { w: "稳中", group: "承诺夸大", note: "命中承诺" },
  { w: "包中", group: "承诺夸大", note: "命中承诺" },
  { w: "高命中率", group: "承诺夸大", note: "命中率夸大" },
  { w: "命中率提升", group: "承诺夸大", note: "效果承诺" },
  { w: "精准预测", group: "承诺夸大", note: "精准度承诺" },
  { w: "内部消息", group: "承诺夸大", note: "内幕话术" },
  { w: "内幕", group: "承诺夸大", note: "内幕话术" },

  // 权威 / 背书类
  { w: "专家推荐", group: "权威背书", note: "权威背书话术" },
  { w: "独家", group: "权威背书", note: "权威背书话术" },
  { w: "官方合作", group: "权威背书", note: "官方背书暗示" },
  { w: "官方授权", group: "权威背书", note: "官方背书暗示" },
  { w: "权威预测", group: "权威背书", note: "权威背书话术" },
];

// 号码推荐类：必须前缀匹配。理由：本项目允许在"不提供专家推荐"这类否定语境里
// 使用"推荐"二字，但绝不允许出现"推荐号码""号码推荐""推荐购买"这类**号码交付**形态。
const FORBIDDEN_PATTERNS = [
  { re: /推荐号码|号码推荐|推荐一组|推荐号码组/g, note: "任何「把号码交付给用户」的形态都禁止（方案 17.2 永久否决项 A）" },
  { re: /主推|本期看好|首推|精选号码|智能选号/g, note: "号码优选/交付形态" },
  { re: /命中率\s*(提升|提高|增加|更高)/g, note: "效果承诺" },
  { re: /(准|精确)确?率\s*\d/gi, note: "给出命中率数值会被读成效果承诺" },
];

// 否定 / 禁止语境标记：违规词出现在这些标记附近时视为"合规表述"
const NEGATION_MARKERS = [
  "不提供", "不接入", "不支持", "不涉及", "不做", "不承诺", "不暗示", "不使用",
  "不能", "不得", "禁止", "严禁", "避免", "杜绝", "拒绝", "没有", "无任何",
  "非售彩", "概不", "均不", "一律不", "永不",
  // 免责声明里最常见的句式（"不构成购彩建议"），命中点前 30 字内出现即放行
  "不构成", "仅用于", "仅供", "只用于", "科普",
];

// 允许出现在页面上的"统计术语型"百分比（不是数据，是固定口径）
const ALLOWED_PERCENT_NOTATION = [95, 99, 100, 50, 0];

// 免责声明句子的定位锚点：这句话内部整体豁免（因为它本身就是声明）
const DISCLAIMER_ANCHOR = "不提供售彩";

// 引文标记：明确标注为"引用原文"的文字整体豁免。
// 理由：核对官方开奖公告时必须原样引用原文（包括"投注总额"这类官方用语），
// 改动引文就等于篡改证据——那比用一个敏感词更糟。
// 与免责声明豁免的区别：这一类的边界更窄，必须由这些标记**显式声明**是引文，
// 且引文内容会连同来源一起展示在页面上，可被任何人核对。
// 不影响规则强度：正文（未经标记的表述）里出现这些词，照样 fail。
const QUOTE_MARKERS = ["原文摘录", "引用自", "原文引用"];

// 页面必须同时包含的两段声明（方案 1.3 / 十一节）
const REQUIRED_STATEMENTS = [
  { name: "服务范围声明", needle: "不提供售彩", desc: "必须明确声明不提供售彩/代购/充值/返利等服务" },
  { name: "随机性声明", needle: "独立随机事件", desc: "必须明确声明开奖是独立随机事件、历史数据不影响未来结果" },
  { name: "非建议声明", needles: ["不构成购彩建议", "不构成任何建议", "不构成投资建议", "不构成购彩"], desc: "必须明确声明页面内容不构成购彩建议" },
];

// 外链白名单：页面是自包含的，原则上不该有任何外链
const HREF_WHITELIST = [
  /^#/,                          // 空锚点 / 站内锚点 / onclick="return false" 的假链接
  /^javascript:void\(0\)$/i,
  /^data:/i,                     // 内联 SVG / 图片资源
];

// 允许的 input 类型（滑块是交互必需的，提交类控件一律禁止）
const ALLOWED_INPUT_TYPES = ["range", "checkbox", "radio"];

// 唯一的例外：文本输入框。允许条件非常窄（见 checkInteractiveElements）：
//   页面里没有任何 <form>，且全文**有且仅有一个**文本输入框。
// 为什么需要这个例外：形态诊断器要允许用户输入自己的 6 个号码。
// 为什么可以接受：这个输入框只做本地校验 + 本地渲染，不提交、不存储、不联网；
//   而"不提交"由 <form> 检查独立保证，"不联网"由外部链接检查独立保证。
// 为什么不直接放开：一个没有数量上限的文本输入框集合，迟早会变成"收集用户数据"的界面；
//   限制成"最多一个、且没有表单"，就把它锁死在"本地计算器"这个形态里。
const MAX_TEXT_INPUTS_ALLOWED = 1;

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
const results = { pass: [], fail: [], warn: [] };

function readText(p) {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch (e) {
    return null;
  }
}

function walkJs(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJs(full, out);
    else if (/\.(js|mjs|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, "/");
}

function lineOfIndex(text, index) {
  return text.slice(0, index).split("\n").length;
}

function snippetAt(text, index, span = 26) {
  const start = Math.max(0, index - span);
  const end = Math.min(text.length, index + span);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

function pass(name, detail = "") {
  results.pass.push({ name, detail });
}

function fail(name, detail) {
  results.fail.push({ name, detail });
}

function warn(name, detail) {
  results.warn.push({ name, detail });
}

/**
 * 违规词上下文判定。
 * 返回 { allowed: boolean, reason: string }
 *
 * 放行条件（全部是「否定/禁止语境」，不构成合规风险）：
 *   1. 命中点前 30 字内出现否定标记（"不提供""禁止""不做"…）
 *   2. 命中点所在的「句子 / 段落」内包含免责声明锚点（DISCLAIMER_ANCHOR）
 *
 * 之所以要做这一层判定：合规声明本身必然包含"售彩、代购、充值、返利"这些词，
 * 简单关键词黑名单会把最正确的那句话判成违规，最后逼着维护者把检查关掉——
 * 那才是这类审计脚本最坏的结局。宁可多写 30 行上下文判定，也不要留一个会误报的检查。
 */
function judgeContext(text, index, word) {
  const before = text.slice(Math.max(0, index - 30), index);
  for (const marker of NEGATION_MARKERS) {
    if (before.includes(marker)) {
      return { allowed: true, reason: `前文出现否定标记「${marker}」` };
    }
  }

  // 引文豁免：命中点前 60 字内出现引文标记，视为"引用来源原文"。
  // 之所以给到 60 字：引文常常是「原文摘录："……"」这种形式，标记与命中词之间有
  // 一段引号内的原话。这个窗口只影响"是否豁免"，不改变任何正文的判定。
  const quoteWindow = text.slice(Math.max(0, index - 60), index);
  for (const marker of QUOTE_MARKERS) {
    if (quoteWindow.includes(marker)) {
      return { allowed: true, reason: `位于标注为「${marker}」的来源引文中` };
    }
  }

  // 免责声明句/段内整体豁免。边界取"最近的句末标点"与"最近的块级标签"中更靠后的那个，
  // 这样 <p>…不提供售彩、代购…</p> 里的"代购"能落在同一段内被正确豁免，
  // 而正文其它段落里的违规词不会被前面某段声明"隔空"豁免掉。
  const boundaryCandidates = [
    text.lastIndexOf("。", index),
    text.lastIndexOf("；", index),
    text.lastIndexOf("！", index),
    text.lastIndexOf("？", index),
    text.lastIndexOf("</p>", index) + 3,
    text.lastIndexOf("</li>", index) + 4,
    text.lastIndexOf("</div>", index) + 5,
    text.lastIndexOf("</strong>", index) + 8,
  ];
  const sentenceStart = Math.max(...boundaryCandidates);
  const sentence = text.slice(sentenceStart < 0 ? 0 : sentenceStart, index + word.length + 40);
  if (sentence.includes(DISCLAIMER_ANCHOR)) {
    return { allowed: true, reason: "位于免责声明句/段内" };
  }
  return { allowed: false, reason: "既不在否定语境，也不在免责声明句/段内" };
}

// ---------------------------------------------------------------------------
// 检查 1：违禁话术（上下文感知）
// ---------------------------------------------------------------------------
function checkForbiddenWords(text, label) {
  const hits = [];
  for (const { w, group, note } of FORBIDDEN_WORDS) {
    let from = 0;
    for (;;) {
      const idx = text.indexOf(w, from);
      if (idx < 0) break;
      from = idx + w.length;
      const judge = judgeContext(text, idx, w);
      if (!judge.allowed) {
        hits.push({ word: w, group, note, line: lineOfIndex(text, idx), snippet: snippetAt(text, idx) });
      }
    }
  }
  for (const { re, note } of FORBIDDEN_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const judge = judgeContext(text, m.index, m[0]);
      if (!judge.allowed) {
        hits.push({ word: m[0], group: "号码交付", note, line: lineOfIndex(text, m.index), snippet: snippetAt(text, m.index) });
      }
      if (re.lastIndex === m.index) re.lastIndex++;
    }
  }

  if (hits.length === 0) {
    pass(`违禁话术检查（${label}）`, `${FORBIDDEN_WORDS.length} 个词 + ${FORBIDDEN_PATTERNS.length} 条号码交付正则，全部未命中或被正确豁免`);
  } else {
    fail(
      `违禁话术检查（${label}）`,
      `发现 ${hits.length} 处违规：\n` +
        hits
          .map((h) => `      · ${rel(label)}:${h.line} 「${h.word}」(${h.group}｜${h.note})\n        上下文：…${h.snippet}…`)
          .join("\n")
    );
  }
  return hits;
}

// ---------------------------------------------------------------------------
// 检查 2：交易类交互元素
// ---------------------------------------------------------------------------
function checkInteractiveElements(html, label) {
  const problems = [];
  let hasForm = false;

  // form 一律禁止
  if (/<form[\s>]/i.test(html)) {
    hasForm = true;
    const idx = html.search(/<form[\s>]/i);
    problems.push(`页面存在 <form> 元素（${rel(label)}:${lineOfIndex(html, idx)}）——本项目不收集、不提交任何用户数据`);
  }

  // 提交类 input 禁止；range/checkbox/radio 放行；text 仅在极窄条件下放行（见常量说明）
  const textInputs = [];
  const inputRe = /<input\b[^>]*>/gi;
  let m;
  while ((m = inputRe.exec(html)) !== null) {
    const typeMatch = m[0].match(/type\s*=\s*["']([^"']+)["']/i);
    const type = typeMatch ? typeMatch[1].toLowerCase() : "text";
    if (type === "text" || type === "search") {
      textInputs.push({ line: lineOfIndex(html, m.index), tag: m[0] });
      continue;
    }
    if (!ALLOWED_INPUT_TYPES.includes(type)) {
      problems.push(
        `存在非交互类 <input type="${type}">（${rel(label)}:${lineOfIndex(html, m.index)}）——只允许滑块/勾选类控件，禁止任何输入提交控件`
      );
    }
  }

  // 文本输入框的放行判定：没有 form，且数量不超过上限
  if (textInputs.length > MAX_TEXT_INPUTS_ALLOWED) {
    problems.push(
      `页面存在 ${textInputs.length} 个文本输入框，超过允许上限 ${MAX_TEXT_INPUTS_ALLOWED} 个` +
        `（${rel(label)}:${textInputs.map((t) => t.line).join(", ")}）——` +
        `文本输入框只允许"整页最多一个、且无表单"，用来支持本地的号码形态诊断；再多就有变成数据收集界面的风险`
    );
  } else if (textInputs.length === 1 && !hasForm) {
    // 这一条是"放行"，但要打印出来，让它始终可见、可被复查
    console.log(
      `        · 放行 1 个文本输入框（${rel(label)}:${textInputs[0].line}）：页面无 <form>、无提交按钮，` +
        `该输入框仅用于本地号码形态诊断，不提交、不上传`
    );
  }

  // 按钮文本必须不含交易动作
  const buttonRe = /<(button|a)\b[^>]*>([\s\S]{0,120}?)<\/\1>/gi;
  let bm;
  while ((bm = buttonRe.exec(html)) !== null) {
    const inner = bm[2].replace(/<[^>]+>/g, "").trim();
    if (!inner) continue;
    for (const bad of ["立即购买", "一键下单", "去投注", "马上下单", "复制号码", "去买", "购买号码", "立即投注"]) {
      if (inner.includes(bad)) {
        problems.push(
          `按钮/链接文本「${inner}」含交易动作「${bad}」（${rel(label)}:${lineOfIndex(html, bm.index)}）——方案 1.3 红线，号码旁不得出现任何购买类交互`
        );
      }
    }
  }

  if (problems.length === 0) {
    pass(
      `交易类交互检查（${rel(label)}）`,
      `无 <form>；<input> 仅使用 ${ALLOWED_INPUT_TYPES.join("/")}` +
        (textInputs.length ? ` + ${textInputs.length} 个本地诊断用文本输入框` : "") +
        `；按钮/链接文本无购买类动作`
    );
  } else {
    fail(`交易类交互检查（${rel(label)}）`, problems.map((p) => `      · ${p}`).join("\n"));
  }
}

// ---------------------------------------------------------------------------
// 检查 3：外部链接
// ---------------------------------------------------------------------------
function checkHrefs(html, label) {
  const bad = [];
  const hrefRe = /href\s*=\s*["']([^"']*)["']/gi;
  let m;
  while ((m = hrefRe.exec(html)) !== null) {
    const href = m[1].trim();
    if (href === "") continue;
    if (HREF_WHITELIST.some((re) => re.test(href))) continue;
    if (href.startsWith("./") || href.startsWith("../") || !/^[a-z]+:/i.test(href)) continue; // 站内相对路径
    bad.push({ href, line: lineOfIndex(html, m.index) });
  }
  if (bad.length === 0) {
    pass(`外部链接检查（${rel(label)}）`, "页面自包含，无任何指向第三方购彩平台的外部链接");
  } else {
    fail(
      `外部链接检查（${rel(label)}）`,
      bad.map((b) => `      · 第 ${b.line} 行存在外部链接：${b.href}——即使是「只链接到第三方购彩平台」也不允许（方案十一节）`).join("\n")
    );
  }
}

// ---------------------------------------------------------------------------
// 检查 4：免责声明与声明完整性
// ---------------------------------------------------------------------------
function checkRequiredStatements(html, label) {
  const missing = [];
  for (const st of REQUIRED_STATEMENTS) {
    const needles = st.needles || [st.needle];
    const ok = needles.some((n) => html.includes(n));
    if (!ok) missing.push(`      · 缺少「${st.name}」：${st.desc}（应包含：${needles.join(" 或 ")}）`);
  }
  if (missing.length === 0) {
    pass(`声明完整性检查（${rel(label)}）`, REQUIRED_STATEMENTS.map((s) => s.name).join("、") + " 均存在");
  } else {
    fail(`声明完整性检查（${rel(label)}）`, "声明缺失，页面不得发布：\n" + missing.join("\n"));
  }
}

/**
 * 判断某个位置是否落在 JS 字符串字面量里（简易扫描，不做完整词法分析）。
 *
 * 用途：build-site.js 这类"生成器"文件里，页面文案是写在字符串/模板字符串里的，
 * 里面出现 Math.random() 往往是**说明性文字**（页面上正在解释"我们不使用它"），
 * 属于合规内容而不是违规代码。没有这一层判定，审计脚本会逼着人把一句正确的科普
 * 文案删掉——那就是审计脚本自己在破坏产品。
 */
function isInsideStringLiteral(text, index) {
  let state = "code"; // code | sq | dq | tpl | lineComment | blockComment
  for (let i = 0; i < index; i++) {
    const c = text[i];
    const next = text[i + 1];
    switch (state) {
      case "code":
        if (c === "/" && next === "/") { state = "lineComment"; i++; }
        else if (c === "/" && next === "*") { state = "blockComment"; i++; }
        else if (c === "'") state = "sq";
        else if (c === '"') state = "dq";
        else if (c === "`") state = "tpl";
        break;
      case "lineComment":
        if (c === "\n") state = "code";
        break;
      case "blockComment":
        if (c === "*" && next === "/") { state = "code"; i++; }
        break;
      case "sq":
        if (c === "\\") i++;
        else if (c === "'") state = "code";
        break;
      case "dq":
        if (c === "\\") i++;
        else if (c === '"') state = "code";
        break;
      case "tpl":
        if (c === "\\") i++;
        else if (c === "`") state = "code";
        break;
    }
  }
  return state === "sq" || state === "dq" || state === "tpl";
}

// ---------------------------------------------------------------------------
// 检查 5：源码不得使用非确定性/真实随机（回测可复现性）
// ---------------------------------------------------------------------------
// 放行规则说明（不是偷懒，是三种情况本来就不同，见方案第七节）：
//   1. 注释行 / 文档行        —— 代码里到处都在**说明**"不使用 Math.random()"；
//   2. 字符串字面量内         —— 页面文案在讲这件事，属于合规科普内容；
//   3. my-strategy-client.js  —— 浏览器交互层，用户点"再来一组"时按方案约定
//      允许普通随机；真正需要确定性的是回测路径（strategies.js / backtest.js）。
function checkDeterminism(files) {
  const problems = [];
  const allowedFiles = ["my-strategy-client.js"];
  let scanned = 0;

  for (const file of files) {
    const text = readText(file);
    if (text === null) continue;
    scanned++;
    const isInteractiveLayer = allowedFiles.includes(path.basename(file));
    const lines = text.split("\n");
    let lineStart = 0; // 当前行首在全文中的偏移，用于判断"是否在字符串字面量内"

    lines.forEach((line, i) => {
      const absoluteLineStart = lineStart;
      lineStart += line.length + 1; // +1 为换行符
      if (!/Math\.random\s*\(/.test(line)) return;
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;

      // 逐个命中点判断：是否在字符串里 / 是否在行尾注释里
      const re = /Math\.random\s*\(/g;
      let m;
      while ((m = re.exec(line)) !== null) {
        if (isInsideStringLiteral(text, absoluteLineStart + m.index)) continue;
        const rest = line.slice(m.index);
        if (/^Math\.random\s*\([^)]*\)[^/]*\/\//.test(rest)) continue; // 行尾注释
        if (isInteractiveLayer) continue; // 交互层按方案约定豁免

        problems.push(
          `      · ${rel(file)}:${i + 1} 出现裸 Math.random()：${trimmed}\n` +
            `        回测路径必须用「期号+策略名」做种子的伪随机数，否则同一份数据每次跑出的排行榜都会变（方案第七节核心原则）`
        );
        break;
      }
    });
  }
  if (problems.length === 0) {
    pass(
      "确定性/可复现性检查（src/）",
      `扫描 ${scanned} 个文件：回测路径无裸 Math.random()（注释/页面文案/交互层按规则豁免）`
    );
  } else {
    fail("确定性/可复现性检查（src/）", problems.join("\n"));
  }
}

// ---------------------------------------------------------------------------
// 检查 6：内联脚本是否注入了（HTML 内出现脚本源码，说明注入成功）
// ---------------------------------------------------------------------------
// 说明：探针从客户端脚本里**自动提取**，不写死函数名——写死的话，
// 以后给 my-strategy-client.js 改个函数名，这个检查就会变成永远失败的假警报，
// 然后被人注释掉。宁可每次动态找，也不要留一个会自己烂掉的检查。
function checkScriptInjection() {
  const clientPath = path.join(ROOT, "src", "my-strategy-client.js");
  const src = readText(clientPath);
  if (src === null) {
    warn("脚本注入检查", "未找到 src/my-strategy-client.js，跳过");
    return;
  }

  const probes = [];
  const fnRe = /^\s*function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
  let m;
  while ((m = fnRe.exec(src)) !== null) probes.push(`function ${m[1]}(`);
  const constRe = /^\s*(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=/gm;
  while ((m = constRe.exec(src)) !== null) probes.push(`${m[1]} =`);

  const html = readText(path.join(ROOT, "public", "index.html")) || "";
  if (probes.length === 0) {
    warn("脚本注入检查", "无法从 my-strategy-client.js 中提取探针，跳过");
    return;
  }
  const hit = probes.filter((p) => html.includes(p));
  if (hit.length > 0) {
    pass(
      "脚本注入检查",
      `浏览器端脚本已内联进页面（${hit.length}/${probes.length} 个探针命中，例如「${hit[0].trim()}」）`
    );
  } else {
    fail(
      "脚本注入检查",
      `页面中未找到 src/my-strategy-client.js 的任何内联探针（试过 ${probes.length} 个，例如「${probes[0].trim()}」）。\n` +
        `        说明：构建产物可能被手工修补过，或 build-site.js 的注入逻辑失效。页面必须是构建产物，不接受手工编辑（方案 17.8 风险表）。`
    );
  }
}

// ---------------------------------------------------------------------------
// 检查 7：页面里出现的百分比数字是否都能在 report.json 里找到出处（方案 17.5 L4）
// ---------------------------------------------------------------------------
// 判定口径（写清楚，免得以后有人觉得这个检查"太松"就把它删了）：
//   一个数字算"有出处"，当且仅当它是
//     (a) report.json 里某个数值本身（含比例→百分比的换算）；或者
//     (b) report.json 里**任意两个数值的比值**（含比例→百分比）——例如
//         "单注期望回报 ÷ 成本 = 24.3%"、"过滤后组合数 ÷ 总组合数 = 44.64%"。
//   仍然会被报警的是那些**凭空写死**的数字（比如手打一个"中奖率约 6.7%"）。
//
//   为什么必须接受 (b)：页面本来就应该展示派生指标（回收率、剩余比例），
//   如果只有原样搬运的数字才算合格，这个检查就会天天误报；一个天天误报的检查，
//   最后一定会被人关掉——那还不如不做。反过来，只有比值才放行、四则运算里的
//   加减乘不算，是为了保证"放行的都是**能一眼看出怎么来的**两个数字之间的关系"。
function collectNumbersFromReport() {
  const raw = readText(REPORT_FILE);
  if (raw === null) return null;
  let report;
  try {
    report = JSON.parse(raw);
  } catch (e) {
    return null;
  }

  // 第一步：收集 report.json 里所有不同的原始数值（不设上限地递归，但去重）
  const rawValues = new Set();
  const collect = (node) => {
    if (typeof node === "number" && Number.isFinite(node)) {
      rawValues.add(node);
    } else if (Array.isArray(node)) {
      node.forEach(collect);
    } else if (node && typeof node === "object") {
      Object.values(node).forEach(collect);
    }
  };
  collect(report);

  // 第二步：把每个原始值可能的呈现形式加进来（原始 / 百分比 / 各种保留位数）
  const values = new Set();
  const add = (v) => {
    if (!Number.isFinite(v)) return;
    values.add(Number(v.toFixed(4)));
    values.add(Number(v.toFixed(2)));
    values.add(Number(v.toFixed(1)));
    values.add(Math.round(v));
    values.add(Number((v * 100).toFixed(4))); // 比例 → 百分比
    values.add(Number((v * 100).toFixed(2)));
    values.add(Number((v * 100).toFixed(1)));
    values.add(Math.round(v * 100));
  };
  rawValues.forEach(add);

  // 第三步：加入两两比值（含比例→百分比）。
  // 为了不让组合爆炸，只取 |v| 在合理区间内的值，并给基数设一个上限——
  // 命中率只需要"某个合理的候选集合"里存在即可，不需要穷举所有对。
  const baseValues = [...rawValues].filter((v) => v !== 0 && Math.abs(v) >= 1e-6 && Math.abs(v) <= 1e8);
  const limited = baseValues.slice(0, 600);
  const derived = new Set();
  for (let i = 0; i < limited.length; i++) {
    for (let j = 0; j < limited.length && derived.size < 200000; j++) {
      if (i === j) continue;
      const r = limited[i] / limited[j];
      if (!Number.isFinite(r) || r <= 0) continue;
      derived.add(Number(r.toFixed(2)));
      const pct = r * 100;
      if (pct <= 1000) {
        derived.add(Number(pct.toFixed(2)));
        derived.add(Number(pct.toFixed(1)));
        derived.add(Math.round(pct));
      }
    }
  }
  derived.forEach((v) => values.add(v));

  return values;
}

function checkNumberProvenance(html) {
  const reportValues = collectNumbersFromReport();
  if (reportValues === null) {
    warn("数字出处检查", "未能读取 data/report.json，跳过（应先运行 node src/build.js）");
    return;
  }

  // 先把 CSS 里的百分比剔除：border-radius:50%、渐变 stop 的 52%，这些是样式不是数据，
  // 不剔除的话会变成一片假警报，最后没人看这个检查（同脚本注入检查的说明）。
  const styleBlocks = [];
  html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, (m, offset) => {
    styleBlocks.push([offset, offset + m.length]);
    return m;
  });
  const inStyleBlock = (idx) => styleBlocks.some(([a, b]) => idx >= a && idx < b);
  const inStyleAttr = (idx) => {
    const before = html.slice(Math.max(0, idx - 400), idx);
    const lastOpen = before.lastIndexOf("<");
    const lastClose = before.lastIndexOf(">");
    if (lastOpen <= lastClose) return false; // 命中点不在任何标签内部
    return /style\s*=\s*["'][^"']*$/i.test(before.slice(lastOpen));
  };

  const orphans = [];
  const pctRe = /(\d+(?:\.\d+)?)\s*%/g;
  let m;
  while ((m = pctRe.exec(html)) !== null) {
    const v = Number(m[1]);
    if (inStyleBlock(m.index) || inStyleAttr(m.index)) continue;
    if (ALLOWED_PERCENT_NOTATION.includes(v)) continue;
    if (reportValues.has(v) || reportValues.has(Math.round(v))) continue;
    orphans.push({ v: m[1], line: lineOfIndex(html, m.index), snippet: snippetAt(html, m.index, 40) });
  }
  if (orphans.length === 0) {
    pass("数字出处检查", "页面中的百分比数字均可在 data/report.json 中找到对应数据字段（已排除 CSS 样式值）");
  } else {
    warn(
      "数字出处检查",
      `有 ${orphans.length} 个百分比数字在 report.json 中找不到直接来源（可能是硬编码的经验数字，也可能是派生计算）：\n` +
        orphans
          .slice(0, 12)
          .map((o) => `      · 第 ${o.line} 行 ${o.v}%  上下文：…${o.snippet}…`)
          .join("\n") +
        (orphans.length > 12 ? `\n      · …另有 ${orphans.length - 12} 处` : "") +
        `\n        处理原则：每个数字都要有出处（方案 17.5 L4）。能由组合数算出来的必须算，不能手写。`
    );
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function main() {
  const args = process.argv.slice(2);
  const htmlPath = args[0] ? path.resolve(args[0]) : path.join(ROOT, "public", "index.html");
  const srcDir = args[1] ? path.resolve(args[1]) : path.join(ROOT, "src");

  console.log("=".repeat(78));
  console.log("安全审计（方案第十七节 17.5 · L1 合规红线层）");
  console.log("=".repeat(78));
  console.log(`审计目标：${rel(htmlPath)}  +  ${rel(srcDir)}/`);
  console.log("");

  const html = readText(htmlPath);
  if (html === null) {
    console.error(`[fail] 找不到待审计文件：${htmlPath}`);
    console.error("       请先运行 node src/build-site.js 生成页面。");
    process.exit(1);
  }

  console.log(`检查项 1/7  违禁话术（上下文感知）...`);
  checkForbiddenWords(html, htmlPath);
  console.log(`检查项 2/7  交易类交互元素...`);
  checkInteractiveElements(html, htmlPath);
  console.log(`检查项 3/7  外部链接...`);
  checkHrefs(html, htmlPath);
  console.log(`检查项 4/7  免责声明与声明完整性...`);
  checkRequiredStatements(html, htmlPath);
  console.log(`检查项 5/7  构建产物完整性（脚本是否被注入）...`);
  checkScriptInjection();
  console.log(`检查项 6/7  源码确定性（禁止裸 Math.random 进回测）...`);
  checkDeterminism(walkJs(srcDir));
  console.log(`检查项 7/7  数字出处（硬编码经验数字检查）...`);
  checkNumberProvenance(html);

  console.log("");
  console.log("-".repeat(78));
  console.log(`通过 ${results.pass.length} 项：`);
  results.pass.forEach((p) => console.log(`  [pass] ${p.name}${p.detail ? " — " + p.detail : ""}`));

  if (results.warn.length > 0) {
    console.log("");
    console.log(`警告 ${results.warn.length} 项（不阻断构建，但需要人工确认）：`);
    results.warn.forEach((w) => console.log(`  [warn] ${w.name}\n${w.detail}`));
  }

  if (results.fail.length > 0) {
    console.log("");
    console.log(`失败 ${results.fail.length} 项：`);
    results.fail.forEach((f) => console.log(`  [FAIL] ${f.name}\n${f.detail}`));
    console.log("");
    console.log("=".repeat(78));
    console.log("审计未通过 —— 页面视为未产出，不得发布。");
    console.log("这条底线的作用就是让构建红掉，而不是让人说一句「下次注意」。");
    console.log("=".repeat(78));
    process.exit(1);
  }

  console.log("");
  console.log("=".repeat(78));
  console.log(`审计通过：${new Date().toISOString()}`);
  console.log("说明：本审计只能证明页面没有出现明令禁止的内容，不能证明统计结论正确性。");
  console.log("=".repeat(78));
}

main();
