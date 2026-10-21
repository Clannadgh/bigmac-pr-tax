'use strict';

/**
 * 小票渲染 —— 纯 ASCII，等宽对齐，可直接截图转发。
 *
 * 排版难点：中英文混排时一个汉字在等宽字体里占 2 列，英文/数字占 1 列。
 * 按 String.length 对齐一定会歪，所以全部走"显示宽度"（displayWidth），
 * 并且做两件中文排版必须做的事：
 *   1. 避头点——逗号句号不许落在行首；
 *   2. 词内不断行——2026-10-21、11:30 不能被拦腰截断。
 */

const RECEIPT_WIDTH = 48;

function isWideCodePoint(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/** 字符串在等宽终端里的显示宽度：中文 2 列，其余 1 列 */
function displayWidth(text) {
  let w = 0;
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    if (cp === 0x200b || cp === 0xfe0f) continue;
    w += isWideCodePoint(cp) ? 2 : 1;
  }
  return w;
}

function clipW(text, width) {
  const s = String(text);
  if (displayWidth(s) <= width) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = isWideCodePoint(ch.codePointAt(0)) ? 2 : 1;
    if (w + cw > width - 2) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

function padEndW(text, width) {
  const s = clipW(text, width);
  return s + ' '.repeat(Math.max(0, width - displayWidth(s)));
}

function padStartW(text, width) {
  const s = clipW(text, width);
  return ' '.repeat(Math.max(0, width - displayWidth(s))) + s;
}

function centerW(text, width) {
  const s = String(text);
  const diff = width - displayWidth(s);
  if (diff <= 0) return s;
  const left = Math.floor(diff / 2);
  return ' '.repeat(left) + s + ' '.repeat(diff - left);
}

const NO_LINE_START = new Set([...'，。、；：！？）》」』】〕〉…·%‰′″℃', ...',.;:!?)]}']);

/** 把文本切成不可再分的排版单元：CJK 一字一元，ASCII 连续串整体一个 */
function tokenize(text) {
  const tokens = [];
  let buf = '';
  for (const ch of String(text)) {
    const wide = isWideCodePoint(ch.codePointAt(0));
    if (wide || ch === ' ') {
      if (buf) {
        tokens.push(buf);
        buf = '';
      }
      tokens.push(ch);
    } else {
      buf += ch;
    }
  }
  if (buf) tokens.push(buf);
  return tokens;
}

/** 按显示宽度换行：词内不断行，标点不落行首 */
function wrapW(text, width) {
  const out = [];
  let line = '';
  let w = 0;
  const flush = () => {
    if (line) out.push(line);
    line = '';
    w = 0;
  };

  for (const token of tokenize(text)) {
    const tw = displayWidth(token);
    if (token === ' ') {
      if (w === 0) continue;
      if (w + 1 > width) flush();
      else {
        line += token;
        w += 1;
      }
      continue;
    }
    if (tw > width) {
      if (line) flush();
      let chunk = '';
      let cw = 0;
      for (const ch of token) {
        const chw = isWideCodePoint(ch.codePointAt(0)) ? 2 : 1;
        if (cw + chw > width && chunk) {
          out.push(chunk);
          chunk = '';
          cw = 0;
        }
        chunk += ch;
        cw += chw;
      }
      line = chunk;
      w = cw;
      continue;
    }
    if (w + tw > width && line) {
      const isSingle = [...token].length === 1;
      if (isSingle && NO_LINE_START.has(token)) {
        line += token;
        w += tw;
        continue;
      }
      flush();
    }
    line += token;
    w += tw;
  }
  flush();
  return out.length ? out : [''];
}

const border = () => '='.repeat(RECEIPT_WIDTH);
const divider = () => '-'.repeat(RECEIPT_WIDTH);
const title = (t) => centerW(t, RECEIPT_WIDTH);

/** 左右两列 */
function row(left, right) {
  const L = String(left);
  const R = String(right ?? '');
  const gap = RECEIPT_WIDTH - 1 - displayWidth(L) - displayWidth(R) - 1;
  if (gap < 1) return (' ' + L + ' ' + R).slice(0, RECEIPT_WIDTH);
  return ` ${L}${' '.repeat(gap)}${R} `;
}

/** 段落：自动换行，左缩进 */
function para(text, indent = 1) {
  const width = RECEIPT_WIDTH - indent * 2;
  return wrapW(text, width).map((l) => ' '.repeat(indent) + l);
}

const yuan = (fen) => ((Number(fen) || 0) / 100).toFixed(2);
const countText = (n) => (Number.isInteger(Number(n)) ? String(Number(n)) : Number(n).toFixed(1));

/** 「×2 ＋1 薯条」／「×0.5」／「+1 只」 */
function amountText(line) {
  if (line.units !== undefined) return `+${countText(line.units)} 只`;
  let s = `×${countText(line.multiplier)}`;
  if (line.sideDish) s += ` ＋${line.sideDish.quantity} ${line.sideDish.name}`;
  return s;
}

function barcode(serial) {
  let seed = 0;
  for (const ch of String(serial)) seed = (seed * 31 + ch.charCodeAt(0)) % 9973;
  let bars = '';
  let s = seed || 7;
  for (let i = 0; i < 34; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    bars += s % 3 === 0 ? '|' : s % 3 === 1 ? '#' : ':';
  }
  return bars;
}

function formatStamp(date) {
  const d = new Date(new Date(date).getTime() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getUTCDay()];
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} CST · ${wd}`;
}

/**
 * 渲染 ASCII 小票。
 *
 * @param {object} view
 * @param {string} view.taxpayer  作者（不含 @）
 * @param {string} view.serial    单号
 * @param {Date}   view.issuedAt  开票时间（合并时刻）
 * @param {object} view.tax       computeTax 的返回值
 * @param {object} view.pricing   assess 的返回值
 * @returns {string}
 */
function renderReceipt(view) {
  const { taxpayer, serial, issuedAt, tax, pricing } = view;
  const out = [];

  out.push(border());
  out.push(title('麦  门  税  务  局'));
  out.push(title('MAIMEN REVENUE SERVICE'));
  out.push(title('· 巨 无 霸 税 单 ·'));
  out.push(border());

  // 商户 / 地址
  out.push(row('商户', pricing.storeName || '麦当劳'));
  // 地址能一行放下就对齐成两列，放不下才折行，避免出现"商户右对齐、地址左对齐"的突兀
  const addr = pricing.address || '—';
  if (1 + displayWidth('地址') + displayWidth(addr) + 1 <= RECEIPT_WIDTH) out.push(row('地址', addr));
  else out.push(...para(`地址  ${addr}`, 1));
  out.push(row('门店编号', pricing.storeCode || '—'));
  if (pricing.distance !== null && pricing.distance !== undefined) {
    out.push(row('直线距离', `${pricing.distance} 米`));
  }
  out.push(row('开票时间', formatStamp(issuedAt)));
  out.push(row('纳税人', `@${taxpayer}`));
  out.push(row('票据编号', serial));

  // 税项
  out.push(divider());
  out.push(row('税  项', '税  额'));
  out.push(divider());
  for (const line of tax.unitLines) {
    if (!line.units) continue;
    out.push(row(line.label, amountText(line)));
  }
  for (const line of tax.multiplierLines) {
    out.push(row(line.label, amountText(line)));
  }
  if (tax.unitLines.every((l) => !l.units) && tax.multiplierLines.length === 0) {
    out.push(row('（无）', '—'));
  }
  out.push(divider());

  // 应缴
  const sides = (tax.sideDishes || []).map((s) => `${s.quantity} ${s.name}`);
  const amountLine = `${tax.bigMacs} 只${sides.length ? ' ＋' + sides.join(' ') : ''}`;
  out.push(row('应  缴', amountLine));
  if (tax.capped) out.push(row('破产保护', `已达上限 ${tax.config.maxBigMacs} 只`));
  out.push(border());

  // 商品明细
  out.push(row('商 品 明 细', '小计'));
  out.push(divider());
  for (const item of pricing.basket || []) {
    out.push(row(`${item.name} x${item.quantity}`, `¥${yuan(item.subtotalFen)}`));
  }
  for (const s of pricing.skipped || []) {
    out.push(row(`（缺货）${s.name}`, '已跳过'));
  }
  out.push(divider());
  out.push(row('原  价', `¥${yuan(pricing.originalFen)}`));
  out.push(row('应  付', `¥${yuan(pricing.totalFen)}`));
  if (pricing.discountFen) out.push(row('已优惠', `-¥${yuan(pricing.discountFen)}`));
  out.push(row('计价单位', `${pricing.totalFen} 分`));
  out.push(border());

  out.push(title('本小票不构成任何法律效力'));
  out.push(title('谢谢惠顾 · 麦门永存'));
  out.push(centerW(barcode(serial), RECEIPT_WIDTH));
  out.push(centerW(serial, RECEIPT_WIDTH));
  out.push(border());

  return out.map((l) => l.replace(/\s+$/, '')).join('\n');
}

module.exports = {
  renderReceipt,
  displayWidth,
  isWideCodePoint,
  padEndW,
  padStartW,
  centerW,
  wrapW,
  clipW,
  amountText,
  fen2yuan: (fen) => `${yuan(fen)} 元`,
  RECEIPT_WIDTH,
};
