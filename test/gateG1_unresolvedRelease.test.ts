// G1 收口门：无关订单不得销掉「结果未知」（整改任务书 23 号 §3 G1，验收反例 1-9）。
//
// 这道门要改的不是某个函数写错了，而是判据的性质：改造前解除未决只收「查单来源 + 数量」，
// 于是「查了一张三天前的已完成旧单」「查到的是别人的单」「data 是 null」「列表只有第一页」
// 「重启后换了个人来查」全都被当成「弄清楚了」——一次真实读回被当成一次成立的核对
// （盲审 B01 / 21 号 P0-1 发现 B / 22 号 F03）。
//
// 本文件的每条用例对应任务书 §3 G1 的一条验收反例，用例名带 G1-n 编号。
//
// 🚨 红线自证：globalThis.fetch 全程被替换成按路径分发的 mock，绝不发出任何真实 HTTP 请求；
// 6.2.9 创建路径的调用次数单独计数。审计/幂等文件一律落 mkdtemp 临时目录，不碰生产 logs/。
// 全部识别值用假值（customerId 1234567890123456789 / 2222222222222222222）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callWrite, setReadAuditLogPathForTesting } from "../src/client.js";
import { WRITE_WHITELIST } from "../src/constants.js";
import {
  WriteGuard,
  setWriteGuardForTesting,
  beijingDateKey,
  beijingTimeString,
  customerCountKey,
  fingerprint,
} from "../src/writeGuard.js";
import { SessionStore, setSessionStoreForTesting, DEFAULT_SESSION_KEY } from "../src/session.js";
import { AccessAuditLogger, setAccessAuditLoggerForTesting } from "../src/accessAudit.js";
import { PendingOrderStore, setPendingOrderStoreForTesting } from "../src/pendingOrders.js";
import { myOrdersHandler } from "../src/myOrdersTool.js";
import { getOrderStatusHandler } from "../src/orderStatusTool.js";

process.env.QMAI_OPEN_KEY ??= "test-open-key-0123456789abcdef0123456789ab";
process.env.QMAI_OPEN_ID ??= "test-open-id-0000000000000000";
process.env.QMAI_GRANT_CODE ??= "test-grant-code-0000000000";

const FAKE_CUSTOMER_ID = "1234567890123456789"; // 19 位假会员 ID（本人）
const OTHER_CUSTOMER_ID = "2222222222222222222"; // 另一位顾客
const STORE_ID = 503542;
const PATH_CREATE = WRITE_WHITELIST[0];
const PATH_ORDER_LIST = "v3/order/userAppointTimeOrderList";
const PATH_ORDER_STATUS = "v3/order/status";
const DAY_MS = 24 * 60 * 60 * 1000;
const realFetch = globalThis.fetch;

const SAMPLE_PARAMS = {
  storeId: STORE_ID,
  items: [{ goodsId: "1200000000000000001", skuId: "1288634197263667200", num: 1 }],
  orderType: 1,
  source: 18,
  userId: FAKE_CUSTOMER_ID,
};

interface Fixture {
  guard: WriteGuard;
  auditLogPath: string;
  placedOrdersPath: string;
  dir: string;
  /** 6.2.9 创建路径的实际调用次数（写路径多调一次就是事故）。 */
  createCalls: () => number;
  /** 换掉当前 guard 实例（模拟进程重启：新实例从同一份日志重建）。 */
  reopen: () => WriteGuard;
  bind: (customerId: string) => void;
  restore: () => void;
}

function installFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "licha-gate-g1-"));
  const auditLogPath = join(dir, "write-audit.log");
  const placedOrdersPath = join(dir, "placed-orders.json");
  let guard = new WriteGuard({ auditLogPath, placedOrdersPath });
  setWriteGuardForTesting(guard);
  setPendingOrderStoreForTesting(new PendingOrderStore());
  setSessionStoreForTesting(new SessionStore());
  setAccessAuditLoggerForTesting(new AccessAuditLogger({ logPath: join(dir, "access-audit.log") }));
  setReadAuditLogPathForTesting(join(dir, "read-audit.log"));
  return {
    get guard() {
      return guard;
    },
    auditLogPath,
    placedOrdersPath,
    dir,
    createCalls: () => createCallCount,
    reopen: () => {
      guard = new WriteGuard({ auditLogPath, placedOrdersPath });
      setWriteGuardForTesting(guard);
      return guard;
    },
    bind: (customerId: string) => {
      const store = new SessionStore();
      store.bind(DEFAULT_SESSION_KEY, { customerId, boundAt: Date.now(), boundVia: "phone" });
      setSessionStoreForTesting(store);
    },
    restore: () => {
      setWriteGuardForTesting(null);
      setPendingOrderStoreForTesting(null);
      setSessionStoreForTesting(null);
      setAccessAuditLoggerForTesting(null);
      setReadAuditLogPathForTesting(null);
      globalThis.fetch = realFetch;
    },
  } as Fixture;
}

let createCallCount = 0;

/**
 * 按路径分发的 mock fetch。写路径单独计数——「未决闸门期间写路径一次都不许被调用」
 * 这类断言必须精确到路径，笼统数 fetch 数不出来。
 */
function installRouter(routes: Record<string, () => Response>): void {
  createCallCount = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes(PATH_CREATE)) createCallCount++;
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) throw new Error(`mock 路由未覆盖的路径（说明代码调了预期之外的接口）：${url}`);
    return routes[key]();
  }) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function orderListResponse(rows: Array<Record<string, unknown>>, total = rows.length): Response {
  return jsonResponse({ status: true, code: 0, data: { blttUserId: FAKE_CUSTOMER_ID, total, data: rows } });
}

/**
 * 直接往审计日志里写一笔未决记录，再让新 WriteGuard 从日志重建。
 *
 * 为什么用这个手法而不是每次都真跑一遍 callWrite：多数反例需要「一笔发生在特定时刻、
 * 属于特定顾客的未决」，而 callWrite 的时间只能是此刻。而且这条路径本身就是真实场景——
 * 未决在重启后只能从日志恢复，从日志重建的未决（live=false）正是「该被读回核对」的那一类。
 */
function appendPendingLine(
  auditLogPath: string,
  opts: { idempotencyKey: string; atMs: number; customerId?: string; result?: "unknown" | "inflight"; storeId?: number },
): void {
  const line = {
    time: beijingTimeString(opts.atMs),
    dateKey: beijingDateKey(opts.atMs),
    path: PATH_CREATE,
    result: opts.result ?? "unknown",
    reason: opts.result === "inflight" ? "RequestAboutToBeSent" : "HTTP500",
    tokenId: null,
    idempotencyKey: opts.idempotencyKey,
    summary: { storeId: opts.storeId ?? STORE_ID, itemCount: 1, totalQuantity: 1, estimatedAmountFen: 2400 },
    orderNo: null,
    code: null,
    ...(opts.customerId ? { customerKey: customerCountKey(opts.customerId) } : {}),
    durationMs: 0,
  };
  appendFileSync(auditLogPath, `${JSON.stringify(line)}\n`);
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

function jsonOf(r: { content: Array<{ type: "text"; text: string }> }): any {
  return JSON.parse(textOf(r));
}

/**
 * G1 验收反例 9 的不变式，每条用例结尾都要过一遍：
 *
 *   未决集合大小 == 已发出的创建请求数 − 已有确定结论的笔数
 *
 * 「已有确定结论」= 企迈明确回话说成了（allowed）/ 明确说没成（rejected）/ 被一次成立的
 * 核对销掉（resolved）。这条不变式是整道门的总闸：任何一次「凭不足的证据销账」都会让
 * 左边偏小，任何一次「明确终态没销账」都会让左边偏大，两种方向的错都逃不过它。
 */
function assertPendingInvariant(guard: WriteGuard, sent: number, settled: number, msg: string): void {
  assert.equal(guard.describeUnresolvedWrites().total, sent - settled, `不变式（反例 9）：${msg}`);
}

// ============================================================================
// G1-1（任务书验收反例 1）：一笔未知后查到本人历史已完成单 → 未知保留、计数不变、不提示付款
// ============================================================================
test("G1-1: 未知之后查到的是本人三天前的已完成旧单 → 未知保留、当日计数不变、不提示付款", async () => {
  const fx = installFixture();
  fx.bind(FAKE_CUSTOMER_ID);
  const now = Date.now();
  installRouter({
    [PATH_CREATE]: () => new Response("upstream error", { status: 500 }),
    // 三天前的一张已完成单：在 my_orders 的 7 天查询窗内，但离本次请求发出时刻差三天，
    // 与那一笔未决毫无关联——改造前它照样把闸门清空。
    [PATH_ORDER_LIST]: () =>
      orderListResponse([
        { orderNo: "D00281924556183175168", status: 50, actualAmount: 2400, orderAt: now - 3 * DAY_MS, userId: FAKE_CUSTOMER_ID },
      ]),
  });

  try {
    const { tokenId } = fx.guard.issueConfirmToken(SAMPLE_PARAMS);
    await callWrite(PATH_CREATE, SAMPLE_PARAMS, { amountFen: 2400, confirmToken: tokenId });
    assert.equal(fx.guard.hasUnresolvedWrite(), true, "5xx 之后必须有一笔未决");
    assert.equal(fx.guard.currentDailyCount(), 1);

    const body = jsonOf(await myOrdersHandler({ days: 7 }));
    assert.equal(body.resolvedPendingWrites, undefined, "无关旧单不得销账");
    assert.equal(body.unresolvedPendingWrites, 1, "必须如实报告仍有 1 笔无法核对");
    assert.equal(fx.guard.hasUnresolvedWrite(), true, "闸门必须继续关着");
    assert.equal(fx.guard.currentDailyCount(), 1, "额度计数不变（既不释放也不重复计）");
    assert.ok(!/付款/.test(body.pendingWriteNote ?? ""), "证据不成立时不许出现任何付款引导");
    assert.match(body.pendingWriteNote, /无法核对/);
    // 这份列表其实是完整的（total=1、就那一张旧单），窗内也确实没有本次的单——但请求刚
    // 发出几毫秒，那张单可能还在企迈侧落库，此刻的「窗内没有」证明不了「没建单」。
    assert.match(body.pendingWriteNote, /10 分钟/, "要说清还要等多久才能下「没建单」的结论");

    assert.equal(auditLines(fx.auditLogPath).filter((l) => l.result === "resolved").length, 0, "不成立的核对不许留 resolved 记录");
    assertPendingInvariant(fx.guard, 1, 0, "发出 1 笔、无确定结论 → 仍有 1 笔未决");
  } finally {
    fx.restore();
  }
});

// 同一条反例在 get_order_status 上的形态（审计反例 unrelated_old_order_clears_all）：
// 6.1.5 的回执只有 status/storeOrderNo/userId，没有下单时间——一张单和一次请求之间
// 压根没有可核对的连接点，所以它永远不该销账，也不该对已完成的单劝顾客付款。
test("G1-1 附: get_order_status 查到本人一张已完成旧单 → 两笔未知全部保留、且不提示付款", async () => {
  const fx = installFixture();
  const now = Date.now();
  appendPendingLine(fx.auditLogPath, { idempotencyKey: fingerprint({ pending: 1 }), atMs: now - 60_000, customerId: FAKE_CUSTOMER_ID });
  appendPendingLine(fx.auditLogPath, { idempotencyKey: fingerprint({ pending: 2 }), atMs: now - 30_000, customerId: FAKE_CUSTOMER_ID });
  const guard = fx.reopen();
  fx.bind(FAKE_CUSTOMER_ID);
  installRouter({ [PATH_ORDER_STATUS]: () => jsonResponse({ status: true, code: 0, data: { status: 50, userId: FAKE_CUSTOMER_ID } }) });

  try {
    assert.equal(guard.describeUnresolvedWrites().total, 2, "重建后应有 2 笔未决");
    const body = jsonOf(await getOrderStatusHandler({ orderNo: "D00281924556183175168" }));

    assert.equal(body.statusText, "已完成");
    assert.equal(body.resolvedPendingWrites, undefined, "6.1.5 单张查询不得销账");
    assert.equal(body.unresolvedPendingWrites, 2, "两笔未决都要保留");
    assert.match(body.paymentHint, /不需要再付款/, "已完成的单不许提示付款");
    assert.match(body.pendingWriteNote, /my_orders/, "要指路到真正能核对的工具");
    assert.equal(guard.hasUnresolvedWrite(), true);
    assertPendingInvariant(guard, 2, 0, "两笔未决、无确定结论");
  } finally {
    fx.restore();
  }
});

// ============================================================================
// G1-2（验收反例 2）：my_orders 返回他人订单列表 → 未知保留
// ============================================================================
test("G1-2: my_orders 返回的整页都是他人订单（userId 不符被丢弃）→ 未知保留", async () => {
  const fx = installFixture();
  const now = Date.now();
  appendPendingLine(fx.auditLogPath, { idempotencyKey: fingerprint({ pending: "foreign" }), atMs: now - 60_000, customerId: FAKE_CUSTOMER_ID });
  const guard = fx.reopen();
  fx.bind(FAKE_CUSTOMER_ID);
  installRouter({
    [PATH_ORDER_LIST]: () =>
      orderListResponse([{ orderNo: "D00281924556183175169", status: 10, actualAmount: 2400, orderAt: now - 60_000, userId: OTHER_CUSTOMER_ID }]),
  });

  try {
    const body = jsonOf(await myOrdersHandler({ days: 7 }));
    assert.equal(body.count, 0, "他人订单不得出现在结果里");
    assert.equal(body.discardedNotOwned, 1);
    assert.equal(body.resolvedPendingWrites, undefined, "混进他人订单的响应本身就不可信，不得销账");
    assert.equal(body.unresolvedPendingWrites, 1);
    assert.equal(guard.hasUnresolvedWrite(), true);
    assertPendingInvariant(guard, 1, 0, "他人订单不是证据");
  } finally {
    fx.restore();
  }
});

// ============================================================================
// G1-3（验收反例 3）：my_orders 返回 status:true, data:null → 未知保留
// ============================================================================
test("G1-3: my_orders 返回 status:true 但 data 为 null（空数组假象）→ 未知保留", async () => {
  const fx = installFixture();
  const now = Date.now();
  appendPendingLine(fx.auditLogPath, { idempotencyKey: fingerprint({ pending: "nulldata" }), atMs: now - 60_000, customerId: FAKE_CUSTOMER_ID });
  const guard = fx.reopen();
  fx.bind(FAKE_CUSTOMER_ID);
  // 施工令 §8-17 的坑：data 结构对不上时代码会拿到空数组，而「空数组」与「确实没有订单」
  // 在改造前是同一句话——一次解析失败被读成了一次不存在性核查。
  installRouter({ [PATH_ORDER_LIST]: () => jsonResponse({ status: true, code: 0, data: null }) });

  try {
    const body = jsonOf(await myOrdersHandler({ days: 7 }));
    assert.equal(body.count, 0);
    assert.equal(body.resolvedPendingWrites, undefined, "data:null 不是「查过了没有」");
    assert.equal(body.unresolvedPendingWrites, 1);
    assert.equal(guard.hasUnresolvedWrite(), true);
    assertPendingInvariant(guard, 1, 0, "data:null 不是证据");
  } finally {
    fx.restore();
  }
});

// 同一条的另一种形态：数组在 records 而不是 data（企迈换字段名 / 上游改结构）。
test("G1-3 附: my_orders 的订单数组不在 data.data（换成 records）→ 未知保留", async () => {
  const fx = installFixture();
  const now = Date.now();
  appendPendingLine(fx.auditLogPath, { idempotencyKey: fingerprint({ pending: "records" }), atMs: now - 60_000, customerId: FAKE_CUSTOMER_ID });
  const guard = fx.reopen();
  fx.bind(FAKE_CUSTOMER_ID);
  installRouter({
    [PATH_ORDER_LIST]: () =>
      jsonResponse({
        status: true,
        code: 0,
        data: { total: 500, records: [{ orderNo: "D00281924556183175170", userId: FAKE_CUSTOMER_ID, status: 10 }] },
      }),
  });

  try {
    const body = jsonOf(await myOrdersHandler({ days: 7 }));
    assert.equal(body.resolvedPendingWrites, undefined);
    assert.equal(body.unresolvedPendingWrites, 1);
    assert.equal(guard.hasUnresolvedWrite(), true);
    assertPendingInvariant(guard, 1, 0, "解析不到列表不是证据");
  } finally {
    fx.restore();
  }
});

// ============================================================================
// G1-4（验收反例 4）：列表分页不全 / 时间窗不覆盖原请求 → 未知保留
// ============================================================================
test("G1-4: my_orders 只返回第一页（total=100、本页 10 条）→ 分页不全，未知保留", async () => {
  const fx = installFixture();
  const now = Date.now();
  appendPendingLine(fx.auditLogPath, { idempotencyKey: fingerprint({ pending: "partial" }), atMs: now - 60_000, customerId: FAKE_CUSTOMER_ID });
  const guard = fx.reopen();
  fx.bind(FAKE_CUSTOMER_ID);
  installRouter({
    [PATH_ORDER_LIST]: () =>
      orderListResponse(
        Array.from({ length: 10 }, (_, i) => ({
          orderNo: `D0028192455618317${String(5200 + i)}`,
          status: 50,
          actualAmount: 2400,
          orderAt: now - (3 + i) * DAY_MS,
          userId: FAKE_CUSTOMER_ID,
        })),
        100,
      ),
  });

  try {
    const body = jsonOf(await myOrdersHandler({ days: 7 }));
    assert.equal(body.count, 10);
    assert.equal(body.resolvedPendingWrites, undefined, "还有 90 条没看，「没查到」这个结论不成立");
    assert.equal(body.unresolvedPendingWrites, 1);
    assert.equal(guard.hasUnresolvedWrite(), true);
    assertPendingInvariant(guard, 1, 0, "分页不全不是证据");
  } finally {
    fx.restore();
  }
});

test("G1-4 附: 未决发生在 8 天前、只查最近 1 天 → 时间窗不覆盖，未知保留（列表完整也不行）", async () => {
  const fx = installFixture();
  const now = Date.now();
  appendPendingLine(fx.auditLogPath, { idempotencyKey: fingerprint({ pending: "outofwindow" }), atMs: now - 8 * DAY_MS, customerId: FAKE_CUSTOMER_ID });
  const guard = fx.reopen();
  fx.bind(FAKE_CUSTOMER_ID);
  // 一份**完整**的空列表（total=0）——它能证明「最近 1 天没有订单」，证明不了「8 天前没有」。
  installRouter({ [PATH_ORDER_LIST]: () => orderListResponse([], 0) });

  try {
    const body = jsonOf(await myOrdersHandler({ days: 1 }));
    assert.equal(body.count, 0);
    assert.equal(body.resolvedPendingWrites, undefined, "查询窗没覆盖那一笔，空列表不能给它下结论");
    assert.equal(body.unresolvedPendingWrites, 1);
    assert.match(body.pendingWriteNote, /days/, "要告诉模型可以把时间窗放大再查");
    assert.equal(guard.hasUnresolvedWrite(), true);
    assertPendingInvariant(guard, 1, 0, "窗口不覆盖不是证据");
  } finally {
    fx.restore();
  }
});

// ============================================================================
// G1-5（验收反例 5）：创建回执 HTTP 200 缺 status → 记未知而非拒绝，额度不释放
// ============================================================================
test("G1-5: 创建回执 HTTP 200 但缺 status 字段 → 终态记 unknown、占额度、拉起未决闸门", async () => {
  const fx = installFixture();
  fx.bind(FAKE_CUSTOMER_ID);
  installRouter({ [PATH_CREATE]: () => jsonResponse({}) });

  try {
    const { tokenId } = fx.guard.issueConfirmToken(SAMPLE_PARAMS);
    const res = await callWrite(PATH_CREATE, SAMPLE_PARAMS, { amountFen: 2400, confirmToken: tokenId });

    assert.equal(res.ok, false);
    assert.match(res.error!.hint, /结果未知/, "必须如实告知结果未知，不能报成失败");
    assert.match(res.error!.hint, /不要立即重复下单/);

    const terminal = auditLines(fx.auditLogPath).filter((l) => l.result !== "inflight");
    assert.equal(terminal.length, 1, "应恰好一条终态记录");
    assert.equal(terminal[0].result, "unknown", "缺 status 的终态必须是 unknown，不能是 rejected");
    assert.equal(terminal[0].reason, "MalformedResponse:noStatus");

    assert.equal(fx.guard.currentDailyCount(), 1, "额度不释放——请求确实发出过，企迈侧可能已建单");
    assert.equal(fx.guard.hasUnresolvedWrite(), true, "必须拉起未决闸门");
    assert.equal(fx.guard.describeUnresolvedWrites().unknown, 1);
    assert.equal(fx.createCalls(), 1, "写路径恰好发出一次（不重试）");
    assertPendingInvariant(fx.guard, 1, 0, "缺 status = 没有确定结论");
  } finally {
    fx.restore();
  }
});

test("G1-5 附: 创建回执 HTTP 200 但整体无法 JSON 解析 → 同样记 unknown、额度不释放", async () => {
  const fx = installFixture();
  fx.bind(FAKE_CUSTOMER_ID);
  installRouter({ [PATH_CREATE]: () => new Response("<html>502 Bad Gateway</html>", { status: 200 }) });

  try {
    const { tokenId } = fx.guard.issueConfirmToken(SAMPLE_PARAMS);
    const res = await callWrite(PATH_CREATE, SAMPLE_PARAMS, { amountFen: 2400, confirmToken: tokenId });

    assert.equal(res.ok, false);
    assert.match(res.error!.hint, /结果未知/);
    const terminal = auditLines(fx.auditLogPath).filter((l) => l.result !== "inflight");
    assert.equal(terminal[0].result, "unknown");
    assert.equal(terminal[0].reason, "MalformedResponse:unparsable");
    assert.equal(fx.guard.currentDailyCount(), 1);
    assert.equal(fx.guard.hasUnresolvedWrite(), true);
    assertPendingInvariant(fx.guard, 1, 0, "读不懂的回执 = 没有确定结论");
  } finally {
    fx.restore();
  }
});

// ============================================================================
// G1-6（验收反例 6）：完整匹配证据 → 只解除对应那一笔，其余未决不动
// ============================================================================
test("G1-6: 一笔有可关联证据、另一笔在查询窗外 → 只解除前者，resolvedKeys 只含它", async () => {
  const fx = installFixture();
  const now = Date.now();
  const keyMatched = fingerprint({ pending: "matched" });
  const keyOutOfWindow = fingerprint({ pending: "still-unknown" });
  appendPendingLine(fx.auditLogPath, { idempotencyKey: keyMatched, atMs: now - 2 * 60_000, customerId: FAKE_CUSTOMER_ID });
  appendPendingLine(fx.auditLogPath, { idempotencyKey: keyOutOfWindow, atMs: now - 8 * DAY_MS, customerId: FAKE_CUSTOMER_ID });
  const guard = fx.reopen();
  fx.bind(FAKE_CUSTOMER_ID);
  installRouter({
    [PATH_ORDER_LIST]: () =>
      orderListResponse([
        { orderNo: "D00281924556183175171", status: 10, actualAmount: 2400, orderAt: now - 2 * 60_000, userId: FAKE_CUSTOMER_ID },
      ]),
  });

  try {
    assert.equal(guard.describeUnresolvedWrites().total, 2);
    const body = jsonOf(await myOrdersHandler({ days: 7 }));

    assert.equal(body.resolvedPendingWrites, 1, "只该解除被证实的那一笔");
    assert.equal(body.unresolvedPendingWrites, 1, "另一笔必须留着");
    assert.match(body.pendingWriteNote, /D00281924556183175171/, "要点名是哪一张单");
    assert.match(body.pendingWriteNote, /引导顾客去小程序/, "待支付的匹配单可以引导付款");
    assert.equal(guard.hasUnresolvedWrite(), true, "还有一笔没核对，闸门继续关着");

    const resolved = auditLines(fx.auditLogPath).filter((l) => l.result === "resolved");
    assert.equal(resolved.length, 1);
    assert.deepEqual(resolved[0].resolvedKeys, [keyMatched], "resolvedKeys 只许含被证实的那个键");
    assert.match(resolved[0].reason, /^ResolvedBy:my_orders:found=1:absent=0:kept=1$/);

    // 重启后口径一致：被销的那笔不复活，留着的那笔还在。
    const rebuilt = fx.reopen();
    assert.equal(rebuilt.describeUnresolvedWrites().total, 1, "重建后仍恰好剩 1 笔未决");
    assertPendingInvariant(rebuilt, 2, 1, "两笔未决销掉 1 笔");
  } finally {
    fx.restore();
  }
});

test("G1-6 附: 完整列表 + 窗口覆盖 + 窗内确无订单 → 判定「企迈侧没有那一单」并解除", async () => {
  const fx = installFixture();
  const now = Date.now();
  const key = fingerprint({ pending: "absent" });
  appendPendingLine(fx.auditLogPath, { idempotencyKey: key, atMs: now - 60 * 60_000, customerId: FAKE_CUSTOMER_ID });
  const guard = fx.reopen();
  fx.bind(FAKE_CUSTOMER_ID);
  // 这一条是 order_absent 必须存在的理由：一次真正失败的下单，如果永远解除不了闸门，
  // 整条下单链路会永久卡死。它的证据门槛全部满足（完整列表 + 窗口覆盖那一笔的落点）。
  installRouter({ [PATH_ORDER_LIST]: () => orderListResponse([], 0) });

  try {
    const body = jsonOf(await myOrdersHandler({ days: 7 }));
    assert.equal(body.resolvedPendingWrites, 1);
    assert.equal(body.unresolvedPendingWrites, undefined);
    assert.match(body.pendingWriteNote, /没有建单/);
    assert.match(body.pendingWriteNote, /prepare_order/, "确认没建单后要允许重新组单");
    assert.ok(!/付款/.test(body.pendingWriteNote), "没建单的情况下不许提付款");
    assert.equal(guard.hasUnresolvedWrite(), false, "证据成立 → 闸门解除");

    const resolved = auditLines(fx.auditLogPath).filter((l) => l.result === "resolved");
    assert.match(resolved[0].reason, /^ResolvedBy:my_orders:found=0:absent=1:kept=0$/);
    assertPendingInvariant(guard, 1, 1, "一笔未决被证实不存在");
  } finally {
    fx.restore();
  }
});

test("G1-6 附2: 请求还在飞（本进程 inflight 未落终态）→ 任何读回都不得解除", async () => {
  const fx = installFixture();
  fx.bind(FAKE_CUSTOMER_ID);
  let releaseCreate: (() => void) | undefined;
  // 写请求挂住不回话：模拟真实的「请求已发出、还没有结果」窗口。这个形态没法用
  // installRouter 表达（它的每条路由都立即返回），所以这条用例自己接 fetch。
  createCallCount = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes(PATH_CREATE)) {
      createCallCount++;
      return new Promise<Response>((resolve) => {
        releaseCreate = () => resolve(new Response("late 500", { status: 500 }));
      });
    }
    return orderListResponse([], 0);
  }) as typeof fetch;

  try {
    const { tokenId } = fx.guard.issueConfirmToken(SAMPLE_PARAMS);
    const writing = callWrite(PATH_CREATE, SAMPLE_PARAMS, { amountFen: 2400, confirmToken: tokenId });
    // 等到写请求真的发出去（callWrite 里 fetch 之前有 210ms 节流，固定睡一小会儿会 flaky）。
    for (let i = 0; i < 200 && fx.createCalls() === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(fx.createCalls(), 1, "写请求必须已经发出（这条用例要的就是「在飞」这个状态）");
    assert.equal(fx.guard.hasUnresolvedWrite(), true, "请求在飞时就该挂着未决");
    assert.equal(fx.guard.currentDailyCount(), 1, "在飞的请求同样占额度");

    const body = jsonOf(await myOrdersHandler({ days: 7 }));
    assert.equal(body.resolvedPendingWrites, undefined, "在飞的请求不许被外部证据销账（企迈侧可能还没建出来）");
    assert.equal(fx.guard.hasUnresolvedWrite(), true, "闸门必须继续关着");
    assert.equal(fx.guard.currentDailyCount(), 1, "额度不许在请求还没回话时被清掉");
    assertPendingInvariant(fx.guard, 1, 0, "在飞 = 没有结论");

    releaseCreate!();
    await writing;
    assert.equal(fx.guard.describeUnresolvedWrites().unknown, 1, "终态到达后转成 unknown（这时才可被核对）");
  } finally {
    fx.restore();
  }
});

// ============================================================================
// G1-7（验收反例 7）：重启后绑定另一人 → 不得解除前一人的未知
// ============================================================================
test("G1-7: 重启后会话绑了另一位顾客，他的一次读回不得解除前一人的未知", async () => {
  const fx = installFixture();
  const now = Date.now();
  // A 的一笔未决（重启前发生）。重启后内存身份清空，B 报号即可绑定——这条通路本身不改
  // （bind_member 的换绑闸门只在「进程内已有绑定」时生效），所以必须由 guard 这一侧拦住。
  // 这一笔取「一小时前」而不是「一分钟前」：order_absent 有 10 分钟静默期（见
  // judgePendingWrite ⑤），太新的未决无论谁来查都会被保留，那样就测不出「换人」这一条判据
  // 到底有没有生效——用一笔静默期已过的未决，保留的唯一原因才只能是顾客对不上。
  appendPendingLine(fx.auditLogPath, { idempotencyKey: fingerprint({ pending: "belongs-to-A" }), atMs: now - 60 * 60_000, customerId: FAKE_CUSTOMER_ID });
  const guard = fx.reopen();
  fx.bind(OTHER_CUSTOMER_ID);
  installRouter({ [PATH_ORDER_LIST]: () => orderListResponse([], 0) });

  try {
    const body = jsonOf(await myOrdersHandler({ days: 7 }));
    assert.equal(body.resolvedPendingWrites, undefined, "B 查自己的订单，证明不了 A 那一笔的结果");
    assert.equal(body.unresolvedPendingWrites, 1);
    assert.match(body.pendingWriteNote, /绑定的另一位顾客/, "要说清为什么核对不了、该怎么办");
    assert.equal(guard.hasUnresolvedWrite(), true, "A 的未决必须继续挂着（闸门是全局的）");
    assertPendingInvariant(guard, 1, 0, "换人查不算核对");

    // 绑回 A 之后，同一份证据就能成立——保留未知不是死锁，是要求用对的身份来核对。
    // （这也顺带证明前一次保留不是因为静默期或窗口，就是因为查的人不对。）
    fx.bind(FAKE_CUSTOMER_ID);
    const second = jsonOf(await myOrdersHandler({ days: 7 }));
    assert.equal(second.resolvedPendingWrites, 1, "绑回 A 后，完整空列表足以证明那一单不存在");
    assert.equal(guard.hasUnresolvedWrite(), false);
    assertPendingInvariant(guard, 1, 1, "绑回本人后核对成立");
  } finally {
    fx.restore();
  }
});

test("G1-7 附: 未决记录没有 customerKey（历史日志）→ 任何人的读回都不得解除", async () => {
  const fx = installFixture();
  const now = Date.now();
  // M2 时代的日志行没有 customerKey 字段。归属不明的未决只能保留——凭「查的人是谁」
  // 猜归属，就是把两位顾客的账算混，那比闸门一直关着糟得多。
  appendPendingLine(fx.auditLogPath, { idempotencyKey: fingerprint({ pending: "legacy" }), atMs: now - 60 * 60_000 });
  const guard = fx.reopen();
  fx.bind(FAKE_CUSTOMER_ID);
  installRouter({ [PATH_ORDER_LIST]: () => orderListResponse([], 0) });

  try {
    const body = jsonOf(await myOrdersHandler({ days: 7 }));
    assert.equal(body.resolvedPendingWrites, undefined);
    assert.equal(body.unresolvedPendingWrites, 1);
    assert.equal(guard.hasUnresolvedWrite(), true);
    assertPendingInvariant(guard, 1, 0, "归属不明的未决不许被任何人销账");
  } finally {
    fx.restore();
  }
});

// ============================================================================
// G1-8（验收反例 8）：正常「明确拒绝」回执仍按现有额度规则处理（防误伤）
// ============================================================================
test("G1-8: 企迈明确回话 status:false（售罄）→ 仍记 rejected、不占额度、不拉闸门", async () => {
  const fx = installFixture();
  fx.bind(FAKE_CUSTOMER_ID);
  installRouter({ [PATH_CREATE]: () => jsonResponse({ status: false, code: 30005, message: "商品已售罄" }) });

  try {
    const { tokenId } = fx.guard.issueConfirmToken(SAMPLE_PARAMS);
    const res = await callWrite(PATH_CREATE, SAMPLE_PARAMS, { amountFen: 2400, confirmToken: tokenId });

    assert.equal(res.ok, false);
    assert.equal(res.code, 30005, "业务错误码要原样透传");
    const lines = auditLines(fx.auditLogPath);
    assert.equal(lines.length, 2);
    assert.equal(lines[1].result, "rejected", "明确没建单仍然是 rejected——不许被 MalformedResponse 误伤");
    assert.equal(lines[1].reason, "ApiRejected:30005");
    assert.equal(fx.guard.currentDailyCount(), 0, "明确没建单 → 不占额度（正常业务拒绝不吃顾客额度）");
    assert.equal(fx.guard.hasUnresolvedWrite(), false, "明确没建单 → 不拉未决闸门");
    assertPendingInvariant(fx.guard, 1, 1, "明确拒绝 = 已有确定结论");
  } finally {
    fx.restore();
  }
});

// ============================================================================
// G1-9（验收反例 9）：不变式贯穿一整条多步链路
// ============================================================================
// 前面每条用例结尾都调了 assertPendingInvariant；这一条把它放进一条连续的链路里逐步验，
// 覆盖「成功 / 明确拒绝 / 未知 / 不成立的核对 / 成立的核对」五种事件的组合。
test("G1-9: 多步链路逐步核对不变式——未决数 == 发出的创建请求数 − 已有确定结论的笔数", async () => {
  const fx = installFixture();
  fx.bind(FAKE_CUSTOMER_ID);
  const now = Date.now();
  let createSeq = 0;
  let listRows: Array<Record<string, unknown>> = [];
  let listTotal = 0;
  createCallCount = 0; // 本用例自己接 fetch（installRouter 表达不了「按次序换响应」），计数要自己归零
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes(PATH_CREATE)) {
      createCallCount++;
      createSeq++;
      if (createSeq === 1) return jsonResponse({ status: true, code: 0, data: { orderNo: "D00281924556183175180" } });
      if (createSeq === 2) return jsonResponse({ status: false, code: 30005, message: "商品已售罄" });
      return new Response("boom", { status: 503 });
    }
    return orderListResponse(listRows, listTotal);
  }) as typeof fetch;

  try {
    // 第 1 单：成功 → 确定结论。
    const p1 = { ...SAMPLE_PARAMS, items: [{ goodsId: "g-1", skuId: "s", num: 1 }] };
    await callWrite(PATH_CREATE, p1, { amountFen: 2400, confirmToken: fx.guard.issueConfirmToken(p1).tokenId });
    assertPendingInvariant(fx.guard, 1, 1, "第 1 单成功");

    // 第 2 单：明确拒绝 → 确定结论。
    const p2 = { ...SAMPLE_PARAMS, items: [{ goodsId: "g-2", skuId: "s", num: 1 }] };
    await callWrite(PATH_CREATE, p2, { amountFen: 2400, confirmToken: fx.guard.issueConfirmToken(p2).tokenId });
    assertPendingInvariant(fx.guard, 2, 2, "第 2 单明确被拒");

    // 第 3 单：5xx → 结果未知。
    const p3 = { ...SAMPLE_PARAMS, items: [{ goodsId: "g-3", skuId: "s", num: 1 }] };
    const thirdRequestAtMs = Date.now();
    await callWrite(PATH_CREATE, p3, { amountFen: 2400, confirmToken: fx.guard.issueConfirmToken(p3).tokenId });
    assertPendingInvariant(fx.guard, 3, 2, "第 3 单结果未知");

    // 一次不成立的核对（分页不全）→ 不变式不许变。
    listRows = [{ orderNo: "D00281924556183175181", status: 50, actualAmount: 2400, orderAt: now - 5 * DAY_MS, userId: FAKE_CUSTOMER_ID }];
    listTotal = 40;
    const bad = jsonOf(await myOrdersHandler({ days: 7 }));
    assert.equal(bad.resolvedPendingWrites, undefined);
    assertPendingInvariant(fx.guard, 3, 2, "不成立的核对不改变任何账");

    // 一次成立的核对（完整列表 + 一行落在第 3 单的关联时间窗内）→ 第 3 单按 order_found 销账。
    // 这里用 found 而不是 absent：第 3 单是刚才发出的，absent 的 10 分钟静默期还没过。
    listRows = [{ orderNo: "D00281924556183175182", status: 10, actualAmount: 2400, orderAt: thirdRequestAtMs, userId: FAKE_CUSTOMER_ID }];
    listTotal = 1;
    const good = jsonOf(await myOrdersHandler({ days: 7 }));
    assert.equal(good.resolvedPendingWrites, 1);
    assert.match(good.pendingWriteNote, /D00281924556183175182/, "要点名销账凭的是哪一张单");
    assertPendingInvariant(fx.guard, 3, 3, "成立的核对销掉那一笔");
    assert.equal(fx.createCalls(), 3, "全程只发出 3 次创建请求");

    // 重启后不变式仍然成立（同一份日志、同一个状态机）。
    const rebuilt = fx.reopen();
    assertPendingInvariant(rebuilt, 3, 3, "重启后不变式不许漂移");
    assert.equal(rebuilt.currentDailyCount(), 2, "成功 1 笔 + 未知 1 笔 = 占额 2（明确拒绝的那笔不占）");
  } finally {
    fx.restore();
  }
});
