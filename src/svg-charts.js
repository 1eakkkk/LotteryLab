// 构建期生成静态 SVG 图表（不依赖任何前端图表库，保证离线可打开、零依赖）。

function scaleLinear(domain, range) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  return (v) => r0 + ((v - d0) / span) * (r1 - r0);
}

/**
 * 折线图：多条 series，每条 series 是 [{x, y}, ...]
 * extraLines: 额外的水平参考线（如理论期望值）
 */
function lineChart({ series, width = 720, height = 320, padding = { top: 20, right: 24, bottom: 36, left: 48 }, yLabel = "", xTicks = [], horizontalRefs = [] }) {
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  const allX = series.flatMap((s) => s.points.map((p) => p.x));
  const allY = series.flatMap((s) => s.points.map((p) => p.y)).concat(horizontalRefs.map((r) => r.y));

  const xDomain = [Math.min(...allX), Math.max(...allX)];
  const yMin = Math.min(...allY);
  const yMax = Math.max(...allY);
  const yPad = (yMax - yMin) * 0.1 || 0.1;
  const yDomain = [yMin - yPad, yMax + yPad];

  const sx = scaleLinear(xDomain, [padding.left, padding.left + innerW]);
  const sy = scaleLinear(yDomain, [padding.top + innerH, padding.top]);

  const pathFor = (points) =>
    points.map((p, i) => `${i === 0 ? "M" : "L"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ");

  let svg = `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" class="chart" role="img" aria-label="${yLabel}">`;

  // y轴网格线 + 刻度
  const yTickCount = 5;
  for (let i = 0; i <= yTickCount; i++) {
    const v = yDomain[0] + ((yDomain[1] - yDomain[0]) * i) / yTickCount;
    const y = sy(v);
    svg += `<line x1="${padding.left}" y1="${y.toFixed(1)}" x2="${padding.left + innerW}" y2="${y.toFixed(1)}" class="grid-line" />`;
    svg += `<text x="${padding.left - 8}" y="${(y + 4).toFixed(1)}" class="axis-label" text-anchor="end">${v.toFixed(2)}</text>`;
  }

  // x轴刻度（用传入的 xTicks: [{x, label}]）
  xTicks.forEach(({ x, label }) => {
    const px = sx(x);
    svg += `<text x="${px.toFixed(1)}" y="${height - 10}" class="axis-label" text-anchor="middle">${label}</text>`;
  });

  // 水平参考线
  horizontalRefs.forEach((ref) => {
    const y = sy(ref.y);
    svg += `<line x1="${padding.left}" y1="${y.toFixed(1)}" x2="${padding.left + innerW}" y2="${y.toFixed(1)}" class="ref-line ${ref.className || ""}" stroke-dasharray="5,4" />`;
    svg += `<text x="${padding.left + innerW}" y="${(y - 6).toFixed(1)}" class="ref-label ${ref.className || ""}" text-anchor="end">${ref.label}</text>`;
  });

  // 数据线
  series.forEach((s) => {
    svg += `<path d="${pathFor(s.points)}" class="line ${s.className || ""}" fill="none" />`;
  });

  svg += `</svg>`;
  return svg;
}

/**
 * 直方图：bins = [{bucket, count}], markers = [{x, label, className}] 用于标出各策略均命中在分布中的位置
 */
function histogram({ bins, width = 720, height = 280, padding = { top: 20, right: 24, bottom: 40, left: 48 }, markers = [] }) {
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  const xs = bins.map((b) => b.bucket);
  const xDomain = [Math.min(...xs, ...markers.map((m) => m.x)), Math.max(...xs, ...markers.map((m) => m.x))];
  const maxCount = Math.max(...bins.map((b) => b.count));

  const sx = scaleLinear(xDomain, [padding.left, padding.left + innerW]);
  const sy = scaleLinear([0, maxCount], [padding.top + innerH, padding.top]);

  const barWidth = innerW / bins.length;

  let svg = `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" class="chart" role="img" aria-label="蒙特卡洛随机分布直方图">`;

  bins.forEach((b) => {
    const x = sx(b.bucket) - barWidth / 2;
    const y = sy(b.count);
    const barH = padding.top + innerH - y;
    svg += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(barWidth - 1, 1).toFixed(1)}" height="${barH.toFixed(1)}" class="hist-bar" />`;
  });

  // x轴刻度
  const tickCount = 6;
  for (let i = 0; i <= tickCount; i++) {
    const v = xDomain[0] + ((xDomain[1] - xDomain[0]) * i) / tickCount;
    const x = sx(v);
    svg += `<text x="${x.toFixed(1)}" y="${height - 20}" class="axis-label" text-anchor="middle">${v.toFixed(2)}</text>`;
  }

  // 策略均值标记（竖线 + 标签）
  markers.forEach((m, i) => {
    const x = sx(m.x);
    svg += `<line x1="${x.toFixed(1)}" y1="${padding.top}" x2="${x.toFixed(1)}" y2="${padding.top + innerH}" class="marker-line ${m.className || ""}" />`;
    svg += `<text x="${x.toFixed(1)}" y="${padding.top + 14 + i * 16}" class="marker-label ${m.className || ""}" text-anchor="middle">${m.label}</text>`;
  });

  svg += `</svg>`;
  return svg;
}

module.exports = { lineChart, histogram };
