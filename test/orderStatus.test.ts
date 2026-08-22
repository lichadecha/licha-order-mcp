// U2, U8-U10：get_order_status 的未绑定拒绝、所有权校验通过/不通过、userId 缺失 fail closed。
// 附带 assertOrderOwnership 纯函数的三条独立断言（导出给 M4 复用，这里先把判据钉死）。
//
// 红线自证：globalThis.fetch 被整体替换为可计数、可指定响应体的 mock 函数；未绑定用例断言
// fetch 调用次数为 0（未绑定时在 callRead 之前就直接拒绝）。会话态与 access-audit 均注入独立
// 临时实例，不污染生产 logs/ 目录。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertOrderOwnership, getOrderStatusHandler } from "../src/orderStatusTool.js";
import { setReadAuditLogPathForTesting } from "../src/client.js";
import { SessionStore, setSessionStoreForTesting, DEFAULT_SESSION_KEY, type SessionBinding } from "../src/session.js";
import { AccessAuditLogger, setAccessAuditLoggerForTesting } from "../src/accessAudit.js";

process.env.QMAI_OPEN_KEY ??= "test-open-key-0123456789abcdef0123456789ab";
process.env.QMAI_OPEN_ID ??= "test-open-id-0000000000000000";
process.env.QMAI_GRANT_CODE ??= "test-grant-code-0000000000";

// getOrderStatusHandler 会真正调用 callRead（走 6.1.5 只读白名单）。同 bindMember.test.ts 的
// 理由：client.ts 的一期读侧审计（audit()，硬编码 logs/audit.log）没有随 WriteGuard/
// AccessAuditLogger 一起被注入过测试路径，这里在模块顶层统一注入一次，避免污染生产 logs/。
setReadAuditLogPathForTesting(join(mkdtempSync(join(tmpdir(), "licha-read-audit-orderstatus-")), "audit.log"));

function freshAuditLogger(): { logger: AccessAuditLogger; logPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "licha-access-audit-orderstatus-"));
  const logPath = join(dir, "access-audit.log");
  return { logger: new AccessAuditLogger({ logPath }), logPath };
}

function installFetchSpy(responseBody: string): { count: () => number; restore: () => void } {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (..._args: Parameters<typeof fetch>) => {
    calls++;
    return new Response(responseBody, { status: 200 });
  }) as typeof fetch;
  return {
    count: () => calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const BOUND_CUSTOMER_ID = "1234567890123456789";
const OTHER_CUSTOMER_ID = "9999999999999999999";

// ---------- assertOrderOwnership 纯函数 ----------

test("assertOrderOwnership: userId 缺失 → fail closed（missing_userId）", () => {
  const binding: SessionBinding = { customerId: BOUND_CUSTOMER_ID, boundAt: 0, boundVia: "phone" };
  const result = assertOrderOwnership({ status: 10 }, binding);
  assert.strictEqual(result.ok, false);
  if (!result.ok) assert.strictEqual(result.reason, "missing_userId");
});

test("assertOrderOwnership: userId 与绑定 customerId 不一致 → mismatch", () => {
  const binding: SessionBinding = { customerId: BOUND_CUSTOMER_ID, boundAt: 0, boundVia: "phone" };
  const result = assertOrderOwnership({ status: 10, userId: OTHER_CUSTOMER_ID }, binding);
  assert.strictEqual(result.ok, false);
  if (!result.ok) assert.strictEqual(result.reason, "mismatch");
});

test("assertOrderOwnership: userId 与绑定 customerId 一致 → 通过", () => {
  const binding: SessionBinding = { customerId: BOUND_CUSTOMER_ID, boundAt: 0, boundVia: "phone" };
  const result = assertOrderOwnership({ status: 10, userId: BOUND_CUSTOMER_ID }, binding);
  assert.strictEqual(result.ok, true);
});

// ---------- U2：未绑定调用 ----------

test("U2: 未绑定调用 get_order_status → 被拒，fetch 未被调用", async () => {
  setSessionStoreForTesting(new SessionStore());
  const { logger, logPath } = freshAuditLogger();
  setAccessAuditLoggerForTesting(logger);
  const spy = installFetchSpy('{"status":true,"code":0,"data":{}}');
  try {
    const result = await getOrderStatusHandler({ orderNo: "D0000001" });
    assert.strictEqual(result.isError, true);
    assert.ok(/尚未绑定会员身份/.test(result.content[0].text));
    assert.ok(/bind_member/.test(result.content[0].text));
    assert.strictEqual(spy.count(), 0, "fetch 不应被调用");
    const log = readFileSync(logPath, "utf8");
    assert.ok(log.includes('"event":"unbound_call_rejected"'));
    assert.ok(log.includes('"tool":"get_order_status"'));
  } finally {
    spy.restore();
    setSessionStoreForTesting(null);
    setAccessAuditLoggerForTesting(null);
  }
});

// ---------- U8：查自己的订单 ----------

test("U8: 绑定后查自己的订单 → 返回 status=10/待支付，不含 userId", async () => {
  const sessionStore = new SessionStore();
  sessionStore.bind(DEFAULT_SESSION_KEY, { customerId: BOUND_CUSTOMER_ID, boundAt: Date.now(), boundVia: "phone" });
  setSessionStoreForTesting(sessionStore);
  const { logger } = freshAuditLogger();
  setAccessAuditLoggerForTesting(logger);
  // userId 是 19 位大数，响应体用原始字符串保留"未加引号大数"形态，理由同 bindMember.test.ts。
  const spy = installFetchSpy(`{"status":true,"code":0,"data":{"status":10,"userId":${BOUND_CUSTOMER_ID}}}`);
  try {
    const result = await getOrderStatusHandler({ orderNo: "D0000123" });
    assert.strictEqual(result.isError, undefined, "应成功");
    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.orderNo, "D0000123");
    assert.strictEqual(parsed.status, 10);
    assert.strictEqual(parsed.statusText, "待支付");
    assert.ok(!("userId" in parsed), "出参不应包含 userId，连自己的也不返回");
    assert.strictEqual(spy.count(), 1);
  } finally {
    spy.restore();
    setSessionStoreForTesting(null);
    setAccessAuditLoggerForTesting(null);
  }
});

// ---------- U9：查别人的订单 ----------

test("U9: 绑定后查别人的订单 → 被拒，返回文本不含订单任何字段，access-audit 有 ownership_mismatch", async () => {
  const sessionStore = new SessionStore();
  sessionStore.bind(DEFAULT_SESSION_KEY, { customerId: BOUND_CUSTOMER_ID, boundAt: Date.now(), boundVia: "phone" });
  setSessionStoreForTesting(sessionStore);
  const { logger, logPath } = freshAuditLogger();
  setAccessAuditLoggerForTesting(logger);
  const spy = installFetchSpy(`{"status":true,"code":0,"data":{"status":10,"userId":${OTHER_CUSTOMER_ID}}}`);
  try {
    const result = await getOrderStatusHandler({ orderNo: "D0000999" });
    assert.strictEqual(result.isError, true);
    const text = result.content[0].text;
    assert.ok(/无法查询：该订单不属于当前绑定的会员/.test(text));
    assert.ok(!/10/.test(text), "返回文本不应含订单状态");
    assert.ok(!text.includes(OTHER_CUSTOMER_ID), "返回文本不应含对方 userId");
    assert.ok(!text.includes("D0000999"), "返回文本不应含订单号");
    assert.strictEqual(spy.count(), 1, "callRead 仍会真的发出一次请求，只是拿到结果后在服务端内部被拒绝");

    const log = readFileSync(logPath, "utf8");
    assert.ok(log.includes('"event":"ownership_mismatch"'));
    assert.ok(log.includes("mismatch"));
    assert.ok(!log.includes(OTHER_CUSTOMER_ID), "审计日志不应出现对方完整 userId");
  } finally {
    spy.restore();
    setSessionStoreForTesting(null);
    setAccessAuditLoggerForTesting(null);
  }
});

// ---------- U10：响应无 userId 字段 ----------

test("U10: 6.1.5 响应无 userId 字段 → fail closed 被拒", async () => {
  const sessionStore = new SessionStore();
  sessionStore.bind(DEFAULT_SESSION_KEY, { customerId: BOUND_CUSTOMER_ID, boundAt: Date.now(), boundVia: "phone" });
  setSessionStoreForTesting(sessionStore);
  const { logger, logPath } = freshAuditLogger();
  setAccessAuditLoggerForTesting(logger);
  const spy = installFetchSpy('{"status":true,"code":0,"data":{"status":20}}'); // 没有 userId 字段
  try {
    const result = await getOrderStatusHandler({ orderNo: "D0000555" });
    assert.strictEqual(result.isError, true);
    assert.ok(/无法查询：该订单不属于当前绑定的会员/.test(result.content[0].text));
    assert.strictEqual(spy.count(), 1);
    const log = readFileSync(logPath, "utf8");
    assert.ok(log.includes('"event":"ownership_mismatch"'));
    assert.ok(log.includes("missing_userId"));
  } finally {
    spy.restore();
    setSessionStoreForTesting(null);
    setAccessAuditLoggerForTesting(null);
  }
});
