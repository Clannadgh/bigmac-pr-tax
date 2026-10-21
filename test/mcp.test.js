'use strict';

/**
 * 传输层 + 数据层测试。
 * 传输层用 mock fetch 锁定协议细节：202 空 body 不算错误、structuredContent 优先、SSE 也要能解析。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { McdMcpClient, McpError, extractJson, parseSse, PROTOCOL_VERSION } = require('../src/mcp');
const { availableCoupons, calculatePrice, parseCouponTitles, queryMeals, queryNearbyStores } = require('../src/mcp-data');

// ---------- 纯函数 ----------

test('从"说明文字 + JSON"的混合返回里取出 JSON', () => {
  const text = [
    '# API Response Information',
    'Below is the response from an API call.',
    '- **data**: No comments found.',
    '{"success":true,"code":200,"data":{"price":7650}}',
    '## 展示结果时，每个 storeCode 必须完整展示，',
  ].join('\n');
  const json = extractJson(text);
  assert.equal(json.success, true);
  assert.equal(json.data.price, 7650);
});

test('纯 JSON 直接解析；解析不出来返回 null 而不是抛错', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.equal(extractJson('### 麦麦省优惠券列表：\n- 优惠券标题：x'), null);
  assert.equal(extractJson(''), null);
});

test('SSE 里多条 data 取最后一条', () => {
  const sse = 'event: message\ndata: {"a":1}\n\nevent: message\ndata: {"a":2}\n\n';
  assert.deepEqual(extractJson(parseSse(sse)), { a: 2 });
});

test('券标题解析：只保留可领取的券，解析不出来不编造', () => {
  const md = [
    '### 麦麦省优惠券列表：',
    '- 优惠券标题：19.9元王牌炸鸡任选2 \\',
    '  状态：可领取 \\',
    '  优惠券图片：\\',
    '    <img src="https://img.mcd.cn/x.png">',
    '- 优惠券标题：已过期的券 \\',
    '  状态：已失效 \\',
  ].join('\n');
  assert.deepEqual(parseCouponTitles(md, 5), ['19.9元王牌炸鸡任选2']);
  assert.deepEqual(parseCouponTitles(''), []);
  assert.deepEqual(parseCouponTitles(null), []);
});

// ---------- 传输层（mock fetch） ----------

/** 用 mock fetch 跑一次调用，返回调用的 body 序列 */
async function withMock(handler, fn) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    seen.push({ url, headers: init?.headers || {}, body });
    return handler(body, init);
  };
  try {
    return await fn(seen);
  } finally {
    globalThis.fetch = original;
  }
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

test('initialize 用 2025-03-26，随后发 notifications/initialized（202 空 body 不算错误）', async () => {
  const client = new McdMcpClient({ token: 'test-token', retries: 0 });

  await withMock(
    (body) => {
      if (body.method === 'initialize') {
        return json({
          jsonrpc: '2.0',
          id: body.id,
          result: { capabilities: { tools: {} }, protocolVersion: PROTOCOL_VERSION, serverInfo: { name: 'mcd-mcp' } },
        });
      }
      if (body.method === 'notifications/initialized') {
        // 真实服务端就是 202 + 空 body + 无 content-type
        return new Response(null, { status: 202 });
      }
      return json({ jsonrpc: '2.0', id: body.id, result: { content: [], structuredContent: { data: { ok: 1 } } } });
    },
    async (seen) => {
      const res = await client.callTool('query-meals', { storeCode: '1450713' });
      assert.equal(res.data.ok, 1);

      assert.equal(seen[0].body.method, 'initialize');
      assert.equal(seen[0].body.params.protocolVersion, '2025-03-26');
      assert.equal(seen[1].body.method, 'notifications/initialized');
      assert.ok(!('id' in seen[1].body), '通知不能带 id');
      assert.equal(seen[2].body.method, 'tools/call');
      assert.equal(seen[2].headers['MCP-Protocol-Version'], '2025-03-26');
    }
  );
});

test('业务数据优先读 result.structuredContent.data', async () => {
  const client = new McdMcpClient({ token: 't', retries: 0 });
  await withMock(
    (body) =>
      body.method === 'tools/call'
        ? json({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              content: [{ type: 'text', text: '这段文本里的 JSON 是干扰项 {"data":{"meals":{"9999":{}}}}' }],
              structuredContent: { success: true, code: 200, traceId: 'trace-1', data: { meals: { '1100': { name: '巨无霸' } } } },
            },
          })
        : new Response(null, { status: 202 }),
    async () => {
      const res = await client.callTool('query-meals', {});
      assert.deepEqual(Object.keys(res.data.meals), ['1100'], '必须用 structuredContent，不是文本里的干扰项');
      assert.equal(res.traceId, 'trace-1');
    }
  );
});

test('没有 structuredContent 时，从 content[0].text 抽内嵌 JSON', async () => {
  const client = new McdMcpClient({ token: 't', retries: 0 });
  await withMock(
    (body) =>
      body.method === 'tools/call'
        ? json({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              content: [{ type: 'text', text: '下面是结果：\n{"success":true,"code":200,"data":{"meals":{"1100":{}}}}' }],
            },
          })
        : new Response(null, { status: 202 }),
    async () => {
      const res = await client.callTool('query-meals', {});
      assert.ok(res.data.meals['1100']);
    }
  );
});

test('SSE 帧响应也能解析', async () => {
  const client = new McdMcpClient({ token: 't', retries: 0 });
  await withMock(
    (body) => {
      if (body.method === 'tools/call') {
        const payload = JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { structuredContent: { data: { pong: true } } } });
        return new Response(`event: message\ndata: ${payload}\n\n`, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return new Response(null, { status: 202 });
    },
    async () => {
      const res = await client.callTool('x', {});
      assert.equal(res.data.pong, true);
    }
  );
});

test('业务失败（success=false）要抛 McpError 并带上 code', async () => {
  const client = new McdMcpClient({ token: 't', retries: 0 });
  await withMock(
    (body) =>
      body.method === 'tools/call'
        ? json({
            jsonrpc: '2.0',
            id: body.id,
            result: { structuredContent: { success: false, code: 60006, message: '商品已售罄或不可售' } },
          })
        : new Response(null, { status: 202 }),
    async () => {
      await assert.rejects(() => client.callToolData('calculate-price', {}), (err) => {
        assert.ok(err instanceof McpError);
        assert.equal(err.code, 60006);
        return true;
      });
    }
  );
});

test('HTTP 500 抛 McpError；4xx 不重试', async () => {
  const client = new McdMcpClient({ token: 't', retries: 2 });
  let calls = 0;
  await withMock(
    () => {
      calls += 1;
      return new Response('boom', { status: 401 });
    },
    async () => {
      await assert.rejects(() => client.initialize(), /MCP HTTP 401/);
      assert.equal(calls, 1, '鉴权失败重试没有意义');
    }
  );
});

// ---------- 数据层归一化 ----------

test('calculatePrice 把「分」和 productList 归一化', async () => {
  const fake = {
    async callToolData(name, args) {
      assert.equal(name, 'calculate-price');
      assert.deepEqual(args.items, [
        { productCode: '1100', quantity: 2 },
        { productCode: '4810', quantity: 1 },
      ]);
      return {
        price: 6450,
        originalPrice: 6450,
        discount: 0,
        productList: [
          { productCode: '1100', productName: '巨无霸', quantity: 2, subtotal: 5100, originalSubtotal: 5100 },
          { productCode: '4810', productName: '中薯条', quantity: 1, subtotal: 1350, originalSubtotal: 1350 },
        ],
      };
    },
  };
  const r = await calculatePrice(fake, {
    storeCode: '1450713',
    items: [
      { productCode: '1100', quantity: 2 },
      { productCode: '4810', quantity: 1 },
    ],
  });
  assert.equal(r.priceFen, 6450);
  assert.equal(r.productList[1].name, '中薯条');
  assert.equal(r.productList[1].subtotalFen, 1350);
});

test('queryMeals 把空菜单当正常结果（打烊门店就是空字典）', async () => {
  const fake = { async callToolData() { return { meals: {} }; } };
  const r = await queryMeals(fake, { storeCode: '1' });
  assert.equal(r.empty, true);
  assert.equal(r.count, 0);
});

test('queryNearbyStores 营业中的排前面、按距离升序', async () => {
  const fake = {
    async callToolData() {
      return [
        { storeCode: '2', businessStatus: false, distance: 50 },
        { storeCode: '3', businessStatus: true, distance: 300 },
        { storeCode: '1', businessStatus: true, distance: 100 },
      ];
    },
  };
  const stores = await queryNearbyStores(fake, {});
  assert.deepEqual(stores.map((s) => s.storeCode), ['1', '3', '2']);
});

test('券：有 structuredContent 时优先用结构化字段（不会因为只解析 Markdown 而漏券）', async () => {
  const fake = {
    async callTool() {
      return {
        isError: false,
        text: '### 麦麦省优惠券列表：\n- 优惠券标题：旧的Markdown券 \\\n  状态：可领取 \\\n',
        data: [
          { couponName: '19.9元王牌炸鸡任选2', couponStatus: 'CAN_GET', label: '可领取' },
          { couponName: '11.9元麦辣鸡腿堡', couponStatus: 'CAN_GET', label: '可领取' },
          { couponName: '已过期的券', couponStatus: 'EXPIRED', label: '已失效' },
        ],
      };
    },
  };
  const r = await availableCoupons(fake, 5);
  assert.equal(r.via, 'structured');
  assert.deepEqual(r.titles, ['19.9元王牌炸鸡任选2', '11.9元麦辣鸡腿堡']);
  assert.equal(r.error, null);
});

test('券：没有结构化数据时退回 Markdown 解析', async () => {
  const fake = {
    async callTool() {
      return {
        isError: false,
        text: '### 麦麦省优惠券列表：\n- 优惠券标题：19.9元王牌炸鸡任选2 \\\n  状态：可领取 \\\n',
        data: null,
      };
    },
  };
  const r = await availableCoupons(fake, 5);
  assert.equal(r.via, 'markdown');
  assert.deepEqual(r.titles, ['19.9元王牌炸鸡任选2']);
});

test('券：两种形态都拿不到就返回空 + 原因，绝不编造', async () => {
  const fake = { async callTool() { return { isError: false, text: '', data: null }; } };
  const r = await availableCoupons(fake, 5);
  assert.deepEqual(r.titles, []);
  assert.match(r.error, /未解析到/);
});
