'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { composeComment, buildInstallCta, MARKER } = require('../src/action');
const { computeTax } = require('../src/tax');

const NO_COUPONS = { titles: [], error: null };
const COUPONS = { titles: ['19.9元王牌炸鸡任选2', '11.9元麦辣鸡腿堡', '免费脆薯饼', '人气麦旋风买一送一', '9.9元中杯冰美式'], error: null };

function makeView(taxOverrides = {}, pricingOverrides = {}) {
  const tax = computeTax({
    additions: 180,
    deletions: 320,
    changedFiles: 12,
    mergedAt: '2026-10-23T19:04:00+08:00',
    ...taxOverrides,
  });
  const pricing = {
    mode: 'live',
    source: 'mcp-live',
    storeCode: '1450713',
    storeName: '麦当劳上海黄浦华旭国际大厦餐厅',
    address: '南京东路街道西藏中路336号',
    distance: 144,
    reservationDate: null,
    afterHours: false,
    basket: [
      { productCode: '1100', name: '巨无霸', quantity: tax.bigMacs, unitFen: 2550, subtotalFen: 2550 * tax.bigMacs },
      { productCode: '4810', name: '中薯条', quantity: 1, unitFen: 1350, subtotalFen: 1350 },
    ],
    skipped: [],
    totalFen: 2550 * tax.bigMacs + 1350,
    originalFen: 2550 * tax.bigMacs + 1350,
    discountFen: 0,
    unitPriceFen: 2550,
    attempts: ['找店成功：5 家（营业中 5 家）', '[1450713@11:30] 核价成功 9000 分'],
    note: null,
    ...pricingOverrides,
  };
  const view = {
    taxpayer: 'octocat',
    action: '合并 PR #128「refactor: 拆掉上帝函数」',
    repo: 'acme/nebula',
    serial: 'BMT-20261023-A1B2C3',
    issuedAt: new Date('2026-10-23T11:04:00Z'),
    tax,
    pricing,
    coupons: [],
    note: null,
  };
  return { view, tax, pricing };
}

test('评论以 marker 开头（幂等更新的依据）', () => {
  const { view, tax, pricing } = makeView();
  const body = composeComment({ view, tax, pricing, coupons: NO_COUPONS });
  assert.ok(body.startsWith(MARKER), '首行必须是 marker，否则会重复开票');
});

test('标题与 @作者 符合规定格式', () => {
  const { view, tax, pricing } = makeView();
  const body = composeComment({ view, tax, pricing, coupons: NO_COUPONS });
  assert.ok(body.includes('## 🍔 麦门 PR 税已征收！'));
  assert.ok(body.includes('@octocat'));
  assert.ok(body.includes('**应缴：3 只巨无霸 ＋ 1 薯条**'));
});

test('税项是三列表格：税项 / 依据 / 税额，附加税写成 ×2 ＋1 薯条', () => {
  const { view, tax, pricing } = makeView();
  const body = composeComment({ view, tax, pricing, coupons: NO_COUPONS });

  assert.ok(body.includes('| 税项 | 依据 | 税额 |'));
  assert.ok(body.includes('| 基础合并税 |'), '要有基础合并税行');
  assert.ok(body.includes('| 代码量税 |'));
  assert.ok(body.includes('| 文件数税 |'));
  assert.ok(body.includes('| 周五夜间附加税 |'));
  assert.ok(body.includes('| 负熵减免 |'));
  assert.ok(body.includes('×2 ＋1 薯条'), '附加税税额必须是「×2 ＋1 薯条」形态');
  assert.ok(body.includes('第一条：'), '依据列要带法条');
});

test('ASCII 小票必须放在 text 代码块里，且围栏成对', () => {
  const { view, tax, pricing } = makeView();
  const body = composeComment({ view, tax, pricing, coupons: NO_COUPONS, extra: { projectUrl: 'https://github.com/me/bigmac-pr-tax' } });

  assert.ok(body.includes('```text'));
  const fences = body.split('\n').filter((l) => l.trim().startsWith('```')).length;
  assert.equal(fences % 2, 0, `围栏数为奇数(${fences})，有未闭合的块`);
  assert.ok(body.includes('谢谢惠顾 · 麦门永存'));
  assert.ok(body.includes('本小票不构成任何法律效力'));
});

test('实时模式要有 📍 一行，写明 mcd-city/mcd-keyword 与官方实时接口', () => {
  const { view, tax, pricing } = makeView();
  const body = composeComment({ view, tax, pricing, coupons: NO_COUPONS });
  assert.ok(body.includes('📍'));
  assert.ok(body.includes('`mcd-city` / `mcd-keyword`'));
  assert.ok(body.includes('麦当劳官方 MCP 实时接口'));
  assert.ok(body.includes('麦当劳上海黄浦华旭国际大厦餐厅'));
});

test('深夜兜底要有 🌙 一行', () => {
  const { view, tax, pricing } = makeView({}, { afterHours: true, note: '周边门店已打烊，按 24 小时门店实时核价' });
  const body = composeComment({ view, tax, pricing, coupons: NO_COUPONS });
  assert.ok(body.includes('🌙 深夜兜底'));
  assert.ok(body.includes('24 小时门店'));
});

test('离线快照模式不能伪装成实时', () => {
  const { view, tax, pricing } = makeView(
    {},
    { source: 'snapshot', mode: 'snapshot', snapshotGeneratedAt: '2026-10-21T09:15:00+08:00', note: 'MCP 不可用' }
  );
  const body = composeComment({ view, tax, pricing, coupons: NO_COUPONS });
  assert.ok(body.includes('离线快照模式'));
  assert.ok(!body.includes('麦当劳官方 MCP 实时接口'), '快照模式不能声称实时');
});

test('附麦麦省前 5 张券', () => {
  const { view, tax, pricing } = makeView();
  const body = composeComment({ view, tax, pricing, coupons: COUPONS });
  assert.ok(body.includes('**麦麦省优惠券（前 5 张）**'));
  assert.ok(body.includes('1. 19.9元王牌炸鸡任选2'));
  assert.ok(body.includes('5. 9.9元中杯冰美式'));
});

test('纳税须知恰好 3 条，第 3 条引导点 Star', () => {
  const { view, tax, pricing } = makeView();
  const body = composeComment({
    view,
    tax,
    pricing,
    coupons: NO_COUPONS,
    extra: { projectUrl: 'https://github.com/me/bigmac-pr-tax' },
  });
  assert.ok(body.includes('**纳税须知**'));
  assert.ok(body.includes('1. 《麦门税法》是本项目虚构的娱乐规则'));
  assert.ok(body.includes('2. 金额由麦当劳官方 MCP 核出'));
  assert.ok(/3\. 想在你的仓库也开征此税/.test(body));
  assert.ok(body.includes('⭐'));
  assert.ok(body.includes('https://github.com/me/bigmac-pr-tax'));
});

test('安装引导：uses 为 owner/repo@ref，没给地址时不生成死链', () => {
  const imgBody = buildInstallCta('https://github.com/me/bigmac-pr-tax').join('\n');
  assert.ok(imgBody.includes('uses: me/bigmac-pr-tax@v1'));
  assert.ok(imgBody.includes('secrets.MCD_MCP_TOKEN'));

  const bare = buildInstallCta('').join('\n');
  assert.ok(bare.includes('<你的用户名>/bigmac-pr-tax@v1'));
  assert.ok(!bare.includes('https://github.com//'));
});

test('合规声明不能丢', () => {
  const { view, tax, pricing } = makeView();
  const body = composeComment({ view, tax, pricing, coupons: NO_COUPONS });
  assert.ok(body.includes('不构成任何真实税费、付款或请客义务'));
  assert.ok(body.includes('非麦当劳官方产品'));
});

test('触顶时正文标注破产保护', () => {
  const { view, tax, pricing } = makeView({
    additions: 8400,
    deletions: 6200,
    changedFiles: 210,
    mergedAt: '2026-10-23T21:10:00+08:00',
  });
  const body = composeComment({ view, tax, pricing, coupons: NO_COUPONS });
  assert.ok(body.includes('已达上限 12 只'));
  assert.ok(body.includes('破产保护'));
});
