'use strict';

/**
 * assess() 主流程测试。
 * 用鸭子类型假客户端（只实现 callToolData / callTool），不碰网络。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { assess, nextLunchSlot, AFTER_HOURS_STORE } = require('../src/assess');

const STORES = [
  { storeCode: '1450441', storeName: '麦当劳上海福州路餐厅', distance: 235, businessStatus: true },
  { storeCode: '1450056', storeName: '麦当劳上海食品一店餐厅', distance: 355, businessStatus: true },
];

const MENU = {
  '1100': { name: '巨无霸', currentPrice: '25.5', originalPrice: '25.5' },
  '4810': { name: '薯条', currentPrice: '13.5', originalPrice: '13.5' },
  '507411': { name: '麦咖啡™美式', currentPrice: '11.9', originalPrice: '19' },
};
const BREAKFAST = { 1088: { name: '优品豆浆', currentPrice: '9.5' }, 5022: { name: '猪柳蛋麦满分', currentPrice: '18' } };

const UNIT = { '1100': 2550, '4810': 1350, '507411': 1190 };
const FRIES = { productCode: '4810', name: '薯条', quantity: 1, reason: '周五 18:00 后合并' };

function calcResponse(args) {
  const productList = args.items.map((i) => ({
    productCode: i.productCode,
    productName: MENU[i.productCode]?.name || i.productCode,
    quantity: i.quantity,
    subtotal: UNIT[i.productCode] * i.quantity,
    originalSubtotal: UNIT[i.productCode] * i.quantity,
  }));
  const total = productList.reduce((s, p) => s + p.subtotal, 0);
  return { price: total, originalPrice: total, discount: 0, productList };
}

function soldOut() {
  const err = new Error('工具 calculate-price 业务失败(60006): 商品已售罄或不可售');
  err.code = 60006;
  return err;
}

function makeClient({ stores = STORES, menuFor = () => MENU, calcFor = calcResponse, coupons = '' } = {}) {
  const calls = [];
  return {
    calls,
    async callToolData(name, args) {
      calls.push({ name, args });
      if (name === 'query-nearby-stores') {
        if (stores instanceof Error) throw stores;
        return stores;
      }
      if (name === 'query-meals') {
        const meals = menuFor(args);
        if (meals instanceof Error) throw meals;
        return { meals };
      }
      if (name === 'calculate-price') {
        const res = calcFor(args);
        if (res instanceof Error) throw res;
        return res;
      }
      throw new Error(`未预期的工具: ${name}`);
    },
    async callTool(name, args) {
      calls.push({ name, args });
      if (name === 'available-coupons') {
        if (coupons instanceof Error) throw coupons;
        return { text: coupons, isError: false };
      }
      throw new Error(`未预期的工具: ${name}`);
    },
  };
}

const NOW = new Date('2026-10-21T00:49:00Z'); // 北京时间 08:49（早餐时段）
const COUPON_MD = '### 麦麦省优惠券列表：\n- 优惠券标题：19.9元王牌炸鸡任选2 \\\n  状态：可领取 \\\n';

test('① 当前时段就能买到 → live + mcp-live，配菜同篮核价', async () => {
  const client = makeClient({ coupons: COUPON_MD });
  const r = await assess({ client, bigMacs: 3, sideDishes: [FRIES], now: NOW });

  assert.equal(r.mode, 'live');
  assert.equal(r.source, 'mcp-live');
  assert.equal(r.afterHours, false);
  assert.equal(r.reservationDate, null);
  assert.deepEqual(r.basket.map((b) => [b.productCode, b.quantity, b.subtotalFen]), [
    ['1100', 3, 7650],
    ['4810', 1, 1350],
  ]);
  assert.equal(r.totalFen, 9000);
  assert.equal(r.unitPriceFen, 2550);
  assert.deepEqual(r.coupons.titles, ['19.9元王牌炸鸡任选2']);
});

test('② 打烊门店返回空菜单 → 逐家试到有一家能出菜单为止', async () => {
  const client = makeClient({
    menuFor: (a) => (a.storeCode === '1450441' ? {} : MENU), // 第一家打烊（空菜单）
  });
  const r = await assess({ client, bigMacs: 2, now: NOW });

  assert.equal(r.source, 'mcp-live');
  assert.equal(r.storeCode, '1450056', '应换到第二家');
  assert.ok(r.attempts.some((a) => a.includes('1450441') && a.includes('空菜单')));
});

test('③ 早餐时段菜单里没有巨无霸 → 预约午餐时段后成功', async () => {
  const client = makeClient({ menuFor: (a) => (a.reservationDate ? MENU : BREAKFAST) });
  const r = await assess({ client, bigMacs: 2, sideDishes: [FRIES], now: NOW });

  assert.equal(r.source, 'mcp-live');
  assert.equal(r.reservationDate, '2026-10-21 11:30');
  assert.equal(r.totalFen, 5100 + 1350);
  assert.match(r.note, /当前时段未开售/);
});

test('④ 配菜不在菜单 → 只跳过这一项，请求里不出现下架商品', async () => {
  const client = makeClient({ menuFor: () => ({ '1100': MENU['1100'] }) });
  const r = await assess({ client, bigMacs: 2, sideDishes: [FRIES], now: NOW });

  assert.equal(r.basket.length, 1);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].productCode, '4810');
  const calcCall = client.calls.find((c) => c.name === 'calculate-price');
  assert.equal(calcCall.args.items.length, 1);
});

test('⑤ 深夜周边全打烊（全空菜单）→ 24h 门店兜底并标记 afterHours', async () => {
  // 周边门店全部空菜单，只有 24h 门店有货
  const client = makeClient({ menuFor: (a) => (a.storeCode === '1450713' ? MENU : {}) });
  const r = await assess({ client, bigMacs: 2, now: NOW });

  assert.equal(r.source, 'mcp-live');
  assert.equal(r.afterHours, true);
  assert.equal(r.storeCode, AFTER_HOURS_STORE.storeCode);
  assert.match(r.note, /24 小时门店/);
  assert.ok(r.attempts.some((a) => a.includes('疑似深夜打烊')));
});

test('⑥ 算价一直 60006 但菜单有价 → 第 ⑤ 级菜单标价（不是快照）', async () => {
  const client = makeClient({ calcFor: () => soldOut() });
  const r = await assess({ client, bigMacs: 3, sideDishes: [FRIES], now: NOW });

  assert.equal(r.source, 'mcp-menu');
  assert.equal(r.totalFen, 7650 + 1350);
  assert.match(r.note, /菜单标价/);
});

test('⑦ 找店就失败 → 离线快照模式，并写明快照生成时间', async () => {
  const client = makeClient({ stores: new Error('MCP 请求超时（20000ms）') });
  const r = await assess({ client, bigMacs: 2, sideDishes: [FRIES], now: NOW });

  assert.equal(r.mode, 'snapshot');
  assert.equal(r.source, 'snapshot');
  assert.equal(r.totalFen, 2550 * 2 + 1350);
  assert.match(r.note, /离线快照模式/);
  assert.ok(r.snapshotGeneratedAt, '必须带快照生成时间戳');
});

test('⑧ 没有 Token → 直接离线快照，一次 MCP 都不调', async () => {
  const r = await assess({ client: null, bigMacs: 1, sideDishes: [{ productCode: '507411', name: '麦咖啡美式', quantity: 1 }], now: NOW });
  assert.equal(r.mode, 'snapshot');
  assert.equal(r.totalFen, 2550 + 1190);
  assert.match(r.note, /未配置 MCD_MCP_TOKEN/);
  assert.equal(r.attempts.length, 1, '没有客户端时不该有任何 MCP 尝试');
});

test('⑨ 指定门店时只试这一家（不换到别的普通门店）', async () => {
  const client = makeClient({ menuFor: (a) => (a.storeCode === '1450441' ? BREAKFAST : MENU) });
  const r = await assess({ client, bigMacs: 2, storeCode: '1450441', now: NOW });

  const menuStores = new Set(client.calls.filter((c) => c.name === 'query-meals').map((c) => c.args.storeCode));
  assert.ok(!menuStores.has('1450056'), '不该偷偷换到第二家');
  // 指定店只有早餐菜（无巨无霸），预约后仍无 → 最终落快照
  assert.equal(r.mode, 'snapshot');
});

test('⑩ 快照里没有的配菜也要跳过并说明原因', async () => {
  const r = await assess({
    client: null,
    bigMacs: 1,
    sideDishes: [{ productCode: '9999', name: '派', quantity: 1 }],
    now: NOW,
  });
  assert.equal(r.basket.length, 1);
  assert.equal(r.skipped[0].productCode, '9999');
  assert.match(r.skipped[0].reason, /快照无此商品价格/);
});

test('⑪ 优惠券失败不阻断核价', async () => {
  const client = makeClient({ coupons: new Error('券服务 500') });
  const r = await assess({ client, bigMacs: 2, now: NOW });

  assert.equal(r.source, 'mcp-live');
  assert.equal(r.totalFen, 5100);
  assert.ok(r.coupons.error, '券失败要记录原因');
  assert.deepEqual(r.coupons.titles, []);
});

test('⑫ 只调用这 4 个只读工具，绝不碰下单类接口', async () => {
  const client = makeClient({ coupons: COUPON_MD });
  await assess({ client, bigMacs: 2, sideDishes: [FRIES], now: NOW });

  const allowed = new Set(['query-nearby-stores', 'query-meals', 'calculate-price', 'available-coupons']);
  for (const call of client.calls) {
    assert.ok(allowed.has(call.name), `调用了不该调的工具: ${call.name}`);
  }
});

test('⑬ 预约时段：今天 11:30 未过用今天，过了用明天，跨月正确', () => {
  assert.equal(nextLunchSlot(new Date('2026-10-21T00:49:00Z')), '2026-10-21 11:30');
  assert.equal(nextLunchSlot(new Date('2026-10-21T05:00:00Z')), '2026-10-22 11:30');
  assert.equal(nextLunchSlot(new Date('2026-10-31T16:00:00Z')), '2026-11-01 11:30');
});
