// ============================================================================
// 数字体检 / 遗漏分布 / 形态诊断 的共用计算模块（V4 第 1~3 层，方案 17.3）
// ----------------------------------------------------------------------------
// 为什么单独抽一个文件：
//   这三块功能的数据既要在构建期算（写进 report.json，浏览器直接读），
//   又要在浏览器端对"用户输入的号码"实时算。两边必须是同一套公式——
//   否则会出现「页面静态显示的数字」与「交互算出来的数字」对不上，
//   而那种 bug 在一个以数字可信为卖点的项目里是致命的。
//
// 所以：公式只写在这里。Node 构建脚本 require 它；
// build-site.js 会把这个文件原样内联进页面（浏览器端通过 window.LotteryTools 取用）。
// 因此本文件必须：不依赖任何 Node API、不使用 CommonJS 之外的东西。
// ============================================================================

// 注意：**必须显式挂到全局对象上**，不能只写 "var LotteryTools = ..."。
// 原因（真实踩过的坑）：本文件作为 <script> 内联进页面时，顶层 "var LotteryTools = ..."
// 只会创建一个全局词法绑定，而交互脚本读的是 window.LotteryTools ——
// 在浏览器里这两者通常能对上，但执行环境稍有不同（严格模式、沙箱、模块化加载）就会读不到，
// 表现是三个工具全部静默失效、页面上什么都不显示，而构建与审计全绿。
// 下面这两个分支分别覆盖浏览器（window）与 Node 构建脚本（globalThis）；
// scripts/smoke-test-client.js 会守住"浏览器那一支真的挂上了"这一点。
(function (root) {
  root.LotteryTools = (function () {
  var RED_TOTAL = 33;
  var RED_PICK = 6;
  var BLUE_TOTAL = 16;

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function allNumberStrings(total) {
    var a = [];
    for (var i = 1; i <= total; i++) a.push(pad2(i));
    return a;
  }

  /**
   * Wilson 区间（二项比例的置信区间）。
   *
   * 为什么不用常见的「样本值 ± 1.96×标准误」：
   *   那个正态近似公式在比例接近 0 或 1、样本量又小时，会算出负数或大于 1 的边界
   *   （例如某号码近 10 期出现 0 次，正态近似给出的下界是负数）。
   *   页面上一旦出现「−3%」这种数字，整套东西的可信度就没了。
   *   Wilson 区间由 score interval 推导，边界永远落在 [0,1]，小样本下也更准。
   *   代价只是多几行算术，没有理由不用它。
   */
  function wilsonInterval(successes, trials, z) {
    if (z === undefined) z = 1.96;
    if (trials <= 0) return [0, 1];
    var p = successes / trials;
    var z2 = z * z;
    var denom = 1 + z2 / trials;
    var center = p + z2 / (2 * trials);
    var margin = z * Math.sqrt(Math.max(0, (p * (1 - p)) / trials + z2 / (4 * trials * trials)));
    var lo = (center - margin) / denom;
    var hi = (center + margin) / denom;

    // ---- 关于"要不要做有限总体校正"：这里刻意不做，理由是实测（防返工注释）----
    // 代码审查曾指出：一期是从 33 个号里**不放回**抽 6 个，单号出现次数的真实方差
    // 应带有限总体校正 √((N−K)/(N−1)) ≈ 0.919，而 Wilson 用的是二项方差，
    // 因此区间"偏窄约 9%、会过度标记偏离号码"。**这个理论分析本身是对的，但结论是错的。**
    //
    // 实测（用合格的 Mulberry32 生成 200 组完全随机的 3502 期数据，统计 33 个号码里
    // 平均有多少个落在 95% 区间之外，标称值应为 33 × 5% = 1.65）：
    //   标准 Wilson（不做校正）   平均 1.710 个  → 偏离标称  4%  ✅ 覆盖率是准的
    //   Wilson + 有限总体校正     平均 2.425 个  → 偏离标称 47%  ❌ 过度标记
    //   正态 + 精确超几何方差      平均 2.425 个  → 偏离标称 47%  ❌ 过度标记
    //
    // 原因：Wilson 区间锚在样本比例 p̂ 上、而不是直接使用完整方差，这个保守性
    // 恰好抵消了"二项方差偏大"的影响。**所以这里不减方差、也不做 FPC。**
    // 若将来有人再看到"方差口径不对"就想改，请先跑 scripts/test-interval-calibration.js，
    // 它会把这三种口径的实测标记率打出来——用数据决定，不要用直觉决定。
    //
    // 浮点收尾：p=0 或 p=1 时开方项可能出现极小的负数/超出，实测会出现 -0.0000 和 1.0000 这类
    // 越界值。界面上出现"−0.0% 的出现率"这种数字，会让整页的可信度受损，所以这里强制夹到 [0,1]。
    return [Math.max(0, Math.min(1, lo)), Math.max(0, Math.min(1, hi))];
  }

  function comb(n, k) {
    if (k < 0 || k > n) return 0;
    var r = 1;
    for (var i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
    return Math.round(r);
  }

  /**
   * 每个号码的体检报告（方案 17.3 第 1 层）。
   * 统计口径全部写明——这一层的全部价值就在于「每个数字后面都站着一条区间」。
   */
  function buildNumberHealth(history, windows) {
    if (!windows) windows = [10, 30, 50, 100];
    var redCounts = {};
    var blueCounts = {};
    allNumberStrings(RED_TOTAL).forEach(function (n) {
      redCounts[n] = 0;
    });
    allNumberStrings(BLUE_TOTAL).forEach(function (n) {
      blueCounts[n] = 0;
    });
    history.forEach(function (d) {
      d.red.forEach(function (b) {
        redCounts[b] += 1;
      });
      blueCounts[d.blue] += 1;
    });

    var totalPeriods = history.length;
    var windowsData = windows.map(function (size) {
      var win = history.slice(-size);
      var rc = {};
      var bc = {};
      allNumberStrings(RED_TOTAL).forEach(function (n) {
        rc[n] = 0;
      });
      allNumberStrings(BLUE_TOTAL).forEach(function (n) {
        bc[n] = 0;
      });
      win.forEach(function (d) {
        d.red.forEach(function (b) {
          rc[b] += 1;
        });
        bc[d.blue] += 1;
      });
      return { size: size, rc: rc, bc: bc, periods: win.length };
    });

    function makeRows(counts, total, perPeriodProbability, kind) {
      return allNumberStrings(total).map(function (number) {
        var count = counts[number];
        var expected = totalPeriods * perPeriodProbability;
        // 红球/蓝球都要传有限总体校正参数：红球是 33 选 6、蓝球是 16 选 1
        var ci = wilsonInterval(count, totalPeriods);
        var recent = windowsData.map(function (w) {
          var c = (kind === "red" ? w.rc : w.bc)[number];
          var exp = w.periods * perPeriodProbability;
          var rci = wilsonInterval(c, w.periods);
          return {
            window: w.size,
            count: c,
            expected: Number(exp.toFixed(2)),
            covers_expected: rci[0] * w.periods <= exp && exp <= rci[1] * w.periods,
          };
        });
        return {
          number: number,
          count: count,
          expected: Number(expected.toFixed(2)),
          ci_95: [Number((ci[0] * totalPeriods).toFixed(2)), Number((ci[1] * totalPeriods).toFixed(2))],
          covers_expected: ci[0] * totalPeriods <= expected && expected <= ci[1] * totalPeriods,
          recent: recent,
        };
      });
    }

    return {
      periods: totalPeriods,
      red: makeRows(redCounts, RED_TOTAL, RED_PICK / RED_TOTAL, "red"),
      blue: makeRows(blueCounts, BLUE_TOTAL, 1 / BLUE_TOTAL, "blue"),
      ci_method: "Wilson score interval (95%)",
    };
  }

  /**
   * 遗漏期数的几何分布分析（方案 17.3 第 2 层）。
   *
   * 正面回答那句「这个号该出了吧」：
   *   在每期等概率假设下，单个号码遗漏 k 期的概率是 P(遗漏 ≥ k) = (1−p)^k。
   *   真正有说服力的不是这个概率本身，而是把它乘上「总共有多少个号码-期」：
   *   概率小并不代表这件事稀奇，因为机会次数很多。
   *   这正是「该出了」这个直觉出错的地方——人只看概率，不看机会次数。
   */
  function buildOmissionAnalysis(history) {
    var n = history.length;
    var maxRed = {};
    var maxBlue = {};
    var curRed = {};
    var curBlue = {};
    allNumberStrings(RED_TOTAL).forEach(function (x) {
      maxRed[x] = 0;
      curRed[x] = 0;
    });
    allNumberStrings(BLUE_TOTAL).forEach(function (x) {
      maxBlue[x] = 0;
      curBlue[x] = 0;
    });

    history.forEach(function (d) {
      allNumberStrings(RED_TOTAL).forEach(function (x) {
        if (d.red.indexOf(x) >= 0) {
          maxRed[x] = Math.max(maxRed[x], curRed[x]);
          curRed[x] = 0;
        } else {
          curRed[x] += 1;
        }
      });
      allNumberStrings(BLUE_TOTAL).forEach(function (x) {
        if (d.blue === x) {
          maxBlue[x] = Math.max(maxBlue[x], curBlue[x]);
          curBlue[x] = 0;
        } else {
          curBlue[x] += 1;
        }
      });
    });

    function makeRows(cur, max, total, p) {
      return allNumberStrings(total).map(function (number) {
        var k = cur[number];
        var probAtLeastK = Math.pow(1 - p, k);
        // 理论上「遗漏 ≥ k 期」在整个数据集里应出现多少次：
        //   号码总数 × 期数 × (1−p)^k
        // 这个数字才是回答「该出了吧」的关键——它把「概率很小」换算成「其实经常发生」。
        var expectedOccurrences = total * n * probAtLeastK;
        return {
          number: number,
          current: k,
          max_historical: max[number],
          probability_at_least_k: Number(probAtLeastK.toExponential(3)),
          expected_occurrences: Number(expectedOccurrences.toFixed(2)),
          one_in_number_periods: Math.round(1 / probAtLeastK),
        };
      });
    }

    var pRed = RED_PICK / RED_TOTAL;
    var theoreticalCurve = [];
    for (var k = 0; k <= 60; k++) {
      var prob = Math.pow(1 - pRed, k);
      theoreticalCurve.push({
        k: k,
        probability: Number(prob.toExponential(3)),
        expected_occurrences: Number((RED_TOTAL * n * prob).toFixed(3)),
      });
    }

    return {
      periods: n,
      red: makeRows(curRed, maxRed, RED_TOTAL, pRed),
      blue: makeRows(curBlue, maxBlue, BLUE_TOTAL, 1 / BLUE_TOTAL),
      theoretical_curve: theoreticalCurve,
    };
  }

  /**
   * 形态诊断用的组合数表（方案 17.3 第 3 层）。
   *
   * 这件事本身很简单，但必须**由代码枚举算出来**，而不是从别处抄一张表：
   * 手抄的表一旦被质疑就只是一句说法；枚举出来的，任何人都能复现。
   */
  function buildPatternCombinationTable() {
    var total = comb(RED_TOTAL, RED_PICK);
    var oddEven = {};
    var bigSmall = {};
    var zones = {};
    var consecutive = {};
    var sums = {};
    var sumBucketSize = 10;

    var nums = [];
    for (var i = 1; i <= RED_TOTAL; i++) nums.push(i);

    var chosen = [];
    var walk = function (start) {
      if (chosen.length === RED_PICK) {
        var odd = chosen.filter(function (x) {
          return x % 2 === 1;
        }).length;
        var big = chosen.filter(function (x) {
          return x >= 17;
        }).length;
        var z = [0, 0, 0];
        chosen.forEach(function (x) {
          z[Math.floor((x - 1) / 11)]++;
        });
        var hasConsecutive = false;
        for (var j = 1; j < chosen.length; j++) {
          if (chosen[j] - chosen[j - 1] === 1) hasConsecutive = true;
        }
        var sum = chosen.reduce(function (a, b) {
          return a + b;
        }, 0);

        var oeKey = odd + ":" + (RED_PICK - odd);
        var bsKey = big + ":" + (RED_PICK - big);
        var zoneKey = z.join(":");
        var conKey = hasConsecutive ? "有连号" : "无连号";
        var sumKey = String(Math.floor(sum / sumBucketSize) * sumBucketSize);

        oddEven[oeKey] = (oddEven[oeKey] || 0) + 1;
        bigSmall[bsKey] = (bigSmall[bsKey] || 0) + 1;
        zones[zoneKey] = (zones[zoneKey] || 0) + 1;
        consecutive[conKey] = (consecutive[conKey] || 0) + 1;
        sums[sumKey] = (sums[sumKey] || 0) + 1;
        return;
      }
      for (var i2 = start; i2 < nums.length; i2++) {
        chosen.push(nums[i2]);
        walk(i2 + 1);
        chosen.pop();
      }
    };
    walk(0);

    return {
      total_combinations: total,
      odd_even: oddEven,
      big_small: bigSmall,
      zones: zones,
      consecutive: consecutive,
      sum_buckets: sums,
      sum_bucket_size: sumBucketSize,
      zone_definition: "一区 1-11 / 二区 12-22 / 三区 23-33",
      big_small_definition: "小 1-16 / 大 17-33",
    };
  }

  /**
   * 对任意一组红球做形态诊断（浏览器与 Node 共用）。
   * 每一项都同时给出「这组号码的实际形态」与「该形态在全部组合里的占比」——
   * 后者才是重点：它把「我的选号很特别」换成「我的选号落在多大的一堆里」。
   */
  function diagnoseCombination(redNumbers, table) {
    var nums = redNumbers
      .map(Number)
      .sort(function (a, b) {
        return a - b;
      });
    var odd = nums.filter(function (x) {
      return x % 2 === 1;
    }).length;
    var big = nums.filter(function (x) {
      return x >= 17;
    }).length;
    var z = [0, 0, 0];
    nums.forEach(function (x) {
      z[Math.floor((x - 1) / 11)]++;
    });
    var chainCount = 0;
    for (var i = 1; i < nums.length; i++) {
      if (nums[i] - nums[i - 1] === 1) chainCount++;
    }
    var sum = nums.reduce(function (a, b) {
      return a + b;
    }, 0);

    function share(count) {
      return Number(((count / table.total_combinations) * 100).toFixed(3));
    }
    var oeKey = odd + ":" + (RED_PICK - odd);
    var bsKey = big + ":" + (RED_PICK - big);
    var zoneKey = z.join(":");
    var conKey = chainCount > 0 ? "有连号" : "无连号";
    var sumKey = String(Math.floor(sum / table.sum_bucket_size) * table.sum_bucket_size);

    return {
      red: nums.map(pad2),
      odd_even: { actual: oeKey, combinations: table.odd_even[oeKey] || 0, share_percent: share(table.odd_even[oeKey] || 0) },
      big_small: { actual: bsKey, combinations: table.big_small[bsKey] || 0, share_percent: share(table.big_small[bsKey] || 0) },
      zones: { actual: zoneKey, combinations: table.zones[zoneKey] || 0, share_percent: share(table.zones[zoneKey] || 0) },
      consecutive: {
        actual: chainCount > 0 ? conKey + "（" + chainCount + " 组）" : conKey,
        combinations: table.consecutive[conKey] || 0,
        share_percent: share(table.consecutive[conKey] || 0),
      },
      sum: {
        actual: sum,
        bucket: sumKey,
        combinations: table.sum_buckets[sumKey] || 0,
        share_percent: share(table.sum_buckets[sumKey] || 0),
      },
      total_combinations: table.total_combinations,
    };
  }

  /**
   * 用蒙特卡洛估计「完全随机的数据里，平均会有多少个号码落在 95% 区间之外」。
   *
   * 这一条是数字体检层的**防误读装置**，重要性不亚于体检本身：
   *   在 95% 水平上检验 33 个号码，即使开奖完全随机，也几乎总会有 1~2 个号码"看起来偏离"。
   *   实测本数据里有 2 个号码（24 偏多、26 偏少）落在区间外——如果用蒙特卡洛算一下
   *   纯随机数据的基线，会发现"至少 2 个偏离"在完全随机时约有 56% 的概率发生。
   *   也就是说：这个"发现"什么都不是。
   *   不把这个基线写在旁边，读者一定会把它读成"发现了规律"。
   *
   * 用确定性种子（可复现原则）：同一份数据、同一个种子，永远得到同一个基线。
   */
  function estimateMultipleComparisonBaseline(periods, trials, seed) {
    if (trials === undefined) trials = 2000;
    if (seed === undefined) seed = 11;
    // 用 Mulberry32（与 src/rng.js 逐字一致的实现）。
    // 为什么内联而不 require：本文件会被 build-site.js 原样注入浏览器，不能依赖 CommonJS。
    // **改动时两边必须同步**，否则页面上的基线与构建期算出来的会不一致。
    // 这里曾经是一段手写 LCG：(s * 1103515245 + 12345) & 0x7fffffff。
    // 因为 s*1103515245（最大约 2.37e18）远超 Number.MAX_SAFE_INTEGER，
    // 浮点精度丢失使 & 0x7fffffff 不再等价于模 2^31，输出的是**有结构的错误分布**
    // （实测 100 桶卡方 13127.97，而合格的 Mulberry32 只有 106.23）。
    // 这直接让下面这条"防误读基线"失去意义——基线本身不随机，就没资格当基线。
    var _a = seed | 0;
    var rnd = function () {
      _a |= 0;
      _a = (_a + 0x6d2b79f5) | 0;
      var t = Math.imul(_a ^ (_a >>> 15), 1 | _a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    var p = RED_PICK / RED_TOTAL;
    var expected = periods * p;
    var dist = [];
    var ge2 = 0;
    var ge3 = 0;
    for (var t = 0; t < trials; t++) {
      var counts = new Array(RED_TOTAL).fill(0);
      for (var d = 0; d < periods; d++) {
        var pool = [];
        for (var i = 0; i < RED_TOTAL; i++) pool.push(i);
        for (var j = 0; j < RED_PICK; j++) {
          var idx = Math.floor(rnd() * pool.length);
          counts[pool[idx]]++;
          pool.splice(idx, 1);
        }
      }
      var outside = 0;
      for (var k = 0; k < RED_TOTAL; k++) {
        var ci = wilsonInterval(counts[k], periods);
        if (!(ci[0] * periods <= expected && expected <= ci[1] * periods)) outside++;
      }
      dist.push(outside);
      if (outside >= 2) ge2++;
      if (outside >= 3) ge3++;
    }
    var meanOutside = dist.reduce(function (a, b) {
      return a + b;
    }, 0) / dist.length;
    return {
      trials: trials,
      periods: periods,
      mean_outside_per_trial: Number(meanOutside.toFixed(3)),
      theoretical_expectation: Number((RED_TOTAL * 0.05).toFixed(3)),
      probability_at_least_2: Number(((ge2 / trials) * 100).toFixed(1)),
      probability_at_least_3: Number(((ge3 / trials) * 100).toFixed(1)),
      seed: seed,
      note:
        "在 95% 水平上对 " + RED_TOTAL + " 个号码分别检验，即使开奖完全随机，平均也会有 " +
        meanOutside.toFixed(2) + " 个号码落到区间之外（理论值 " + (RED_TOTAL * 0.05).toFixed(2) + " 个）。" +
        "所以看到一个或两个号码偏离理论期望，什么都不说明——这正是多重比较的经典陷阱。",
    };
  }

  return {
    RED_TOTAL: RED_TOTAL,
    RED_PICK: RED_PICK,
    BLUE_TOTAL: BLUE_TOTAL,
    pad2: pad2,
    allNumberStrings: allNumberStrings,
    wilsonInterval: wilsonInterval,
    comb: comb,
    buildNumberHealth: buildNumberHealth,
    buildOmissionAnalysis: buildOmissionAnalysis,
    buildPatternCombinationTable: buildPatternCombinationTable,
    diagnoseCombination: diagnoseCombination,
    estimateMultipleComparisonBaseline: estimateMultipleComparisonBaseline,
  };
  })();
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).LotteryTools;
}
