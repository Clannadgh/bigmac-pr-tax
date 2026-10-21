# Changelog

## v1.0.0 — 2026-10-21

首个可用版本。

### 新增

- **计税内核**（`src/tax.js`）：按《麦门税法》实现 T1–T3 加性税目、M1–M3 乘性税目与破产保护，
  顺序固定为"先加、再乘、后夹紧"；输出结构含 `unitLines` / `multiplierLines` / `sideDishes`，
  每行带 `label` / `detail` / 法条 `basis`。
- **MCP 传输层**（`src/mcp.js`）：Streamable HTTP，协议版本 `2025-03-26`；
  `initialize` 后发送 `notifications/initialized`（202 + 空 body 视为成功）；
  同时支持纯 JSON 与 SSE 帧；业务数据优先读 `result.structuredContent.data`；
  4xx 不重试，超时 20s。
- **数据层**（`src/mcp-data.js`）：`queryNearbyStores` / `queryMeals` / `calculatePrice` / `availableCoupons`
  四个只读函数，只碰这四个工具。
- **主流程**（`src/assess.js`）：找店 → 逐家试菜单（打烊门店返回空菜单）→ 整篮核价
  → 预约午餐时段重试 → 深夜 24 小时门店兜底（`afterHours`）→ 菜单标价 → 离线快照。
- **小票渲染**（`src/receipt.js`）：ASCII 凭证，中文按 2 列宽对齐，避头点不落行首，
  数字串不断行；含抬头、商户、地址、税项、应缴、商品明细、原价/应付、落款。
- **GitHub Action**（`action.yml` + `src/action.js`）：PR 合并自动开票，
  幂等更新（marker 命中则改而不重发），fork PR 写评论失败降级为 warning + 日志留票。
- **离线快照**（`data/menu-snapshot.json`）：带 `generatedAt` 时间戳与三件商品单价（分）。

### 已知局限

- 快照价格是静态的，跨城市或调价后会偏差（票面标注「离线快照模式」）。
- 门店选择取"最近的一家"，不判断用户实际会去哪。
- 无历史记录（零存储的取舍）。
- 团队规模大时每条 PR 一条评论，可能刷屏（可用 `comment: false` 关闭）。

### 升级注意

- 输入名从 `city` / `keyword` 改为 `mcd-city` / `mcd-keyword`，旧名仍兼容。
- `max-burgers` 默认值从 20 调整为 12。
