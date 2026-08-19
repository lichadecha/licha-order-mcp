// T5 / T6 / T8 / T11：callWrite 的金额护栏、频次护栏、幂等去重，以及全部护栏通过后的 mock 成功路径。
//
// 金额/频次/幂等三道关都在"获取凭证、真正发出请求"之前拦截，唯独 T11（成功路径）与 T8 系列的
// 部分用例会走到 fetch 这一步——因此本文件设置假凭证环境变量，避免 loadCredentials() 去读本机
// keychain 或 ~/.config/qmai/config.yaml（单元测试不该依赖这些外部资源存在）。
//
// 红线自证：globalThis.fetch 被整体替换为可计数的 mock 函数；护栏拒绝的用例都断言 fetch 调用次数
// 没有增加，证明护栏在请求发出前就拦住了。
//
// T8 幂等键定义（总工验收裁决 M2 追加修复）：幂等键 = fingerprint({ params, tokenId })，不是单纯
// fingerprint(params)。这意味着"同一令牌重复提交"和"内容相同但令牌不同的两次独立购买"是两件
// 不该被同一把尺子量的事——前者该被拒，后者不该被拒。本文件把原来揉在一起的 T8 拆成两条：
//   - T8：同一份 (params, token) 组合的幂等命中 → 拒绝（用手动预置幂等记录的方式构造，见用例内注释）
//   - T8-补充：内容相同、令牌不同的两次独立购买 → 两次都应该放行（这是本次要修的 bug 的回归测试）

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callWrite, WriteGuardRejected } from "../src/client.js";
import { WRITE_WHITELIST, ORDER_GUARD } from "../src/constants.js";
import { customerCountKey, WriteGuard, setWriteGuardForTesting, fingerprint } from "../src/writeGuard.js";

// 假凭证：仅供本文件内会真正发出 mock fetch 的用例使用（T8 的第一次调用、T11）。
process.env.QMAI_OPEN_KEY ??= "test-open-key-0123456789abcdef0123456789ab";
process.env.QMAI_OPEN_ID ??= "test-open-id-0000000000000000";
process.env.QMAI_GRANT_CODE ??= "test-grant-code-0000000000";

function freshGuard(): { guard: WriteGuard; auditLogPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "licha-wg-guards-"));
  const auditLogPath = join(dir, "write-audit.log");
  const placedOrdersPath = join(dir, "placed-orders.json");
  return { guard: new WriteGuard({ auditLogPath, placedOrdersPath }), auditLogPath };
}

function installFetchSpy(): { count: () => number; restore: () => void } {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (..._args: Parameters<typeof fetch>) => {
    calls++;
    return new Response(
      JSON.stringify({ status: true, code: 0, message: "创建订单成功", data: { orderNo: `D-MOCK-${calls}`, payAmount: 24.0, needPay: 1 } }),
      { status: 200 },
    );
  }) as typeof fetch;
  return {
    count: () => calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const SAMPLE_PARAMS = { storeId: 503542, items: [{ goodsId: "g1", skuId: "s1", num: 1 }], orderType: 1, source: 18, userId: "u-1" };

test("T5: 金额 10001 分（>¥100）→ 拒绝，审计留记录，fetch 未被调用", async () => {
  const { guard, auditLogPath } = freshGuard();
  setWriteGuardForTesting(guard);
  const spy = installFetchSpy();
  try {
    await assert.rejects(
      () => callWrite(WRITE_WHITELIST[0], SAMPLE_PARAMS, { amountFen: 10001, confirmToken: "irrelevant-amount-blocks-first" }),
      (err: unknown) => err instanceof WriteGuardRejected && /AmountExceeded/.test((err as Error).message),
    );
    assert.strictEqual(spy.count(), 0, "fetch 不应被调用");
    const log = readFileSync(auditLogPath, "utf8");
    assert.ok(log.includes('"result":"rejected"'), "审计应留下拒绝记录");
    assert.ok(log.includes("AmountExceeded"), "审计原因应指出金额超限");
  } finally {
    spy.restore();
    setWriteGuardForTesting(null);
  }
});

test("T6: 当日第 6 单 → 拒绝，审计留记录，fetch 未被调用", async () => {
  const { guard, auditLogPath } = freshGuard();
  setWriteGuardForTesting(guard);
  // 直接把内存计数打到上限，模拟"当日已有 5 单成功"——本用例只关心频次这一道关，
  // 不需要真的把前 5 单跑一遍（"重启后计数从审计日志重建"是 T9 的职责，见 writeAuditRebuild.test.ts）。
  for (let i = 0; i < ORDER_GUARD.maxOrdersPerDay; i++) guard.incrementDailyCount();

  const spy = installFetchSpy();
  try {
    await assert.rejects(
      () => callWrite(WRITE_WHITELIST[0], SAMPLE_PARAMS, { amountFen: 100, confirmToken: "irrelevant-daily-limit-blocks-first" }),
      (err: unknown) => err instanceof WriteGuardRejected && /DailyLimitExceeded/.test((err as Error).message),
    );
    assert.strictEqual(spy.count(), 0, "fetch 不应被调用");
    const log = readFileSync(auditLogPath, "utf8");
    assert.ok(log.includes("DailyLimitExceeded"), "审计原因应指出当日额度已满");
  } finally {
    spy.restore();
    setWriteGuardForTesting(null);
  }
});

test("T8: 幂等键命中（同一份 params+token 组合的技术性重放）→ 拒绝，fetch 未被调用", async () => {
  // 幂等键现在是 fingerprint({ params, tokenId })。在自然的顺序调用流程里，"同一个令牌"的
  // 重复提交会先被令牌校验的 TokenAlreadyUsed 挡住（verifyToken 与 consumeToken 之间没有
  // await，JS 单线程语义下不可能有竞态），根本走不到幂等这一步——幂等在这里是"第二道防线"，
  // 真正要防的是"校验通过、consumeToken 与幂等记录落盘之间的窗口期被并发利用"这种更边缘的场景。
  // 用直接预置幂等记录的方式稳定构造这个窗口，而不依赖真的起并发去撞概率极低的时序。
  const { guard, auditLogPath } = freshGuard();
  setWriteGuardForTesting(guard);
  const spy = installFetchSpy();
  try {
    const token = guard.issueConfirmToken(SAMPLE_PARAMS).tokenId;
    const key = fingerprint({ params: SAMPLE_PARAMS, tokenId: token });
    guard.recordPlacedOrder(key, "D-ALREADY-PLACED-CONCURRENTLY"); // 模拟"这份组合已经被下单成功过"

    // 此时令牌本身仍然合法、未过期、未被 consumeToken 标记为 used——四项校验能全部通过，
    // 但幂等检查会独立命中，证明它不依赖令牌状态、是真正独立的第二道关卡。
    await assert.rejects(
      () => callWrite(WRITE_WHITELIST[0], SAMPLE_PARAMS, { amountFen: 2400, confirmToken: token }),
      (err: unknown) => err instanceof WriteGuardRejected && /DuplicateIdempotencyKey/.test((err as Error).message),
    );
    assert.strictEqual(spy.count(), 0, "fetch 不应被调用");
    const log = readFileSync(auditLogPath, "utf8");
    assert.ok(log.includes("DuplicateIdempotencyKey"), "审计原因应指出幂等键重复");
  } finally {
    spy.restore();
    setWriteGuardForTesting(null);
  }
});

test("T8-补充（bug 回归防护）：内容相同、令牌不同的两次独立购买 → 两次都应放行", async () => {
  // 这是总工验收裁决要修的 bug 本身：旧实现里 idempotencyKey = fingerprint(params)，
  // 会导致"顾客上午买一杯瑞香大红袍、下午想再买一模一样的一杯"被永久拒绝（内容指纹相同）。
  // 现在 idempotencyKey 绑定了 tokenId，两次独立的 prepare_order 天然签发不同令牌，
  // 即使下单内容逐字节相同，也应该被当成两次独立、都合法的购买。
  const { guard } = freshGuard();
  setWriteGuardForTesting(guard);
  const spy = installFetchSpy();
  try {
    const token1 = guard.issueConfirmToken(SAMPLE_PARAMS).tokenId;
    const r1 = await callWrite(WRITE_WHITELIST[0], SAMPLE_PARAMS, { amountFen: 2400, confirmToken: token1 });
    assert.strictEqual(r1.ok, true, "第一杯应该成功");
    assert.strictEqual(spy.count(), 1);

    // 顾客后来决定再买一杯完全一样的——重新走一遍确认流程会拿到全新令牌，内容却和上次相同。
    const token2 = guard.issueConfirmToken(SAMPLE_PARAMS).tokenId;
    assert.notStrictEqual(token1, token2, "两次签发应该是不同的令牌（前提条件自检）");
    const r2 = await callWrite(WRITE_WHITELIST[0], SAMPLE_PARAMS, { amountFen: 2400, confirmToken: token2 });
    assert.strictEqual(r2.ok, true, "第二杯（内容相同、令牌不同）也应该成功——这是两次独立购买，不是重复提交");
    assert.strictEqual(spy.count(), 2, "两次都应该真的发出请求，不应被幂等误伤");
  } finally {
    spy.restore();
    setWriteGuardForTesting(null);
  }
});

test("T11: 白名单路径 + 合法令牌 + 金额合规 → callWrite 返回 mock 结果，审计记 allowed，零真实请求", async () => {
  const { guard, auditLogPath } = freshGuard();
  setWriteGuardForTesting(guard);
  const spy = installFetchSpy();
  try {
    const { tokenId } = guard.issueConfirmToken(SAMPLE_PARAMS);
    const result = await callWrite<{ orderNo: string }>(WRITE_WHITELIST[0], SAMPLE_PARAMS, { amountFen: 2400, confirmToken: tokenId });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data?.orderNo, "D-MOCK-1");
    assert.strictEqual(spy.count(), 1, "应恰好发出一次 mock fetch（全局 fetch 已被替换，零真实网络请求）");

    const lastLine = readFileSync(auditLogPath, "utf8").trim().split("\n").pop()!;
    const entry = JSON.parse(lastLine);
    assert.strictEqual(entry.result, "allowed");
    assert.strictEqual(entry.orderNo, "D-MOCK-1");
    assert.strictEqual(entry.summary.estimatedAmountFen, 2400);
    assert.strictEqual(entry.summary.storeId, 503542);
  } finally {
    spy.restore();
    setWriteGuardForTesting(null);
  }
});

// ============================================================================
// 按顾客维度的频次护栏（2026-08-19 老板拍板：「回头想绑谁就绑谁，批量生成订单总会造成打扰」）
// ============================================================================
// 改造前：单日 ≤5 单是**全局**计数，不分人——冒用者往某人账上塞 5 单就把所有人的额度用光了，
// 反过来说也挡不住「专门针对某一个人塞满 5 单」。改造后两层：每人 5 单 + 全局 10 单。
// 这三条守的是三件不同的事，别合并。

test("PC1: 两位顾客的额度互不占用——A 用满 5 单，B 的第 1 单照样能下", async () => {
  const dir = mkdtempSync(join(tmpdir(), "licha-pc1-"));
  const guard = new WriteGuard({ auditLogPath: join(dir, "write-audit.log"), placedOrdersPath: join(dir, "placed.json") });
  setWriteGuardForTesting(guard);
  const spy = installFetchSpy();
  try {
    for (let i = 0; i < ORDER_GUARD.maxOrdersPerDayPerCustomer; i++) {
      const params = { storeId: 1, items: [{ goodsId: `a${i}`, skuId: "s", num: 1 }], orderType: 1, source: 18, userId: "1111111111111111111" };
      const { tokenId } = guard.issueConfirmToken(params);
      assert.strictEqual((await callWrite(WRITE_WHITELIST[0], params, { amountFen: 100, confirmToken: tokenId })).ok, true);
    }
    // A 再下一单 → 撞自己的额度
    const aMore = { storeId: 1, items: [{ goodsId: "a-more", skuId: "s", num: 1 }], orderType: 1, source: 18, userId: "1111111111111111111" };
    const { tokenId: tA } = guard.issueConfirmToken(aMore);
    await assert.rejects(
      () => callWrite(WRITE_WHITELIST[0], aMore, { amountFen: 100, confirmToken: tA }),
      (e: unknown) => e instanceof WriteGuardRejected && /DailyLimitExceeded:perCustomer/.test((e as Error).message),
      "A 超出自己的额度，理由要指明是 perCustomer 那一层",
    );

    // B 是另一位顾客，一单都没下过 → **必须放行**。这是整个改造的意义：
    // 改造前 A 用满 5 单就把全局额度吃光，B 会被误拒。
    const bFirst = { storeId: 1, items: [{ goodsId: "b1", skuId: "s", num: 1 }], orderType: 1, source: 18, userId: "2222222222222222222" };
    const { tokenId: tB } = guard.issueConfirmToken(bFirst);
    assert.strictEqual(
      (await callWrite(WRITE_WHITELIST[0], bFirst, { amountFen: 100, confirmToken: tB })).ok,
      true,
      "B 的额度不该被 A 占掉——改造前这里会被误拒",
    );
  } finally {
    spy.restore();
    setWriteGuardForTesting(null);
  }
});

test("PC2: 全局总闸仍然有效——各顾客都没撞自己的额度，但全局满了就拒，且理由指明 global", async () => {
  const dir = mkdtempSync(join(tmpdir(), "licha-pc2-"));
  const guard = new WriteGuard({ auditLogPath: join(dir, "write-audit.log"), placedOrdersPath: join(dir, "placed.json") });
  setWriteGuardForTesting(guard);
  const spy = installFetchSpy();
  try {
    for (let i = 0; i < ORDER_GUARD.maxOrdersPerDay; i++) {
      const params = { storeId: 1, items: [{ goodsId: `g${i}`, skuId: "s", num: 1 }], orderType: 1, source: 18, userId: `cust-${i}` };
      const { tokenId } = guard.issueConfirmToken(params);
      assert.strictEqual((await callWrite(WRITE_WHITELIST[0], params, { amountFen: 100, confirmToken: tokenId })).ok, true);
    }
    const fresh = { storeId: 1, items: [{ goodsId: "fresh", skuId: "s", num: 1 }], orderType: 1, source: 18, userId: "cust-fresh" };
    const { tokenId } = guard.issueConfirmToken(fresh);
    await assert.rejects(
      () => callWrite(WRITE_WHITELIST[0], fresh, { amountFen: 100, confirmToken: tokenId }),
      (e: unknown) => e instanceof WriteGuardRejected && /DailyLimitExceeded:global/.test((e as Error).message),
      "全新顾客自己没下过单，只可能被全局层拦住",
    );
    assert.strictEqual(spy.count(), ORDER_GUARD.maxOrdersPerDay);
  } finally {
    spy.restore();
    setWriteGuardForTesting(null);
  }
});

test("PC3: 写审计里落的是不可逆哈希、不是会员 ID——按顾客计数不能靠泄露身份换来", async () => {
  const dir = mkdtempSync(join(tmpdir(), "licha-pc3-"));
  const auditLogPath = join(dir, "write-audit.log");
  const guard = new WriteGuard({ auditLogPath, placedOrdersPath: join(dir, "placed.json") });
  setWriteGuardForTesting(guard);
  const spy = installFetchSpy();
  const REAL_LOOKING_ID = "1288634197238501377"; // 19 位，真实会员 ID 的形态
  try {
    const params = { storeId: 1, items: [{ goodsId: "x", skuId: "s", num: 1 }], orderType: 1, source: 18, userId: REAL_LOOKING_ID };
    const { tokenId } = guard.issueConfirmToken(params);
    assert.strictEqual((await callWrite(WRITE_WHITELIST[0], params, { amountFen: 100, confirmToken: tokenId })).ok, true);

    const log = readFileSync(auditLogPath, "utf8");
    assert.ok(!log.includes(REAL_LOOKING_ID), "审计日志不许出现完整会员 ID");
    // 落的是 16 位 hex 哈希：既能区分顾客（尾四位会碰撞，哈希不会），又不可逆。
    const line = JSON.parse(log.trim().split("\n").pop() as string);
    assert.match(String(line.customerKey), /^[0-9a-f]{16}$/, "customerKey 应是 16 位 hex");
    assert.strictEqual(line.customerKey, customerCountKey(REAL_LOOKING_ID), "应与 customerCountKey 算出的一致");

    // 反向确认判据本身有分辨力：不同 ID 必须算出不同键，否则两位顾客会共用额度。
    assert.notStrictEqual(customerCountKey("1111111111111111111"), customerCountKey("2222222222222222222"));
    // 0 与空值不构成有效顾客身份（同 bindMemberTool.isAbsentCustomerId 的口径）
    assert.strictEqual(customerCountKey(0), undefined);
    assert.strictEqual(customerCountKey("0"), undefined);
    assert.strictEqual(customerCountKey(null), undefined);
  } finally {
    spy.restore();
    setWriteGuardForTesting(null);
  }
});
