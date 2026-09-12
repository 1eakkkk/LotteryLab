// 数据清洗：把抓取到的原始双色球数据转换为项目标准格式
// 标准格式见方案第六节：{ period, date, red[6](两位数字符串), blue(两位数字符串), source, fetched_at }
// 注意：这里只做格式转换，排序防御留给回测引擎自己做（7.5节的强制升序防御），
// 但清洗后的 ssq.json 本身也以升序存储，方便直接查看。

const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "../data/ssq_source.json");
const OUT = path.join(__dirname, "../data/ssq.json");

const pad2 = (n) => String(n).padStart(2, "0");

function main() {
  const raw = JSON.parse(fs.readFileSync(SRC, "utf-8"));

  const cleaned = raw.map((rec) => {
    if (!Array.isArray(rec.redBalls) || rec.redBalls.length !== 6) {
      throw new Error(`期号 ${rec.issueNumber} 红球数量异常`);
    }
    if (typeof rec.blueBall !== "number") {
      throw new Error(`期号 ${rec.issueNumber} 蓝球字段异常`);
    }
    return {
      period: rec.issueNumber,
      date: rec.drawDate,
      red: [...rec.redBalls].sort((a, b) => a - b).map(pad2),
      blue: pad2(rec.blueBall),
      source: "gudaoxuri/lottery_history",
      fetched_at: new Date().toISOString(),
    };
  });

  // 按期号数值升序（防御"最新在前"的倒序陷阱，7.5节要求的防御在这里先做一遍，
  // 回测引擎入口处会再做一次，双重保险）
  cleaned.sort((a, b) => Number(a.period) - Number(b.period));

  // 校验：升序后期号应严格递增，且日期也应递增，否则说明数据有问题
  for (let i = 1; i < cleaned.length; i++) {
    if (Number(cleaned[i].period) <= Number(cleaned[i - 1].period)) {
      throw new Error(`期号未严格递增: ${cleaned[i - 1].period} -> ${cleaned[i].period}`);
    }
    if (new Date(cleaned[i].date) < new Date(cleaned[i - 1].date)) {
      throw new Error(`日期未递增: ${cleaned[i - 1].date} -> ${cleaned[i].date}`);
    }
  }

  fs.writeFileSync(OUT, JSON.stringify(cleaned, null, 2), "utf-8");
  console.log(`已生成 ${OUT}，共 ${cleaned.length} 期，区间 ${cleaned[0].period}(${cleaned[0].date}) ~ ${cleaned[cleaned.length - 1].period}(${cleaned[cleaned.length - 1].date})`);
}

main();
