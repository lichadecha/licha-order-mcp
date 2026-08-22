// M3 总工独立验收用例（施工令 § 4.5 纪律：交叉验收必须独立设计用例，不采信施工方自测）。
// 本文件的用例在施工方交付前就已设计好（验收清单 B 组），重点猎两类坑：
//   「业务上合法但实现可能误拒」与「看似被挡但实际可绕/可漏」。
// 验收后保留入库：这些边界（空 data、数字 userId、令牌指纹一致性、嵌入式手机号脱敏）
// 是三期回归的第一批用例。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setReadAuditLogPathForTesting } from "../src/client.js";
import { WriteGuard, setWriteGuardForTesting } from "../src/writeGuard.js";
import { SessionStore, setSessionStoreForTesting, DEFAULT_SESSION_KEY } from "../src/session.js";
import { AccessAuditLogger, setAccessAuditLoggerForTesting } from "../src/accessAudit.js";
import { bindMemberHandler } from "../src/bindMemberTool.js";
import { getOrderStatusHandler } from "../src/orderStatusTool.js";
import { placeOrderConfirmedHandler } from "../src/placeOrderTool.js";
import { PendingOrderStore, setPendingOrderStoreForTesting } from "../src/pendingOrders.js";

process.env.QMAI_OPEN_KEY ??= "test-open-key-0123456789abcdef0123456789ab";
process.env.QMAI_OPEN_ID ??= "test-open-id-0000000000000000";
process.env.QMAI_GRANT_CODE ??= "test-grant-code-0000000000";

const FAKE_CUSTOMER_ID = "1234567890123456789";

interface Fixture {
  dir: string;
  accessLogPath: string;
  writeGuard: WriteGuard;
  pendingStore: PendingOrderStore;
  restore: () => void;
}

function installFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "licha-m3-gauntlet-"));
  const accessLogPath = join(dir, "access-audit.log");
  const writeGuard = new WriteGuard({
    auditLogPath: join(dir, "write-audit.log"),
    placedOrdersPath: join(dir, "placed-orders.json"),
  });
  setWriteGuardForTesting(writeGuard);
  const pendingStore = new PendingOrderStore();
  setPendingOrderStoreForTesting(pendingStore);
  setSessionStoreForTesting(new SessionStore());
  setAccessAuditLoggerForTesting(new AccessAuditLogger({ logPath: accessLogPath }));
  setReadAuditLogPathForTesting(join(dir, "read-audit.log"));
  return {
    dir,
    accessLogPath,
    writeGuard,
    pendingStore,
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

const realFetch = globalThis.fetch;

/** mock fetch：按请求路径依次返回 responses 队列里的响应体，并记录每次请求。
 * bodyText 保留原文——发送侧 restoreIdsForSend 会把 ≥15 位的 ID 还原成 JSON 数字
 * （与 M1 Python 真发成功的形态一致），JSON.parse 在 JS 侧会丢精度，
 * 所以对 19 位大数的断言必须用正则打在原文上。 */
function installFetchQueue(responses: Array<Record<string, unknown>>): {
  calls: Array<{ url: string; body: Record<string, unknown>; bodyText: string }>;
  restore: () => void;
} {
  const calls: Array<{ url: string; body: Record<string, unknown>; bodyText: string }> = [];
  let i = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const bodyText = String(init?.body ?? "{}");
    const body = JSON.parse(bodyText) as Record<string, unknown>;
    calls.push({ url: String(input), body, bodyText });
    const resp = responses[Math.min(i, responses.length - 1)];
    i++;
    return new Response(JSON.stringify(resp), { status: 200 });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = realFetch) };
}

async function bindFakeMember(): Promise<void> {
  const fetchMock = installFetchQueue([{ status: true, code: 0, data: { customerId: FAKE_CUSTOMER_ID } }]);
  const result = await bindMemberHandler({ code: "13800001234", codeType: "phone" });
  fetchMock.restore();
  assert.equal(result.isError ?? false, false, `前置绑定失败：${result.content[0].text}`);
}

function textOf(r: { content: Array<{ type: "text"; text: string }> }): string {
  return r.content.map((c) => c.text).join("\n");
}

// ---------- B1【误拒】绑定失败（查无此人）不许把会话卡死，之后必须还能绑定成功 ----------
test("B1：4.2.2 查无此人导致绑定失败后，同会话再次绑定必须成功（失败不卡死会话）", async () => {
  const fx = installFixture();
  try {
    const failMock = installFetchQueue([{ status: false, code: 40001, message: "会员不存在" }]);
    const first = await bindMemberHandler({ code: "13800001234", codeType: "phone" });
    failMock.restore();
    assert.equal(first.isError, true);

    const okMock = installFetchQueue([{ status: true, code: 0, data: { customerId: FAKE_CUSTOMER_ID } }]);
    const second = await bindMemberHandler({ code: "13800001234", codeType: "phone" });
    okMock.restore();
    assert.equal(second.isError ?? false, false, `失败后的再次绑定被误拒：${textOf(second)}`);
    assert.match(textOf(second), /\*\*\*6789/);
  } finally {
    fx.restore();
  }
});

// ---------- B2【误放·fail closed】6.1.5 返回 ok=true 但 data=null：必须拒绝且不 crash ----------
// 实测背景：6.1.9 查已取消订单返回空 data（施工令 § 8 第 16 条），空 data 是真实存在的响应形态。
test("B2：6.1.5 响应 data=null → get_order_status 拒绝（不 crash、不返回任何订单字段）", async () => {
  const fx = installFixture();
  try {
    await bindFakeMember();
    const mock = installFetchQueue([{ status: true, code: 0, data: null }]);
    const r = await getOrderStatusHandler({ orderNo: "D-TEST-NULL-DATA" });
    mock.restore();
    assert.equal(r.isError, true);
    assert.doesNotMatch(textOf(r), /status/i);
  } finally {
    fx.restore();
  }
});

// ---------- B3【误放】data 存在但无 userId 键 → 拒绝 ----------
test("B3：6.1.5 响应 data 无 userId 键 → fail closed 拒绝", async () => {
  const fx = installFixture();
  try {
    await bindFakeMember();
    const mock = installFetchQueue([{ status: true, code: 0, data: { status: 10 } }]);
    const r = await getOrderStatusHandler({ orderNo: "D-TEST-NO-USERID" });
    mock.restore();
    assert.equal(r.isError, true);
    // 拒绝文本不许泄露订单状态（10/待支付都不许出现）
    assert.doesNotMatch(textOf(r), /10|待支付/);
  } finally {
    fx.restore();
  }
});

// ---------- B4【类型陷阱】userId 为 JSON 短数字（不经 protectIds 字符串化）→ String 化比对仍正确 ----------
test("B4：6.1.5 的 userId 为短数字形态时，同人放行、异人拒绝（String 化比对）", async () => {
  const fx = installFixture();
  try {
    // 绑定一个短 customerId（模拟 protectIds 不介入的形态）
    const bindMock = installFetchQueue([{ status: true, code: 0, data: { customerId: 12345 } }]);
    const bindResult = await bindMemberHandler({ code: "13800001234", codeType: "phone" });
    bindMock.restore();
    assert.equal(bindResult.isError ?? false, false);

    const sameMock = installFetchQueue([{ status: true, code: 0, data: { status: 20, userId: 12345 } }]);
    const same = await getOrderStatusHandler({ orderNo: "D-SAME" });
    sameMock.restore();
    assert.equal(same.isError ?? false, false, `同人短数字 userId 被误拒：${textOf(same)}`);
    assert.match(textOf(same), /已支付/);

    const otherMock = installFetchQueue([{ status: true, code: 0, data: { status: 20, userId: 99999 } }]);
    const other = await getOrderStatusHandler({ orderNo: "D-OTHER" });
    otherMock.restore();
    assert.equal(other.isError, true);
  } finally {
    fx.restore();
  }
});

// ---------- B5/B6 迁移说明（2026-08-19，T5-1 旧 handler 清理）----------
//
// 这三条原本调的是 M2/M3 留下的旧 `placeOrderHandler`（入参 `orderParams` 完整透传）。
// M4 定稿把 place_order 的入参收窄成「confirmToken + confirmAmountYuan」两个标量，旧 handler
// 只为承载这三条用例而留在仓库里（未注册、模型不可见），登记为 §8-22 的 M6 收官清理项。
// 现按 17 号执行包 T5-1 的**例外授权**（仅此三条、语义等价迁移，其余一行不动）改写为调用定稿 handler。
//
// 逐条的语义映射（照 19 号检查单第一节的对照表，不是「看着像」就改）：
//   B5a 原：对「注入 userId 后的最终 params」签发令牌 → 放行到 fetch、body 含绑定值
//       新：待确认单登记的 finalParams（含会话注入的 userId）→ 凭令牌下单 → 同一断言
//   B5b 原：对「不含 userId 的 orderParams」签发令牌 → TokenFingerprintMismatch
//       新：定稿架构下模型**没有传 orderParams 的入口**，指纹不符在生产已不可达；
//           等价的「令牌与登记单对不上」判据是第 ③ 步 PendingOrderNotFound —— 令牌是
//           writeGuard 真签发的，但登记表里没有这张单，一样必须拒且 fetch 零调用。
//   B6  原：orderParams 塞 userId（顶层/嵌套）→ 黑名单拒
//       新：定稿第 ① 步 findUserIdField 扫的是**整个入参对象**，塞在任何层级都命中（UserIdInInput）
//
// 三条守的东西一条没少：合法令牌放行且 userId 无损、令牌对不上必拒且不发请求、
// 调用方塞 userId 一律拒。

test("B5a：待确认单登记的 finalParams（含注入 userId）→ 凭令牌放行到 fetch，body.params.userId=绑定值", async () => {
  const fx = installFixture();
  try {
    await bindFakeMember();
    const finalParams = {
      storeId: 503542,
      items: [{ goodsId: "1", skuId: "2", num: 1 }],
      orderType: 1,
      source: 18,
      userId: FAKE_CUSTOMER_ID,
    };
    const { tokenId } = fx.writeGuard.issueConfirmToken(finalParams);
    fx.pendingStore.register(tokenId, { finalParams, estimatedAmountFen: 2400 });
    const mock = installFetchQueue([
      { status: true, code: 0, data: { orderNo: "D-M3-GAUNTLET", payAmount: 24.0 } },
      // 定稿 handler 成功后会强制 6.1.9 读回；给一条归属正确的响应，读回才不会走 readbackFailed。
      { status: true, code: 0, data: { orderNo: "D-M3-GAUNTLET", userId: FAKE_CUSTOMER_ID, actualAmount: 2400, discountList: [] } },
    ]);
    const r = await placeOrderConfirmedHandler({ confirmToken: tokenId, confirmAmountYuan: 24.0 });
    mock.restore();
    assert.equal(r.isError ?? false, false, `合法令牌被误拒：${textOf(r)}`);
    const writeCalls = mock.calls.filter((c) => c.bodyText.includes("order/v1/create") || c.url.includes("order/v1/create"));
    assert.equal(writeCalls.length >= 1, true, "写请求应已发出");
    // 大数无损断言打在请求体原文上：userId 应以无引号的 19 位数字形态、完整无损地发出
    // （restoreIdsForSend 的设计行为；JSON.parse 会把它折成 ...800，不能用来断言）。
    assert.match(writeCalls[0].bodyText, new RegExp(`"userId":${FAKE_CUSTOMER_ID}[,}]`));
  } finally {
    fx.restore();
  }
});

test("B5b：令牌真签发但待确认单未登记 → PendingOrderNotFound 拒且 fetch 未调用", async () => {
  const fx = installFixture();
  try {
    await bindFakeMember();
    const finalParams = {
      storeId: 503542,
      items: [{ goodsId: "1", skuId: "2", num: 1 }],
      orderType: 1,
      source: 18,
      userId: FAKE_CUSTOMER_ID,
    };
    // 令牌签发了，但**故意不 register** —— 定稿架构下「令牌与登记单对不上」的等价形态。
    const { tokenId } = fx.writeGuard.issueConfirmToken(finalParams);
    const mock = installFetchQueue([{ status: true, code: 0, data: { orderNo: "D-SHOULD-NOT-EXIST" } }]);
    const r = await placeOrderConfirmedHandler({ confirmToken: tokenId, confirmAmountYuan: 24.0 });
    mock.restore();
    assert.equal(r.isError, true);
    assert.match(textOf(r), /确认令牌无效|不存在|已被使用/);
    assert.equal(mock.calls.length, 0, "令牌取不到待确认单时不许发出任何请求");
  } finally {
    fx.restore();
  }
});

// ---------- B6【双锁不互斥】绑定后调用方塞 userId（顶层与嵌套）仍被拒 ----------
test("B6：入参里塞 userId（顶层/嵌套）→ 仍被黑名单拒、fetch 未调用", async () => {
  const fx = installFixture();
  try {
    await bindFakeMember();
    const mock = installFetchQueue([{ status: true, code: 0, data: {} }]);
    // 定稿入参只有两个标量字段，但 findUserIdField 扫的是整个入参对象——
    // 将来有人顺手扩字段时这道防御依然在。类型断言只为把额外字段塞进去。
    const top = await placeOrderConfirmedHandler({
      confirmToken: "t",
      confirmAmountYuan: 1,
      userId: "666",
    } as unknown as Parameters<typeof placeOrderConfirmedHandler>[0]);
    assert.equal(top.isError, true);
    assert.match(textOf(top), /userId/);
    const nested = await placeOrderConfirmedHandler({
      confirmToken: "t",
      confirmAmountYuan: 1,
      ext: { deep: { userId: "666" } },
    } as unknown as Parameters<typeof placeOrderConfirmedHandler>[0]);
    assert.equal(nested.isError, true);
    assert.match(textOf(nested), /userId/);
    assert.equal(mock.calls.length, 0, "黑名单命中时不许发出任何请求");
    mock.restore();
  } finally {
    fx.restore();
  }
});

// ---------- B7【脱敏漏点】4.2.2 失败 message 含嵌入式手机号 → access-audit 不许漏完整号码 ----------
test("B7：企迈 message 含嵌入式手机号时，access-audit 落盘不许出现完整号码", async () => {
  const fx = installFixture();
  try {
    const mock = installFetchQueue([{ status: false, code: 40001, message: "手机号13800001234不存在" }]);
    const r = await bindMemberHandler({ code: "13800001234", codeType: "phone" });
    mock.restore();
    assert.equal(r.isError, true);
    assert.ok(existsSync(fx.accessLogPath), "bind_rejected 应已落盘");
    const logText = readFileSync(fx.accessLogPath, "utf8");
    assert.ok(!logText.includes("13800001234"), `access-audit 泄露完整手机号：${logText}`);
  } finally {
    fx.restore();
  }
});

// ---------- B9【多次查询】绑定后连续查两个自己的单，互不干扰 ----------
test("B9：绑定后连续查询两个自己的订单，均成功且状态各自正确", async () => {
  const fx = installFixture();
  try {
    await bindFakeMember();
    const mock1 = installFetchQueue([{ status: true, code: 0, data: { status: 10, userId: FAKE_CUSTOMER_ID } }]);
    const r1 = await getOrderStatusHandler({ orderNo: "D-ONE" });
    mock1.restore();
    const mock2 = installFetchQueue([{ status: true, code: 0, data: { status: 50, userId: FAKE_CUSTOMER_ID } }]);
    const r2 = await getOrderStatusHandler({ orderNo: "D-TWO" });
    mock2.restore();
    assert.match(textOf(r1), /待支付/);
    assert.match(textOf(r2), /已完成/);
  } finally {
    fx.restore();
  }
});
