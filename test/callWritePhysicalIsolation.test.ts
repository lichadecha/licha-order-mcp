// T3 / T4：读写两条通道的物理隔离。
//
// T3：callWrite 传非白名单路径 → WriteNotAllowed，且 fetch 未被调用。
// T4：callRead 传写路径（6.2.9）→ ReadOnlyViolation（读通道不许被借道去发写请求），且 fetch 未被调用。
//
// 红线自证：globalThis.fetch 被整体替换为一个计数器函数，callWrite/callRead 内部无论怎样调用
// fetch(...) 实际执行的都是这个假函数——不存在真实网络 I/O 的可能。测试结束后在 finally 里还原。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callRead, callWrite, ReadOnlyViolation, WriteNotAllowed } from "../src/client.js";
import { WRITE_WHITELIST } from "../src/constants.js";
import { WriteGuard, setWriteGuardForTesting } from "../src/writeGuard.js";

function freshGuard(): WriteGuard {
  const dir = mkdtempSync(join(tmpdir(), "licha-wg-isolation-"));
  return new WriteGuard({ auditLogPath: join(dir, "write-audit.log"), placedOrdersPath: join(dir, "placed-orders.json") });
}

function installFetchSpy(): { count: () => number; restore: () => void } {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (..._args: Parameters<typeof fetch>) => {
    calls++;
    return new Response(JSON.stringify({ status: true, code: 0, data: {} }), { status: 200 });
  }) as typeof fetch;
  return {
    count: () => calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test("T3: callWrite 传非白名单路径 → 抛 WriteNotAllowed，fetch 未被调用", async () => {
  // getWriteGuard() 在 callWrite 函数体最开头就会被调用（构造审计摘要之前），
  // 即使本用例的拒绝发生在"连白名单都没过"这一步，也要注入独立 guard，
  // 避免落到生产默认路径、写脏真实 logs/ 目录或被历史测试状态污染。
  setWriteGuardForTesting(freshGuard());
  const spy = installFetchSpy();
  try {
    await assert.rejects(
      () => callWrite("v3/not/in/write/whitelist", { storeId: 1 }, { amountFen: 100, confirmToken: "whatever" }),
      (err: unknown) => err instanceof WriteNotAllowed,
    );
    assert.strictEqual(spy.count(), 0, "fetch 不应被调用");
  } finally {
    spy.restore();
    setWriteGuardForTesting(null);
  }
});

test("T4: callRead 传写路径（6.2.9）→ 抛 ReadOnlyViolation，fetch 未被调用", async () => {
  const spy = installFetchSpy();
  try {
    await assert.rejects(
      () => callRead(WRITE_WHITELIST[0], { storeId: 1 }),
      (err: unknown) => err instanceof ReadOnlyViolation,
    );
    assert.strictEqual(spy.count(), 0, "fetch 不应被调用");
  } finally {
    spy.restore();
  }
});
