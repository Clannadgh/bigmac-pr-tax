'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  displayWidth,
  wrapW,
  renderReceipt,
  padStartW,
  clipW,
  amountText,
  RECEIPT_WIDTH,
} = require('../src/receipt');
const { computeTax } = require('../src/tax');

function makePricing(overrides = {}) {
  return {
    mode: 'live',
    source: 'mcp-live',
    storeCode: '1450713',
    storeName: '麦当劳上海黄浦华旭国际大厦餐厅',
    address: '南京东路街道西藏中路336号',
    distance: 144,
    reservationDate: null,
    afterHours: false,
    basket: [
      { productCode: '1100', name: '巨无霸', quantity: 3, kind: 'base', unitFen: 2550, subtotalFen: 7650, originalSubtotalFen: 7650 },
      { productCode: '4810', name: '中薯条', quantity: 1, kind: 'side', unitFen: 1350, subtotalFen: 1350, originalSubtotalFen: 1350 },
    ],
    skipped: [],
    totalFen: 9000,
    originalFen: 9000,
    discountFen: 0,
    unitPriceFen: 2550,
    attempts: ['找店成功：5 家（营业中 5 家）'],
    note: null,
    ...overrides,
  };
}

function makeView(taxOverrides = {}, pricingOverrides = {}) {
  const tax = computeTax({
    additions: 180,
    deletions: 320,
    changedFiles: 12,
    mergedAt: '2026-10-23T19:04:00+08:00', // 周五夜间
    ...taxOverrides,
  });
  return {
    taxpayer: 'octocat',
    action: '合并 PR #128「refactor: 拆掉上帝函数」',
    repo: 'acme/nebula',
    serial: 'BMT-20261023-A1B2C3',
    issuedAt: new Date('2026-10-23T11:04:00Z'),
    tax,
    pricing: makePricing(pricingOverrides),
  };
}

// ---------- 基础排版 ----------

test('中文字符算 2 列，英文数字算 1 列', () => {
  assert.equal(displayWidth('巨无霸'), 6);
  assert.equal(displayWidth('BigMac'), 6);
  assert.equal(displayWidth('巨无霸 x3'), 9);
});

test('中文按宽度换行，不超宽（允许避头点悬挂 2 列）', () => {
  const text = '凡合并入主干者，征巨无霸一只；变更每五百行加征一只，至多五只。';
  for (const line of wrapW(text, 20)) {
    assert.ok(displayWidth(line) <= 22, `行超宽: ${line} (${displayWidth(line)})`);
  }
});

test('不把数字串拆开（11:30 / 2026-10-21）', () => {
  const joined = wrapW('预约 2026-10-21 11:30 取餐', 16).join('');
  assert.ok(joined.includes('11:30'));
  assert.ok(joined.includes('2026-10-21'));
});

test('标点不出现在行首', () => {
  const lines = wrapW('删除代码属减少技术债务之行为，每删除二百行准予抵扣一只，抵扣额不得超过应纳额。', 16);
  for (const line of lines.slice(1)) {
    assert.ok(!/^[，。、；：！？）》」』】]/.test(line), `行首出现标点: ${line}`);
  }
});

test('padStartW / clipW 用显示宽度对齐', () => {
  assert.equal(displayWidth(padStartW('只', 8)), 8);
  assert.ok(displayWidth(clipW('很长的中文标签需要截断才行', 10)) <= 10, '截断后不能超宽');
  assert.ok(clipW('很长的中文标签需要截断才行', 10).endsWith('…'));
});

// ---------- 附加税金额文案 ----------

test('税额文案：加性税目是 +N 只，附加税是 ×2 ＋1 薯条', () => {
  assert.equal(amountText({ units: 1 }), '+1 只');
  assert.equal(amountText({ units: 0 }), '+0 只');
  assert.equal(
    amountText({ multiplier: 2, sideDish: { productCode: '4810', name: '薯条', quantity: 1 } }),
    '×2 ＋1 薯条'
  );
  assert.equal(
    amountText({ multiplier: 1.5, sideDish: { productCode: '507411', name: '麦咖啡美式', quantity: 1 } }),
    '×1.5 ＋1 麦咖啡美式'
  );
  assert.equal(amountText({ multiplier: 0.5 }), '×0.5');
});

// ---------- 小票正文 ----------

test('小票每行不超宽，且该有的都有', () => {
  const text = renderReceipt(makeView());
  for (const line of text.split('\n')) {
    assert.ok(displayWidth(line) <= RECEIPT_WIDTH + 2, `小票行超宽: ${line} (${displayWidth(line)})`);
  }

  // 抬头
  assert.ok(text.includes('麦  门  税  务  局'));
  assert.ok(text.includes('MAIMEN REVENUE SERVICE'));
  // 商户 / 地址
  assert.ok(text.includes('商户'));
  assert.ok(text.includes('麦当劳上海黄浦华旭国际大厦餐厅'));
  assert.ok(text.includes('南京东路街道西藏中路336号'));
  assert.ok(text.includes('1450713'));
  // 税项 + 应缴
  assert.ok(text.includes('基础合并税'));
  assert.ok(text.includes('周五夜间附加税'));
  assert.ok(text.includes('×2 ＋1 薯条'), '附加税要显示成「×2 ＋1 薯条」');
  assert.ok(text.includes('应  缴'));
  // 商品明细
  assert.ok(text.includes('商 品 明 细'));
  assert.ok(text.includes('巨无霸 x3'));
  assert.ok(text.includes('中薯条 x1'));
  assert.ok(text.includes('¥76.50'));
  // 原价 / 应付
  assert.ok(text.includes('原  价'));
  assert.ok(text.includes('应  付'));
  assert.ok(text.includes('¥90.00'));
  // 落款
  assert.ok(text.includes('本小票不构成任何法律效力'));
  assert.ok(text.includes('谢谢惠顾 · 麦门永存'));

  assert.ok(!text.includes('undefined'), '不能把 undefined 打进小票');
  assert.ok(!text.includes('NaN'), '不能把 NaN 打进小票');
});

test('小票显示的是真实门店，不是占位符', () => {
  const text = renderReceipt(makeView({}, { storeName: '麦当劳上海福州路餐厅', storeCode: '1450441' }));
  assert.ok(text.includes('麦当劳上海福州路餐厅'));
  assert.ok(text.includes('1450441'));
});

test('配菜缺货时小票标明已跳过，不虚构成交', () => {
  const view = makeView(
    {},
    {
      basket: [{ productCode: '1100', name: '巨无霸', quantity: 3, unitFen: 2550, subtotalFen: 7650 }],
      skipped: [{ productCode: '507411', name: '麦咖啡美式', reason: '当前菜单无此商品（可能已下架）' }],
      totalFen: 7650,
      originalFen: 7650,
    }
  );
  const text = renderReceipt(view);
  assert.ok(text.includes('（缺货）麦咖啡美式'));
  assert.ok(text.includes('已跳过'));
});

test('触顶时小票打印破产保护', () => {
  const text = renderReceipt(
    makeView({ additions: 8400, deletions: 6200, changedFiles: 210, mergedAt: '2026-10-23T21:10:00+08:00' })
  );
  assert.ok(text.includes('破产保护'));
  assert.ok(text.includes('已达上限 12 只'));
});

test('工作日白天不出现附加税字样', () => {
  const text = renderReceipt(makeView({ additions: 620, deletions: 40, mergedAt: '2026-10-21T14:20:00+08:00' }));
  assert.ok(text.includes('基础合并税'));
  assert.ok(!text.includes('周五夜间附加税'));
  assert.ok(!text.includes('周末加班附加税'));
});
