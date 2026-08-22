// U1, U11：place_order 接入会话态之后的行为——未绑定直接拒绝，绑定后全链路把 customerId
// 注入到发往企迈的最终请求参数里（"userId 只能由会话态注入"这条 M3 架构硬规矩的物理验证）。
//
// 红线自证：globalThis.fetch 被整体替换为可计数、可捕获请求体的 mock 函数；U1 断言 fetch
// 调用次数为 0（未绑定时在 callWrite 之前就直接拒绝）；U11 虽然会真的走到 mock fetch，但
// mock 本身不发出任何真实网络请求。会话态/写护栏/access-audit 均注入独立临时实例。

import { test } from "node:test";
import assert from "node:assert/strict";
import { setReadAuditLogPathForTesting } from "../src/client.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { placeOrderConfirmedHandler } from "../src/placeOrderTool.js";
import { PendingOrderStore, setPendingOrderStoreForTesting } from "../src/pendingOrders.js";
import { WriteGuard, setWriteGuardForTesting } from "../src/writeGuard.js";
import { SessionStore, setSessionStoreForTesting, DEFAULT_SESSION_KEY } from "../src/session.js";
import { AccessAuditLogger, setAccessAuditLoggerForTesting } from "../src/accessAudit.js";

// 2026-08-19 T5-1 迁移的连带修复：定稿 handler 比旧 handler 多一条 callRead 路径
// （第 ⑧ 步强制 6.1.9 读回）。旧 handler 不读回，所以本文件原先不需要注入只读审计路径；
// 一改成定稿 handler，那条路径就活了——不注入就会往**生产** logs/audit.log 追加行，
// 而「测试不许碰生产 logs/」是明确红线（本轮真的被 m4ConfirmOrder 的红线自证抓到了一次）。
setReadAuditLogPathForTesting(join(mkdtempSync(join(tmpdir(), "licha-read-audit-")), "audit.log"));

process.env.QMAI_OPEN_KEY ??= "test-open-key-0123456789abcdef0123456789ab";
process.env.QMAI_OPEN_ID ??= "test-open-id-0000000000000000";
process.env.QMAI_GRANT_CODE ??= "test-grant-code-0000000000";

function freshWriteGuard(): { guard: WriteGuard; auditLogPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "licha-wg-placeorder-session-"));
  const auditLogPath = join(dir, "write-audit.log");
  const placedOrdersPath = join(dir, "placed-orders.json");
  return { guard: new WriteGuard({ auditLogPath, placedOrdersPath }), auditLogPath };
}

function freshAccessAuditLogger(): { logger: AccessAuditLogger; logPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "licha-access-audit-placeorder-"));
  const logPath = join(dir, "access-audit.log");
  return { logger: new AccessAuditLogger({ logPath }), logPath };
}

function installFetchSpyNoCall(): { count: () => number; restore: () => void } {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (..._args: Parameters<typeof fetch>) => {
    calls++;
    return new Response('{"status":true,"code":0,"data":{"orderNo":"D-SHOULD-NOT-HAPPEN"}}', { status: 200 });
  }) as typeof fetch;
  return {
    count: () => calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function installFetchSpyCapture(responseBody: string): {
  calls: () => Array<{ url: string; body: string }>;
  restore: () => void;
} {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; body: string }> = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), body: String(init?.body ?? "") });
    return new Response(responseBody, { status: 200 });
  }) as typeof fetch;
  return {
    calls: () => calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const BOUND_CUSTOMER_ID = "1234567890123456789";

test("U1: 未绑定调用 place_order → 被拒，fetch 未被调用，access-audit 落盘 unbound_call_rejected", async () => {
  const { guard } = freshWriteGuard();
  setWriteGuardForTesting(guard);
  setSessionStoreForTesting(new SessionStore());
  const { logger, logPath } = freshAccessAuditLogger();
  setAccessAuditLoggerForTesting(logger);
  const spy = installFetchSpyNoCall();
  try {
    // 2026-08-19 T5-1 迁移：改调定稿 handler。未绑定拦在第 ② 步、早于令牌查询，
    // 所以令牌传什么都不影响——这正是本用例要证明的「身份缺失优先于一切」。
    const result = await placeOrderConfirmedHandler({
      confirmToken: "irrelevant-because-unbound-blocks-first",
      confirmAmountYuan: 24.0,
    });
    assert.strictEqual(result.isError, true);
    assert.ok(/尚未绑定会员身份/.test(result.content[0].text));
    assert.ok(/bind_member/.test(result.content[0].text));
    assert.ok(/后再下单/.test(result.content[0].text));
    assert.strictEqual(spy.count(), 0, "fetch 不应被调用");

    const log = readFileSync(logPath, "utf8");
    assert.ok(log.includes('"event":"unbound_call_rejected"'));
    assert.ok(log.includes('"tool":"place_order"'));
  } finally {
    spy.restore();
    setWriteGuardForTesting(null);
    setSessionStoreForTesting(null);
    setAccessAuditLoggerForTesting(null);
    setPendingOrderStoreForTesting(null);
  }
});

test("U11: 绑定后 place_order 全链路注入验证——发往企迈的请求体里 params.userId 等于绑定的 customerId，写审计记 allowed", async () => {
  const { guard, auditLogPath } = freshWriteGuard();
  setWriteGuardForTesting(guard);
  const sessionStore = new SessionStore();
  sessionStore.bind(DEFAULT_SESSION_KEY, { customerId: BOUND_CUSTOMER_ID, boundAt: Date.now(), boundVia: "phone" });
  setSessionStoreForTesting(sessionStore);
  const { logger } = freshAccessAuditLogger();
  setAccessAuditLoggerForTesting(logger);

  // 令牌必须对"预期的 finalParams（含注入的 userId）"签发——这正是 placeOrderTool.ts 里
  // 给 M4 留的提醒：确认令牌的指纹要对注入 userId 后的最终 params 计算，两侧才能对得上。
  const orderParams = {
    storeId: 503542,
    items: [{ goodsId: "g1", skuId: "s1", num: 1 }],
    orderType: 1,
    source: 18,
  };
  const expectedFinalParams = { ...orderParams, userId: BOUND_CUSTOMER_ID };
  const { tokenId } = guard.issueConfirmToken(expectedFinalParams);
  // 2026-08-19 T5-1 迁移：定稿 handler 从待确认单登记表取 finalParams（不再由调用方透传），
  // 所以这里要把同一份 finalParams 登记进去——「令牌 ↔ 登记单」这层绑定正是 M4 收窄入参的核心。
  const pendingStore = new PendingOrderStore();
  setPendingOrderStoreForTesting(pendingStore);
  pendingStore.register(tokenId, { finalParams: expectedFinalParams, estimatedAmountFen: 2400 });

  const spy = installFetchSpyCapture(
    '{"status":true,"code":0,"message":"创建订单成功","data":{"orderNo":"D-MOCK-U11","payAmount":24.0,"needPay":1}}',
  );
  try {
    const result = await placeOrderConfirmedHandler({ confirmToken: tokenId, confirmAmountYuan: 24.0 });
    assert.strictEqual(result.isError, undefined, `应成功：${result.content[0]?.text}`);

    const calls = spy.calls();
    // 定稿 handler 成功后会**强制 6.1.9 读回**（施工令 §8 第 16 条：查已取消订单返回空 data，
    // 读回必须在订单活着时立刻做）。所以这里是 2 次：第 1 次写下单、第 2 次读回。
    // 旧 handler 不读回、原断言是 1 次——这处从 1 改成 2 不是放宽，是新链路多了一步必要动作。
    assert.strictEqual(calls.length, 2, "应恰好两次 mock fetch：写下单 + 强制读回（零真实网络请求）");
    const sentBody = calls[0].body;
    // userId 是 19 位大数：client.ts 的 restoreIdsForSend 会把它从请求体 JSON 文本里的
    // 引号字符串还原成不带引号的数字形式（v6 实测服务端要求数字形式），所以在原始请求体文本里
    // 断言，不经过 JSON.parse（JSON.parse 会把 19 位大数解析成精度不足的 JS number，反而不可靠）。
    assert.ok(
      sentBody.includes(`"userId":${BOUND_CUSTOMER_ID}`),
      `请求体里应包含注入的 userId（原样大数形式），实得请求体：${sentBody}`,
    );
    // orderParams 本身没有 userId，防止误判成"巧合传对了"：确认原始 orderParams 序列化后确实不含它。
    assert.ok(!JSON.stringify(orderParams).includes("userId"));

    const auditLog = readFileSync(auditLogPath, "utf8");
    const lastLine = auditLog.trim().split("\n").pop()!;
    const entry = JSON.parse(lastLine);
    assert.strictEqual(entry.result, "allowed");
    assert.strictEqual(entry.orderNo, "D-MOCK-U11");
  } finally {
    spy.restore();
    setWriteGuardForTesting(null);
    setSessionStoreForTesting(null);
    setAccessAuditLoggerForTesting(null);
    setPendingOrderStoreForTesting(null);
  }
});
