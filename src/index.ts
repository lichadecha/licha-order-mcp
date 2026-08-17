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

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[${SERVER_NAME}] v${SERVER_VERSION} stdio 已启动，四工具已注册：find_store / get_menu / get_item_detail / preview_order`,
  );
}

process.on("SIGINT", () => void server.close().then(() => process.exit(0)));
process.on("SIGTERM", () => void server.close().then(() => process.exit(0)));

main().catch((e) => {
  console.error(`[${SERVER_NAME}] 启动失败：`, e);
  process.exit(1);
});
