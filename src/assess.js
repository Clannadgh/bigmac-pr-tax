'use strict';

/**
 * 主流程 assess() —— 把「税单」核成一张真实可结算的购物篮。
 *
 * 现实约束（都是实测出来的）：
 *   · 打烊门店的 query-meals 不报错，而是返回**空菜单**（0 条餐品）；
 *     所以"哪家店能用"只能靠逐家试菜单试出来，看 businessStatus 不够。
 *   · 深夜周边全打烊时，用上海人民广场的 24 小时门店（1450713）继续实时核价，
 *     结果标记 afterHours —— 价格还是真的，只是取餐地点换了家店。
 *   · 早餐时段门店菜单有 90+ 条，但**没有巨无霸**，算价直接 60006，
 *     需要带 reservationDate 换到最近午餐时段重试。
 *   · 配菜（薯条/美式）缺货只跳过该项；巨无霸缺货必须换店/换时段。
 *
 * 顺序：
 *   ① 找店 → ② 当前时段逐家试 → ③ 预约午餐时段逐家试
 *   → ④ 深夜兜底（24h 门店，afterHours=true）→ ⑤ 菜单标价 → ⑥ 离线快照
 *
 * 只调 mcp-data 里那 4 个只读工具，永不调 create-order。
 */

const fs = require('node:fs');
const path = require('node:path');
const { queryNearbyStores, queryMeals, calculatePrice, availableCoupons } = require('./mcp-data');

const BIGMAC = '1100';
const SNAPSHOT_PATH = path.join(__dirname, '..', 'data', 'menu-snapshot.json');

/** 深夜兜底门店：上海人民广场，24 小时营业 */
const AFTER_HOURS_STORE = {
  storeCode: '1450713',
  storeName: '麦当劳上海黄浦华旭国际大厦餐厅',
  address: '南京东路街道西藏中路336号',
  distance: null,
  businessStatus: true,
};

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * 下一个能吃到常规菜单的时段：今天 11:30 没过就今天，否则明天 11:30。
 * 用 11:30 而非 10:44（午餐开始）是为了避开时段切换的边界抖动。
 */
function nextLunchSlot(now = new Date()) {
  const d = new Date(now.getTime() + 8 * 3600 * 1000);
  const today = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 11, 30));
  const cur = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()));
  const chosen = cur.getTime() < today.getTime() ? today : new Date(today.getTime() + 86400000);
  return `${chosen.getUTCFullYear()}-${pad2(chosen.getUTCMonth() + 1)}-${pad2(chosen.getUTCDate())} 11:30`;
}

function loadSnapshot() {
  try {
    return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
  } catch {
    // 快照都读不到时的最后一道墙：保证税单永远能开出来
    return {
      generatedAt: '2026-10-21T09:25:00+08:00',
      storeCode: AFTER_HOURS_STORE.storeCode,
      storeName: AFTER_HOURS_STORE.storeName,
      items: {
        '1100': { name: '巨无霸', priceFen: 2550 },
        '4810': { name: '薯条', priceFen: 1350 },
        '507411': { name: '麦咖啡美式', priceFen: 1190 },
      },
    };
  }
}

/**
 * 试一个「门店 × 时段」格子。
 * @returns {Promise<{kind:'priced'|'menuOnly'|'emptyMenu'|'noBigMac', ...}>}
 */
async function attemptSlot(client, store, wanted, reservationDate, attempts) {
  const tag = `${store.storeCode}${reservationDate ? '@' + reservationDate.slice(11) : ''}`;

  let menu;
  try {
    menu = await queryMeals(client, { storeCode: store.storeCode, reservationDate });
  } catch (err) {
    attempts.push(`[${tag}] 取菜单失败 ${err.code ? 'code=' + err.code + ' ' : ''}${err.message}`);
    return { kind: 'emptyMenu', reason: '取菜单失败' };
  }

  if (menu.empty) {
    attempts.push(`[${tag}] 空菜单（0 条，门店可能已打烊）`);
    return { kind: 'emptyMenu', reason: '空菜单' };
  }
  if (!menu.meals[BIGMAC]) {
    attempts.push(`[${tag}] 菜单无巨无霸（共 ${menu.count} 条）`);
    return { kind: 'noBigMac', count: menu.count };
  }

  // 巨无霸在售；配菜逐项判断，缺的只跳过
  const available = [];
  const skipped = [];
  for (const item of wanted) {
    if (menu.meals[item.productCode]) available.push(item);
    else skipped.push({ productCode: item.productCode, name: item.name, reason: '当前菜单无此商品（可能已下架）' });
  }

  const menuPrices = {};
  for (const item of available) {
    const p = Number(menu.meals[item.productCode].currentPrice);
    if (Number.isFinite(p)) menuPrices[item.productCode] = Math.round(p * 100);
  }
  attempts.push(
    `[${tag}] 菜单命中巨无霸（${menu.count} 条，标价 ${menu.meals[BIGMAC].currentPrice} 元）` +
      (skipped.length ? `，跳过配菜 ${skipped.map((s) => s.name).join('、')}` : '')
  );

  try {
    const priced = await calculatePrice(client, {
      storeCode: store.storeCode,
      reservationDate,
      items: available.map((i) => ({ productCode: i.productCode, quantity: i.quantity })),
    });
    attempts.push(`[${tag}] 核价成功 ${priced.priceFen} 分`);
    return { kind: 'priced', ...priced, available, skipped, menuPrices };
  } catch (err) {
    attempts.push(`[${tag}] 算价失败 ${err.code ? 'code=' + err.code + ' ' : ''}${err.message}`);
    return { kind: 'menuOnly', available, skipped, menuPrices };
  }
}

/** 把核价结果整理成统一形状（购物篮 + 合计 + 来源） */
function buildResult({ source, mode, store, reservationDate, priced, wanted, skipped, attempts, afterHours = false, note, extra = {} }) {
  const basket = (priced?.productList || []).map((p) => {
    const item = wanted.find((w) => w.productCode === p.productCode);
    return {
      productCode: p.productCode,
      name: p.name,
      quantity: p.quantity,
      kind: item?.kind || 'side',
      unitFen: p.quantity ? Math.round(p.subtotalFen / p.quantity) : 0,
      subtotalFen: p.subtotalFen,
      originalSubtotalFen: p.originalSubtotalFen,
    };
  });
  const bigMacLine = basket.find((b) => b.productCode === BIGMAC);
  return {
    ok: true,
    mode,
    afterHours,
    source,
    storeCode: store.storeCode,
    storeName: store.storeName,
    address: store.address || '',
    distance: store.distance ?? null,
    reservationDate: reservationDate || null,
    basket,
    skipped: skipped || [],
    totalFen: priced?.priceFen ?? 0,
    originalFen: priced?.originalPriceFen ?? 0,
    discountFen: priced?.discountFen ?? 0,
    unitPriceFen: bigMacLine?.unitFen ?? 0,
    bigMacTotalFen: bigMacLine?.subtotalFen ?? 0,
    note: note || null,
    attempts: attempts || [],
    ...extra,
  };
}

/**
 * 主流程。
 *
 * @param {object} opts
 * @param {import('./mcp').McdMcpClient|null} opts.client
 * @param {number} opts.bigMacs                                巨无霸只数（税单本位，>=1）
 * @param {Array<{productCode,name,quantity,reason}>} [opts.sideDishes] 附加税配菜
 * @param {string} [opts.city]
 * @param {string} [opts.keyword]
 * @param {string} [opts.storeCode]                            指定门店（只试这一家，24h 兜底除外）
 * @param {number} [opts.maxStores]                            最多试几家
 * @param {Date}   [opts.now]
 * @param {boolean} [opts.withCoupons]                         是否顺带取券（默认 true）
 */
async function assess(opts) {
  const {
    client,
    bigMacs,
    sideDishes = [],
    city = '上海',
    keyword = '人民广场',
    storeCode,
    maxStores = 3,
    now = new Date(),
    withCoupons = true,
  } = opts;

  const qty = Math.max(1, Math.floor(Number(bigMacs) || 1));
  const wanted = [
    { productCode: BIGMAC, name: '巨无霸', quantity: qty, kind: 'base' },
    ...sideDishes.map((s) => ({
      productCode: String(s.productCode),
      name: s.name,
      quantity: Math.max(1, Number(s.quantity) || 1),
      kind: 'side',
      reason: s.reason || '',
    })),
  ];
  const attempts = [];

  if (!client) {
    return withCouponResult(fromSnapshot(wanted, attempts, '未配置 MCD_MCP_TOKEN'), withCoupons, null);
  }

  // ---- ① 找店 ----
  let stores = [];
  try {
    stores = await queryNearbyStores(client, { city, keyword });
    const openCount = stores.filter((s) => s.businessStatus).length;
    attempts.push(`找店成功：${stores.length} 家（营业中 ${openCount} 家）`);
  } catch (err) {
    attempts.push(`找店失败：${err.message}`);
    return withCouponResult(fromSnapshot(wanted, attempts, 'MCP 找店失败'), withCoupons, client);
  }

  let candidates;
  if (storeCode) {
    const hit = stores.find((s) => s.storeCode === String(storeCode));
    candidates = [hit || { storeCode: String(storeCode), storeName: `指定门店 ${storeCode}`, address: '', distance: null, businessStatus: true }];
    attempts.push(`按 store-code 指定门店 ${storeCode}，只试这一家`);
  } else {
    candidates = stores.slice(0, Math.max(1, maxStores));
  }
  if (!candidates.length) {
    return withCouponResult(fromSnapshot(wanted, attempts, `「${city}·${keyword}」附近没有可用门店`), withCoupons, client);
  }

  // ---- ② 当前时段：逐家试到有一家能出菜单为止 ----
  let menuOnly = null;
  let allEmpty = true;
  for (const store of candidates) {
    const r = await attemptSlot(client, store, wanted, null, attempts);
    if (r.kind !== 'emptyMenu') allEmpty = false;
    if (r.kind === 'priced') {
      return withCouponResult(buildResult({ source: 'mcp-live', mode: 'live', store, reservationDate: null, priced: r, wanted, skipped: r.skipped, attempts }), withCoupons, client);
    }
    if (r.kind === 'menuOnly' && !menuOnly) menuOnly = { store, ...r };
  }

  // ---- ③ 预约午餐时段：再逐家试一遍 ----
  const lunch = nextLunchSlot(now);
  attempts.push(`当前时段全部候选门店不可用，改预约 ${lunch} 重试`);
  for (const store of candidates) {
    const r = await attemptSlot(client, store, wanted, lunch, attempts);
    if (r.kind === 'priced') {
      return withCouponResult(
        buildResult({
          source: 'mcp-live',
          mode: 'live',
          store,
          reservationDate: lunch,
          priced: r,
          wanted,
          skipped: r.skipped,
          attempts,
          note: `当前时段未开售，按 ${lunch} 核价`,
        }),
        withCoupons,
        client
      );
    }
    if (r.kind === 'menuOnly' && !menuOnly) menuOnly = { store, ...r };
  }

  // ---- ④ 深夜兜底：周边全打烊（全是空菜单）→ 24 小时门店 ----
  if (allEmpty && AFTER_HOURS_STORE.storeCode !== candidates[0]?.storeCode) {
    attempts.push(`周边门店全部返回空菜单（疑似深夜打烊），改用 24 小时门店 ${AFTER_HOURS_STORE.storeCode}`);
    for (const slot of [null, lunch]) {
      const r = await attemptSlot(client, AFTER_HOURS_STORE, wanted, slot, attempts);
      if (r.kind === 'priced') {
        return withCouponResult(
          buildResult({
            source: 'mcp-live',
            mode: 'live',
            store: AFTER_HOURS_STORE,
            reservationDate: slot,
            priced: r,
            wanted,
            skipped: r.skipped,
            attempts,
            afterHours: true,
            note: '周边门店已打烊，按 24 小时门店实时核价',
          }),
          withCoupons,
          client
        );
      }
      if (r.kind === 'menuOnly' && !menuOnly) menuOnly = { store: AFTER_HOURS_STORE, ...r, reservationDate: slot };
    }
  }

  // ---- ⑤ 菜单标价兜底（活数据，但没经过算价接口）----
  if (menuOnly) {
    const prices = menuOnly.menuPrices || {};
    const productList = [];
    const skipped = [...(menuOnly.skipped || [])];
    for (const item of wanted) {
      const unit = prices[item.productCode];
      if (!unit) {
        if (!skipped.some((s) => s.productCode === item.productCode)) {
          skipped.push({ productCode: item.productCode, name: item.name, reason: '无菜单标价' });
        }
        continue;
      }
      productList.push({
        productCode: item.productCode,
        name: item.name,
        quantity: item.quantity,
        subtotalFen: unit * item.quantity,
        originalSubtotalFen: unit * item.quantity,
      });
    }
    const total = productList.reduce((s, p) => s + p.subtotalFen, 0);
    attempts.push('算价接口不可用，按 MCP 实时菜单标价求和');
    return withCouponResult(
      buildResult({
        source: 'mcp-menu',
        mode: 'live',
        store: menuOnly.store,
        reservationDate: menuOnly.reservationDate || null,
        priced: { priceFen: total, originalPriceFen: total, discountFen: 0, productList },
        wanted,
        skipped,
        attempts,
        note: '算价接口不可用，按 MCP 实时菜单标价求和（未含优惠）',
      }),
      withCoupons,
      client
    );
  }

  // ---- ⑥ 离线快照 ----
  return withCouponResult(
    fromSnapshot(wanted, attempts, `MCP 实时核价不可用（${attempts[attempts.length - 1] || '未知原因'}）`),
    withCoupons,
    client
  );
}

/** 离线快照模式 */
function fromSnapshot(wanted, attempts, why) {
  const snapshot = loadSnapshot();
  const items = snapshot.items || {};
  const basket = [];
  const skipped = [];
  for (const item of wanted) {
    const hit = items[item.productCode];
    const unit = hit?.priceFen ?? (hit?.currentPrice ? Math.round(hit.currentPrice * 100) : null);
    if (!unit) {
      skipped.push({ productCode: item.productCode, name: item.name, reason: '快照无此商品价格' });
      continue;
    }
    basket.push({
      productCode: item.productCode,
      name: hit.name || item.name,
      quantity: item.quantity,
      kind: item.kind,
      unitFen: unit,
      subtotalFen: unit * item.quantity,
      originalSubtotalFen: unit * item.quantity,
    });
  }
  const total = basket.reduce((s, b) => s + b.subtotalFen, 0);
  const bigMacLine = basket.find((b) => b.productCode === BIGMAC);
  attempts.push(`离线快照模式：快照生成于 ${snapshot.generatedAt}`);
  return {
    ok: true,
    mode: 'snapshot',
    afterHours: false,
    source: 'snapshot',
    snapshotGeneratedAt: snapshot.generatedAt,
    storeCode: snapshot.storeCode,
    storeName: snapshot.storeName,
    address: snapshot.storeAddress || '',
    distance: null,
    reservationDate: null,
    basket,
    skipped,
    totalFen: total,
    originalFen: total,
    discountFen: 0,
    unitPriceFen: bigMacLine?.unitFen ?? 0,
    bigMacTotalFen: bigMacLine?.subtotalFen ?? 0,
    note: `${why}，进入离线快照模式（快照生成于 ${snapshot.generatedAt}）`,
    attempts,
  };
}

/** 顺带取券：失败不阻断 */
async function withCouponResult(result, withCoupons, client) {
  if (!withCoupons) return { ...result, coupons: { titles: [], error: null } };
  const coupons = await availableCoupons(client);
  return { ...result, coupons };
}

module.exports = {
  assess,
  attemptSlot,
  nextLunchSlot,
  loadSnapshot,
  fromSnapshot,
  AFTER_HOURS_STORE,
  SNAPSHOT_PATH,
  BIGMAC,
};
