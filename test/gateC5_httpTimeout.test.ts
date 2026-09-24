// 25 号任务书 C5：HTTP 超时。
//
// 改造前 client.ts 两处 fetch 都没有 AbortSignal，企迈挂起时对话无限等待（WorkBuddy 侧「AI 卡住」）。
// 读：8s 超时，按既有传输异常路径退避重试（attempts 语义不变，attempts:1 只等一次）。
// 写：15s 超时，「已发出 ≠ 已成功」——记 unknown/RequestTimeout、占额度、拉未决闸门，零重试。
//
// 🚨 红线自证：globalThis.fetch 全程被 mock 替换，绝不发出真实请求。mock 会尊重 init.signal——
// 没有 signal 就永远挂着，那正是本文件要抓的退化形态（会表现为测试超时而不是假绿）。
// 超时值经 setHttpTimeoutsForTesting 注入成几十毫秒，测试不等 8s/15s。落盘一律在 mkdtemp 临时目录。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callRead, callWrite, setHttpTimeoutsForTesting, setReadAuditLogPathForTesting } from "../src/client.js";
import { WRITE_WHITELIST } from "../src/constants.js";
import { WriteGuard, setWriteGuardForTesting } from "../src/writeGuard.js";
import { SessionStore, setSessionStoreForTesting, DEFAULT_SESSION_KEY } from "../src/session.js";
import { AccessAuditLogger, setAccessAuditLoggerForTesting } from "../src/accessAudit.js";
import { PendingOrderStore, setPendingOrderStoreForTesting } from "../src/pendingOrders.js";
import { placeOrderConfirmedHandler } from "../src/placeOrderTool.js";

process.env.QMAI_OPEN_KEY ??= "test-open-key-0123456789abcdef0123456789ab";
process.env.QMAI_OPEN_ID ??= "test-open-id-0000000000000000";
process.env.QMAI_GRANT_CODE ??= "test-grant-code-0000000000";

const FAKE_CUSTOMER_ID = "1234567890123456789";
const PATH_CREATE = WRITE_WHITELIST[0];
const PATH_STATUS = "v3/order/status";
const realFetch = globalThis.fetch;

const SAMPLE_PARAMS = {
  storeId: 503542,
  items: [{ goodsId: "1200000000000000001", skuId: "1288634197263667200", num: 1 }],
  orderType: 1,
  source: 18,
  userId: FAKE_CUSTOMER_ID,
};

interface Fixture {
  guard: WriteGuard;
  pendingStore: PendingOrderStore;
  auditLogPath: string;
  restore: () => void;
}
function installFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "licha-c5-"));
  const auditLogPath = join(dir, "write-audit.log");
  const guard = new WriteGuard({ auditLogPath, placedOrdersPath: join(dir, "placed-orders.json") });
  setWriteGuardForTesting(guard);
  const pendingStore = new PendingOrderStore();
  setPendingOrderStoreForTesting(pendingStore);
  const sessions = new SessionStore();
  sessions.bind(DEFAULT_SESSION_KEY, { customerId: FAKE_CUSTOMER_ID, boundAt: Date.now(), boundVia: "phone", phone: "13800001234" });
  setSessionStoreForTesting(sessions);
  setAccessAuditLoggerForTesting(new AccessAuditLogger({ logPath: join(dir, "access-audit.log") }));
  setReadAuditLogPathForTesting(join(dir, "read-audit.log"));
  return {
    guard,
    pendingStore,
    auditLogPath,
    restore: () => {
      setHttpTimeoutsForTesting(null);
      setWriteGuardForTesting(null);
      setPendingOrderStoreForTesting(null);
      setSessionStoreForTesting(null);
      setAccessAuditLoggerForTesting(null);
      setReadAuditLogPathForTesting(null);
      globalThis.fetch = realFetch;
    },
  };
}

function auditLines(path: string): Array<Record<string, any>> {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
function textOf(r: { content: Array<{ type: "text"; text: string }> }): string {
  return r.content.map((c) => c.text).join("\n");
}

/**
 * 挂起的 fetch：只在 signal 触发 abort 时以 signal.reason（TimeoutError）拒绝。
 * 里面那个 setTimeout 是在模拟真实 socket 句柄——Node 的 AbortSignal.timeout 用的是 unref 定时器，不撑事件循环；
 * 真环境有 socket / stdio 撑着没事，测试里的 mock 什么句柄都没有，事件循环一空 test runner 就报
 * "Promise resolution is still pending"。没有 signal 时 5s 后主动失败，让退化形态（fetch 不带 signal）明确报错而不是假绿。
 */
function installHangingFetch(): { calls: () => number; sawSignal: () => boolean } {
  let calls = 0;
  let sawSignal = false;
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    const sig = init?.signal;
    return new Promise<Response>((_, reject) => {
      if (!sig) {
        setTimeout(() => reject(new Error("mock fetch：请求没带 AbortSignal，这就是 C5 要修的无限等待")), 5000);
        return;
      }
      sawSignal = true;
      const keepAlive = setTimeout(() => reject(new Error("mock fetch：signal 60s 内没触发 abort")), 60_000);
      const done = () => {
        clearTimeout(keepAlive);
        reject(sig.reason);
      };
      if (sig.aborted) return done();
      sig.addEventListener("abort", done, { once: true });
    });
  }) as typeof fetch;
  return { calls: () => calls, sawSignal: () => sawSignal };
}

// ============================================================================
// C5-1：读挂起
// ============================================================================
test("C5-1a: 读挂起 + attempts:1 → 只等一次就返回 TIMEOUT，带读超时话术，fetch 恰 1 次", async () => {
  const fx = installFixture();
  setHttpTimeoutsForTesting({ readMs: 40 });
  const hang = installHangingFetch();
  try {
    const t0 = Date.now();
    const res = await callRead(PATH_STATUS, { orderNo: "D-C5-READ" }, { attempts: 1 });
    const elapsed = Date.now() - t0;
    assert.equal(res.ok, false);
    assert.equal(res.error!.code, "TIMEOUT");
    assert.match(res.error!.hint, /稍等几秒/, "读超时话术：什么都没发生，可以再问一次");
    assert.ok(!/重复下单/.test(res.error!.hint), "读超时不能用写超时那句吓人的话");
    assert.equal(hang.calls(), 1, "attempts:1 只等一次");
    assert.ok(hang.sawSignal(), "fetch 必须带 AbortSignal——没带就是退化回无限等待");
    assert.ok(elapsed < 1500, `约超时值内返回（实际 ${elapsed}ms），不能等 8s`);
  } finally {
    fx.restore();
  }
});

test("C5-1b: 读挂起 + 默认 attempts(3) → 三次都超时、按既有退避重试后返回 TIMEOUT（退避常量不动：1s + 2s）", async () => {
  const fx = installFixture();
  setHttpTimeoutsForTesting({ readMs: 40 });
  const hang = installHangingFetch();
  try {
    const t0 = Date.now();
    const res = await callRead(PATH_STATUS, { orderNo: "D-C5-READ3" });
    const elapsed = Date.now() - t0;
    assert.equal(res.ok, false);
    assert.equal(res.error!.code, "TIMEOUT");
    assert.equal(hang.calls(), 3, "attempts 语义不变：超时走传输异常路径重试到 3 次");
    assert.ok(elapsed >= 3000 && elapsed < 6000, `退避 1s + 2s 应仍在（实际 ${elapsed}ms）`);
  } finally {
    fx.restore();
  }
});

// ============================================================================
// C5-2：写挂起 —— unknown/RequestTimeout、写请求恰 1 次、闸门拦后续下单
// ============================================================================
test("C5-2: 写挂起 → write-audit 记 unknown/RequestTimeout、占额度、写请求恰 1 次；随后第二笔下单被未决闸门拦、写路径仍是 1 次", async () => {
  const fx = installFixture();
  setHttpTimeoutsForTesting({ writeMs: 60 });
  const hang = installHangingFetch();
  try {
    const first = fx.guard.issueConfirmToken(SAMPLE_PARAMS);
    const t0 = Date.now();
    const res = await callWrite(PATH_CREATE, SAMPLE_PARAMS, { amountFen: 2400, confirmToken: first.tokenId });
    const elapsed = Date.now() - t0;

    assert.equal(res.ok, false);
    assert.equal(res.error!.code, "TIMEOUT");
    assert.match(res.error!.hint, /我的订单/, "写超时话术：先去小程序确认");
    assert.match(res.error!.hint, /先别重复下单/, "写超时话术的核心任务：拦住顾客再点一次");
    assert.equal(hang.calls(), 1, "写超时零重试");
    assert.ok(hang.sawSignal(), "写侧 fetch 必须带 AbortSignal");
    assert.ok(elapsed < 1500, `约超时值内返回（实际 ${elapsed}ms），不能等 15s`);

    const lines = auditLines(fx.auditLogPath);
    assert.equal(lines.filter((l) => l.result === "inflight").length, 1, "fetch 之前的 inflight 记录保留");
    const terminal = lines.filter((l) => l.result !== "inflight");
    assert.equal(terminal.length, 1, "恰好一条终态");
    assert.equal(terminal[0].result, "unknown", "超时 = 结果未知，不是失败");
    assert.equal(terminal[0].reason, "RequestTimeout", "超时单列原因，与 TransportError 在日志里分得开");
    assert.ok(terminal[0].idempotencyKey, "幂等键保留");
    assert.equal(fx.guard.currentDailyCount(), 1, "结果未知照样占当日额度");
    assert.equal(fx.guard.hasUnresolvedWrite(), true, "超时之后必须拉起未决闸门");

    // 模型「重走一次流程」：新令牌、新待确认单——闸门必须拦下，写路径一次都不能再被调用。
    const second = fx.guard.issueConfirmToken(SAMPLE_PARAMS);
    fx.pendingStore.register(second.tokenId, { finalParams: SAMPLE_PARAMS, estimatedAmountFen: 2400 });
    const r = await placeOrderConfirmedHandler({ confirmToken: second.tokenId, confirmAmountYuan: 24 });
    assert.equal(r.isError, true, "存在未决写请求时必须拒绝新下单");
    assert.match(textOf(r), /结果还没有核对清楚/);
    assert.equal(hang.calls(), 1, "第二笔的写路径一次都没被调用（仍是第一笔那 1 次）");
    const rejects = auditLines(fx.auditLogPath).filter((l) => String(l.reason ?? "").startsWith("UnresolvedWriteExists"));
    assert.equal(rejects.length, 1);
  } finally {
    fx.restore();
  }
});

// ============================================================================
// C5-3：正常快速响应零行为变化
// ============================================================================
test("C5-3: 正常快速响应 → 读 ok、写 allowed，各恰 1 次；默认超时值 8s/15s 不影响快路径", async () => {
  const fx = installFixture();
  let calls = 0;
  let sawSignal = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    sawSignal = sawSignal || Boolean(init?.signal);
    const url = String(input);
    if (url.includes(PATH_CREATE)) {
      return new Response(JSON.stringify({ status: true, code: 0, data: { orderNo: "D-C5-OK", payAmount: 24.0 } }), { status: 200 });
    }
    return new Response(JSON.stringify({ status: true, code: 0, data: { orderNo: "D-C5-OK", status: 10 } }), { status: 200 });
  }) as typeof fetch;
  try {
    const read = await callRead<{ status: number }>(PATH_STATUS, { orderNo: "D-C5-OK" });
    assert.equal(read.ok, true);
    assert.equal(read.data?.status, 10);

    const { tokenId } = fx.guard.issueConfirmToken(SAMPLE_PARAMS);
    const write = await callWrite(PATH_CREATE, SAMPLE_PARAMS, { amountFen: 2400, confirmToken: tokenId });
    assert.equal(write.ok, true);
    assert.equal(calls, 2);
    assert.ok(sawSignal, "快路径同样带 signal——超时是常态配置，不是异常路径才有");
    const terminal = auditLines(fx.auditLogPath).filter((l) => l.result !== "inflight");
    assert.deepEqual(terminal.map((l) => l.result), ["allowed"]);
    assert.equal(fx.guard.hasUnresolvedWrite(), false);
  } finally {
    fx.restore();
  }
});
