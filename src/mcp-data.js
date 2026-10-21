'use strict';

/**
 * 数据层 —— 只碰这四个只读工具，别的一概不调。
 *
 *   1. query-nearby-stores  找店
 *   2. query-meals          取菜单（data.meals 是「编码 → {name,currentPrice,originalPrice}」的字典）
 *   3. calculate-price      整篮核价，金额单位是分
 *   4. available-coupons    麦麦省优惠券（失败不阻断）
 *
 * 这一层只负责"把接口返回变成稳定形状"，不做任何降级决策——
 * 降级是 assess() 的事。职责分开，测试才好写。
 */

const { McpError } = require('./mcp');

/**
 * 找店。返回按距离升序的门店列表；**营业中的排在前面**，
 * 但不丢弃打烊门店——打烊店的菜单会是空的，assess() 需要逐家试过去。
 *
 * @returns {Promise<Array<{storeCode:string, storeName:string, address:string,
 *                          distance:number|null, businessStatus:boolean}>>}
 */
async function queryNearbyStores(client, { city = '上海', keyword = '人民广场', beType = 1, searchType = 2 } = {}) {
  const data = await client.callToolData('query-nearby-stores', { beType, searchType, city, keyword });
  const list = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];

  const normalized = list.map((s) => ({
    storeCode: String(s.storeCode),
    storeName: s.storeName || `门店 ${s.storeCode}`,
    address: s.address || '',
    distance: Number.isFinite(Number(s.distance)) ? Number(s.distance) : null,
    businessStatus: s.businessStatus === true,
  }));

  // 营业中优先，其次按距离升序
  return normalized.sort((a, b) => {
    if (a.businessStatus !== b.businessStatus) return a.businessStatus ? -1 : 1;
    return (a.distance ?? Number.MAX_SAFE_INTEGER) - (b.distance ?? Number.MAX_SAFE_INTEGER);
  });
}

/**
 * 取菜单。`data.meals` 是字典，不是数组。
 * 打烊门店通常返回空字典（而不是报错），所以"空菜单"要当正常结果处理。
 *
 * @returns {Promise<{meals: object, count: number, empty: boolean}>}
 */
async function queryMeals(client, { storeCode, orderType = 1, beType = 1, reservationDate }) {
  const args = { storeCode: String(storeCode), orderType, beType };
  if (reservationDate) args.reservationDate = reservationDate;
  const data = await client.callToolData('query-meals', args);
  const meals = data?.meals && typeof data.meals === 'object' ? data.meals : {};
  return { meals, count: Object.keys(meals).length, empty: Object.keys(meals).length === 0 };
}

/**
 * 整篮核价（巨无霸 ×N + 配菜），金额单位：分。
 *
 * @param {object} opts
 * @param {Array<{productCode:string, quantity:number}>} opts.items
 * @returns {Promise<{priceFen:number, originalPriceFen:number, discountFen:number,
 *                    productList:Array<{productCode:string,name:string,quantity:number,
 *                                      subtotalFen:number, originalSubtotalFen:number}>}>}
 */
async function calculatePrice(client, { storeCode, items, orderType = 1, beType = 1, reservationDate }) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new McpError('calculate-price 需要至少一个商品');
  }
  const args = {
    storeCode: String(storeCode),
    orderType,
    beType,
    items: items.map((i) => ({ productCode: String(i.productCode), quantity: Math.max(1, Number(i.quantity) || 1) })),
  };
  if (reservationDate) args.reservationDate = reservationDate;

  const data = await client.callToolData('calculate-price', args);
  const priceFen = Number(data?.price);
  if (!Number.isFinite(priceFen)) throw new McpError('calculate-price 未返回 price 字段');

  const list = Array.isArray(data.productList) ? data.productList : [];
  return {
    priceFen,
    originalPriceFen: Number.isFinite(Number(data.originalPrice)) ? Number(data.originalPrice) : priceFen,
    discountFen: Number.isFinite(Number(data.discount)) ? Number(data.discount) : 0,
    productList: list.map((p) => ({
      productCode: String(p.productCode),
      name: p.productName || String(p.productCode),
      quantity: Number(p.quantity) || 0,
      subtotalFen: Number(p.subtotal) || 0,
      originalSubtotalFen: Number(p.originalSubtotal) || Number(p.subtotal) || 0,
    })),
  };
}

/** 解析 available-coupons 的 Markdown 返回（这个工具不给 JSON，也不给 traceId） */
function parseCouponTitles(text, limit = 5) {
  if (!text) return [];
  const lines = String(text).split(/\r?\n/);
  const titles = [];
  let pending = null;
  for (const line of lines) {
    const t = line.match(/^[-*]\s*优惠券标题[:：]\s*(.+?)\s*\\?$/);
    if (t) {
      if (pending) titles.push(pending);
      pending = t[1].trim();
      continue;
    }
    const s = line.match(/状态[:：]\s*(.+?)\s*\\?$/);
    if (s && pending && !/可领取/.test(s[1])) pending = null;
  }
  if (pending) titles.push(pending);
  return titles.slice(0, limit);
}

/**
 * 取当日可领券。**失败不阻断**——拿不到券就少印一行，不能让整张税单开不出来。
 *
 * 返回形态在不同时刻不同（实测都遇到过）：
 *   · 有 structuredContent 时：data 是 [{couponName, couponStatus:"CAN_GET", label:"可领取"}] 数组
 *   · 只有文本时：content 是 Markdown 列表
 * 所以先吃结构化字段，退回 Markdown；两边都解析不出来就返回空，绝不编造。
 *
 * @returns {Promise<{titles:string[], error:string|null, via?:'structured'|'markdown'}>}
 */
async function availableCoupons(client, limit = 5) {
  if (!client) return { titles: [], error: '无 MCP 客户端' };
  try {
    const res = await client.callTool('available-coupons', {});
    if (res.isError) return { titles: [], error: `工具返回错误: ${(res.text || '').slice(0, 120)}` };

    const list = Array.isArray(res.data) ? res.data : Array.isArray(res.data?.coupons) ? res.data.coupons : null;
    if (list) {
      const titles = list
        .filter((c) => {
          const status = String(c.couponStatus || '');
          const label = String(c.label || '');
          // 有状态字段就按状态收；没有状态字段就默认可用
          if (!status && !label) return true;
          return /CAN_GET|可领取|可用/i.test(status) || /可领取/.test(label);
        })
        .map((c) => c.couponName || c.title || c.name)
        .filter(Boolean)
        .slice(0, limit);
      if (titles.length) return { titles, error: null, via: 'structured' };
    }

    const titles = parseCouponTitles(res.text, limit);
    return { titles, error: titles.length ? null : '未解析到可领取券', via: titles.length ? 'markdown' : undefined };
  } catch (err) {
    return { titles: [], error: err.message };
  }
}

module.exports = {
  queryNearbyStores,
  queryMeals,
  calculatePrice,
  availableCoupons,
  parseCouponTitles,
};
