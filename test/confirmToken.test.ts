// T7：确认令牌四项校验，四种失败模式各自独立验证，均不触发真实 fetch。
//
// 校验顺序（src/writeGuard.ts 的 WriteGuard.verifyToken 内部）：存在 → 未过期 → 未用过 → 指纹一致。
// 这个顺序把"与内容无关"的检查放在"与内容相关"的指纹比对之前，保证：
//   - 重放同一个已用令牌 → 命中 TokenAlreadyUsed（不会被指纹比对抢先，因为内容其实是对得上的）
//   - 拿别的下单内容套用一个未用令牌 → 命中 TokenFingerprintMismatch
// 两种失败模式在审计里能被明确区分，互不掩盖，测试也因此能对四种失败各自独立构造场景。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callWrite, WriteGuardRejected } from "../src/client.js";
import { WRITE_WHITELIST, ORDER_GUARD } from "../src/constants.js";
import { WriteGuard, setWriteGuardForTesting } from "../src/writeGuard.js";

// 假凭证：T7-3 的第一次调用需要真正走到 mock fetch 成功一次，才能测"第二次重放被拒"。
process.env.QMAI_OPEN_KEY ??= "test-open-key-0123456789abcdef0123456789ab";
process.env.QMAI_OPEN_ID ??= "test-open-id-0000000000000000";
process.env.QMAI_GRANT_CODE ??= "test-grant-code-0000000000";

function freshGuard(clock?: () => number): WriteGuard {
  const dir = mkdtempSync(join(tmpdir(), "licha-wg-token-"));
  return new WriteGuard({
    auditLogPath: join(dir, "write-audit.log"),
    placedOrdersPath: join(dir, "placed-orders.json"),
    clock,
  });
}

function installFetchSpy(): { count: () => number; restore: () => void } {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (..._args: Parameters<typeof fetch>) => {
    calls++;
    return new Response(JSON.stringify({ status: true, code: 0, data: { orderNo: "D-SHOULD-NOT-MATTER" } }), { status: 200 });
  }) as typeof fetch;
  return {
    count: () => calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const PARAMS_A = { storeId: 1, items: [{ goodsId: "a", skuId: "s", num: 1 }], orderType: 1, source: 18, userId: "u1" };
const PARAMS_B = { storeId: 2, items: [{ goodsId: "b", skuId: "s", num: 1 }], orderType: 1, source: 18, userId: "u1" };

test("T7-1: 令牌不存在 → TokenNotFound，拒绝，fetch 未被调用", async () => {
  setWriteGuardForTesting(freshGuard());
  const spy = installFetchSpy();
  try {
    await assert.rejects(
      () => callWrite(WRITE_WHITELIST[0], PARAMS_A, { amountFen: 100, confirmToken: "never-issued-token-id" }),
      (err: unknown) => err instanceof WriteGuardRejected && /TokenNotFound/.test((err as Error).message),
    );
    assert.strictEqual(spy.count(), 0);
  } finally {
    spy.restore();
    setWriteGuardForTesting(null);
  }
});

test("T7-2: 令牌已过期 → TokenExpired，拒绝，fetch 未被调用", async () => {
  let now = 2_000_000_000_000; // 任意基准毫秒时间戳（可控时钟，不真的等 5 分钟）
  const guard = freshGuard(() => now);
  setWriteGuardForTesting(guard);
  const spy = installFetchSpy();
  try {
    const { tokenId } = guard.issueConfirmToken(PARAMS_A);
    now += ORDER_GUARD.confirmTokenTtlMs + 1; // 快进超过 TTL（5 分钟）
    await assert.rejects(
      () => callWrite(WRITE_WHITELIST[0], PARAMS_A, { amountFen: 100, confirmToken: tokenId }),
      (err: unknown) => err instanceof WriteGuardRejected && /TokenExpired/.test((err as Error).message),
    );
    assert.strictEqual(spy.count(), 0);
  } finally {
    spy.restore();
    setWriteGuardForTesting(null);
  }
});

test("T7-3: 令牌已用过 → TokenAlreadyUsed，拒绝，fetch 未被调用（第二次起）", async () => {
  const guard = freshGuard();
  setWriteGuardForTesting(guard);
  const spy = installFetchSpy();
  try {
    const { tokenId } = guard.issueConfirmToken(PARAMS_A);
    const r1 = await callWrite(WRITE_WHITELIST[0], PARAMS_A, { amountFen: 100, confirmToken: tokenId });
    assert.strictEqual(r1.ok, true, "第一次应成功（用后即焚，消耗掉令牌）");
    assert.strictEqual(spy.count(), 1);

    await assert.rejects(
      () => callWrite(WRITE_WHITELIST[0], PARAMS_A, { amountFen: 100, confirmToken: tokenId }), // 同一令牌、同样内容重放
      (err: unknown) => err instanceof WriteGuardRejected && /TokenAlreadyUsed/.test((err as Error).message),
    );
    assert.strictEqual(spy.count(), 1, "第二次不应真的发出请求");
  } finally {
    spy.restore();
    setWriteGuardForTesting(null);
  }
});

test("T7-4: 令牌指纹不符 → TokenFingerprintMismatch，拒绝，fetch 未被调用", async () => {
  const guard = freshGuard();
  setWriteGuardForTesting(guard);
  const spy = installFetchSpy();
  try {
    const { tokenId } = guard.issueConfirmToken(PARAMS_A); // 令牌是照着 PARAMS_A 签发的
    await assert.rejects(
      () => callWrite(WRITE_WHITELIST[0], PARAMS_B, { amountFen: 100, confirmToken: tokenId }), // 却被拿去对 PARAMS_B 下单
      (err: unknown) => err instanceof WriteGuardRejected && /TokenFingerprintMismatch/.test((err as Error).message),
    );
    assert.strictEqual(spy.count(), 0);
  } finally {
    spy.restore();
    setWriteGuardForTesting(null);
  }
});

test("令牌惰性清理：过期令牌在下一次签发新令牌时被物理清除（总工验收裁决顺手项）", () => {
  // 黑盒验证思路：不直接探测 WriteGuard 内部 Map 的大小（那会破坏封装），而是利用
  // verifyToken 的判据顺序——"记录还在但已过期"返回 TokenExpired，"记录已经不存在"返回
  // TokenNotFound。如果一个过期令牌在触发清理前后，拒绝原因从 TokenExpired 变成了
  // TokenNotFound，就足以证明它的记录被物理删除了，而不只是逻辑上判定失效。
  let now = 1_000_000_000_000;
  const guard = freshGuard(() => now);

  const { tokenId: staleToken } = guard.issueConfirmToken(PARAMS_A);
  now += ORDER_GUARD.confirmTokenTtlMs + 1; // 快进超过 TTL，但还没有任何"签发新令牌"的动作触发清理

  const beforeClean = guard.verifyToken(staleToken, PARAMS_A);
  assert.strictEqual(beforeClean.ok, false);
  if (!beforeClean.ok) assert.strictEqual(beforeClean.reason, "TokenExpired", "清理前：记录还在，只是判定过期");

  guard.issueConfirmToken(PARAMS_B); // 签发新令牌——pruneExpiredTokens() 在这一步顺手跑一遍

  const afterClean = guard.verifyToken(staleToken, PARAMS_A);
  assert.strictEqual(afterClean.ok, false);
  if (!afterClean.ok) assert.strictEqual(afterClean.reason, "TokenNotFound", "清理后：记录已被物理删除，不再是「过期」而是「不存在」");
});
