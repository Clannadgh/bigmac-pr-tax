'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePr } = require('../scripts/tax-cli');

test('normalizePr 能吃掉 gh pr view 的原始 JSON', () => {
  const pr = normalizePr({
    number: 128,
    title: 'refactor: 拆掉上帝函数',
    author: { login: 'octocat' },
    additions: 180,
    deletions: 320,
    changedFiles: 12,
    mergedAt: '2026-10-16T19:04:00+08:00',
    mergeCommitSha: 'a1b2c3d4',
  });
  assert.equal(pr.author, 'octocat');
  assert.equal(pr.changedFiles, 12);
  assert.equal(pr.additions, 180);
});

test('normalizePr 兼容 GitHub REST 的下划线字段', () => {
  const pr = normalizePr({
    user: { login: 'hubot' },
    changed_files: 7,
    merged_at: '2026-10-16T11:04:00Z',
    merge_commit_sha: 'deadbeef',
  });
  assert.equal(pr.author, 'hubot');
  assert.equal(pr.changedFiles, 7);
  assert.equal(pr.mergeCommitSha, 'deadbeef');
});

test('normalizePr 对缺失/非法字段给安全默认值', () => {
  const pr = normalizePr({ additions: 'abc', deletions: -5 });
  assert.equal(pr.additions, 0, '非法数字按 0');
  assert.equal(pr.deletions, 0, '负数按 0');
  assert.equal(pr.number, 1);
  assert.equal(pr.author, 'unknown');
  assert.ok(pr.mergedAt, '必须有合并时间，否则算不出附加税');
});
