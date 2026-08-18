// T1 / T2 / U12：写能力开关（LICHA_ENABLE_ORDERING）控制二期工具（place_order / bind_member /
// get_order_status）是否出现在 tools/list 里。M3 把 T1/T2 的断言从"只看 place_order"升级为
// "看全部三个二期工具 + 精确数量"，这是合理更新，不是回归——旧断言（place_order 有无、四个
// 一期工具始终都在）原样保留，只是新增而非替换。
//
// 红线自证：本文件只做协议层 introspection（子进程真实启动 MCP server，走 initialize + tools/list），
// 从不调用 callTool——不会触发凭证读取（loadCredentials 只在工具被"调用"时才执行），不会有任何网络
// 请求。这是本轮测试里最安全的一类：连"要不要 mock fetch"这个问题都不需要回答。

import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = dirname(fileURLToPath(import.meta.url)); // dist/test
const SERVER_ENTRY = join(HERE, "..", "src", "index.js"); // dist/src/index.js

interface ToolDescriptor {
  name: string;
  inputSchema?: unknown;
}

async function listTools(enableOrdering: string | undefined): Promise<ToolDescriptor[]> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  if (enableOrdering === undefined) {
    delete env.LICHA_ENABLE_ORDERING;
  } else {
    env.LICHA_ENABLE_ORDERING = enableOrdering;
  }

  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER_ENTRY], env });
  const client = new Client({ name: "licha-mcp-test-toolslist", version: "0.1.0" });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    return listed.tools
      .map((t) => ({ name: t.name, inputSchema: (t as unknown as { inputSchema?: unknown }).inputSchema }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    await client.close();
  }
}

async function listToolNames(enableOrdering: string | undefined): Promise<string[]> {
  return (await listTools(enableOrdering)).map((t) => t.name);
}

const READONLY_TOOLS = ["find_store", "get_menu", "get_item_detail", "preview_order"] as const;
const PHASE2_TOOLS = ["place_order", "bind_member", "get_order_status"] as const;

test("T1: 开关未设置 → tools/list 不含任何写工具（含 place_order）", async () => {
  const names = await listToolNames(undefined);
  assert.ok(!names.includes("place_order"), `未设置开关时不应出现 place_order，实得：${names.join(", ")}`);
  // 顺带确认四个一期只读工具仍在——不能因为二期改造把它们弄丢，这是一期零回归的另一种证明角度。
  for (const readonlyTool of READONLY_TOOLS) {
    assert.ok(names.includes(readonlyTool), `只读工具 ${readonlyTool} 应始终存在，实得：${names.join(", ")}`);
  }
});

test("T2: 开关 =1 → tools/list 含 place_order", async () => {
  const names = await listToolNames("1");
  assert.ok(names.includes("place_order"), `设置 LICHA_ENABLE_ORDERING=1 后应出现 place_order，实得：${names.join(", ")}`);
});

test("U12: tools/list 双态——开关关闭 = 4 工具；开启 = 7 工具（四只读 + place_order + bind_member + get_order_status）", async () => {
  const offNames = await listToolNames(undefined);
  assert.strictEqual(offNames.length, 4, `开关关闭时应恰好 4 个工具，实得：${offNames.join(", ")}`);
  for (const t of PHASE2_TOOLS) {
    assert.ok(!offNames.includes(t), `开关关闭时不应出现二期工具 ${t}，实得：${offNames.join(", ")}`);
  }

  const onTools = await listTools("1");
  const onNames = onTools.map((t) => t.name);
  assert.strictEqual(onNames.length, 7, `开关开启时应恰好 7 个工具，实得：${onNames.join(", ")}`);
  for (const t of [...READONLY_TOOLS, ...PHASE2_TOOLS]) {
    assert.ok(onNames.includes(t), `开关开启时应包含 ${t}，实得：${onNames.join(", ")}`);
  }

  // 同一测试里断言：所有工具的 inputSchema JSON 序列化后不含 "userId" 键——
  // userId 只能由会话态注入，绝不能出现在任何工具的入参形状里（M3 验收现象第一条）。
  for (const tool of onTools) {
    const schemaJson = JSON.stringify(tool.inputSchema ?? {});
    assert.ok(!/"userId"/.test(schemaJson), `工具 ${tool.name} 的 inputSchema 不应含 userId 键，实得：${schemaJson}`);
  }
});
