# MCP 集成说明

本文说明 **麦门 PR 税** 实际使用了哪些麦当劳 MCP 能力、怎么调用、为什么这么调用，以及踩到的真实坑。

- MCP Server：`https://mcp.mcd.cn`
- 传输方式：Streamable HTTP（JSON-RPC 2.0）
- 鉴权：`Authorization: Bearer <MCD_MCP_TOKEN>`
- 客户端实现：[`src/mcp.js`](src/mcp.js)（零依赖，只用 Node 18+ 原生 `fetch`）

---

## 1. 使用的 Tool 清单

| # | Tool | 用途 | 在本项目中的角色 |
| --- | --- | --- | --- |
| 1 | `query-nearby-stores` | 查城市内可点餐门店 | 把"城市 + 商圈"落成一家**真实营业中**的门店，拿到 `storeCode` |
| 2 | `query-meals` | 查门店菜单与标价 | 确认该门店**当下能否买到**巨无霸（`productCode = 1100`），并取菜单标价做交叉校验 |
| 3 | `calculate-price` | 算商品实付价（含优惠） | **税单金额的唯一来源**：整篮一次算（`1100 × N` + 配菜），逐项小计取自 `productList` |
| 4 | `available-coupons` | 麦麦省可领券列表 | 小票底部的"今日可领券"，让凭证有二次动作（去领券） |

未使用（有意为之）：`create-order`、`cancel-order`、`query-order` 等一切会改变用户账户状态的接口。项目定位是"开一张凭证"，不是替用户下单。

---

## 2. 调用流程

只有 4 个只读工具，没有第 5 个；`create-order` 之类永远不调。

```
PR merged (GitHub webhook)
   │  计税：只用 PR 统计数字（增删行 / 文件数 / 合并时刻），不读源码
   ▼
[1] query-nearby-stores
      → 营业中的排前面，其余按距离升序，取前 max-stores 家（默认 3）
      → 指定了 store-code 就只留那一家
   ▼
[2] 当前时段逐家试 query-meals
      空菜单（0 条）        → 这家打烊了，换下一家（不能只看 businessStatus）
      有菜单但无 1100       → 早餐时段，记下来，换下一家
      有 1100               → 进 [3]
   ▼
[3] calculate-price（整篮：1100×N + 配菜）
      成功 → price（分）→ 出票
      60006 → 这份菜单记作"菜单标价兜底"候选，继续试
   ▼
[4] 预约最近午餐时段（11:30），把 [2][3] 对候选门店再跑一遍
   ▼
[5] 深夜兜底：若候选门店**全部空菜单**（全城打烊）
      → 用 24h 门店 1450713 继续实时核价，标记 afterHours
   ▼
[6] 菜单标价兜底：有价但算不出 → currentPrice × 数量 求和
   ▼
[7] 离线快照：data/menu-snapshot.json（带 generatedAt），票面标「离线快照模式」
   │
[8] available-coupons → 解析 Markdown → 渲染小票 → 写 PR 评论（券失败不阻断）
```

为什么既要换店又要换时段：**早餐时段三家店的菜单都没有巨无霸**（3.2 有实测），
只看 `businessStatus` 或只重试时段，都会有一半场景失败；
而**打烊门店返回的是空菜单而不是报错**，所以"能不能用"只能靠试菜单试出来。

---

## 3. 关键请求与真实返回

以下均为 2026-10-21 08:49–08:56（北京时间）的实测结果。

### 3.1 `query-nearby-stores`

请求：

```json
{ "beType": 1, "searchType": 2, "city": "上海", "keyword": "人民广场" }
```

返回（截取）：

```json
{
  "success": true, "code": 200, "message": "请求成功",
  "data": [
    {
      "storeCode": "1450713",
      "storeName": "麦当劳上海黄浦华旭国际大厦餐厅",
      "address": "南京东路街道西藏中路336号",
      "distance": 144,
      "businessStatus": true,
      "businessStartTime": "00:00", "businessEndTime": "23:59",
      "reservation": true
    },
    { "storeCode": "1450441", "storeName": "麦当劳上海福州路餐厅", "distance": 235, "businessStatus": true, "...": "..." }
  ]
}
```

要点：
- `beType=1`（到店自取）返回的门店**没有 `beCode`**，后续调用也**不能传** `beCode`；`beType=5`（得来速）才需要。
- 必须过滤 `businessStatus`，否则会给一家关门的店核价。

### 3.2 `query-meals`

请求：

```json
{ "storeCode": "1450713", "orderType": 1, "beType": 1 }
```

返回结构（**注意 `meals` 是对象，不是数组**）：

```json
{
  "success": true, "code": 200,
  "data": {
    "categories": [ { "name": "超值早餐", "meals": [ { "code": "9900011873" } ] } ],
    "meals": {
      "1088": { "name": "优品豆浆", "currentPrice": "9.5", "originalPrice": "9.5" },
      "5022": { "name": "猪柳蛋麦满分", "currentPrice": "18", "originalPrice": "18" }
    }
  }
}
```

早餐时段实测：**97 条**餐品，`meals["1100"]` 不存在。

带预约时段重试：

```json
{ "storeCode": "1450713", "orderType": 1, "beType": 1, "reservationDate": "2026-10-21 12:30" }
```

返回 **111 条**，巨无霸出现：

```json
"1100": {
  "name": "巨无霸",
  "image": "https://menu-img.mcd.cn/pcm/prod/menu/20260309/product/MS_1100_320.png",
  "currentPrice": "25.5",
  "originalPrice": "25.5",
  "canWithOrder": false
}
```

### 3.3 `calculate-price`

请求（3 只巨无霸）：

```json
{
  "storeCode": "1450713", "orderType": 1, "beType": 1,
  "reservationDate": "2026-10-21 12:30",
  "items": [{ "productCode": "1100", "quantity": 3 }]
}
```

返回：

```json
{
  "success": true, "code": 200,
  "data": {
    "productOriginalPrice": 7650,
    "productPrice": 7650,
    "originalPrice": 7650,
    "discount": 0,
    "price": 7650,
    "productList": [{ "productCode": "1100", "productName": "巨无霸", "quantity": 3,
                      "originalSubtotal": 7650, "subtotal": 7650 }],
    "takeWayList": [{ "code": "eat-in", "title": "堂食" }, { "code": "locker-out", "title": "外带" }]
  }
}
```

**`price` 单位是"分"**：7650 分 = ¥76.50，除以 3 得到单价 2550 分 = ¥25.50。

不带 `reservationDate` 的同一请求（早餐时段）：

```json
{ "success": false, "code": 60006, "message": "商品已售罄或不可售，换一个商品或检查orderType/beType" }
```

这正是本项目 `pricing.js` 里"② 预约重试"分支存在的原因。

### 3.4 整篮核价（巨无霸 + 附加税配菜）

税单不只买巨无霸：周五夜间要加一份薯条（`4810`），周末要加一杯麦咖啡美式（`507411`）。
两样配菜**一次请求算完**，避免"分开算再相加"与真实优惠口径不一致。

请求：

```json
{
  "storeCode": "1450713", "orderType": 1, "beType": 1,
  "reservationDate": "2026-10-21 11:30",
  "items": [
    { "productCode": "1100", "quantity": 2 },
    { "productCode": "4810", "quantity": 1 },
    { "productCode": "507411", "quantity": 1 }
  ]
}
```

返回（真实数据，2026-10-21 09:15）：

```json
{
  "success": true, "code": 200,
  "data": {
    "originalPrice": 8350, "productPrice": 7640, "discount": 710, "price": 7640,
    "productList": [
      { "productCode": "1100", "productName": "巨无霸", "quantity": 2, "originalSubtotal": 5100, "subtotal": 5100 },
      { "productCode": "4810", "productName": "中薯条", "quantity": 1, "originalSubtotal": 1350, "subtotal": 1350 },
      { "productCode": "507411", "productName": "麦咖啡™冰美式中杯", "quantity": 1, "originalSubtotal": 1900, "subtotal": 1190 }
    ]
  }
}
```

两个只有算价接口才给得出的信息：

1. **美式有 710 分优惠**：菜单标价 11.9 元，但 `calculate-price` 按原价 19 元起算、实付 11.9 元 → 优惠 7.1 元。
   如果自己"菜单价 × 数量"求和，会得出 76.40 元并声称"无优惠"——数字碰巧相等，但口径是错的。
2. **逐项小计**（`productList[].subtotal`）可以直接铺进小票的购物篮表格，不需要自己再乘一遍。

**配菜不在菜单时**（深夜会下架部分单品；薯条与美式全天在售，但"派"这类过午夜会下架，所以税单不选派）：

```json
// 深夜菜单里没有 507411 时，客户端只把存在的商品发出去
items: [{ "productCode": "1100", "quantity": 3 }]
```

小票会打印 `✗ 已跳过 麦咖啡美式：当前菜单无此商品（可能已下架）`，主商品照常核价，不会因为配菜下架而整单失败。

### 3.5 `available-coupons`

请求：`{}`（无参数）

返回形态**不稳定**，实测两种都出现过。有结构化字段时是这样：

```json
"data": [
  { "couponName": "19.9元王牌炸鸡任选2", "couponStatus": "CAN_GET", "label": "可领取" },
  { "couponName": "11.9元麦辣鸡腿堡",     "couponStatus": "CAN_GET", "label": "可领取" }
]
```

只有文本时是 Markdown：

```markdown
### 麦麦省优惠券列表：
- 优惠券标题：19.9元王牌炸鸡任选2 \
  状态：可领取 \
  优惠券图片：...
- 优惠券标题：11.9元麦辣鸡腿堡 \
  状态：可领取 \
...
```

`src/mcp-data.js` 的处理顺序：**先读结构化券数组**（按 `couponStatus` / `label` 过滤），拿不到再退回正则抽 `优惠券标题：` + `状态：可领取`。两条路都失败就返回空数组——**小票上宁可不出现券，也不出现编造的券**。

---

## 4. 传输层实现要点

协议版本 **2025-03-26**，实测三步：

```text
POST https://mcp.mcd.cn
Authorization: Bearer <token>
Content-Type: application/json
Accept: application/json, text/event-stream

① initialize            → 200 {"result":{"protocolVersion":"2025-03-26","serverInfo":{"name":"mcd-mcp"}}}
② notifications/initialized → 202，body 为空
③ tools/call            → 200，content[0].text + structuredContent
```

| 问题 | 处理方式 |
| --- | --- |
| `notifications/initialized` 返回 **202 + 空 body** | **当成功**，不重试、不抛错。早期把它当失败会让每条链路白跑一次重试 |
| 服务端可能回 `application/json`，也可能回 `text/event-stream` | 按 `Content-Type` 分流；SSE 取最后一条 `data:` |
| 业务数据在哪 | **优先 `result.structuredContent.data`**；缺失时才从 `content[0].text` 抽内嵌 JSON |
| 为什么不直接解析文本 | 真机一次 `query-meals` 的 `text` 有 **28 KB**（含字段说明），结构化字段是同一份数据的干净版本，还自带 `traceId` |
| 服务端无状态，不返回 `Mcp-Session-Id` | 每次 `tools/call` 独立发送，不需要维护会话 |
| 网络抖动 / 超时 | 重试 1 次；4xx 不重试；20s `AbortController`，超时后降级 |

```js
// src/mcp.js 的核心：一次 POST + 双格式解析 + 结构化优先
const res = await fetch(url, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2025-03-26', // initialize 之后带上
  },
  body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  signal: controller.signal,
});

if (res.status === 202 || res.status === 204) return { empty: true }; // 通知的正常响应

const structured = result.structuredContent ?? null;
const data = structured?.data ?? extractJson(text)?.data ?? null;
```

协议细节用 **mock fetch** 锁在 `test/mcp.test.js` 里（12 个用例），不依赖网络：
202 空 body、`structuredContent` 优先于文本干扰项、SSE 帧、业务失败抛带 `code` 的错、401 不重试。

---

## 5. 降级策略（"买不到巨无霸"怎么办）

| 场景 | 行为 | 小票上的表现 |
| --- | --- | --- |
| 未配置 `MCD_MCP_TOKEN` | 直接用 `data/menu-snapshot.json` | 右上角 **离线快照模式**，并打印快照 `generatedAt` |
| 门店查询失败 / 该城市无营业门店 | 快照 | 同上，并写明失败原因 |
| **某家门店菜单里没有巨无霸** | 按距离换下一家门店（默认最多 3 家） | 「核价链路」里逐店记录 `[storeCode] 菜单无巨无霸` |
| **门店打烊（`query-meals` 返回空菜单）** | 视为不可用，继续试下一家；**不能只看 `businessStatus`** | 逐店记录 `[storeCode] 空菜单（0 条，门店可能已打烊）` |
| **深夜周边全打烊（候选门店全空菜单）** | 用上海人民广场 24 小时门店 `1450713` 继续实时核价 | 票面标 `夜间兜底 · 周边已打烊 · 24h 门店`，结果带 `afterHours: true` |
| **早餐时段全线无货**（实测三家店全是 97/93/84 条早餐菜单） | 改为预约最近午餐时段（11:30），重新跑一遍全部候选门店 | 「取餐时段 预约 2026-10-21 11:30」+「当前时段未开售，按 … 核价」 |
| **菜单里有价但算价接口 60006** | 用 `query-meals` 的 `currentPrice × N` 作为第 ⑦ 级 | 右上角 **MCP 菜单标价**，注明"算价接口不可用，未含优惠" |
| 预约重试仍失败 / 超时 / 5xx | 离线快照 | 写明"进入离线快照模式（快照生成于 …）"及最后一次失败原因 |
| **附加税配菜不在菜单**（深夜下架部分单品） | **只跳过这一项**，主商品照常核价 | 「购物篮」里打印 `✗ 已跳过 麦咖啡美式：当前菜单无此商品（可能已下架）` |
| 用户指定了 `store-code` | **只试那一家**，不自动换店 | 不会出现"你不知道的餐厅" |
| 券解析失败 | 不显示券区块 | 「核价链路」折叠区里写"优惠券未取到：…" |

快照内容（`data/menu-snapshot.json`）记录了生成时间戳、来源 Tool、门店与三件商品的单价（分），可审计：

```json
{
  "generatedAt": "2026-10-21T09:15:00+08:00",
  "storeCode": "1450713", "storeName": "麦当劳上海黄浦华旭国际大厦餐厅",
  "unit": "fen",
  "items": {
    "1100":   { "name": "巨无霸",     "priceFen": 2550 },
    "4810":   { "name": "薯条",       "priceFen": 1350 },
    "507411": { "name": "麦咖啡美式", "priceFen": 1190 }
  }
}
```

---

## 6. 业务价值

**对用户（开发者团队）**
- 把"这个 PR 有多大"变成一个**能截图、能转发、能拿来开玩笑**的物件，而且金额是真的（来自门店实时价），不是编的；
- 每条税都有依据，天然免于"你是不是针对我"的争论——争税率去改 `RULES`，别争人；
- 零配置成本：一个 workflow + 一个 Secret，不装机器人框架、不建数据库、不留存任何数据。

**对麦当劳**
- 把 MCP 从"点餐前的对话助手"扩展到**开发者工作流**这个高频场景：每次合并都是一次品牌曝光，且曝光发生在团队沟通的最高注意力位置（PR 评论区）；
- 小票底部的「今日可领券」是**真实可核销**的转化入口，从"看到"到"领券"只有一次截图之隔；
- 全部调用都是只读/算价接口，不产生订单、不占用库存、没有履约风险；
- 核价逻辑公开可审计（`MCP_INTEGRATION.md` 里连踩到的 `60006` 都写清楚了），方便官方复用这套"时段可售性"处理经验。

---

## 7. 可对账的会话记录

一次完整会话（6 次调用、traceId、耗时、返回摘要）见 [`../docs/mcp-session.md`](../docs/mcp-session.md)，
由 `node scripts/trace-mcp.js` 生成，随时可重跑。

## 8. 复现命令

```bash
# 只跑核价链路（不涉及 GitHub）
MCD_MCP_TOKEN=xxx node scripts/demo.js --json

# 观察降级行为
node scripts/demo.js --offline
```
