#!/usr/bin/env node
// N7a MCP 协议接线：stdio server 注册四柜台工具（找店 / 菜单 / 点单卡片 / 算总价）。
// stdout 纪律：stdout 是 MCP 协议通道，本进程禁止 console.log；日志一律 stderr。

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { findStore } from "./tools/findStore.js";
import { getMenu } from "./tools/getMenu.js";
import { getItemDetail } from "./tools/getItemDetail.js";
import { previewOrder } from "./tools/previewOrder.js";
import { ENABLE_ORDERING_ENV } from "./constants.js";
import { placeOrderHandler } from "./placeOrderTool.js";
import { bindMemberHandler } from "./bindMemberTool.js";
import { getOrderStatusHandler } from "./orderStatusTool.js";

const SERVER_NAME = "licha-order-mcp";
const SERVER_VERSION = "0.3.1";

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
// 实际处理逻辑都拆到独立模块（placeOrderTool.ts / bindMemberTool.ts / orderStatusTool.ts），
// 不写在这里——因为本文件顶层有 main().catch(...) 会启动真实 stdio transport connect，
// 单元测试不能安全地 import 这个文件；处理逻辑拆到独立模块后，测试才能直接 import + mock fetch。
const ORDERING_ENABLED = process.env[ENABLE_ORDERING_ENV] === "1";

if (ORDERING_ENABLED) {
  server.registerTool(
    "place_order",
    {
      title: "确认下单（写·唯一，M2/M3 施工骨架）",
      description:
        "【M2/M3 施工骨架，非最终形态】校验一次性确认令牌与护栏后调用企迈 6.2.9 创建订单。" +
        "需先用 bind_member 绑定会员身份——本会话尚未绑定时会被直接拒绝，不会发起请求。" +
        "完整参数组装与下单前确认单见 M4 的 prepare_order；当前阶段没有工具能签发合法令牌，" +
        "任何调用都会被护栏拒绝——这是预期行为，不是 bug。orderParams 不接受 userId 字段（任意嵌套层级，" +
        "userId 只能由会话态注入）。",
      inputSchema: {
        confirmToken: z.string().min(1).describe("prepare_order 签发的一次性确认令牌（M4 交付物；M2 阶段传任意值都会被拒绝）"),
        amountFen: z.number().int().positive().describe("本地预估金额（分），金额护栏用，> 10000 直接拒绝"),
        orderParams: z
          .record(z.string(), z.unknown())
          .describe("6.2.9 完整下单参数（M2 阶段原样透传给 callWrite，参数组装规则见 M4；不接受 userId 字段）"),
      },
    },
    placeOrderHandler,
  );

  server.registerTool(
    "bind_member",
    {
      title: "绑定会员身份",
      description:
        "绑定当前会话到一位李茶的茶会员，之后才能下单或查自己的订单。一个会话只能绑定一位会员，" +
        "绑定后不可切换——要换人请重新开启会话。三种标识形态：phone=11 位手机号；" +
        "card=实体卡号或会员码；dynamic_code=小程序「会员码」页面显示的动态码（每 30 秒刷新一次，" +
        "需要请顾客当场打开小程序读出，这是对外默认推荐的形态）。",
      inputSchema: {
        code: z
          .string()
          .min(4)
          .max(64)
          .describe("会员标识：手机号 11 位数字，或实体卡号/会员码/小程序动态码（4-64 位）"),
        codeType: z
          .enum(["phone", "card", "dynamic_code"])
          .describe(
            "标识形态：phone=11 位手机号；card=实体卡号/会员码；dynamic_code=小程序会员码页动态码（每 30 秒刷新，对外默认形态）",
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
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const writeNote = ORDERING_ENABLED
    ? " + place_order/bind_member/get_order_status（二期已开启）"
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
