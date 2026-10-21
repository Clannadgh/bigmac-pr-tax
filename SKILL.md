---
name: bigmac-pr-tax
description: 麦门 PR 税。当用户说"给这个 PR 开张税单""这个合并该交多少税""麦门税""请同事吃几只巨无霸""给这个 MR 定个价"时使用。按《麦门税法》把 PR 的增删行、文件数、合并时刻折算成巨无霸只数，再用麦当劳官方 MCP 实时核价，产出可截图转发的 ASCII 小票与 GitHub 评论正文。适用于 GitHub PR、本地 git 统计，或用户口述的一组数字。触发词：麦门税、PR 税、税单、巨无霸税、开张税单、请同事吃汉堡。
license: MIT
---

# 麦门 PR 税

把"这次改动有多大"翻译成"你该请同事吃几只巨无霸"，并且**把价格算准**。

## 这个 Skill 解决什么问题

团队里"这个 PR 太大了"是一句没有刻度的话。说的人凭感觉，听的人不认账。
本 Skill 提供一个**确定性的、可复核的**刻度：

- **算税是纯函数**：同样的增删行数永远得到同样的只数，不存在"看心情"；
- **价格来自麦当劳官方 MCP**：不是估值、不是常量表，是门店实时算价（含优惠，单位分）；
- **每条税都写依据**：《麦门税法》七条，票面逐条打印，同事可以当场质证。

分工：

- `scripts/tax-cli.js` 负责**算**（计税 + 核价 + 渲染），确定性、无网络也能出票；
- 麦当劳 MCP 负责**取数与算钱**（门店、菜单、算价、券）；
- **你（Agent）负责取数与表达**：把 PR 的统计数字拿出来，把结果讲成人话。

## 工作流（四步）

### 1. 取数（只取统计数字，不读代码）

有 `gh` 时最省事：

```bash
gh pr view <编号> --json number,title,additions,deletions,changedFiles,mergedAt,author
```

没有 gh 但有本地 git 时：

```bash
git log --numstat --pretty=%H -1 --mergest 2>/dev/null || git show --stat --oneline HEAD
```

用户只口头给数字也可以，直接传参即可，不需要真实仓库。

### 2. 算税

```bash
node scripts/tax-cli.js --stdin --format json        # 从上游 JSON 读
node scripts/tax-cli.js --additions 180 --deletions 320 --files 12 \
     --merged-at 2026-10-16T19:04:00+08:00 --format json
```

返回 `tax.bigMacs`（应缴只数）、`tax.unitLines`（加性税目）、`tax.multiplierLines`（附加/减免）。

### 3. 核价（同一条命令内部完成）

- 有 `MCD_MCP_TOKEN` → 真实调 `query-nearby-stores` → `query-meals` → `calculate-price`；
- 没有 Token 或接口不可用 → 自动降级到 `data/menu-snapshot.json`，**并标注「离线快照模式」**；
- 深夜/打烊/早餐时段都有对应回退（详见 `MCP_INTEGRATION.md`）。

### 4. 出票

```bash
# 发到 PR 的评论正文（Markdown，含税项表格与 ASCII 小票）
node scripts/tax-cli.js --stdin --format comment > comment.md

# 只要那张小票（截图用）
node scripts/tax-cli.js --stdin --format receipt
```

## 规则速查

| 税目 | 规则 | 上限 |
| --- | --- | --- |
| 基础合并税 | 合并即 +1 | — |
| 代码量税 | 每 500 行（增+删）+1 | +5 |
| 文件数税 | 每 10 个文件 +1 | +3 |
| 周五夜间附加税 | 周五 ≥18:00 合并 ×2，附薯条 1 份 | — |
| 周末加班附加税 | 周六/日合并 ×1.5，附麦咖啡美式 1 杯 | — |
| 负熵减免 | 删 > 增且总量 ≥50 行，×0.5 | — |
| 破产保护 | 四舍五入，下限 1，上限 12（可配） | — |

完整法条与算例见 `docs/tax-rules.md`。

## 硬约束（不可违反）

1. **只调 4 个只读工具**：`query-nearby-stores`、`query-meals`、`calculate-price`、`available-coupons`。
   **绝不下单**（`create-order` / `cancel-order` 一律不碰）。
2. **价格不能编**。接口拿不到就明写「离线快照模式（快照生成于 …）」，不能把快照价说成实时价。
3. **券不能编**。解析不出来就不显示，不要在票面上脑补"今日优惠"。
4. **这是娱乐规则**。回答时必须保留"虚构规则、不构成任何真实税费或付款义务"的声明。

## 参考文件

| 文件 | 用途 |
| --- | --- |
| `docs/tax-rules.md` | 七条法条原文、计算顺序、四个算例 |
| `MCP_INTEGRATION.md` | MCP 工具用法、真实返回、降级策略 |
| `docs/design-notes.md` | 为什么这样设计（计税结构、回退表、排版、时区） |
| `docs/mcp-session.md` | 一次可对账的真实调用记录（含 traceId） |
| `assets/comment-friday.png` | 成品效果：真实的 GitHub 评论截图 |
