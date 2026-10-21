'use strict';

/**
 * Action 入口：PR 合并 → 计税 → 麦当劳 MCP 核价 → 在 PR 评论区开票。
 *
 * 运行模式：
 *   - 正常：读 pull_request 事件 → 发/更新评论
 *   - dry-run：只把税单打到 stdout（本地调试 & 截图用，不碰 GitHub 写接口）
 *   - manual：workflow_dispatch 时用 pr-number 输入指定 PR
 */

const fs = require('node:fs');
const { computeTax, formatShanghai } = require('./tax');
const { renderReceipt, fen2yuan, amountText } = require('./receipt');
const { McdMcpClient } = require('./mcp');
const { assess } = require('./assess');
const { GitHubClient } = require('./github');

const MARKER = '<!-- bigmac-pr-tax:v1 -->';

/** 兼容 action.yml 里带连字符的 input 名（INPUT_GITHUB-TOKEN 与 INPUT_GITHUB_TOKEN 都能取到） */
function input(name, fallback = '') {
  const variants = [
    `INPUT_${name.toUpperCase().replace(/ /g, '_')}`,
    `INPUT_${name.toUpperCase().replace(/[ -]/g, '_')}`,
  ];
  for (const key of variants) {
    const v = process.env[key];
    if (v !== undefined && v !== '') return v;
  }
  return fallback;
}

function boolInput(name, fallback = false) {
  const v = input(name, '');
  if (!v) return fallback;
  return /^(1|true|yes|y|on)$/i.test(v.trim());
}

function readEvent() {
  const p = process.env.GITHUB_EVENT_PATH;
  if (!p || !fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

function log(msg) {
  console.log(msg);
}

/** 把 PR 的原始数据整理成计税输入（只取统计数字，不读代码内容） */
function buildTaxInput({ pull, files }) {
  return {
    additions: pull.additions ?? files.reduce((s, f) => s + (f.additions || 0), 0),
    deletions: pull.deletions ?? files.reduce((s, f) => s + (f.deletions || 0), 0),
    changedFiles: pull.changed_files ?? files.length,
    mergedAt: pull.merged_at || new Date().toISOString(),
  };
}

/**
 * 汇总成评论正文。
 *
 * 结构（按产品格式固定）：
 *   标题 → @作者 + 应缴 → 税项三列表格（税项/依据/税额）
 *   → ASCII 小票 → 📍 门店说明 → 🌙 深夜兜底 → 麦麦省前 5 张券 → 纳税须知 3 条
 *   → 折叠的计税参数 / 核价链路 → 合规脚注
 */
function composeComment({ view, tax, pricing, coupons, extra }) {
  const { taxpayer, repo, serial } = view;
  const receipt = renderReceipt(view);
  const lines = [];

  const sideText = (tax.sideDishes || []).map((s) => `${s.quantity} ${s.name}`).join(' ＋ ');
  const dueText = `${tax.bigMacs} 只巨无霸${sideText ? ` ＋ ${sideText}` : ''}`;

  // ---- 标题 ----
  lines.push(MARKER);
  lines.push('## 🍔 麦门 PR 税已征收！');
  lines.push('');
  lines.push(`@${taxpayer} ${view.action}。`);
  lines.push('');
  lines.push(`**应缴：${dueText}**`);
  lines.push('');

  // ---- 税项三列表格 ----
  lines.push('| 税项 | 依据 | 税额 |');
  lines.push('| --- | --- | --- |');
  for (const line of tax.unitLines) {
    lines.push(`| ${line.label} | ${line.basis || line.detail} | +${line.units} 只 |`);
  }
  for (const line of tax.multiplierLines) {
    lines.push(`| ${line.label} | ${line.basis || line.detail} | ${amountText(line)} |`);
  }
  const protect = [];
  if (tax.capped) protect.push(`已达上限 ${tax.config.maxBigMacs} 只`);
  if (tax.floorApplied) protect.push('不足 1 只按 1 只');
  lines.push(
    `| **应缴** | 四舍五入后 ${tax.bigMacs} 只${protect.length ? `（${protect.join('，')}）` : ''} | **${dueText}** |`
  );
  lines.push('');

  // ---- ASCII 小票 ----
  lines.push('```text');
  lines.push(receipt);
  lines.push('```');
  lines.push('');

  // ---- 门店与价格来源 ----
  if (pricing.source === 'mcp-live') {
    lines.push(
      `📍 门店按 \`mcd-city\` / \`mcd-keyword\` 就近选择：**${pricing.storeName}**（${pricing.storeCode}）` +
        `${pricing.reservationDate ? `，预约 ${pricing.reservationDate} 取餐` : ''}。价格来自**麦当劳官方 MCP 实时接口**。`
    );
  } else if (pricing.source === 'mcp-menu') {
    lines.push(
      `📍 门店按 \`mcd-city\` / \`mcd-keyword\` 就近选择：**${pricing.storeName}**（${pricing.storeCode}）。` +
        '算价接口不可用，金额取自 MCP 实时菜单标价，**未含优惠**。'
    );
  } else {
    lines.push(
      `📍 ${pricing.note || 'MCP 不可用'}。票面标注「离线快照模式」，点单前请以门店实时价为准。`
    );
  }
  if (pricing.afterHours) {
    lines.push('');
    lines.push('🌙 深夜兜底：周边门店已打烊（菜单为空），自动切到人民广场 24 小时门店继续实时核价。');
  }
  lines.push('');

  // ---- 麦麦省券（前 5 张）----
  if (coupons.titles.length) {
    lines.push('**麦麦省优惠券（前 5 张）**');
    lines.push('');
    coupons.titles.slice(0, 5).forEach((t, i) => lines.push(`${i + 1}. ${t}`));
    lines.push('');
    lines.push('<sub>打开麦当劳 App / 小程序 → 麦麦省 → 一键领取</sub>');
    lines.push('');
  }

  // ---- 纳税须知（恰好 3 条）----
  lines.push('**纳税须知**');
  lines.push('');
  lines.push('1. 《麦门税法》是本项目虚构的娱乐规则，本税单**不构成任何真实税费、付款或请客义务**。');
  lines.push('2. 金额由麦当劳官方 MCP 核出；若票面标注「离线快照模式」，请以门店实时价为准。');
  lines.push(
    extra?.projectUrl
      ? `3. 想在你的仓库也开征此税？把 [项目主页](${extra.projectUrl}) 里的 workflow 贴进 \`.github/workflows/\` 即可，顺手点个 ⭐ 就当交税了。`
      : '3. 想在你的仓库也开征此税？贴上 3 行 workflow 即可（见下方折叠），顺手点个 ⭐ 就当交税了。'
  );
  lines.push('');

  // ---- 折叠：计税参数 + 核价链路 ----
  lines.push('<details><summary>📎 计税参数与核价链路（可复核）</summary>');
  lines.push('');
  lines.push('| 参数 | 数值 |');
  lines.push('| --- | --- |');
  lines.push(`| 新增行 / 删除行 | +${tax.stats.additions} / -${tax.stats.deletions}（共 ${tax.stats.totalChangedLines} 行） |`);
  lines.push(`| 变更文件 | ${tax.stats.changedFiles} 个 |`);
  lines.push(`| 合并时间 | ${tax.stats.localTime}（${tax.stats.weekdayCn}，UTC+${tax.config.offsetHours}） |`);
  lines.push(`| 加性小计 → 连乘 → 应缴 | ${tax.subtotalUnits} 只 × ${tax.totalMultiplier} = ${tax.rawBigMacs} → ${tax.bigMacs} 只 |`);
  for (const b of pricing.basket || []) {
    lines.push(`| ${b.name} | ${fen2yuan(b.unitFen)} × ${b.quantity} = ${fen2yuan(b.subtotalFen)} |`);
  }
  for (const s of pricing.skipped || []) lines.push(`| ${s.name} | 已跳过：${s.reason} |`);
  lines.push(
    `| 应付 | ${fen2yuan(pricing.totalFen)}（原价 ${fen2yuan(pricing.originalFen)}，优惠 ${fen2yuan(pricing.discountFen)}，${pricing.totalFen} 分） |`
  );
  lines.push(`| 门店 | ${pricing.storeName}（${pricing.storeCode}） |`);
  lines.push('');
  lines.push('```text');
  for (const a of pricing.attempts || []) lines.push(`· ${a}`);
  lines.push('```');
  if (coupons.error) {
    lines.push('');
    lines.push(`> 优惠券未取到：${coupons.error}`);
  }
  lines.push('');
  lines.push('</details>');
  lines.push('');

  lines.push(...buildInstallCta(extra?.projectUrl));

  lines.push(
    '<sub>本税单由 <a href="https://github.com/">麦门 PR 税 bigmac-pr-tax</a> 自动开具；' +
      '《麦门税法》为虚构娱乐规则，本项目非麦当劳官方产品。</sub>'
  );
  if (extra?.footer) lines.push('', `<sub>${extra.footer}</sub>`);

  return lines.join('\n');
}

const FALLBACK_ACTION_REF = '<你的用户名>/bigmac-pr-tax@v1';

/**
 * 安装引导。放在税单底部、默认折叠——不打扰看票，但想装的人 2 分钟能装完。
 * projectUrl 为空时只给出 yml 模板，不生成死链。
 */
function buildInstallCta(projectUrl) {
  const raw = projectUrl
    ? String(projectUrl).replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, '')
    : FALLBACK_ACTION_REF;
  const ref = raw.includes('@') ? raw : `${raw}@v1`;
  const out = [];
  out.push('<details><summary>🍔 把这个税单装到你自己的仓库（2 分钟）</summary>');
  out.push('');
  out.push('在你的仓库新建 `.github/workflows/bigmac-pr-tax.yml`：');
  out.push('');
  out.push('```yaml');
  out.push('on: { pull_request: { types: [closed] } }');
  out.push('permissions: { contents: read, pull-requests: write }');
  out.push('jobs:');
  out.push('  tax:');
  out.push('    if: github.event.pull_request.merged == true');
  out.push('    runs-on: ubuntu-latest');
  out.push('    steps:');
  out.push(`      - uses: ${ref}`);
  out.push('        with:');
  out.push('          mcd-mcp-token: ${{ secrets.MCD_MCP_TOKEN }}');
  out.push('```');
  out.push('');
  out.push('- 不需要 `checkout`，不需要 `npm install`，**不读你的源码**（只用 GitHub API 的 PR 统计数字）');
  out.push('- 没有 `MCD_MCP_TOKEN` 也能跑，价格会标注为「内置快照」');
  out.push('- 想换城市/门店：加 `city` / `keyword` / `store-code` 输入');
  out.push('');
  out.push(
    projectUrl
      ? `<sub>项目主页：[${projectUrl}](${projectUrl})　觉得有意思的话，点个 ⭐ 就当是给税务局交的税。</sub>`
      : '<sub>把上面的 `<你的用户名>` 换成你自己的仓库地址即可。</sub>'
  );
  out.push('');
  out.push('</details>');
  out.push('');
  return out;
}

async function run() {
  const repository = process.env.GITHUB_REPOSITORY || '';
  const event = readEvent();
  const dryRun = boolInput('dry-run', false) || process.env.BIGMAC_DRY_RUN === '1';

  const manualPr = input('pr-number', '');
  const pull = event.pull_request;
  const prNumber = manualPr ? Number(manualPr) : pull?.number || event.issue?.number;

  if (!pull && !manualPr) {
    log('没有 pull_request 事件（也不是手动指定 PR），跳过。');
    return;
  }
  if (pull && event.action === 'closed' && pull.merged !== true) {
    log(`PR #${pull.number} 已关闭但未合并，不予征税。`);
    return;
  }

  const githubToken = input('github-token', process.env.GITHUB_TOKEN || '');
  const mcdToken = input('mcd-mcp-token', process.env.MCD_MCP_TOKEN || '');
  // mcd-city / mcd-keyword 是正式输入名；city / keyword 作为旧名兼容保留
  const city = input('mcd-city', input('city', '上海'));
  const keyword = input('mcd-keyword', input('keyword', '人民广场'));
  const storeCode = input('store-code', '');
  const maxBurgers = Number(input('max-burgers', '12')) || 12;
  const maxStores = Number(input('max-stores', '3')) || 3;
  const offsetHours = input('utc-offset', '') === '' ? 8 : Number(input('utc-offset', '8'));
  const projectUrl = input('project-url', '');

  const gh = dryRun && !githubToken ? null : new GitHubClient({ token: githubToken, repository, logger: log });

  // ---- 取 PR 数据 ----
  log(`[1/5] 读取 PR #${prNumber} 数据 ...`);
  let pr = pull;
  let files = [];
  if (gh) {
    if (!pr) pr = await gh.getPullRequest(prNumber);
    files = await gh.getPullRequestFiles(prNumber);
  } else {
    pr =
      pr ||
      {
        number: prNumber || 1,
        title: 'feat: demo',
        user: { login: 'demo-dev' },
        additions: 0,
        deletions: 0,
        changed_files: 0,
        merged_at: new Date().toISOString(),
      };
  }

  // ---- 计税 ----
  log('[2/5] 按《麦门税法》计算税额 ...');
  const tax = computeTax(buildTaxInput({ pull: pr, files }), {
    maxBigMacs: maxBurgers,
    offsetHours,
  });
  log(
    `      加性 ${tax.subtotalUnits} 只（${tax.unitLines.map((l) => l.id + ':' + l.units).join(' ')}）` +
      ` × ${tax.totalMultiplier} → 应纳 ${tax.bigMacs} 只${tax.capped ? '（封顶）' : ''}`
  );
  if (tax.sideDishes.length) log(`      附加配菜 ${tax.sideDishes.map((s) => s.name).join('、')}`);

  // ---- 核价 ----
  log('[3/5] 麦当劳 MCP 核价 ...');
  let client = null;
  if (mcdToken) {
    try {
      client = new McdMcpClient({ token: mcdToken, logger: log });
    } catch (err) {
      log(`      MCP 客户端初始化失败：${err.message}`);
    }
  } else {
    log('      未提供 MCD_MCP_TOKEN，将使用内置价格快照');
  }
  const pricing = await assess({
    client,
    bigMacs: tax.bigMacs,
    sideDishes: tax.sideDishes,
    city,
    keyword,
    storeCode,
    maxStores,
  });
  log(
    `      模式=${pricing.mode} 来源=${pricing.source} 实付=${fen2yuan(pricing.totalFen)} 门店=${pricing.storeName}` +
      ` 篮=${(pricing.basket || []).map((b) => b.name + '×' + b.quantity).join('+')}` +
      (pricing.afterHours ? ' [夜间兜底]' : '')
  );
  if ((pricing.skipped || []).length) log(`      跳过：${pricing.skipped.map((s) => s.name).join('、')}`);

  // ---- 优惠券（assess 顺带取，失败不阻断）----
  log('[4/5] 当日可领券 ...');
  const coupons = pricing.coupons || { titles: [], error: '未取券' };
  log(`      ${coupons.titles.length ? coupons.titles.join(' / ') : '无（' + coupons.error + '）'}`);

  // ---- 开票 ----
  const taxpayer = pr.user?.login || 'unknown';
  const mergedAt = pr.merged_at ? new Date(pr.merged_at) : new Date();
  const serial = `BMT-${formatShanghai(mergedAt, false).replace(/-/g, '')}-${(pr.merge_commit_sha || pr.head?.sha || 'demo').slice(0, 6).toUpperCase()}`;
  const rawTitle = String(pr.title || '').replace(/\s+/g, ' ').trim();
  const title = rawTitle.length > 48 ? `${rawTitle.slice(0, 47)}…` : rawTitle;
  const view = {
    taxpayer,
    action: `合并 PR #${prNumber}「${title}」`,
    repo: repository || 'local/demo',
    serial,
    issuedAt: mergedAt,
    tax,
    pricing,
    coupons: coupons.titles,
    note: pricing.source === 'snapshot' ? pricing.note : null,
  };

  const body = composeComment({ view, tax, pricing, coupons, extra: { projectUrl } });

  if (dryRun || !boolInput('comment', true)) {
    log('[5/5] dry-run：以下为评论正文（未提交到 GitHub）');
    console.log('\n' + '─'.repeat(60) + '\n');
    console.log(body);
    return;
  }

  log('[5/5] 写入 PR 评论 ...');

  // fork 来的 PR：pull_request 事件下的 GITHUB_TOKEN 是只读的，写评论必然 403。
  // 这不该让整个 workflow 变红（用户会以为是项目坏了），所以降级为 warning + 日志留票。
  const fromFork = Boolean(pull?.head?.repo?.fork) || (pull?.head?.repo?.full_name && pull.head.repo.full_name !== repository);
  try {
    const existing = await gh.listComments(prNumber).catch(() => []);
    const mine = existing.find((c) => typeof c.body === 'string' && c.body.includes(MARKER));
    if (mine) {
      await gh.updateComment(mine.id, body);
      log(`      已更新原税单评论 #${mine.id}（避免重复开票）`);
    } else {
      const created = await gh.createComment(prNumber, body);
      log(`      已开具税单评论 #${created.id}`);
    }
  } catch (err) {
    const status = err?.status;
    if (status === 403 || status === 404) {
      log('');
      log(`::warning::无法写 PR 评论（HTTP ${status}）。` + (fromFork ? '这个 PR 来自 fork。' : ''));
      log('  原因：pull_request 事件下 GITHUB_TOKEN 对 fork PR 只有读权限。');
      log('  解法（二选一）：');
      log('    a) workflow 触发事件改成 pull_request_target（本项目不 checkout PR 代码，因此不会有代码执行风险）');
      log('    b) 在 job 上加 permissions: { pull-requests: write }，并确认仓库 Actions 允许写权限');
      log('');
      log('  税单正文如下（未写入 GitHub）：');
      console.log('\n' + '─'.repeat(60) + '\n');
      console.log(body);
      return;
    }
    throw err;
  }
}

if (require.main === module) {
  run().catch((err) => {
    console.error(`::error::麦门税务局发生故障: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
}

module.exports = { run, composeComment, buildInstallCta, buildTaxInput, input, boolInput, MARKER };
