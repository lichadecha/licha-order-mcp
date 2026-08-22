// N7b 协议握手：真拉起编译后的 stdio server，initialize → tools/list → tools/call 四柜台。
// 预算披露：真实只读调用 ≤10 次（find_store 2 + 搜索 1 + 详情 1 + 组单详情 1 ≈ 5-6，分类走缓存），
// 费用 ≈0（基础类 0.1 元/百次且在 10 万次/月免费额度内）。

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const STORE_ID = 503542; // 深圳湾万象城
const LANHUANG_GOODS_ID = "1123942469096853505"; // 兰皇金观音奶茶（v6 无损锚点）
const PRACTICES = ["少冰（400ml)", "70%-L阿拉伯糖"]; // 0 元做法（smokeOrder 同锚）
const EXPECT_TOOLS = ["find_store", "get_menu", "get_item_detail", "preview_order"];
// M4：写工具上线后「工具数=4」的写死断言在开启态必然失败（施工令 § 8 第 19 条已登记为技术债，
// 不是回归）。改成双态断言——本脚本按自己进程里的 LICHA_ENABLE_ORDERING 决定期望值，
// 两种模式下分别跑都能过：
//   未设置  → 4 个（一期四只读），且一个二期工具都不许出现（公开仓只读形象的协议层自证）
//   =1     → 9 个（四只读 + prepare_order/place_order/bind_member/get_order_status/my_orders）
// 注意：脚本后续步骤只调用一期四个只读工具，开启态也绝不调用任何写工具——本脚本永不下单。
const PHASE2_TOOLS = ["prepare_order", "place_order", "bind_member", "get_order_status", "my_orders"];
const ORDERING_ENABLED = process.env.LICHA_ENABLE_ORDERING === "1";
const EXPECT_ALL_TOOLS = ORDERING_ENABLED ? [...EXPECT_TOOLS, ...PHASE2_TOOLS] : EXPECT_TOOLS;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`断言失败：${msg}`);
}

interface ToolResponse {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

// 取 text 内容并 JSON.parse；工具层 isError 直接视为失败
function parseToolJson(raw: unknown): any {
  const r = raw as ToolResponse;
  assert(Array.isArray(r.content) && r.content[0]?.type === "text" && typeof r.content[0].text === "string",
    "工具返回缺少 text 内容");
  assert(r.isError !== true, `工具报错：${r.content[0].text}`);
  return JSON.parse(r.content[0].text!);
}

async function main(): Promise<void> {
  console.log("== N7b MCP 协议握手 ==");
  const here = dirname(fileURLToPath(import.meta.url)); // dist/scripts
  const serverEntry = join(here, "..", "src", "index.js");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string")),
  });
  const client = new Client({ name: "licha-mcp-handshake", version: "0.1.0" });
  await client.connect(transport);
  console.log("① initialize 握手 ✓");

  const listed = await client.listTools();
  const names = listed.tools.map((t) => t.name).sort();
  for (const want of EXPECT_ALL_TOOLS) assert(names.includes(want), `缺少工具 ${want}`);
  assert(
    names.length === EXPECT_ALL_TOOLS.length,
    `工具数量 ${names.length} ≠ ${EXPECT_ALL_TOOLS.length}（LICHA_ENABLE_ORDERING=${ORDERING_ENABLED ? "1" : "未设置"}）`,
  );
  if (!ORDERING_ENABLED) {
    for (const forbidden of PHASE2_TOOLS) {
      assert(!names.includes(forbidden), `开关未设置时不该出现二期工具 ${forbidden}`);
    }
  }
  console.log(
    `② tools/list ${names.length} 个工具注册 ✓（${ORDERING_ENABLED ? "二期已开启" : "仅一期只读"}：${names.join(" / ")}）`,
  );

  const store = parseToolJson(await client.callTool({ name: "find_store", arguments: { query: "深圳湾" } }));
  assert(store.matched === true && store.store.storeId === String(STORE_ID),
    `find_store 未唯一命中深圳湾：${JSON.stringify(store)}`);
  console.log(`③ find_store 深圳湾 → ${store.store.name}（${store.store.openStatusText}）✓`);

  // 字符串 storeId 验证 coerce 容错（find_store 返回字符串 ID，模型原样回传是常态）
  const menu = parseToolJson(await client.callTool({ name: "get_menu", arguments: { storeId: String(STORE_ID) } }));
  assert(menu.mode === "categories" && menu.categories.length === 9,
    `分类数 ≠ 9：${JSON.stringify(menu).slice(0, 200)}`);
  console.log(`④ get_menu（字符串 storeId coerce）→ ${menu.categories.length} 个分类 ✓`);

  const search = parseToolJson(await client.callTool({ name: "get_menu", arguments: { storeId: STORE_ID, keyword: "莲雾" } }));
  assert(search.mode === "items" && search.items.length > 0, "搜索莲雾未命中");
  const lianwu = search.items.find((i: { name: string }) => i.name.includes("莲雾2.0")) ?? search.items[0];
  console.log(`⑤ get_menu keyword=莲雾 → ${search.items.length} 个商品（取「${lianwu.name}」）✓`);

  const detail = parseToolJson(
    await client.callTool({ name: "get_item_detail", arguments: { storeId: STORE_ID, goodsId: LANHUANG_GOODS_ID } }),
  );
  assert(detail.available === true && detail.skus.length > 0 && detail.practices.length > 0,
    `兰皇详情异常：${JSON.stringify(detail).slice(0, 200)}`);
  console.log(`⑥ get_item_detail 兰皇 → ¥${detail.skus[0].priceYuan}，做法组 ${detail.practices.length}，可点 ✓`);

  const preview = parseToolJson(
    await client.callTool({
      name: "preview_order",
      arguments: {
        storeId: STORE_ID,
        items: [
          { goodsId: LANHUANG_GOODS_ID, practices: PRACTICES, quantity: 1 },
          { goodsId: lianwu.goodsId, quantity: 2 },
        ],
      },
    }),
  );
  assert(preview.ok === true && preview.totalYuan === "80.00", `组单总价异常：${JSON.stringify(preview)}`);
  console.log(`⑦ preview_order 两杯单 → ¥${preview.totalYuan}（与 smokeOrder 锚点一致）✓`);

  await client.close();
  console.log("== N7b 协议握手 ✓ 全过 ==");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
