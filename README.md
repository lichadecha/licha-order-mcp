# licha-order-mcp

李茶的茶 · 企迈只读 MCP Server（一期）。让 AI 在对话里找店、看菜单、组单、算预估价。
一期物理禁写：不产生真订单、不碰钱、不读经营数据。

## 用户怎么用

对你的 AI 说一句：

> 我要喝李茶的茶，去 GitHub 拉取一下：lichadecha/licha-order-mcp

装好后直接问「有什么奶茶」「哪家离我近」即可。目前仅支持到店（堂食/自取）。

第一次喝不知道选什么？直接问「有什么推荐」。想让 AI 帮你算哪家店近，可以再给它装一个高德地图 MCP（可选）。

## 给 AI Agent 的安装说明（用户让你拉取本仓库时照做）

1. 把下面这段合并进你的 MCP 配置（mcpServers）：

```json
"licha-order-mcp": {
  "command": "npx",
  "args": ["-y", "github:lichadecha/licha-order-mcp#v0.3.1"]
}
```

2. 把本仓库根目录的 `SKILL.md` 装进你的技能/指令目录（客户端支持 skills 时）。
3. 按你的客户端要求重启或重载 MCP。
4. 告诉用户装好了，并按 `SKILL.md` 的规则开始服务（第一句先说明：仅到店堂食/自取）。

要求 Node ≥ 18；首次运行自动构建（prepare → tsc）。npx 找不到时换 Node 安装目录下的绝对路径。

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
      "args": ["-y", "github:lichadecha/licha-order-mcp#v0.3.1"]
    }
  }
}
```

安装命令固定指向版本标签（`#v0.3.1`），不追踪最新提交；升级时以新版 README 给出的标签为准。

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

## 许可证

代码部分（src/、scripts/、test/、配置文件）采用 Apache-2.0；文字部分（SKILL.md、README 及其他文档）采用 CC BY-ND 4.0。「李茶的茶」名称与标识归品牌方所有，不在任何许可证授权范围内。详见 [LICENSE](./LICENSE)。
