#!/usr/bin/env node
'use strict';

/**
 * 真实调用记录器 —— 跑一遍完整核价链路，逐条打印 name / 参数 / 耗时 / traceId / 结果。
 *
 *   MCD_MCP_TOKEN=xxx node scripts/trace-mcp.js          # 人读表格
 *   MCD_MCP_TOKEN=xxx node scripts/trace-mcp.js --json   # 机器可读
 *
 * 用途：证明"价格真的来自官方 MCP"。每一条都带服务端 traceId，可按时间与 traceId
 * 向麦当劳侧对账；同一个命令随时可以重跑，结果随门店在售状态变化而变化（这正是它真实的原因）。
 */

const { McdMcpClient } = require('../src/mcp');
const { nextLunchSlot } = require('../src/assess');

const token = process.env.MCD_MCP_TOKEN || process.env.INPUT_MCD_MCP_TOKEN || '';
if (!token) {
  console.error('用法：MCD_MCP_TOKEN=xxx node scripts/trace-mcp.js [--json]');
  process.exit(1);
}

const asJson = process.argv.includes('--json');
const STORE = process.env.STORE_CODE || '1450713';
const LUNCH = nextLunchSlot(new Date());
const client = new McdMcpClient({ token });
const rows = [];

async function step(note, name, args) {
  const t0 = Date.now();
  try {
    const res = await client.callTool(name, args);
    const j = res.envelope;
    rows.push({
      note,
      name,
      args,
      elapsedMs: Date.now() - t0,
      serverTime: j?.datetime ?? null,
      traceId: j?.traceId ?? null,
      code: j?.code ?? null,
      result: summarize(name, j, res.text),
    });
  } catch (err) {
    rows.push({
      note,
      name,
      args,
      elapsedMs: Date.now() - t0,
      error: err.message,
      code: err.code ?? null,
      result: null,
    });
  }
}

function summarize(name, j, text) {
  if (!j) return `${(text || '').slice(0, 60).replace(/\n/g, ' ')}…（非 JSON 返回）`;
  if (name === 'query-nearby-stores') {
    const d = j.data || [];
    return `${d.length} 家门店，首选 ${d[0]?.storeCode} ${d[0]?.storeName}`;
  }
  if (name === 'query-meals') {
    const meals = j.data?.meals || {};
    const hit = meals['1100'];
    return `${Object.keys(meals).length} 条餐品；巨无霸 ${hit ? `有，标价 ${hit.currentPrice} 元` : '无'}`;
  }
  if (name === 'calculate-price') {
    if (j.success === false) return `失败 code=${j.code} ${j.message}`;
    return `price=${j.data?.price} 分（${((j.data?.price || 0) / 100).toFixed(2)} 元）`;
  }
  return JSON.stringify(j).slice(0, 80);
}

function renderTable() {
  const out = [];
  out.push('| # | 工具 | 参数要点 | 耗时 | 服务端时间 | traceId | 结果 |');
  out.push('|---:|---|---|---:|---|---|---|');
  rows.forEach((r, i) => {
    const argKeys = r.name === 'query-meals' || r.name === 'calculate-price'
      ? Object.keys(r.args).filter((k) => k !== 'storeCode').join(', ') || '—'
      : Object.keys(r.args).join(', ') || '—';
    out.push(
      `| ${i + 1} | \`${r.name}\` | ${argKeys} | ${r.elapsedMs} ms | ${r.serverTime || '—'} | ${r.traceId ? '`' + r.traceId + '`' : '—（非 JSON）'} | ${r.error ? '❌ ' + r.error : r.result} |`
    );
  });
  const total = rows.reduce((s, r) => s + r.elapsedMs, 0);
  out.push('');
  out.push(`合计 ${rows.length} 次调用，端到端 **${(total / 1000).toFixed(2)} 秒**（含一次故意失败的重试）。`);
  return out.join('\n');
}

(async () => {
  await step('① 找就近门店（上海·人民广场）', 'query-nearby-stores', {
    beType: 1,
    searchType: 2,
    city: '上海',
    keyword: '人民广场',
  });
  await step('② 当前时段菜单', 'query-meals', { storeCode: STORE, orderType: 1, beType: 1 });
  await step('③ 当前时段算价 1100×3（早餐时段通常 60006）', 'calculate-price', {
    storeCode: STORE,
    orderType: 1,
    beType: 1,
    items: [{ productCode: '1100', quantity: 3 }],
  });
  await step(`④ 预约 ${LUNCH} 的菜单`, 'query-meals', {
    storeCode: STORE,
    orderType: 1,
    beType: 1,
    reservationDate: LUNCH,
  });
  await step(`⑤ 预约 ${LUNCH} 的算价 1100×3`, 'calculate-price', {
    storeCode: STORE,
    orderType: 1,
    beType: 1,
    reservationDate: LUNCH,
    items: [{ productCode: '1100', quantity: 3 }],
  });
  await step('⑥ 当日可领券（返回 Markdown，不是 JSON）', 'available-coupons', {});

  if (asJson) {
    console.log(JSON.stringify({ capturedAt: new Date().toISOString(), storeCode: STORE, rows }, null, 2));
  } else {
    console.log(renderTable());
  }
})();
