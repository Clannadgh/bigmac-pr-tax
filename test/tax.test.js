'use strict';

/**
 * 《麦门税法》逐条锁定。
 * 每条规则至少一个正例 + 一个边界反例；改动规则必须同步改这里，否则测试会红。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeTax, PRODUCTS, localParts } = require('../src/tax');

/** 周三 14:20（东八区）——无任何附加税的基准时刻 */
const WED_AFTERNOON = '2026-10-21T14:20:00+08:00';

const base = { additions: 0, deletions: 0, changedFiles: 0, mergedAt: WED_AFTERNOON };

const units = (t, id) => t.unitLines.find((l) => l.id === id)?.units;
const mult = (t, id) => t.multiplierLines.find((l) => l.id === id);

// ===== T1 基础合并税：合并即征税 +1 =====
test('T1 零改动也征 1 只（合并这个动作本身就要交）', () => {
  const t = computeTax(base);
  assert.equal(units(t, 'T1'), 1);
  assert.equal(t.bigMacs, 1);
});

// ===== T2 代码量税：每 500 行 +1，上限 +5 =====
test('T2 499 行不加征，500 行 +1，1000 行 +2', () => {
  assert.equal(units(computeTax({ ...base, additions: 499 }), 'T2'), 0);
  assert.equal(units(computeTax({ ...base, additions: 500 }), 'T2'), 1);
  assert.equal(units(computeTax({ ...base, additions: 600, deletions: 400 }), 'T2'), 2);
});

test('T2 上限 +5（3000 行本应 +6，封顶 5）', () => {
  const t = computeTax({ ...base, additions: 3000 });
  assert.equal(units(t, 'T2'), 5);
  assert.match(t.unitLines.find((l) => l.id === 'T2').detail, /封顶/);
});

test('T2 按 additions+deletions 合计计算，不是只看新增', () => {
  const t = computeTax({ ...base, additions: 100, deletions: 400 });
  assert.equal(units(t, 'T2'), 1);
});

// ===== T3 文件数税：每 10 个 +1，上限 +3 =====
test('T3 9 个文件不加征，10 个 +1，20 个 +2', () => {
  assert.equal(units(computeTax({ ...base, changedFiles: 9 }), 'T3'), 0);
  assert.equal(units(computeTax({ ...base, changedFiles: 10 }), 'T3'), 1);
  assert.equal(units(computeTax({ ...base, changedFiles: 20 }), 'T3'), 2);
});

test('T3 上限 +3（50 个文件本应 +5，封顶 3）', () => {
  const t = computeTax({ ...base, changedFiles: 50 });
  assert.equal(units(t, 'T3'), 3);
  assert.match(t.unitLines.find((l) => l.id === 'T3').detail, /封顶/);
});

// ===== M1 周五夜间附加税：周五 18:00 后 ×2 + 1 份薯条(4810) =====
test('M1 周五 19:04 合并：×2，并附薯条（4810）', () => {
  const t = computeTax({ ...base, additions: 500, mergedAt: '2026-10-23T19:04:00+08:00' });
  const m1 = mult(t, 'M1');
  assert.ok(m1, '应触发周五夜间附加税');
  assert.equal(m1.multiplier, 2);
  assert.deepEqual(m1.sideDish, { productCode: PRODUCTS.FRIES, name: '薯条', quantity: 1 });
  assert.equal(t.sideDishes.length, 1);
  assert.equal(t.sideDishes[0].productCode, '4810');
  // 小计 2 只 × 2 = 4
  assert.equal(t.subtotalUnits, 2);
  assert.equal(t.bigMacs, 4);
});

test('M1 周五 18:00 整点即生效', () => {
  const at18 = computeTax({ ...base, mergedAt: '2026-10-23T18:00:00+08:00' });
  assert.ok(mult(at18, 'M1'));
});

test('M1 周五 17:59 不触发', () => {
  const t = computeTax({ ...base, mergedAt: '2026-10-23T17:59:00+08:00' });
  assert.equal(mult(t, 'M1'), undefined);
  assert.equal(t.multiplierLines.length, 0);
  assert.equal(t.sideDishes.length, 0);
});

// ===== M2 周末加班附加税：周六/周日 ×1.5 + 1 杯美式(507411) =====
test('M2 周六合并：×1.5，并附麦咖啡美式（507411）', () => {
  const t = computeTax({ ...base, mergedAt: '2026-10-24T10:00:00+08:00' });
  const m2 = mult(t, 'M2');
  assert.ok(m2);
  assert.equal(m2.multiplier, 1.5);
  assert.deepEqual(m2.sideDish, { productCode: PRODUCTS.AMERICANO, name: '麦咖啡美式', quantity: 1 });
  assert.equal(t.sideDishes[0].productCode, '507411');
});

test('M2 周日也触发（凌晨照样算加班）', () => {
  const t = computeTax({ ...base, mergedAt: '2026-10-25T02:40:00+08:00' });
  assert.ok(mult(t, 'M2'));
  assert.equal(mult(t, 'M1'), undefined, '周日不应误判为周五夜间');
});

test('M1 与 M2 互斥，不会同时出现', () => {
  const t = computeTax({ ...base, mergedAt: '2026-10-23T23:59:00+08:00' }); // 周五深夜
  assert.ok(mult(t, 'M1'));
  assert.equal(mult(t, 'M2'), undefined);
});

// ===== M3 负熵减免：deletions > additions 且总量 >= 50 → ×0.5 =====
test('M3 删除多于新增且总量 ≥50：×0.5', () => {
  const t = computeTax({ ...base, additions: 100, deletions: 200 });
  const m3 = mult(t, 'M3');
  assert.ok(m3);
  assert.equal(m3.multiplier, 0.5);
  assert.equal(m3.sideDish, undefined, '减免不带配菜');
});

test('M3 总量 49 行不触发（差一行也不行）', () => {
  const t = computeTax({ ...base, additions: 24, deletions: 25 });
  assert.equal(mult(t, 'M3'), undefined);
});

test('M3 增删相等不触发', () => {
  const t = computeTax({ ...base, additions: 100, deletions: 100 });
  assert.equal(mult(t, 'M3'), undefined);
});

// ===== 组合：周五夜间 + 负熵减免 =====
test('周五夜间 ×2 与负熵 ×0.5 连乘 = ×1', () => {
  const t = computeTax({
    additions: 180,
    deletions: 320,
    changedFiles: 12,
    mergedAt: '2026-10-23T19:04:00+08:00',
  });
  assert.equal(t.subtotalUnits, 3, '1 + 1(500行) + 1(12个文件)');
  assert.equal(t.totalMultiplier, 1, '2 × 0.5');
  assert.equal(t.rawBigMacs, 3);
  assert.equal(t.bigMacs, 3);
  assert.equal(t.sideDishes.length, 1, '附加税照征薯条，不因减免而退回');
});

// ===== 破产保护：四舍五入 + 下限 + 上限 =====
test('破产保护：四舍五入（2.5 → 3，不是向上取整也不是截断）', () => {
  // 小计 5 只（2500 行 → 封顶5 + T1 1 = 6？这里精确构造：T1=1，T2=+2（1000行），T3=+1（10文件）=4）
  // 4 × 1.5 = 6；改用 ×0.5：4 × 0.5 = 2 —— 不产生 .5
  // 用 T1=1 + T2=1 + T3=0 = 2，×1.25 无法构造；故用 1.5 与 1：3 × 1.5 = 4.5 → round = 5
  const t = computeTax({
    additions: 500, // T2 = 1
    deletions: 0,
    changedFiles: 0, // T3 = 0
    mergedAt: '2026-10-24T10:00:00+08:00', // M2 ×1.5
  });
  assert.equal(t.subtotalUnits, 2);
  assert.equal(t.totalMultiplier, 1.5);
  assert.equal(t.rawBigMacs, 3);
  assert.equal(t.bigMacs, 3);

  // 直接验证 round 语义：3 × 1.5 = 4.5
  const t2 = computeTax({ additions: 1000, mergedAt: '2026-10-24T10:00:00+08:00' });
  assert.equal(t2.subtotalUnits, 3); // 1 + 2
  assert.equal(t2.rawBigMacs, 4.5);
  assert.equal(t2.bigMacs, 5, '4.5 四舍五入为 5');
});

test('破产保护：下限 1 只（×0.5 也不会变成 0）', () => {
  const t = computeTax({ ...base, additions: 10, deletions: 45 }); // 负熵 ×0.5，小计 1
  assert.equal(t.subtotalUnits, 1);
  assert.equal(t.rawBigMacs, 0.5);
  assert.equal(t.bigMacs, 1);
});

test('破产保护：下限可配置（min 2 时 1 只被抬到 2，并标记 floorApplied）', () => {
  const t = computeTax({ additions: 0 }, { minBigMacs: 2 });
  assert.equal(t.bigMacs, 2);
  assert.equal(t.floorApplied, true);
});

test('破产保护：默认上限 12，超大 PR 被截断并标记 capped', () => {
  const t = computeTax({
    additions: 8400,
    deletions: 6200, // 14600 行 → T2 封顶 5
    changedFiles: 210, // T3 封顶 3
    mergedAt: '2026-10-23T21:10:00+08:00', // 周五夜间 ×2
  });
  assert.equal(t.subtotalUnits, 9); // 1 + 5 + 3
  assert.equal(t.rawBigMacs, 18);
  assert.equal(t.capped, true);
  assert.equal(t.bigMacs, 12);
});

test('破产保护：上限可配置', () => {
  const t = computeTax({ additions: 5000, mergedAt: '2026-10-23T21:10:00+08:00' }, { maxBigMacs: 3 });
  assert.equal(t.bigMacs, 3);
  assert.equal(t.capped, true);
});

// ===== 时区：默认 UTC+8，可配置 =====
test('时区默认 UTC+8：UTC 周五 16:30 已算周六凌晨（触发周末税）', () => {
  // 2026-10-23T16:30Z = 北京时间 10-24 00:30（周六）
  const t = computeTax({ ...base, mergedAt: '2026-10-23T16:30:00Z' });
  assert.equal(t.local.weekday, 6);
  assert.ok(mult(t, 'M2'));
});

test('时区可配置：同一时刻按 UTC+0 算仍是周五白天，不触发附加税', () => {
  const t = computeTax({ ...base, mergedAt: '2026-10-23T16:30:00Z' }, { offsetHours: 0 });
  assert.equal(t.local.weekday, 5);
  assert.equal(t.local.hour, 16);
  assert.equal(t.multiplierLines.length, 0);
});

test('localParts 正确换算星期与本地时刻', () => {
  const p = localParts(new Date('2026-10-23T11:04:00Z'), 8);
  assert.equal(p.ymd, '2026-10-23');
  assert.equal(p.hhmm, '19:04');
  assert.equal(p.weekday, 5);
});

// ===== 输出结构契约 =====
test('输出结构：bigMacs / unitLines / multiplierLines(含 sideDish) / capped 齐全', () => {
  const t = computeTax({
    additions: 180,
    deletions: 320,
    changedFiles: 12,
    mergedAt: '2026-10-23T19:04:00+08:00',
  });

  assert.equal(typeof t.bigMacs, 'number');
  assert.ok(Array.isArray(t.unitLines));
  assert.ok(Array.isArray(t.multiplierLines));
  assert.equal(typeof t.capped, 'boolean');

  assert.deepEqual(t.unitLines.map((l) => l.id), ['T1', 'T2', 'T3']);
  for (const line of [...t.unitLines, ...t.multiplierLines]) {
    assert.ok(line.label && typeof line.label === 'string', `${line.id} 缺 label`);
    assert.ok(line.detail && typeof line.detail === 'string', `${line.id} 缺 detail`);
  }
  const m1 = t.multiplierLines.find((l) => l.id === 'M1');
  assert.ok('sideDish' in m1, '附加税行必须带 sideDish 字段');
  assert.equal(m1.sideDish.productCode, '4810');
});

test('无附加税时 multiplierLines 为空数组（而不是 undefined）', () => {
  const t = computeTax(base);
  assert.ok(Array.isArray(t.multiplierLines));
  assert.equal(t.multiplierLines.length, 0);
  assert.deepEqual(t.sideDishes, []);
});
