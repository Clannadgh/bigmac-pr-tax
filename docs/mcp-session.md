# MCP 会话记录（可逐条对账）

本文件记录一次**完整、可复现**的麦当劳 MCP 调用会话，用于证明税单上的金额确实来自官方接口，而不是代码里写死的一个数字。

- 采集时间：2026-10-21 09:11（北京时间）
- 端点：`https://mcp.mcd.cn`（streamablehttp）
- 门店：`1450713` 麦当劳上海黄浦华旭国际大厦餐厅
- 复现命令：

```bash
MCD_MCP_TOKEN=xxx node scripts/trace-mcp.js          # 人读表格
MCD_MCP_TOKEN=xxx STORE_CODE=1450750 node scripts/trace-mcp.js --json   # 机器可读
```

> 每次运行的 `traceId` 都不同，但**结构完全一致**。如果重跑时第 3 步也成功了，说明你跑的时候不在早餐时段——这恰好说明价格是活的。

## 调用明细

| # | 工具 | 参数要点 | 耗时 | 服务端时间 | traceId | 结果 |
|---:|---|---|---:|---|---|---|
| 1 | `query-nearby-stores` | beType, searchType, city, keyword | 656 ms | 2026-10-21 09:11:24 | `5a7b25ece7192b54e26cb8704cb4ece9` | 5 家门店，首选 1450713 麦当劳上海黄浦华旭国际大厦餐厅 |
| 2 | `query-meals` | orderType, beType | 341 ms | 2026-10-21 09:11:24 | `f0843b116b0b708d414d640fb18312c6` | 97 条餐品；巨无霸 **无** |
| 3 | `calculate-price` | orderType, beType, items(1100×3) | 171 ms | 2026-10-21 09:11:25 | `e25ca8787f5d0f3322a72cc4a1fa1651` | ❌ `code=60006 商品已售罄或不可售` |
| 4 | `query-meals` | + `reservationDate` | 282 ms | 2026-10-21 09:11:25 | `b9feb420e40ef41cfda2110edd636621` | 111 条餐品；巨无霸 **有，标价 25.5 元** |
| 5 | `calculate-price` | + `reservationDate`, items(1100×3) | 132 ms | 2026-10-21 09:11:25 | `7249ecb3612a3d7e9bf4c42cc815c2a5` | ✅ `price=7650 分（76.50 元）` |
| 6 | `available-coupons` | — | 113 ms | — | —（非 JSON 返回） | 麦麦省可领券 5 张（Markdown） |

合计 6 次调用，端到端 **1.70 秒**。

## 这说明的三件事

1. **同一门店、同一商品，时段不同结论不同**：第 2 步 97 条餐品里没有巨无霸，第 4 步加上 `reservationDate` 后变成 111 条、巨无霸现身。所以"核价失败"不是代码 bug，而是真实的可售状态——项目必须为此设计回退（见 [`../MCP_INTEGRATION.md`](../MCP_INTEGRATION.md) 第 5 节）。
2. **算价接口与菜单接口的口径不同**：菜单给的是 `currentPrice="25.5"`（元），算价给的是 `price=7650`（分）。两者都出现在同一会话里，混用会差 100 倍。
3. **不是所有工具都返回 JSON**：第 6 步返回的是 Markdown 文本，没有 `traceId`、没有 `code`。所以客户端不能假设"MCP 工具 = 结构化数据"。

## 一次更早的失败样本（保留作对照）

2026-10-21 08:49:41 运行的 `calculate-price`（`1100 × 3`，不带预约）同样返回：

```json
{ "success": false, "code": 60006, "message": "商品已售罄或不可售，换一个商品或检查orderType/beType",
  "traceId": "811f666e55e535138a41d21e8e71ebb6", "datetime": "2026-10-21 08:49:41" }
```

两个不同时刻、不同 traceId，同一个业务结论——这是真实接口应有的样子，也是本项目 `src/snapshot.json` 里 `note` 字段的由来。

## 关于快照

项目内置了 `src/snapshot.json` 作为最后一级降级。它记录的是**同一会话里第 5 步的结果**（7650 分 / 3 只 = 2550 分/只），并带上抓取时间与来源工具，可以逐条回溯到上表。

它不是"随便填个价"：取值、门店、时段、单位全部与本记录一致。差别只是——实时路径每次都会重新问一遍，快照只在问不到的时候兜底，并且会在小票上标注「内置快照」。
