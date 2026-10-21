'use strict';

/**
 * 《麦门税法》计税内核
 *
 * 规则表（逐条实现，每条都有单测锁定）：
 *   T1 基础合并税        合并即征                         +1 只
 *   T2 代码量税          每 500 行变更 +1，上限 +5
 *   T3 文件数税          每 10 个文件 +1，上限 +3
 *   M1 周五夜间附加税     周五 18:00 后合并 ×2，另征 1 份薯条（4810）
 *   M2 周末加班附加税     周六/周日合并 ×1.5，另征 1 杯麦咖啡美式（507411）
 *   M3 负熵减免          deletions > additions 且变更总量 ≥ 50，×0.5
 *   破产保护            最终数量四舍五入，下限 1，上限默认 12（可配置）
 *
 * 计算顺序（固定，测试锁定）：
 *   加性小计 = T1 + T2 + T3
 *   最终只数 = round(加性小计 × Π(各乘数))  →  再夹到 [下限, 上限]
 *
 * 计价本位是巨无霸（1100）。附加税不折算成巨无霸，而是以「配菜」形式进购物篮，
 * 因为把薯条折算成 0.3 只巨无霸既不可支付、也不可解释。
 *
 * 时区：默认 UTC+8，可配置（offsetHours）。周五/周末的判定一律按配置偏移后的本地时间，
 * 绝不依赖运行机器的时区——GitHub Actions 跑在 UTC 上，这是必须的。
 *
 * ⚠️ 合规声明：本文中的"税法"是虚构的娱乐规则，不属于任何真实税种，
 *    不产生任何真实缴费义务，也不代表麦当劳的任何定价或促销政策。
 */

/** 商品编码（来自麦当劳 MCP 真实菜单） */
const PRODUCTS = {
  BIG_MAC: '1100',
  FRIES: '4810',
  AMERICANO: '507411',
};

const PRODUCT_NAMES = {
  [PRODUCTS.BIG_MAC]: '巨无霸',
  [PRODUCTS.FRIES]: '薯条',
  [PRODUCTS.AMERICANO]: '麦咖啡美式',
};

const DEFAULTS = {
  /** 周五夜间起算小时（含），按配置偏移后的本地时间 */
  fridayNightFromHour: 18,
  /** 代码量税：多少行算 1 只 */
  codeLinesPerUnit: 500,
  codeMaxUnits: 5,
  /** 文件数税：多少文件算 1 只 */
  filesPerUnit: 10,
  filesMaxUnits: 3,
  /** 破产保护 */
  minBigMacs: 1,
  maxBigMacs: 12,
  /** 时区偏移（小时），默认东八区 */
  offsetHours: 8,
};

const round1 = (n) => Math.round(n * 10) / 10;

/** 把 UTC 时刻换算成"配置偏移下的本地时间分量" */
function localParts(date, offsetHours = DEFAULTS.offsetHours) {
  const d = new Date(new Date(date).getTime() + offsetHours * 3600 * 1000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    weekday: d.getUTCDay(), // 0=周日, 5=周五, 6=周六
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    ymd: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`,
    hhmm: `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`,
  };
}

/** 兼容旧调用：东八区 yyyy-MM-dd HH:mm */
function formatShanghai(date, withTime = true, offsetHours = DEFAULTS.offsetHours) {
  const p = localParts(date, offsetHours);
  return withTime ? `${p.ymd} ${p.hhmm}` : p.ymd;
}

const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 计算税单。
 *
 * @param {object} input
 * @param {number} input.additions
 * @param {number} input.deletions
 * @param {number} input.changedFiles
 * @param {Date|string} [input.mergedAt] 合并时刻（PR merged_at），决定附加税
 * @param {object} [options] 覆盖 DEFAULTS
 * @returns {{
 *   bigMacs: number,
 *   rawBigMacs: number,
 *   unitLines: Array<{id,label,detail,units}>,
 *   multiplierLines: Array<{id,label,detail,multiplier,sideDish?:{productCode,name,quantity}}>,
 *   sideDishes: Array<{productCode,name,quantity,reason}>,
 *   capped: boolean,
 *   floorApplied: boolean,
 *   subtotalUnits: number,
 *   totalMultiplier: number,
 *   local: object,
 *   stats: object,
 *   config: object
 * }}
 */
function computeTax(input = {}, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const additions = Math.max(0, Number(input.additions) || 0);
  const deletions = Math.max(0, Number(input.deletions) || 0);
  const changedFiles = Math.max(0, Number(input.changedFiles) || 0);
  const mergedAt = input.mergedAt ? new Date(input.mergedAt) : new Date();
  const local = localParts(mergedAt, cfg.offsetHours);

  const totalChangedLines = additions + deletions;

  // ---- 加性：T1 基础合并税 ----
  const unitLines = [];
  unitLines.push({
    id: 'T1',
    label: '基础合并税',
    basis: '第一条：凡合并入主干者，征巨无霸一只。',
    detail: '合并即征',
    units: 1,
  });

  // ---- 加性：T2 代码量税（每 500 行 +1，上限 +5）----
  const codeRawUnits = Math.floor(totalChangedLines / cfg.codeLinesPerUnit);
  const codeUnits = Math.min(codeRawUnits, cfg.codeMaxUnits);
  unitLines.push({
    id: 'T2',
    label: '代码量税',
    basis: '第二条：变更每五百行加征一只，至多五只。',
    detail: `${totalChangedLines}行÷${cfg.codeLinesPerUnit}${codeRawUnits > cfg.codeMaxUnits ? ' 封顶' : ''}`,
    units: codeUnits,
  });

  // ---- 加性：T3 文件数税（每 10 个 +1，上限 +3）----
  const fileRawUnits = Math.floor(changedFiles / cfg.filesPerUnit);
  const fileUnits = Math.min(fileRawUnits, cfg.filesMaxUnits);
  unitLines.push({
    id: 'T3',
    label: '文件数税',
    basis: '第三条：改动文件每十个加征一只，至多三只。',
    detail: `${changedFiles}个÷${cfg.filesPerUnit}${fileRawUnits > cfg.filesMaxUnits ? ' 封顶' : ''}`,
    units: fileUnits,
  });

  const subtotalUnits = unitLines.reduce((s, l) => s + l.units, 0);

  // ---- 乘性：M1 周五夜间 / M2 周末 ----
  const multiplierLines = [];
  const sideDishes = [];

  const isFridayNight = local.weekday === 5 && local.hour >= cfg.fridayNightFromHour;
  const isWeekend = local.weekday === 0 || local.weekday === 6;

  if (isFridayNight) {
    multiplierLines.push({
      id: 'M1',
      label: '周五夜间附加税',
      basis: '第四条：周五十八时后合并者，倍征，并附薯条一份。',
      detail: `${WEEKDAY_CN[local.weekday]}${local.hhmm} 合并`,
      multiplier: 2,
      sideDish: { productCode: PRODUCTS.FRIES, name: PRODUCT_NAMES[PRODUCTS.FRIES], quantity: 1 },
    });
    sideDishes.push({
      productCode: PRODUCTS.FRIES,
      name: PRODUCT_NAMES[PRODUCTS.FRIES],
      quantity: 1,
      reason: '周五 18:00 后合并',
    });
  } else if (isWeekend) {
    multiplierLines.push({
      id: 'M2',
      label: '周末加班附加税',
      basis: '第五条：周六日合并者，加征五成，并附麦咖啡美式一杯。',
      detail: `${WEEKDAY_CN[local.weekday]}${local.hhmm} 合并`,
      multiplier: 1.5,
      sideDish: { productCode: PRODUCTS.AMERICANO, name: PRODUCT_NAMES[PRODUCTS.AMERICANO], quantity: 1 },
    });
    sideDishes.push({
      productCode: PRODUCTS.AMERICANO,
      name: PRODUCT_NAMES[PRODUCTS.AMERICANO],
      quantity: 1,
      reason: '周末合并',
    });
  }

  // ---- 乘性：M3 负熵减免 ----
  const negativeEntropy = deletions > additions && totalChangedLines >= 50;
  if (negativeEntropy) {
    multiplierLines.push({
      id: 'M3',
      label: '负熵减免',
      basis: '第六条：删多于增且总量逾五十行者，减半征收。',
      detail: `删${deletions}>增${additions} 共${totalChangedLines}行`,
      multiplier: 0.5,
    });
  }

  // ---- 破产保护 ----
  const totalMultiplier = multiplierLines.reduce((m, l) => (l.multiplier ? m * l.multiplier : m), 1);
  const rawBigMacs = round1(subtotalUnits * totalMultiplier);
  const rounded = Math.round(rawBigMacs);
  const capped = rounded > cfg.maxBigMacs;
  const floorApplied = !capped && rounded < cfg.minBigMacs;
  const bigMacs = Math.min(Math.max(rounded, cfg.minBigMacs), cfg.maxBigMacs);

  return {
    bigMacs,
    rawBigMacs,
    unitLines,
    multiplierLines,
    sideDishes,
    capped,
    floorApplied,
    subtotalUnits,
    totalMultiplier: round1(totalMultiplier),
    local,
    config: cfg,
    stats: {
      additions,
      deletions,
      changedFiles,
      totalChangedLines,
      mergedAt: mergedAt.toISOString(),
      weekday: local.weekday,
      weekdayCn: WEEKDAY_CN[local.weekday],
      localTime: `${local.ymd} ${local.hhmm}`,
      negativeEntropy,
      isFridayNight,
      isWeekend,
    },
  };
}

module.exports = {
  computeTax,
  DEFAULTS,
  PRODUCTS,
  PRODUCT_NAMES,
  localParts,
  formatShanghai,
  round1,
};
