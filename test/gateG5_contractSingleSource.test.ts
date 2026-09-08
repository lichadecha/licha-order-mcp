// G5 契约单源：发给 Agent 的东西（握手版本号、bind_member 注册描述）与真源（package.json、
// SKILL.md、处理器实现）必须是同一份，加上单机单人身份边界必须写在文档里。
//
// 为什么这四条要落成测试而不是靠人工 review：G5 修的三处缺陷全是「抄了一份然后忘了同步」——
// SERVER_VERSION 抄了 package.json（停在 0.3.1 两个版本没人发现）、bind_member 描述抄了
// 2026-08-19 之前的话术（与 SKILL、与实现同时相左）。这类缺陷不会让任何测试变红，
// 只有拿真源做断言才拦得住下一次。
//
// 红线自证：沿用 toolsList.test.ts 的手法——子进程真实启动 MCP server，只走 initialize +
// tools/list，从不 callTool（凭证只在工具被调用时才读），因此不触发凭证读取、零网络请求。
// 另外两条只读文件做正则断言，同样不碰网络。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = dirname(fileURLToPath(import.meta.url)); // dist/test
const SERVER_ENTRY = join(HERE, "..", "src", "index.js"); // dist/src/index.js
const REPO_ROOT = join(HERE, "..", ".."); // dist/test → dist → 包根

function readRepoFile(name: string): string {
  return readFileSync(join(REPO_ROOT, name), "utf8");
}

/** 版本号真源：package.json，测试自己也只认它，不写死任何版本字符串。 */
function packageVersion(): string {
  const pkg = JSON.parse(readRepoFile("package.json")) as { version?: unknown };
  assert.strictEqual(typeof pkg.version, "string", "package.json 必须有字符串 version");
  return pkg.version as string;
}

interface HandshakeResult {
  serverVersion: string | undefined;
  serverName: string | undefined;
  tools: Array<{ name: string; description?: string }>;
}

async function handshake(enableOrdering: string | undefined): Promise<HandshakeResult> {
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
  const client = new Client({ name: "licha-mcp-test-g5", version: "0.1.0" });
  await client.connect(transport);
  try {
    const info = client.getServerVersion();
    const listed = await client.listTools();
    return {
      serverVersion: info?.version,
      serverName: info?.name,
      tools: listed.tools
        .map((t) => ({ name: t.name, description: (t as unknown as { description?: string }).description }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  } finally {
    await client.close();
  }
}

test("G5-1: 双态握手 serverInfo.version === package.json 的 version（版本号单源）", async () => {
  const expected = packageVersion();
  for (const [label, flag] of [
    ["开关关闭", undefined],
    ["开关开启", "1"],
  ] as const) {
    const result = await handshake(flag);
    assert.strictEqual(
      result.serverVersion,
      expected,
      `${label}时握手报的版本应为 package.json 的 ${expected}，实得：${String(result.serverVersion)}`,
    );
    assert.strictEqual(result.serverName, "licha-order-mcp", `${label}时握手 name 不应变`);
  }
});

test("G5-2: bind_member description 与 SKILL 换绑段一致——含「直接换绑」，不含「重开会话」「不可切换」", async () => {
  const { tools } = await handshake("1");
  const bindMember = tools.find((t) => t.name === "bind_member");
  assert.ok(bindMember, `开启态应注册 bind_member，实得：${tools.map((t) => t.name).join(", ")}`);
  const description = bindMember.description ?? "";
  assert.ok(description.length > 0, "bind_member 必须有 description");

  // SKILL.md 绑定会员章节的原文短语，两边同时出现才算一致。
  assert.match(description, /直接换绑/, `description 应含 SKILL 的「直接换绑」，实得：${description}`);
  assert.match(description, /rebound/, `description 应说明换成另一人时出参带 rebound，实得：${description}`);
  assert.match(description, /手机号/, `description 应把手机号写成默认形态，实得：${description}`);
  assert.match(
    description,
    /my_orders|get_order_status/,
    `description 应写明有未决单时先核对再换人，实得：${description}`,
  );

  // 2026-08-19 已废弃的旧规矩，一个字都不许再出现在发给 Agent 的文本里。
  for (const stale of ["重开会话", "重新开启会话", "不可切换", "重开对话"]) {
    assert.ok(
      !description.includes(stale),
      `description 不应再含已废弃表述「${stale}」，实得：${description}`,
    );
  }
  // dynamic_code 不再是对外默认推荐形态（手机号才是）。
  assert.ok(
    !/默认推荐/.test(description),
    `description 不应再把 dynamic_code 写成默认推荐形态，实得：${description}`,
  );
});

test("G5-3: 工具数量不变——关闭态 4 个、开启态 9 个（防 G5 改描述时误伤注册）", async () => {
  const off = await handshake(undefined);
  assert.strictEqual(off.tools.length, 4, `关闭态应恰好 4 个工具，实得：${off.tools.map((t) => t.name).join(", ")}`);

  const on = await handshake("1");
  assert.strictEqual(on.tools.length, 9, `开启态应恰好 9 个工具，实得：${on.tools.map((t) => t.name).join(", ")}`);
  assert.deepStrictEqual(
    on.tools.map((t) => t.name),
    [
      "bind_member",
      "find_store",
      "get_item_detail",
      "get_menu",
      "get_order_status",
      "my_orders",
      "place_order",
      "prepare_order",
      "preview_order",
    ],
    "开启态九工具名单不应变",
  );
});

test("G5-4: README 与 SKILL 各含单机单人身份边界三要素", () => {
  // 三要素缺一不可：① 当前形态是单机单人 ② 同一进程内多人共用会互相覆盖
  // ③ 远程化 / 多用户之前必须接入传输层身份。三条正则各盯一个要素。
  const elements: Array<[string, RegExp]> = [
    ["单机单人形态", /单机单人/],
    ["多人共用互相覆盖", /同一进程内多人共用会互相覆盖/],
    ["远程化前接传输层身份", /远程化或开放多用户之前必须先接入传输层身份/],
  ];
  for (const file of ["README.md", "SKILL.md"]) {
    const text = readRepoFile(file);
    for (const [label, pattern] of elements) {
      assert.match(text, pattern, `${file} 缺身份边界要素「${label}」`);
    }
  }
});
