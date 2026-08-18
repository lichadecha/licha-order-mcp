// M5 前置修复第 1 项：「已发出 ≠ 已成功」护栏（施工令 § 3.1 第 5 条补充、§ 8 第 23 条）。
//
// 要挡住的现实场景：写请求真实发出去了，但网络断了 / 企迈网关回 500 / 进程被杀在半途——
// 本地不知道结果，而企迈侧可能已经建了一张真实订单。改造前这些情形一律记 rejected、不占当日
// 额度，于是「单日 ≤5 单」在异常场景下退化成「单日 ≤5 次**成功**」，而且模型重走一次流程就能
// 拿到新令牌把同一杯奶茶再下一遍（企迈侧无幂等字段兜底，§ 8 第 4 条）。
//
// 🚨 红线自证：globalThis.fetch 全程被 mock 替换，绝不发出任何真实 HTTP 请求；写路径的调用
// 次数单独计数并断言。全部识别值用假值（customerId 1234567890123456789）。
// 审计/幂等文件一律落在 mkdtemp 临时目录，测试不碰生产 logs/。

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callWrite, setReadAuditLogPathForTesting } from "../src/client.js";
import { WRITE_WHITELIST } from "../src/constants.js";
import { WriteGuard, setWriteGuardForTesting, beijingDateKey } from "../src/writeGuard.js";
import { SessionStore, setSessionStoreForTesting, DEFAULT_SESSION_KEY } from "../src/session.js";
import { AccessAuditLogger, setAccessAuditLoggerForTesting } from "../src/accessAudit.js";
import { PendingOrderStore, setPendingOrderStoreForTesting } from "../src/pendingOrders.js";
import { placeOrderConfirmedHandler } from "../src/placeOrderTool.js";
import { myOrdersHandler } from "../src/myOrdersTool.js";

process.env.QMAI_OPEN_KEY ??= "test-open-key-0123456789abcdef0123456789ab";
process.env.QMAI_OPEN_ID ??= "test-open-id-0000000000000000";
process.env.QMAI_GRANT_CODE ??= "test-grant-code-0000000000";

const FAKE_CUSTOMER_ID = "1234567890123456789"; // 19 位假会员 ID
const PATH_CREATE = WRITE_WHITELIST[0];
const PATH_ORDER_LIST = "v3/order/userAppointTimeOrderList";
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
  auditLogPath: string;
  dir: string;
  restore: () => void;
}

function installFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "licha-unresolved-"));
  const auditLogPath = join(dir, "write-audit.log");
  const guard = new WriteGuard({ auditLogPath, placedOrdersPath: join(dir, "placed-orders.json") });
  setWriteGuardForTesting(guard);
  setReadAuditLogPathForTesting(join(dir, "read-audit.log"));
  return {
    guard,
    auditLogPath,
    dir,
    restore: () => {
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
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function textOf(r: { content: Array<{ type: "text"; text: string }> }): string {
  return r.content.map((c) => c.text).join("\n");
}

// ============================================================================
// U1：inflight 记录在 fetch **之前**落盘
// ============================================================================
// 验证手法是这条用例的关键：断言写在 mock fetch **函数体内部**——被调用的那一刻去读审计
// 文件。读得到 inflight 行，就证明它是在请求发出之前落的盘。事后再读日志只能证明"有这一行"，
// 证明不了"在 fetch 之前"，而这条护栏的全部价值恰恰在这个先后顺序上。
test("U1: inflight 审计记录在真正 fetch 之前就已落盘（在 mock fetch 内部读文件断言）", async () => {
  const fx = installFixture();
  let sawInflightBeforeFetch = false;
  let inflightEntryAtFetchTime: Record<string, any> | undefined;
  globalThis.fetch = (async () => {
    const lines = auditLines(fx.auditLogPath);
    inflightEntryAtFetchTime = lines.find((l) => l.result === "inflight");
    sawInflightBeforeFetch = Boolean(inflightEntryAtFetchTime);
    return new Response(JSON.stringify({ status: true, code: 0, data: { orderNo: "D-MOCK-U1" } }), { status: 200 });
  }) as typeof fetch;

  try {
    const { tokenId } = fx.guard.issueConfirmToken(SAMPLE_PARAMS);
    await callWrite(PATH_CREATE, SAMPLE_PARAMS, { amountFen: 2400, confirmToken: tokenId });

    assert.ok(sawInflightBeforeFetch, "fetch 被调用时，审计文件里必须已经有 inflight 记录");
    assert.equal(inflightEntryAtFetchTime!.path, PATH_CREATE);
    assert.ok(inflightEntryAtFetchTime!.tokenId, "inflight 记录必须带 tokenId");
    assert.ok(inflightEntryAtFetchTime!.idempotencyKey, "inflight 记录必须带 idempotencyKey");
    assert.ok(inflightEntryAtFetchTime!.summary, "inflight 记录必须带参数摘要");
    assert.equal(inflightEntryAtFetchTime!.summary.estimatedAmountFen, 2400);
  } finally {
    fx.restore();
  }
});

// ============================================================================
// U2：HTTP 5xx → 终态记 unknown（不是 rejected），且占用当日额度
// ============================================================================
test("U2: HTTP 500 → 记 unknown（不再记 rejected）且占当日额度，提示引导先查订单不要重下", async () => {
  const fx = installFixture();
  globalThis.fetch = (async () => new Response("upstream error", { status: 500 })) as typeof fetch;
  try {
    const { tokenId } = fx.guard.issueConfirmToken(SAMPLE_PARAMS);
    const res = await callWrite(PATH_CREATE, SAMPLE_PARAMS, { amountFen: 2400, confirmToken: tokenId });

    assert.equal(res.ok, false);
    assert.match(res.error!.hint, /先去小程序查订单状态，不要立即重复下单/);

    const lines = auditLines(fx.auditLogPath);
    assert.equal(lines.filter((l) => l.result === "inflight").length, 1);
    const terminal = lines.filter((l) => l.result !== "inflight");
    assert.equal(terminal.length, 1, "应恰好有一条终态记录");
    assert.equal(terminal[0].result, "unknown", "5xx 的终态必须是 unknown，不能是 rejected");
    assert.equal(terminal[0].reason, "HTTP500");

    assert.equal(fx.guard.currentDailyCount(), 1, "结果未知照样占当日额度（代价发生在发出那一刻）");
    assert.equal(fx.guard.hasUnresolvedWrite(), true, "5xx 之后必须拉起未决闸门");
    assert.equal(fx.guard.describeUnresolvedWrites().unknown, 1);
  } finally {
    fx.restore();
  }
});

// ============================================================================
// U3：网络异常（TransportError）→ 终态记 unknown，且占用当日额度
// ============================================================================
test("U3: fetch 抛网络异常 → 记 unknown（不再记 rejected）且占当日额度", async () => {
  const fx = installFixture();
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed: ECONNRESET");
  }) as typeof fetch;
  try {
    const { tokenId } = fx.guard.issueConfirmToken(SAMPLE_PARAMS);
    const res = await callWrite(PATH_CREATE, SAMPLE_PARAMS, { amountFen: 2400, confirmToken: tokenId });

    assert.equal(res.ok, false);
    assert.match(res.error!.hint, /先去小程序查订单状态，不要立即重复下单/);

    const lines = auditLines(fx.auditLogPath);
    const terminal = lines.filter((l) => l.result !== "inflight");
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].result, "unknown", "网络异常的终态必须是 unknown");
    assert.equal(terminal[0].reason, "TransportError");

    assert.equal(fx.guard.currentDailyCount(), 1, "网络异常照样占当日额度");
    assert.equal(fx.guard.hasUnresolvedWrite(), true);
  } finally {
    fx.restore();
  }
});

// ============================================================================
// U4：重启后重建——unknown 与「未决 inflight」都仍然占额度、仍然拉着闸门
// ============================================================================
// 「未决 inflight」在真实世界里是"进程在请求途中被杀"。测试里杀不了自己，所以直接按那一刻
// 磁盘上应有的样子构造日志（本用例验证的正是"从日志重建"这条路径的口径）。
test("U4: 进程重启后从审计日志重建——unknown 与未决 inflight 都仍占额度、仍拉着未决闸门", async () => {
  const fx = installFixture();
  try {
    const today = beijingDateKey();

    // 第一次进程：跑出一条 unknown（5xx）
    globalThis.fetch = (async () => new Response("boom", { status: 503 })) as typeof fetch;
    const { tokenId } = fx.guard.issueConfirmToken(SAMPLE_PARAMS);
    await callWrite(PATH_CREATE, SAMPLE_PARAMS, { amountFen: 2400, confirmToken: tokenId });

    // 再手工补一条「只有 inflight、没有任何终态」的记录：模拟进程在请求途中被 kill -9
    appendFileSync(
      fx.auditLogPath,
      `${JSON.stringify({
        time: `${today} 12:00:00 +08:00`,
        dateKey: today,
        path: PATH_CREATE,
        result: "inflight",
        reason: "RequestAboutToBeSent",
        tokenId: "killed-mid-flight-token",
        idempotencyKey: "killed-mid-flight-key",
        durationMs: 0,
      })}\n`,
    );

    // 第二次进程：新建 WriteGuard 指向同一份日志（构造函数会重建）
    const rebuilt = new WriteGuard({
      auditLogPath: fx.auditLogPath,
      placedOrdersPath: join(fx.dir, "placed-orders.json"),
    });

    assert.equal(rebuilt.currentDailyCount(), 2, "重启后：unknown 1 笔 + 未决 inflight 1 笔 = 占额 2");
    assert.equal(rebuilt.hasUnresolvedWrite(), true, "重启绕不过未决闸门");
    const desc = rebuilt.describeUnresolvedWrites();
    assert.equal(desc.unknown, 1);
    assert.equal(desc.inflight, 1);
    assert.equal(desc.total, 2);
  } finally {
    fx.restore();
  }
});

// ============================================================================
// U5：存在未决写请求时，新下单被拒且写路径 fetch 0 次
// ============================================================================
test("U5: 存在未决写请求 → place_order 被拒，写路径一次都没被调用，审计记 UnresolvedWriteExists", async () => {
  const fx = installFixture();
  const pendingStore = new PendingOrderStore();
  setPendingOrderStoreForTesting(pendingStore);
  const sessions = new SessionStore();
  sessions.bind(DEFAULT_SESSION_KEY, { customerId: FAKE_CUSTOMER_ID, boundAt: Date.now(), boundVia: "phone" });
  setSessionStoreForTesting(sessions);
  setAccessAuditLoggerForTesting(new AccessAuditLogger({ logPath: join(fx.dir, "access-audit.log") }));

  let createCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes(PATH_CREATE)) createCalls++;
    return new Response(JSON.stringify({ status: true, code: 0, data: { orderNo: "D-MOCK-U5" } }), { status: 200 });
  }) as typeof fetch;

  try {
    // 先制造一笔「结果未知」：第一次下单撞上 5xx
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes(PATH_CREATE)) createCalls++;
      return new Response("boom", { status: 502 });
    }) as typeof fetch;
    const first = fx.guard.issueConfirmToken(SAMPLE_PARAMS);
    await callWrite(PATH_CREATE, SAMPLE_PARAMS, { amountFen: 2400, confirmToken: first.tokenId });
    assert.equal(createCalls, 1, "第一单确实发出去过一次");
    assert.equal(fx.guard.hasUnresolvedWrite(), true);

    // 现在模型「重走一次流程」：新令牌、新待确认单——这正是审计发现的重复下单路径
    const second = fx.guard.issueConfirmToken(SAMPLE_PARAMS);
    pendingStore.register(second.tokenId, { finalParams: SAMPLE_PARAMS, estimatedAmountFen: 2400 });
    const r = await placeOrderConfirmedHandler({ confirmToken: second.tokenId, confirmAmountYuan: 24 });

    assert.equal(r.isError, true, "存在未决写请求时必须拒绝新下单");
    assert.match(textOf(r), /结果还没有核对清楚/);
    assert.match(textOf(r), /my_orders/);
    assert.equal(createCalls, 1, "第二单的写路径一次都不能被调用（仍是第一单那 1 次）");

    const rejects = auditLines(fx.auditLogPath).filter((l) => String(l.reason ?? "").startsWith("UnresolvedWriteExists"));
    assert.equal(rejects.length, 1, "审计必须留下 UnresolvedWriteExists 拒绝记录");
    assert.equal(rejects[0].result, "rejected");
  } finally {
    fx.restore();
  }
});

// ============================================================================
// U6：正常成功链路 —— inflight + allowed 两条记录，当日计数只加 1
// ============================================================================
test("U6: 成功下单 → 审计恰好 inflight + allowed 两条，当日额度只加 1（不是 2）", async () => {
  const fx = installFixture();
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ status: true, code: 0, data: { orderNo: "D-MOCK-U6", payAmount: 24.0 } }), {
      status: 200,
    })) as typeof fetch;
  try {
    const { tokenId } = fx.guard.issueConfirmToken(SAMPLE_PARAMS);
    const res = await callWrite(PATH_CREATE, SAMPLE_PARAMS, { amountFen: 2400, confirmToken: tokenId });
    assert.equal(res.ok, true);

    const lines = auditLines(fx.auditLogPath);
    assert.equal(lines.length, 2, "成功链路恰好两条记录");
    assert.equal(lines[0].result, "inflight");
    assert.equal(lines[1].result, "allowed");
    assert.equal(lines[0].idempotencyKey, lines[1].idempotencyKey, "两条记录同属一个幂等键");
    assert.equal(lines[1].orderNo, "D-MOCK-U6");

    assert.equal(fx.guard.currentDailyCount(), 1, "一单成功只占 1 个额度（inflight 已被 allowed 销账）");
    assert.equal(fx.guard.hasUnresolvedWrite(), false, "成功链路不留未决状态");

    // 重启重建后口径必须一致（同一份日志，同一个状态机）
    const rebuilt = new WriteGuard({
      auditLogPath: fx.auditLogPath,
      placedOrdersPath: join(fx.dir, "placed-orders.json"),
    });
    assert.equal(rebuilt.currentDailyCount(), 1, "重建后仍然只占 1 个额度");
    assert.equal(rebuilt.hasUnresolvedWrite(), false);
  } finally {
    fx.restore();
  }
});

// ============================================================================
// U7：真实读回（my_orders）解除闸门，写 resolved 记录，但已占额度不退还
// ============================================================================
test("U7: my_orders 真实读回后闸门解除并写 resolved 记录；已占用的额度不退还", async () => {
  const fx = installFixture();
  const sessions = new SessionStore();
  sessions.bind(DEFAULT_SESSION_KEY, { customerId: FAKE_CUSTOMER_ID, boundAt: Date.now(), boundVia: "phone" });
  setSessionStoreForTesting(sessions);
  setAccessAuditLoggerForTesting(new AccessAuditLogger({ logPath: join(fx.dir, "access-audit.log") }));

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes(PATH_ORDER_LIST)) {
      return new Response(
        JSON.stringify({
          status: true,
          code: 0,
          data: { total: 1, data: [{ orderNo: "D-MOCK-U7", status: 10, actualAmount: 2400, userId: FAKE_CUSTOMER_ID }] },
        }),
        { status: 200 },
      );
    }
    return new Response("boom", { status: 500 });
  }) as typeof fetch;

  try {
    const { tokenId } = fx.guard.issueConfirmToken(SAMPLE_PARAMS);
    await callWrite(PATH_CREATE, SAMPLE_PARAMS, { amountFen: 2400, confirmToken: tokenId });
    assert.equal(fx.guard.hasUnresolvedWrite(), true);
    assert.equal(fx.guard.currentDailyCount(), 1);

    const r = await myOrdersHandler({ days: 1 });
    const body = JSON.parse(textOf(r));
    assert.equal(body.resolvedPendingWrites, 1, "读回后应报告解除了 1 笔未决");
    assert.match(body.pendingWriteNote, /已解除闸门/);

    assert.equal(fx.guard.hasUnresolvedWrite(), false, "真实读回之后闸门解除");
    assert.equal(fx.guard.currentDailyCount(), 1, "额度不退还——请求确实发出过（也堵死靠触发异常刷额度的路）");

    const resolved = auditLines(fx.auditLogPath).filter((l) => l.result === "resolved");
    assert.equal(resolved.length, 1, "解除动作必须留审计");
    assert.match(resolved[0].reason, /^ResolvedBy:my_orders:checkedOrders=1$/);
    assert.equal(resolved[0].resolvedKeys.length, 1);

    // 重启重建：resolved 记录必须让未决状态不再复活，且额度仍然记着
    const rebuilt = new WriteGuard({
      auditLogPath: fx.auditLogPath,
      placedOrdersPath: join(fx.dir, "placed-orders.json"),
    });
    assert.equal(rebuilt.hasUnresolvedWrite(), false, "重建后未决状态不复活");
    assert.equal(rebuilt.currentDailyCount(), 1, "重建后额度仍然记着那一笔");
  } finally {
    fx.restore();
  }
});

// ============================================================================
// U8：企迈明确回话说这单没成（ApiRejected）→ 仍记 rejected，不占额度、不拉闸门
// ============================================================================
// 这条是前面几条的边界对照：改造只把「不知道」从 rejected 里摘出来，不该把「明确没成」也
// 一起算成占额度——否则库存不足之类的正常业务拒绝会白白吃掉顾客的当日额度。
test("U8: 企迈明确拒单（status=false）→ 终态仍是 rejected，不占额度、不拉未决闸门", async () => {
  const fx = installFixture();
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ status: false, code: 30005, message: "商品已售罄" }), { status: 200 })) as typeof fetch;
  try {
    const { tokenId } = fx.guard.issueConfirmToken(SAMPLE_PARAMS);
    const res = await callWrite(PATH_CREATE, SAMPLE_PARAMS, { amountFen: 2400, confirmToken: tokenId });
    assert.equal(res.ok, false);

    const lines = auditLines(fx.auditLogPath);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].result, "inflight");
    assert.equal(lines[1].result, "rejected");
    assert.equal(lines[1].reason, "ApiRejected:30005");

    assert.equal(fx.guard.currentDailyCount(), 0, "明确没建单 → 不占额度");
    assert.equal(fx.guard.hasUnresolvedWrite(), false, "明确没建单 → 不拉未决闸门");
  } finally {
    fx.restore();
  }
});
