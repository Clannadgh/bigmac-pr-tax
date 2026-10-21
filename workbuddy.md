# WorkBuddy 开发上下文（workbuddy.md）

> 本文件记录本项目在 WorkBuddy 中的开发过程，用于核验「WorkBuddy 专项奖励」条件。
> 工具：WorkBuddy（官方合作方）· 会话日期：2026-10-21 · 模式：Agent

---

## 1. 一次原始需求，全部由 WorkBuddy 落地

用户在会话中给出的需求原文（节选）：

> 【项目名】麦门 PR 税 bigmac-pr-tax
> 【一句话】GitHub Action：团队里谁合并了 PR，机器人就在 PR 评论区给他开一张"巨无霸税单"——按代码量定税，用麦当劳官方 MCP 实时核价，附 ASCII 小票和当日优惠券，可以截图转发。
> 【核心理念】税收法定（每条税写明依据）、真实核价（价格来自官方 MCP 不是编的）、零 npm 依赖（Node>=18 原生 fetch）、离线可降级（无 Token 用内置价格快照）。
> 在动手之前，请先用 mcd-mcp 连接器实测一遍数据链路：1. query-nearby-stores … 2. query-meals … 3. calculate-price …

WorkBuddy 的工作顺序与需求一致：**先验证数据链路，再写代码**。

---

## 2. WorkBuddy 做了什么

### 2.1 配置 MCP 连接器

用户提供了一份 `mcd-mcp` 的 streamablehttp 配置。WorkBuddy 读取已有的 `~/.workbuddy/mcp.json`，**合并**（而非覆盖）原有的 `blender` 配置，写入后做了 JSON 合法性校验，并对 `https://mcp.mcd.cn` 发了一次 `initialize` 探活：

```json
{"jsonrpc":"2.0","id":1,"result":{"capabilities":{"tools":{}},
 "protocolVersion":"2024-11-05","serverInfo":{"name":"mcd-mcp","version":"1.0.0"}}}
```

自定义连接器尚未被"信任"时工具不会出现在工具列表里，因此 WorkBuddy 改为直接以 JSON-RPC 访问该端点，把整条链路先跑通——这一步避免了"代码写完了才发现接口字段对不上"。

### 2.2 实测数据链路（关键产出）

| 步骤 | 结果 |
| --- | --- |
| `tools/list` | 35 个工具 |
| `query-nearby-stores` | 上海人民广场 5 家门店全部营业中；第一家 `1450713 麦当劳上海黄浦华旭国际大厦餐厅`（西藏中路336号，144m） |
| `query-meals`（不带预约） | 97 条餐品，**没有巨无霸**（`meals["1100"]` 不存在） |
| `calculate-price`（`1100 × 3`） | **失败**：`code=60006 商品已售罄或不可售` |
| `query-meals`（`reservationDate:"2026-10-21 12:30"`） | 111 条餐品，巨无霸出现，`currentPrice:"25.5"` |
| `calculate-price`（`1100 × 3` + 预约） | **成功**：`price=7650` 分 = **¥76.50**，`discount=0` |
| `available-coupons` | 返回 Markdown（非 JSON），解析出 5 张可领券 |

这一步发现了一个会**直接决定项目能否演示**的事实：早于 10:15 运行时，常规菜单根本没上架，天真的实现会 100% 失败。WorkBuddy 把它固化成了代码里的"② 预约重试"分支，并写进了 README 与 MCP_INTEGRATION.md。

### 2.3 从零写出可运行项目

| 文件 | 说明 |
| --- | --- |
| `src/tax.js` | 《麦门税法》内核：T1-T3 加性税目 + M1-M3 乘性税目 + 破产保护；纯函数，无 IO，每条规则带法条依据 |
| `src/receipt.js` | ASCII 小票渲染；自实现 CJK 显示宽度、避头点换行、词内不断行 |
| `src/mcp.js` | 零依赖 Streamable HTTP MCP 客户端；JSON/SSE 双格式；混合文本中提取 JSON |
| `src/pricing.js` | 二维核价回退（门店 × 时段）+ 菜单价/快照兜底 |
| `src/coupons.js` | 解析 Markdown 券列表，只保留"可领取" |
| `src/github.js` | PR 数据读取（分页）+ 评论写入 |
| `src/action.js` | 入口；幂等（marker 命中则更新评论）；dry-run |
| `action.yml` / `examples/` | Action 元数据 + 可直接复制的 workflow |
| `test/*.test.js` | 66 个用例，`node --test` 全绿（其中 26 个逐条锁定税法规则） |

### 2.4 自查并修掉的问题（不是一次成型）

WorkBuddy 每次改完都实际跑一遍并肉眼检查小票，发现并修复：

1. **中文标点跑到行首**（`，抵扣额不得超过应纳额。`）→ 实现避头点悬挂；
2. **数字被拦腰截断**（`11` / `:30`）→ 分词改为"ASCII 连续串整体一个排版单元"；
3. **零税额税目占版面** → 只打印真实发生的税目（加性税目为 0 时不占行）；
4. **同一句说明出现两次**（抬头 + 核价区）→ 抬头说明只在降级时出现；
5. **`-0` 陷阱**：`Math.ceil(0 - 1e-9)` 得到 `-0`，会污染 JSON 与小票 → 显式挡掉，并补了单测；
6. 4 个单测初次失败（取整预期、宽度容差）→ 修正断言后全绿。

---

## 3. 交互形态

用户在会话里给出的信息粒度很粗（一句话 + 四条理念 + 三条验证步骤 + 一个活动仓库地址），WorkBuddy 自行完成了：

1. 读比赛仓库 README，确认**必交文件清单**（`README.md`、`CONTEST_DECLARATION.md` 原样不可改、`MCP_INTEGRATION.md`、源码、`workbuddy.md`），并按清单产出；
2. 直接在 MCP 层做实验（而非假设接口行为），用真实返回驱动设计；
3. 把"数据链路的坑"当成产品需求的一部分写进文档——这是参赛作品与 demo 的区别。

---

## 4. 复现方式

```bash
cd bigmac-pr-tax
node --test                                  # 66 个用例
MCD_MCP_TOKEN=xxx node scripts/demo.js       # 实时核价并打印税单
node scripts/demo.js --offline               # 演示降级
```

---

## 5. 税法改版记录（2026-10-21 09:20）

用户给出了精确的《麦门税法》规则，要求"逐条实现并测试锁定"，于是计税内核整体重写：

| 税目 | 规则 | 锁定它的测试 |
| --- | --- | --- |
| T1 基础合并税 | 合并即 +1 | 零改动也征 1 只 |
| T2 代码量税 | `(additions+deletions)` 每 500 行 +1，上限 +5 | 499/500/1000 行、3000 行封顶、按合计而非只看新增 |
| T3 文件数税 | 每 10 个文件 +1，上限 +3 | 9/10/20 个、50 个封顶 |
| M1 周五夜间税 | 周五 ≥18:00 ×2 + 薯条(4810) | 18:00 整点生效、17:59 不触发、配菜编码 |
| M2 周末加班税 | 周六/周日 ×1.5 + 美式(507411) | 周六、周日凌晨都算，且不与 M1 同现 |
| M3 负熵减免 | `deletions > additions` 且总量 ≥50 → ×0.5 | 49 行不触发、增删相等不触发 |
| 破产保护 | 四舍五入、下限 1、上限 12（可配） | 4.5→5（不是向上取整）、下限、上限、可配置 |

配套改动：

- `pricing.js` 从"只核巨无霸"改成**整篮核价**（`1100` + 配菜），逐项小计取 `productList`；
- 配菜与主商品失败策略不同：巨无霸缺货 → 换店/换时段；配菜缺货 → 只跳该项；
- 真实拿到配菜价格：薯条 `4810` 13.5 元、美式 `507411` 11.9 元，且算价显示美式有 7.1 元优惠（原价 19 元）；
- `snapshot.json` 增加 `prices` 价格表（三件商品），保证无 Token 时也能算出整篮；
- 修掉一个自己引入的时区 bug：演示脚本把东八区墙上时间当 UTC 用，导致 19:04 变成次日 03:04。

---

## 6. MCP 协议层与数据层重构（2026-10-21 09:30）

用户给出了协议与分层要求，于是把 MCP 相关代码重写成三层：

- `src/mcp.js` —— 传输层：protocolVersion **2025-03-26**、`notifications/initialized`（**202 空 body 当成功**）、
  JSON/SSE 双解析、**`structuredContent.data` 优先**、4xx 不重试、20s 超时；
- `src/mcp-data.js` —— 数据层四个只读函数：`queryNearbyStores` / `queryMeals` / `calculatePrice` / `availableCoupons`；
- `src/assess.js` —— 主流程：找店 → 逐家试菜单（**打烊店返回空菜单**）→ 整篮核价 → 预约午餐时段重试
  → **深夜 24h 门店兜底（afterHours）** → 菜单标价 → **离线快照 `data/menu-snapshot.json`（带 generatedAt）**。

删掉了 `src/pricing.js`、`src/coupons.js`、`src/snapshot.json`，避免两套并行实现。

真机验证到的三件事：

1. `initialize` 用 2025-03-26 被接受，服务端原样回显；
2. `notifications/initialized` **确实返回 202 + 空 body**（旧实现会把它当错误重试一次）；
3. `structuredContent` 确实存在：一次 `query-meals` 的 `content[0].text` 有 **28 KB**，结构化字段是干净版本。

顺手发现并修掉一个会漏数据的偏差：`available-coupons` 现在也返回 `structuredContent`（券数组），
只解析 Markdown 会导致券全部丢失。现在先吃结构化、退回文本，并加 3 个测试锁住。

测试 66 → **75**（新增 assess 13、mcp 12、券 3），`npm test` 全绿。

---

## 7. 小票与评论正文格式（2026-10-21 09:35）

按用户给定的版式重写 `src/receipt.js` 与 `composeComment()`：

- 评论：`## 🍔 麦门 PR 税已征收！` → @作者 + 应缴 → **三列表格（税项/依据/税额）**，
  附加税税额写成 `×2 ＋1 薯条` / `×1.5 ＋1 麦咖啡美式` → ```text 小票 → 📍 门店说明
  （`mcd-city`/`mcd-keyword` + "价格来自麦当劳官方 MCP 实时接口"）→ 🌙 深夜兜底
  → 麦麦省前 5 张券 → **纳税须知恰好 3 条**（第 3 条引导去仓库点 Star）。
- 小票：麦门税务局抬头（中英双行）→ 商户/地址/门店编号/直线距离/开票时间/纳税人/票据编号
  → 税项与税额 → 应缴 → 商品明细（`巨无霸 x3 ¥76.50`）→ 原价/应付 → 落款
  `本小票不构成任何法律效力` + `谢谢惠顾 · 麦门永存` + 条码。
- 中文一律按 2 列宽对齐（`displayWidth`），并保留避头点、数字串不断行；
  地址能一行放下就对齐成两列，放不下才折行。
- 输入改名 `mcd-city` / `mcd-keyword`（旧名 `city` / `keyword` 仍兼容）。
- 测试 75 → **78**（receipt 11 / comment 12 重写），`npm test` 全绿。
