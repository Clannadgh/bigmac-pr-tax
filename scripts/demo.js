#!/usr/bin/env node
'use strict';

/**
 * 本地演示：不连 GitHub，用一份"像真的"的 PR 数据跑完整条链路。
 *
 *   node scripts/demo.js                  # 默认：周五夜间的重构 PR（附加税 + 负熵减免都触发）
 *   node scripts/demo.js --case plain     # 工作日白天合并（无附加税）
 *   node scripts/demo.js --case weekend    # 周日加班合并
 *   node scripts/demo.js --case huge       # 超大 PR（触发破产保护上限）
 *   node scripts/demo.js --offline         # 强制走内置快照，演示降级
 *   node scripts/demo.js --json            # 额外输出结构化结果
 */

const { computeTax, formatShanghai } = require('../src/tax');
const { renderReceipt, fen2yuan } = require('../src/receipt');
const { McdMcpClient } = require('../src/mcp');
const { assess } = require('../src/assess');

const args = process.argv.slice(2);
const offline = args.includes('--offline');
const showJson = args.includes('--json');
const caseArg = (args.find((a) => a.startsWith('--case=')) || '').split('=')[1] || valueAfter('--case') || 'friday';

function valueAfter(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/**
 * 取「最近一次」的某个星期几（东八区）并返回 UTC ISO 字符串。
 * 演示数据不要写死未来日期，否则小票上的开票时间会看起来像 bug。
 */
function mostRecent(weekday, hh, mm) {
  const nowLocal = new Date(Date.now() + 8 * 3600 * 1000);
  const cur = new Date(
    Date.UTC(nowLocal.getUTCFullYear(), nowLocal.getUTCMonth(), nowLocal.getUTCDate(), hh, mm)
  );
  let back = (cur.getUTCDay() - weekday + 7) % 7;
  if (back === 0 && cur.getTime() > nowLocal.getTime()) back = 7;
  // cur 是"把东八区墙上时间当成 UTC"，所以要减去 8 小时才是真正的 UTC 瞬时
  return new Date(cur.getTime() - back * 86400000 - 8 * 3600 * 1000).toISOString();
}

/**
 * 四个场景。时间都按东八区写，mergedAt 用带偏移的 ISO 字符串，
 * 保证在任何机器时区下算出来的星期几都一样。
 */
const CASES = {
  friday: {
    label: '周五夜间 · 重构',
    pull: {
      number: 128,
      title: 'refactor(pricing): 拆掉优惠券叠加的上帝函数，改为策略链',
      user: { login: 'octocat' },
      additions: 180,
      deletions: 320,
      changed_files: 12,
      merge_commit_sha: 'a1b2c3d4e5f6a7b8',
      merged_at: mostRecent(5, 19, 4), // 最近的周五 19:04
    },
  },
  plain: {
    label: '工作日白天 · 常规',
    pull: {
      number: 131,
      title: 'feat(api): 新增退款查询接口',
      user: { login: 'octocat' },
      additions: 620,
      deletions: 40,
      changed_files: 23,
      merge_commit_sha: 'b2c3d4e5f6a7b8c9',
      merged_at: mostRecent(3, 14, 20), // 最近的周三 14:20
    },
  },
  weekend: {
    label: '周日 · 线上救火',
    pull: {
      number: 133,
      title: 'hotfix(order): 修复并发下单导致的重复扣款',
      user: { login: 'octocat' },
      additions: 96,
      deletions: 31,
      changed_files: 4,
      merge_commit_sha: 'c3d4e5f6a7b8c9d0',
      merged_at: mostRecent(0, 2, 40), // 最近的周日凌晨
    },
  },
  huge: {
    label: '超大 PR · 破产保护',
    pull: {
      number: 140,
      title: 'chore: 全仓库格式化 + 依赖升级',
      user: { login: 'octocat' },
      additions: 8400,
      deletions: 6200,
      changed_files: 210,
      merge_commit_sha: 'd4e5f6a7b8c9d0e1',
      merged_at: mostRecent(5, 21, 10), // 最近的周五夜里
    },
  },
};

(async () => {
  const scenario = CASES[caseArg] || CASES.friday;
  const { pull } = scenario;

  const tax = computeTax({
    additions: pull.additions,
    deletions: pull.deletions,
    changedFiles: pull.changed_files,
    mergedAt: pull.merged_at,
  });

  const token = process.env.MCD_MCP_TOKEN || '';
  const client = !offline && token ? new McdMcpClient({ token, logger: (m) => console.error(m) }) : null;
  if (!offline && !token) console.error('[demo] 未设置 MCD_MCP_TOKEN，使用内置快照');

  const pricing = await assess({
    client,
    bigMacs: tax.bigMacs,
    sideDishes: tax.sideDishes,
    city: '上海',
    keyword: '人民广场',
  });
  const coupons = pricing.coupons || { titles: [], error: null };

  const receipt = renderReceipt({
    taxpayer: pull.user.login,
    action: `合并 PR #${pull.number}「${pull.title}」`,
    repo: 'acme/nebula',
    serial: `BMT-${formatShanghai(new Date(pull.merged_at), false).replace(/-/g, '')}-A1B2C3`,
    issuedAt: new Date(pull.merged_at),
    tax,
    pricing,
    coupons: coupons.titles,
    note: pricing.source === 'snapshot' ? pricing.note : null,
  });

  console.log(`### 场景：${scenario.label}\n`);
  console.log(receipt);
  console.log('');
  console.log(`— 应纳 ${tax.bigMacs} 只（小计 ${tax.subtotalUnits} × ${tax.totalMultiplier} = ${tax.rawBigMacs}）`);
  console.log(`— 核价来源 ${pricing.source} / 实付 ${fen2yuan(pricing.totalFen)} / 门店 ${pricing.storeName}`);
  if (pricing.skipped.length) console.log(`— 跳过配菜 ${pricing.skipped.map((s) => s.name).join('、')}`);
  if (pricing.attempts?.length) console.log('— 链路 ' + pricing.attempts.join(' → '));

  if (showJson) {
    console.log('\n' + JSON.stringify({ tax, pricing, coupons }, null, 2));
  }
})();
