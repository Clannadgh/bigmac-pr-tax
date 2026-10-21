#!/usr/bin/env node
'use strict';

/**
 * 命令行入口 —— 不开 GitHub 也能开票，同时供 Agent Skill 调用。
 *
 *   node scripts/tax-cli.js --additions 180 --deletions 320 --files 12 \
 *        --merged-at 2026-10-16T19:04:00+08:00 --author octocat --title "refactor: xxx"
 *
 *   gh pr view 128 --json number,title,additions,deletions,changedFiles,mergedAt,author \
 *     | node scripts/tax-cli.js --stdin
 *
 * 选项：
 *   --format comment|receipt|json   输出形态（默认 comment）
 *   --offline                       跳过 MCP，直接用内置快照
 *   --max-burgers N                 破产保护上限（默认 12）
 *   --mcd-city / --mcd-keyword      就近门店
 */

const fs = require('node:fs');
const { parseArgs } = require('node:util');
const { computeTax } = require('../src/tax');
const { renderReceipt } = require('../src/receipt');
const { McdMcpClient } = require('../src/mcp');
const { assess } = require('../src/assess');
const { composeComment } = require('../src/action');

const OPTIONS = {
  stdin: { type: 'boolean', default: false },
  file: { type: 'string' },
  additions: { type: 'string' },
  deletions: { type: 'string' },
  files: { type: 'string' },
  'merged-at': { type: 'string' },
  author: { type: 'string' },
  title: { type: 'string' },
  number: { type: 'string' },
  format: { type: 'string', default: 'comment' },
  offline: { type: 'boolean', default: false },
  'max-burgers': { type: 'string' },
  'mcd-city': { type: 'string', default: '上海' },
  'mcd-keyword': { type: 'string', default: '人民广场' },
  'project-url': { type: 'string' },
  help: { type: 'boolean', default: false },
};

/** 把不同来源（JSON / 参数）归一成计税输入 */
function normalizePr(raw = {}) {
  const num = (v, d = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const author = raw.author?.login || raw.author || raw.user?.login || 'unknown';
  return {
    number: num(raw.number, 1),
    title: raw.title || 'feat: 未命名改动',
    author: typeof author === 'string' ? author : 'unknown',
    additions: Math.max(0, num(raw.additions)),
    deletions: Math.max(0, num(raw.deletions)),
    changedFiles: Math.max(0, num(raw.changedFiles ?? raw.changed_files)),
    mergedAt: raw.mergedAt || raw.merged_at || new Date().toISOString(),
    mergeCommitSha: raw.mergeCommitSha || raw.merge_commit_sha || 'cli0000',
  };
}

function readInput(values) {
  if (values.stdin) return JSON.parse(fs.readFileSync(0, 'utf8'));
  if (values.file) return JSON.parse(fs.readFileSync(values.file, 'utf8'));
  if (values.additions !== undefined) {
    return {
      number: values.number,
      title: values.title,
      author: values.author,
      additions: values.additions,
      deletions: values.deletions,
      changedFiles: values.files,
      mergedAt: values['merged-at'],
    };
  }
  throw new Error('没有 PR 数据：用 --additions/--deletions/--files，或 --stdin / --file 传 JSON');
}

async function main() {
  const { values } = parseArgs({ options: OPTIONS, allowPositionals: false });

  if (values.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*?/, '').replace(/^ \* ?/gm, ''));
    return;
  }

  const pr = normalizePr(readInput(values));
  const maxBigMacs = Number(values['max-burgers']) || 12;

  const tax = computeTax(
    {
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changedFiles,
      mergedAt: pr.mergedAt,
    },
    { maxBigMacs }
  );

  const token = process.env.MCD_MCP_TOKEN || '';
  const client = !values.offline && token ? new McdMcpClient({ token, logger: () => {} }) : null;

  const pricing = await assess({
    client,
    bigMacs: tax.bigMacs,
    sideDishes: tax.sideDishes,
    city: values['mcd-city'],
    keyword: values['mcd-keyword'],
    withCoupons: true,
  });

  if (values.format === 'json') {
    console.log(JSON.stringify({ pr, tax, pricing }, null, 2));
    return;
  }

  const view = {
    taxpayer: pr.author,
    action: `合并 PR #${pr.number}「${pr.title}」`,
    repo: 'local/cli',
    serial: `BMT-${String(pr.mergedAt).slice(0, 10).replace(/-/g, '')}-${String(pr.mergeCommitSha).slice(0, 6).toUpperCase()}`,
    issuedAt: new Date(pr.mergedAt),
    tax,
    pricing,
    coupons: pricing.coupons?.titles || [],
    note: pricing.source === 'snapshot' ? pricing.note : null,
  };

  if (values.format === 'receipt') {
    console.log(renderReceipt(view));
    return;
  }

  console.log(
    composeComment({
      view,
      tax,
      pricing,
      coupons: pricing.coupons || { titles: [], error: null },
      extra: { projectUrl: values['project-url'] || '' },
    })
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  });
}

module.exports = { normalizePr };
