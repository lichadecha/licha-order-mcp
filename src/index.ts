#!/usr/bin/env node
// N7a MCP 协议接线：stdio server 注册四柜台工具（找店 / 菜单 / 点单卡片 / 算总价）。
// stdout 纪律：stdout 是 MCP 协议通道，本进程禁止 console.log；日志一律 stderr。

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { findStore } from "./tools/findStore.js";
import { getMenu } from "./tools/getMenu.js";
import { getItemDetail } from "./tools/getItemDetail.js";
import { previewOrder } from "./tools/previewOrder.js";
import { ENABLE_ORDERING_ENV } from "./constants.js";
import { placeOrderConfirmedHandler } from "./placeOrderTool.js";
import { prepareOrderHandler } from "./prepareOrderTool.js";
import { myOrdersHandler } from "./myOrdersTool.js";
import { bindMemberHandler } from "./bindMemberTool.js";
import { getOrderStatusHandler } from "./orderStatusTool.js";

const SERVER_NAME = "licha-order-mcp";
// 版本号单源：只认 package.json，不在代码里另抄一份。
// 抄一份的代价已经付过：硬编码的 "0.3.1" 跟着 package.json 升到 0.5.1 一路没人改，
// 双态握手对外报的一直是 0.3.1，宿主看到的版本与安装的版本对不上。
// 为什么用 createRequire 而不是 import json：真正被运行的是编译产物 dist/src/index.js
// （bin 指向它，测试也 spawn 它），往上两级就是包根 —— package.json `files: ["dist"]`，
// npx 装出来的形态同样成立。走 import + resolveJsonModule 会让 tsc 把 package.json
// 复制进 dist，那又变成两份版本号。
const { version: SERVER_VERSION } = createRequire(import.meta.url)("../../package.json") as {
  version: string;
};

const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

// storeId 入参：find_store 返回的是字符串，模型可能原样回传，coerce 数字/字符串两种都接。
const storeIdSchema = z.coerce
  .number()
  .int()
  .positive()
  .describe("门店 ID（先用 find_store 查；如深圳湾万象城=503542）");

type TextResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function ok(data: unknown): TextResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(e: unknown): TextResult {
  const message = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text", text: message }], isError: true };
}

server.registerTool(
  "find_store",
  {
    title: "找店",
    description:
      "按店名、商场名或城市找李茶的茶门店，返回 storeId（看菜单/点单都要用）、营业状态；唯一命中时附营业时间。点单第一步先找店。",
    inputSchema: { query: z.string().min(1).describe("店名/商场/城市，如「深圳湾」「太古里」「北京」") },
  },
  async ({ query }) => {
    try {
      return ok(await findStore(query));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "get_menu",
  {
    title: "逛菜单",
    description:
      "看某店菜单：不传 keyword 返回全部分类；传 keyword（商品名或分类名）返回商品列表（goodsId、价格、标签）。",
    inputSchema: {
      storeId: storeIdSchema,
      keyword: z.string().optional().describe("商品名或分类名，如「莲雾」「纯茶」；省略则返回分类列表"),
    },
  },
  async ({ storeId, keyword }) => {
    try {
      return ok(await getMenu(storeId, keyword));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "get_item_detail",
  {
    title: "点单卡片",
    description:
      "看商品点单详情：规格（SKU）、做法（温度/糖度等）、加料、是否估清。goodsId 从 get_menu 结果里取。",
    inputSchema: {
      storeId: storeIdSchema,
      goodsId: z.string().min(1).describe("商品 ID（get_menu 返回的 goodsId）"),
    },
  },
  async ({ storeId, goodsId }) => {
    try {
      return ok(await getItemDetail(storeId, goodsId));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "preview_order",
  {
    title: "算总价",
    description:
      "组单算预估总价（本地累加；实际金额以门店收银台/订单为准）。同组做法（如温度）只能选一个，估清商品会拦截。",
    inputSchema: {
      storeId: storeIdSchema,
      items: z
        .array(
          z.object({
            goodsId: z.string().min(1).describe("商品 ID"),
            skuId: z.string().optional().describe("规格 ID；唯一规格可省略自动选"),
            practices: z.array(z.string()).optional().describe('做法值名，如 ["少冰（400ml)", "70%-L阿拉伯糖"]'),
            attaches: z.array(z.string()).optional().describe("加料名"),
            quantity: z.number().int().min(1).max(99),
          }),
        )
        .min(1)
        .max(20),
    },
  },
  async ({ storeId, items }) => {
    try {
      return ok(await previewOrder(storeId, items));
    } catch (e) {
      return fail(e);
    }
  },
);

// ---------- 二期写/身份工具：默认关闭，LICHA_ENABLE_ORDERING=1 才注册 ----------
//
// 未设置该环境变量时，下面这段代码根本不会跑到 registerTool——tools/list 里连工具名都看不见。
// 理由（施工令 § 3.1）：① 公开库突然多出下单能力会伤装机信任；② 开发期任何误触发都不该能真下单。
// M3 追加理由：bind_member / get_order_status 虽是只读调用，但属二期交易域（身份绑定与查单
// 都是"下单"这条业务线的一部分），开关关闭时 tools/list 必须仍只有一期四工具，保持公开仓只读形象。
//
// M4 追加：prepare_order 虽是纯只读工具（本地算价 + 签发确认令牌，不创建任何订单），仍然放在
// 门控内——它是下单链路的一环，开关关闭时整条交易链路都不该出现在 tools/list 里。my_orders 同理。
//
// 实际处理逻辑都拆到独立模块（prepareOrderTool.ts / placeOrderTool.ts / bindMemberTool.ts /
// orderStatusTool.ts / myOrdersTool.ts），
// 不写在这里——因为本文件顶层有 main().catch(...) 会启动真实 stdio transport connect，
// 单元测试不能安全地 import 这个文件；处理逻辑拆到独立模块后，测试才能直接 import + mock fetch。
const ORDERING_ENABLED = process.env[ENABLE_ORDERING_ENV] === "1";

if (ORDERING_ENABLED) {
  server.registerTool(
    "prepare_order",
    {
      title: "组单（下单前确认，只读）",
      description:
        "两阶段下单的第一步（只读，不会创建任何订单）：本地算价、组装下单参数，返回一张「待确认单」" +
        "和一个 5 分钟内有效、只能用一次的确认令牌。需先用 bind_member 绑定会员身份。" +
        "拿到待确认单后必须逐项念给顾客确认（门店、每杯商品与规格做法、杯数、总金额），" +
        "顾客确认后再调用 place_order。入参与 preview_order 同构；不接受 userId、金额与渠道参数。",
      inputSchema: {
        storeId: storeIdSchema,
        items: z
          .array(
            z.object({
              goodsId: z.string().min(1).describe("商品 ID"),
              skuId: z.string().optional().describe("规格 ID；唯一规格可省略自动选"),
              practices: z.array(z.string()).optional().describe('做法值名，如 ["少冰（400ml)", "70%-L阿拉伯糖"]'),
              attaches: z.array(z.string()).optional().describe("加料名"),
              quantity: z.number().int().min(1).max(99),
            }),
          )
          .min(1)
          .max(20),
      },
    },
    prepareOrderHandler,
  );

  server.registerTool(
    "place_order",
    {
      title: "确认下单（写·唯一）",
      description:
        "两阶段下单的第二步（写）：凭 prepare_order 签发的确认令牌创建真实订单。" +
        "下单参数完全来自那张待确认单，本工具不接受任何订单内容参数——" +
        "这保证「下的单 = 念给顾客听过的那张单」。下单成功后会强制读回企迈的实付金额与优惠明细，" +
        "与本地预估比对；差额超阈值时返回体带 warning，必须先向顾客说清差额再引导付款。" +
        "我们不代付、不碰支付凭据，只引导顾客去小程序「我的订单」自行付款。",
      inputSchema: {
        confirmToken: z.string().min(1).describe("prepare_order 签发的一次性确认令牌（5 分钟内有效，用一次即失效）"),
        confirmAmountYuan: z
          .number()
          .positive()
          .describe("你刚刚念给顾客确认的总金额（元）。必须与待确认单一致，不一致会被拒绝下单"),
      },
    },
    placeOrderConfirmedHandler,
  );

  server.registerTool(
    "bind_member",
    {
      title: "绑定会员身份",
      // 描述与 SKILL.md「绑定会员」章节、bindMemberTool 的三条分支逐条对齐。
      // 为什么盯着这段文本：注册描述与 SKILL 是同时发给 Agent 的两套指令，写法相左时
      // Agent 收到的是矛盾要求。这里原先还写着「绑定后不可切换、换人重开会话」，
      // 那是 2026-08-19 之前的规矩，代码早已改成直接换绑（见 bindMemberTool 头部注释）。
      description:
        "绑定当前会话到一位李茶的茶会员，之后才能下单或查自己的订单；只在顾客明确要下单时才绑定。" +
        "默认用顾客注册会员的手机号（codeType=phone）。" +
        "换人直接换绑：顾客报一个新号，照常再调一次本工具就行，不需要任何额外动作——" +
        "换成了另一位会员时出参带 rebound=true（旧顾客还没确认的待确认单会被作废，见 discardedPendingOrders）；" +
        "报的还是同一位会员则是幂等成功、不改任何状态，出参不带 rebound，别说成「换绑成功」。" +
        "唯一拦换人的情况：上一次下单请求结果还没核对清楚时本工具会拒绝，" +
        "先用 my_orders 或 get_order_status 把那一单核对掉再换人。" +
        "三种标识形态：phone=11 位手机号（默认）；card=实体卡号或会员码；" +
        "dynamic_code=小程序「会员码」页面显示的动态码（每 30 秒刷新一次，需要请顾客当场打开小程序读出）。",
      inputSchema: {
        code: z
          .string()
          .min(4)
          .max(64)
          .describe("会员标识：手机号 11 位数字，或实体卡号/会员码/小程序动态码（4-64 位）"),
        codeType: z
          .enum(["phone", "card", "dynamic_code"])
          .describe(
            "标识形态：phone=11 位手机号，默认用这个；card=实体卡号/会员码；dynamic_code=小程序会员码页动态码（每 30 秒刷新，顾客报不出手机号时才用）",
          ),
      },
    },
    bindMemberHandler,
  );

  server.registerTool(
    "get_order_status",
    {
      title: "查订单状态",
      description: "查询一个订单的当前状态。只能查当前绑定会员自己的订单——查询别人的订单会被拒绝。",
      inputSchema: {
        orderNo: z.string().min(1).describe("订单号"),
      },
    },
    getOrderStatusHandler,
  );

  server.registerTool(
    "my_orders",
    {
      title: "我的订单",
      description:
        "列出当前绑定会员最近几天的订单（订单号、状态、实付金额、下单时间、商品）。" +
        "只查当前绑定的会员本人——不接受指定他人身份，最多返回最近 10 条。",
      inputSchema: {
        days: z.number().int().min(1).max(90).default(7).describe("查最近几天（1-90，默认 7；企迈限制查询窗口最长 90 天）"),
      },
    },
    myOrdersHandler,
  );
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const writeNote = ORDERING_ENABLED
    ? " + prepare_order/place_order/bind_member/get_order_status/my_orders（二期已开启）"
    : "（二期工具未开启）";
  console.error(
    `[${SERVER_NAME}] v${SERVER_VERSION} stdio 已启动，四只读工具已注册：find_store / get_menu / get_item_detail / preview_order${writeNote}`,
  );
}

process.on("SIGINT", () => void server.close().then(() => process.exit(0)));
process.on("SIGTERM", () => void server.close().then(() => process.exit(0)));

main().catch((e) => {
  console.error(`[${SERVER_NAME}] 启动失败：`, e);
  process.exit(1);
});
