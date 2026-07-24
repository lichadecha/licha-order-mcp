# licha-order-mcp

李茶的茶 · 企迈只读 MCP Server（一期）。让 AI 在对话里找店、看菜单、组单、算预估价。
一期物理禁写：不产生真订单、不碰钱、不读经营数据。

## 四个工具

| 工具 | 用途 |
| --- | --- |
| find_store | 按店名/商场/城市找门店，返回 storeId、营业状态、营业时间 |
| get_menu | 看菜单：无 keyword 返回分类，有 keyword 返回商品列表 |
| get_item_detail | 点单卡片：规格、做法（温度/糖度）、加料、是否估清 |
| preview_order | 组单算预估总价（本地累加，实际金额以门店收银台/订单为准） |

## 安装（WorkBuddy / 任意 MCP 客户端）

mcpServers 配置：

```json
{
  "mcpServers": {
    "licha-order-mcp": {
      "command": "npx",
      "args": ["-y", "github:ORG_NAME/licha-order-mcp"]
    }
  }
}
```

要求 Node 不低于 18；首次安装会自动构建（prepare 钩子跑 tsc）。

## 凭证前置（仅授权机器）

本服务从本机读取企迈开放平台凭证，凭证不进本仓库、不进配置、不进日志：

- macOS keychain：qmai-cli 条目的 openKey（自动拆封）
- ~/.config/qmai/config.yaml：active profile 的 openId / grantCode

也可用环境变量覆盖：QMAI_OPEN_KEY / QMAI_OPEN_ID / QMAI_GRANT_CODE。
缺凭证时工具调用报「凭证不完整」，服务本身正常启动。

## 安全边界

- 只读白名单硬编码在 src/constants.ts：仅 7 条门店/菜单/详情/算价路径，写接口在 client 层物理断路（ReadOnlyViolation）。
- 出参只投影公开字段（店名/地址/营业状态/商品价格），不输出店长联系方式、成本等经营字段。
- 审计日志 logs/audit.log 只记路径/时间/成败，不记参数与凭证。

## 复验

```bash
npm install
npm run smoke:mcp
npm run smoke
```

smoke 系列还有 smoke:store / smoke:menu / smoke:detail / smoke:order。
冒烟走真实只读接口（基础类 0.1 元/百次，10 万次/月免费额度内，单次复验不超过 30 次调用）。
