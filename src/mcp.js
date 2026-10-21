'use strict';

/**
 * 麦当劳 MCP 客户端（Streamable HTTP）—— 零 npm 依赖，只用 Node 18+ 原生 fetch。
 *
 * 协议细节（全部在 https://mcp.mcd.cn 上实测过）：
 *   1. POST 到端点，头：Authorization / Content-Type / Accept: application/json, text/event-stream
 *   2. 先 initialize（protocolVersion 2025-03-26）
 *   3. 再发 notifications/initialized —— 服务端返回 **202 且 body 为空**，
 *      这**不是错误**。早期实现把它当失败，导致每条链路都白跑一次重试。
 *   4. 响应可能是纯 JSON，也可能是 SSE 帧（data: 行），两种都要解析
 *   5. 业务数据优先读 result.structuredContent.data；缺失时才从 content[0].text 里抽内嵌 JSON
 *   6. 服务端无状态，不返回 Mcp-Session-Id，因此不需要维护会话
 */

const DEFAULT_URL = 'https://mcp.mcd.cn';
const DEFAULT_TIMEOUT_MS = 20000;
const PROTOCOL_VERSION = '2025-03-26';

class McpError extends Error {
  constructor(message, { status, body, code } = {}) {
    super(message);
    this.name = 'McpError';
    this.status = status;
    this.body = body;
    this.code = code;
  }
}

/** 从"人读说明 + JSON"的混合文本里，用括号配对扫出最长的可解析 JSON */
function extractJson(text) {
  if (typeof text !== 'string' || !text) return null;
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* 说明文字在前，往下扫 */
  }

  let best = null;
  for (let i = 0; i < text.length; i++) {
    const open = text[i];
    if (open !== '{' && open !== '[') continue;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let k = i; k < text.length; k++) {
      const c = text[k];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          const slice = text.slice(i, k + 1);
          try {
            const parsed = JSON.parse(slice);
            if (!best || slice.length > best.len) best = { value: parsed, len: slice.length };
          } catch {
            /* 换下一个起点 */
          }
          break;
        }
      }
    }
  }
  return best ? best.value : null;
}

/** 解析 SSE 文本，返回最后一条 data 的内容 */
function parseSse(text) {
  const events = text.split(/\r?\n\r?\n/);
  let last = null;
  for (const evt of events) {
    const dataLines = evt
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart());
    if (!dataLines.length) continue;
    const payload = dataLines.join('\n');
    if (payload === '[DONE]') continue;
    last = payload;
  }
  return last;
}

class McdMcpClient {
  /**
   * @param {object} options
   * @param {string} [options.url]
   * @param {string} options.token    麦当劳 MCP Token（Bearer）
   * @param {number} [options.timeoutMs]
   * @param {number} [options.retries]
   * @param {(msg:string)=>void} [options.logger]
   */
  constructor(options = {}) {
    const { url = DEFAULT_URL, token, timeoutMs = DEFAULT_TIMEOUT_MS, retries = 1, logger } = options;
    if (!token) throw new McpError('缺少麦当劳 MCP Token（MCD_MCP_TOKEN / mcd-mcp-token 输入为空）');
    this.url = url;
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.logger = logger || (() => {});
    this.rpcId = 0;
    this.initialized = false;
    this.callCount = 0;
    this.serverInfo = null;
  }

  async #post(body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'User-Agent': 'bigmac-pr-tax/1.0',
      };
      // 规范建议初始化后带上协议版本；服务端忽略也无害
      if (body.method !== 'initialize') headers['MCP-Protocol-Version'] = PROTOCOL_VERSION;

      const res = await fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const raw = await res.text();

      // 202 / 204 / 空 body：notifications 的正常响应，不是错误
      if (res.status === 202 || res.status === 204) {
        return { status: res.status, result: null, empty: true, envelope: null, text: raw };
      }
      if (!res.ok) {
        throw new McpError(`MCP HTTP ${res.status}`, { status: res.status, body: raw.slice(0, 500) });
      }
      if (!raw.trim()) {
        return { status: res.status, result: null, empty: true, envelope: null, text: raw };
      }

      const contentType = res.headers.get('content-type') || '';
      let payload;
      if (contentType.includes('text/event-stream')) payload = parseSse(raw);
      else payload = raw.startsWith('{') || raw.startsWith('[') ? raw : parseSse(raw);

      if (!payload) {
        throw new McpError('MCP 返回了无法解析的响应体', { status: res.status, body: raw.slice(0, 500) });
      }
      const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
      if (parsed.error) {
        throw new McpError(`MCP 协议错误: ${parsed.error.message || JSON.stringify(parsed.error)}`, {
          status: res.status,
          body: JSON.stringify(parsed.error).slice(0, 500),
        });
      }
      return { status: res.status, result: parsed.result ?? null, empty: false, envelope: parsed, text: raw };
    } catch (err) {
      if (err.name === 'AbortError') throw new McpError(`MCP 请求超时（${this.timeoutMs}ms）`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async #rpc(method, params) {
    const body = { jsonrpc: '2.0', id: ++this.rpcId, method, params };
    let lastError;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return await this.#post(body);
      } catch (err) {
        lastError = err;
        this.logger(`[mcp] ${method} 第 ${attempt + 1} 次失败: ${err.message}`);
        // 4xx 是参数/鉴权问题，重试没意义
        if (err instanceof McpError && err.status && err.status >= 400 && err.status < 500) break;
      }
    }
    throw lastError;
  }

  async initialize() {
    if (this.initialized) return;
    const res = await this.#rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'bigmac-pr-tax', version: '1.0.0' },
    });
    this.serverInfo = res.result?.serverInfo ?? null;
    this.protocolVersion = res.result?.protocolVersion ?? PROTOCOL_VERSION;

    // 通知：成功是 202 + 空 body。这里刻意不重试、不抛错——
    // 通知失败不该让整张税单开不出来。
    try {
      const notify = await this.#post({ jsonrpc: '2.0', method: 'notifications/initialized' });
      this.logger(`[mcp] initialized (protocol ${this.protocolVersion}, notify ${notify.status})`);
    } catch (err) {
      this.logger(`[mcp] initialized (protocol ${this.protocolVersion})，notifications/initialized 未确认: ${err.message}`);
    }
    this.initialized = true;
  }

  /**
   * 调用工具，返回归一化结果。
   *
   * @returns {Promise<{data:any, envelope:any, text:string, isError:boolean, traceId:string|null}>}
   *   data     —— 业务数据（优先 structuredContent.data，其次 content 文本里的 data，最后整段 JSON）
   *   envelope —— 完整业务信封（含 success/code/message/traceId）
   */
  async callTool(name, args = {}) {
    await this.initialize();
    this.callCount += 1;

    const res = await this.#rpc('tools/call', { name, arguments: args });
    const result = res.result || {};
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .filter((c) => c && c.type === 'text')
      .map((c) => c.text)
      .join('\n');

    // 1) 优先 structuredContent.data（新协议下由服务端直接给结构化结果）
    const structured = result.structuredContent ?? null;
    // 2) 退回到 content 文本里内嵌的 JSON
    const fromText = text ? extractJson(text) : null;
    const envelope = structured || fromText || null;

    let data = null;
    if (structured && Object.prototype.hasOwnProperty.call(structured, 'data')) data = structured.data;
    else if (fromText && Object.prototype.hasOwnProperty.call(fromText, 'data')) data = fromText.data;
    else data = envelope;

    return {
      data,
      envelope,
      text,
      isError: Boolean(result.isError) || envelope?.success === false,
      traceId: envelope?.traceId ?? null,
      datetime: envelope?.datetime ?? null,
      code: envelope?.code ?? null,
      message: envelope?.message ?? null,
    };
  }

  /** 只返回业务数据；业务失败抛 McpError（带 code） */
  async callToolData(name, args = {}) {
    const res = await this.callTool(name, args);
    if (res.isError) {
      throw new McpError(`工具 ${name} 业务失败(${res.code}): ${res.message || '未知错误'}`, {
        code: res.code,
        body: res.message,
      });
    }
    if (res.data === null || res.data === undefined) {
      throw new McpError(`工具 ${name} 未返回业务数据: ${(res.text || '').slice(0, 160)}`);
    }
    return res.data;
  }
}

module.exports = { McdMcpClient, McpError, extractJson, parseSse, DEFAULT_URL, PROTOCOL_VERSION };
