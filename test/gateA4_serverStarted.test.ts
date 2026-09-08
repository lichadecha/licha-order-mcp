// 24 号任务书 A4：MCP 进程启动时在 access-audit 留一条 server_started。
//
// 为什么要这一条：会话绑定与待确认单都在进程内存里，宿主（WorkBuddy）回收 stdio 进程后
// 它们随之清空，而宿主不落盘 stdio 进程的启停记录。2026-09-08 侦察单那次「绑定成功 3 分钟后
// 下单报未绑定」只能靠 access-audit 里 bind_success 出现两次去反推。有了这一条，重启了几次、
// 什么时候重启，直接数日志。
//
// 真实 spawn dist/src/index.js（与 toolsList / gateG5 同法），日志钉到临时目录，不碰生产 logs/。

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = dirname(fileURLToPath(import.meta.url)); // dist/test
const SERVER_ENTRY = join(HERE, "..", "src", "index.js"); // dist/src/index.js
const REPO_ROOT = join(HERE, "..", ".."); // dist/test → dist → 包根

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version?: unknown };
  assert.strictEqual(typeof pkg.version, "string");
  return pkg.version as string;
}

interface StartedLine {
  event: string;
  result: string;
  reason: string | null;
  sessionKey: string | null;
  tool: string | null;
}

/** 起一个 server、握手、tools/list、关掉；返回临时日志目录里 access-audit 的全部行与子进程 pid。 */
async function spawnOnce(enableOrdering: string | undefined): Promise<{ lines: StartedLine[]; pid: number | null; logDir: string }> {
  const logDir = mkdtempSync(join(tmpdir(), "licha-a4-logs-"));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  if (enableOrdering === undefined) {
    delete env.LICHA_ENABLE_ORDERING;
  } else {
    env.LICHA_ENABLE_ORDERING = enableOrdering;
  }
  env.LICHA_LOG_DIR = logDir;

  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER_ENTRY], env });
  const client = new Client({ name: "licha-mcp-test-a4", version: "0.1.0" });
  await client.connect(transport);
  let pid: number | null = null;
  try {
    pid = transport.pid;
    await client.listTools(); // 走一轮协议，确保 main() 里 connect 之后的那条记录已落盘
  } finally {
    await client.close();
  }
  const file = join(logDir, "access-audit.log");
  const lines: StartedLine[] = existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as StartedLine)
    : [];
  return { lines, pid, logDir };
}

const REASON_RE = /^v(\d+\.\d+\.\d+)\|pid=(\d+)\|ordering=([01])$/;

test("A4-1: 启动一次 → access-audit 恰有 1 条 server_started，版本 == package.json，pid 是子进程 pid", async () => {
  const { lines, pid, logDir } = await spawnOnce(undefined);
  try {
    const started = lines.filter((l) => l.event === "server_started");
    assert.equal(started.length, 1, `应恰有 1 条 server_started，实际日志：${JSON.stringify(lines)}`);
    assert.equal(lines.length, 1, "握手 + tools/list 不该产生其他 access-audit 事件");
    const m = REASON_RE.exec(started[0].reason ?? "");
    assert.ok(m, `reason 形态应为 v版本|pid=数字|ordering=0/1，实际：${started[0].reason}`);
    assert.equal(m![1], packageVersion(), "版本号必须与 package.json 一致（单源）");
    if (pid != null) assert.equal(Number(m![2]), pid, "pid 必须是真实子进程 pid");
    assert.equal(started[0].result, "allowed");
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("A4-2: 关闭态 ordering=0、开启态 ordering=1，各恰 1 条", async () => {
  const off = await spawnOnce(undefined);
  const on = await spawnOnce("1");
  try {
    const reasonOf = (r: { lines: StartedLine[] }) => r.lines.find((l) => l.event === "server_started")?.reason ?? "";
    assert.match(reasonOf(off), /\|ordering=0$/);
    assert.match(reasonOf(on), /\|ordering=1$/);
    assert.equal(off.lines.filter((l) => l.event === "server_started").length, 1);
    assert.equal(on.lines.filter((l) => l.event === "server_started").length, 1);
  } finally {
    rmSync(off.logDir, { recursive: true, force: true });
    rmSync(on.logDir, { recursive: true, force: true });
  }
});

test("A4-3: 连续启动两次 → 两条 server_started 的 pid 不同（重启可数）", async () => {
  const first = await spawnOnce("1");
  const second = await spawnOnce("1");
  try {
    const pidOf = (r: { lines: StartedLine[] }) => REASON_RE.exec(r.lines.find((l) => l.event === "server_started")?.reason ?? "")?.[2];
    assert.ok(pidOf(first) && pidOf(second));
    assert.notEqual(pidOf(first), pidOf(second), "两个进程的 pid 不该相同——这正是「数日志知重启」的依据");
  } finally {
    rmSync(first.logDir, { recursive: true, force: true });
    rmSync(second.logDir, { recursive: true, force: true });
  }
});
