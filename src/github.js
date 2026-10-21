'use strict';

/**
 * GitHub REST 客户端 —— 同样零依赖，只用原生 fetch。
 * 只用得到 4 个接口：读 PR、读 PR 文件、读 PR 提交、写/更新 issue comment。
 */

class GitHubError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.body = body;
  }
}

class GitHubClient {
  constructor({ token, apiUrl = 'https://api.github.com', repository, logger }) {
    if (!token) throw new GitHubError('缺少 GITHUB_TOKEN');
    if (!repository || !repository.includes('/')) throw new GitHubError(`GITHUB_REPOSITORY 非法: ${repository}`);
    this.token = token;
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.repository = repository;
    this.logger = logger || (() => {});
  }

  async request(method, endpoint, body) {
    const url = endpoint.startsWith('http') ? endpoint : `${this.apiUrl}${endpoint}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'bigmac-pr-tax/1.0',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      throw new GitHubError(`GitHub ${method} ${endpoint} -> ${res.status}`, res.status, json || text.slice(0, 300));
    }
    return { json, headers: res.headers };
  }

  /** 分页取列表，最多 maxPages 页（避免超大 PR 把 Actions 跑爆） */
  async paginate(endpoint, maxPages = 3) {
    const out = [];
    for (let page = 1; page <= maxPages; page++) {
      const sep = endpoint.includes('?') ? '&' : '?';
      const { json } = await this.request('GET', `${endpoint}${sep}per_page=100&page=${page}`);
      if (!Array.isArray(json) || json.length === 0) break;
      out.push(...json);
      if (json.length < 100) break;
    }
    return out;
  }

  getPullRequest(number) {
    return this.request('GET', `/repos/${this.repository}/pulls/${number}`).then((r) => r.json);
  }

  getPullRequestFiles(number) {
    return this.paginate(`/repos/${this.repository}/pulls/${number}/files`);
  }

  getPullRequestCommits(number) {
    return this.paginate(`/repos/${this.repository}/pulls/${number}/commits`);
  }

  listComments(number) {
    return this.paginate(`/repos/${this.repository}/issues/${number}/comments`);
  }

  createComment(number, body) {
    return this.request('POST', `/repos/${this.repository}/issues/${number}/comments`, { body }).then((r) => r.json);
  }

  updateComment(commentId, body) {
    return this.request('PATCH', `/repos/${this.repository}/issues/comments/${commentId}`, { body }).then((r) => r.json);
  }
}

module.exports = { GitHubClient, GitHubError };
