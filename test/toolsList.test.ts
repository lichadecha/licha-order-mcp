// T1 / T2：写能力开关（LICHA_ENABLE_ORDERING）控制 place_order 是否出现在 tools/list 里。
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

async function listToolNames(enableOrdering: string | undefined): Promise<string[]> {
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
    return listed.tools.map((t) => t.name).sort();
  } finally {
    await client.close();
  }
}

test("T1: 开关未设置 → tools/list 不含任何写工具（含 place_order）", async () => {
  const names = await listToolNames(undefined);
  assert.ok(!names.includes("place_order"), `未设置开关时不应出现 place_order，实得：${names.join(", ")}`);
  // 顺带确认四个一期只读工具仍在——不能因为二期改造把它们弄丢，这是一期零回归的另一种证明角度。
  for (const readonlyTool of ["find_store", "get_menu", "get_item_detail", "preview_order"]) {
    assert.ok(names.includes(readonlyTool), `只读工具 ${readonlyTool} 应始终存在，实得：${names.join(", ")}`);
  }
});

test("T2: 开关 =1 → tools/list 含 place_order", async () => {
  const names = await listToolNames("1");
  assert.ok(names.includes("place_order"), `设置 LICHA_ENABLE_ORDERING=1 后应出现 place_order，实得：${names.join(", ")}`);
});
