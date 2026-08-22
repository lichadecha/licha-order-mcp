// M4 总工独立验收用例（施工令 § 4.5 纪律：交叉验收独立设计用例，不采信施工方自测）。
// 专打施工方 V 系列没覆盖的面：跨会话串用、金额上限边界、复述容差边界、频次护栏在新链路的
// 集成生效、读回归属不符、发出请求体逐字段核对、差额告警的取严边界。
// 验收后保留入库，作三期回归底座。mock 基建与 m4ConfirmOrder.test.ts 同思路（路由器 + 五件套注入），
// 用例设计独立。每条用例用独立 goodsId（getItemDetail 模块级缓存 5 分钟，避免跨用例耦合）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setReadAuditLogPathForTesting } from "../src/client.js";
import { WriteGuard, setWriteGuardForTesting } from "../src/writeGuard.js";
import { SessionStore, setSessionStoreForTesting, DEFAULT_SESSION_KEY } from "../src/session.js";
import { AccessAuditLogger, setAccessAuditLoggerForTesting } from "../src/accessAudit.js";
import { PendingOrderStore, setPendingOrderStoreForTesting } from "../src/pendingOrders.js";
import { prepareOrderHandler } from "../src/prepareOrderTool.js";
import { placeOrderConfirmedHandler } from "../src/placeOrderTool.js";

process.env.QMAI_OPEN_KEY ??= "test-open-key-0123456789abcdef0123456789ab";
process.env.QMAI_OPEN_ID ??= "test-open-id-0000000000000000";
process.env.QMAI_GRANT_CODE ??= "test-grant-code-0000000000";

const CUSTOMER_A = "1234567890123456789";
const CUSTOMER_B = "9876543210987654321";
const STORE_ID = 503542;
const realFetch = globalThis.fetch;

const PATH_DETAIL = "v3/goods/item/getShopGoodsDetail";
const PATH_CREATE = "v3/newPattern/cateringApiserver/post/order/v1/create";
const PATH_READBACK = "v3/order/standard/cyOrderDetail";

function detailFixture(goodsId: string, salePriceFen: number): Record<string, unknown> {
  return {
    status: true,
    code: 0,
    data: [
      {
        goodsId,
        name: "验收测试茶",
        type: 1,
        status: 10,
        goodsSkuList: [
          { skuId: "1288634197263667200", salePrice: salePriceFen, clearStatus: 1, inventory: 99, specName: "标准杯" },
        ],
        sortedPracticeList: [
          {
            practiceId: "1123413139990425601",
            practiceName: "温度",
            practiceValueList: [{ practiceValueId: "1199823927794012164", practiceValue: "少冰", price: 0 }],
          },
        ],
        attachGoodsList: [],
      },
    ],
  };
}

function createOk(orderNo: string): Record<string, unknown> {
  return { status: true, code: 0, message: "创建订单成功", data: { orderNo, payAmount: 24.0, needPay: null } };
}

function readbackOk(userId: string, actualFen: number): Record<string, unknown> {
  return { status: true, code: 0, data: { orderNo: "x", orderStatus: 10, userId, actualAmount: actualFen, discountList: [] } };
}

function installRouter(routes: Record<string, Record<string, unknown> | Array<Record<string, unknown>>>): {
  countOf: (p: string) => number;
  bodiesOf: (p: string) => string[];
  restore: () => void;
} {
  const counts = new Map<string, number>();
  const bodies = new Map<string, string[]>();
  const cursors = new Map<string, number>();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) throw new Error(`mock 路由未覆盖的路径：${url}`);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    (bodies.get(key) ?? bodies.set(key, []).get(key)!).push(String(init?.body ?? ""));
    const route = routes[key];
    let resp: Record<string, unknown>;
    if (Array.isArray(route)) {
      const i = cursors.get(key) ?? 0;
      resp = route[Math.min(i, route.length - 1)];
      cursors.set(key, i + 1);
    } else resp = route;
    return new Response(JSON.stringify(resp), { status: 200 });
  }) as typeof fetch;
  return {
    countOf: (p) => counts.get(p) ?? 0,
    bodiesOf: (p) => bodies.get(p) ?? [],
    restore: () => (globalThis.fetch = realFetch),
  };
}

interface Fx {
  accessAuditPath: string;
  restore: () => void;
}

function installFixture(): Fx {
  const dir = mkdtempSync(join(tmpdir(), "licha-m4-gauntlet-"));
  const accessAuditPath = join(dir, "access-audit.log");
  setWriteGuardForTesting(new WriteGuard({ auditLogPath: join(dir, "write-audit.log"), placedOrdersPath: join(dir, "placed-orders.json") }));
  setPendingOrderStoreForTesting(new PendingOrderStore());
  setSessionStoreForTesting(new SessionStore());
  setAccessAuditLoggerForTesting(new AccessAuditLogger({ logPath: accessAuditPath }));
  setReadAuditLogPathForTesting(join(dir, "read-audit.log"));
  return {
    accessAuditPath,
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

function bindAs(customerId: string): void {
  const store = new SessionStore();
  store.bind(DEFAULT_SESSION_KEY, { customerId, boundAt: Date.now(), boundVia: "phone" });
  setSessionStoreForTesting(store);
}

function textOf(r: { content: Array<{ type: "text"; text: string }> }): string {
  return r.content.map((c) => c.text).join("\n");
}

function tokenFrom(r: { content: Array<{ type: "text"; text: string }> }): string {
  return (JSON.parse(textOf(r)) as { confirmToken: string }).confirmToken;
}

const ITEM = (goodsId: string) => ({ goodsId, practices: ["少冰"], quantity: 1 });

// ---------- G1【跨会话串用】A 的令牌拿到 B 的会话里下单 → 拒且写请求 0 次 ----------
test("G1：用户 A 的待确认令牌在用户 B 的会话里 place → PendingOrderOwnerMismatch 拒，写路径 0 次", async () => {
  const fx = installFixture();
  try {
    bindAs(CUSTOMER_A);
    const router = installRouter({
      [PATH_DETAIL]: detailFixture("9001000000000000001", 2400),
      [PATH_CREATE]: createOk("D-G1-SHOULD-NOT-EXIST"),
    });
    const prep = await prepareOrderHandler({ storeId: STORE_ID, items: [ITEM("9001000000000000001")] });
    assert.equal(prep.isError ?? false, false, `prepare 被误拒：${textOf(prep)}`);
    const token = tokenFrom(prep);

    bindAs(CUSTOMER_B); // 模拟令牌流转到另一个人的会话
    const placed = await placeOrderConfirmedHandler({ confirmToken: token, confirmAmountYuan: 24.0 });
    assert.equal(placed.isError, true);
    assert.match(textOf(placed), /不属于当前绑定的会员/);
    assert.equal(router.countOf(PATH_CREATE), 0, "跨会话串用时写请求绝不能发出");
    router.restore();
  } finally {
    fx.restore();
  }
});

// ---------- G2【金额上限边界】恰好 10000 分放行、10001 分拒（误拒/误放双向） ----------
test("G2a：预估恰好 ¥100.00（上限值）→ prepare 放行、签发令牌", async () => {
  const fx = installFixture();
  try {
    bindAs(CUSTOMER_A);
    const router = installRouter({ [PATH_DETAIL]: detailFixture("9002000000000000001", 2500) });
    const prep = await prepareOrderHandler({
      storeId: STORE_ID,
      items: [{ goodsId: "9002000000000000001", practices: ["少冰"], quantity: 4 }], // 2500×4=10000
    });
    assert.equal(prep.isError ?? false, false, `上限整值被误拒：${textOf(prep)}`);
    assert.ok(tokenFrom(prep).length > 0);
    router.restore();
  } finally {
    fx.restore();
  }
});

test("G2b：预估 ¥100.01 → prepare 拒且不签发令牌", async () => {
  const fx = installFixture();
  try {
    bindAs(CUSTOMER_A);
    const router = installRouter({ [PATH_DETAIL]: detailFixture("9002000000000000002", 10001) });
    const prep = await prepareOrderHandler({
      storeId: STORE_ID,
      items: [{ goodsId: "9002000000000000002", practices: ["少冰"], quantity: 1 }],
    });
    assert.equal(prep.isError, true);
    assert.match(textOf(prep), /超上限/);
    router.restore();
  } finally {
    fx.restore();
  }
});

// ---------- G3【复述金额容差边界】差 1 分放行、差 2 分拒 ----------
test("G3：预估 ¥24.00——复述 23.99（差 1 分）放行，复述 23.98（差 2 分）拒", async () => {
  const fx = installFixture();
  try {
    bindAs(CUSTOMER_A);
    const router = installRouter({
      [PATH_DETAIL]: detailFixture("9003000000000000001", 2400),
      [PATH_CREATE]: createOk("D-G3-OK"),
      [PATH_READBACK]: readbackOk(CUSTOMER_A, 2400),
    });
    const prep1 = await prepareOrderHandler({ storeId: STORE_ID, items: [ITEM("9003000000000000001")] });
    const placed1 = await placeOrderConfirmedHandler({ confirmToken: tokenFrom(prep1), confirmAmountYuan: 23.99 });
    assert.equal(placed1.isError ?? false, false, `容差内复述被误拒：${textOf(placed1)}`);

    const prep2 = await prepareOrderHandler({ storeId: STORE_ID, items: [ITEM("9003000000000000001")] });
    const placed2 = await placeOrderConfirmedHandler({ confirmToken: tokenFrom(prep2), confirmAmountYuan: 23.98 });
    assert.equal(placed2.isError, true);
    assert.match(textOf(placed2), /复述金额与待确认单不一致/);
    assert.equal(router.countOf(PATH_CREATE), 1, "只有容差内那一单发出写请求");
    router.restore();
  } finally {
    fx.restore();
  }
});

// ---------- G4【频次护栏集成】新链路连下 5 单后第 6 单被拒，写请求恰 5 次 ----------
test("G4：prepare+place 链路连下 5 单成功，第 6 单被 DailyLimitExceeded 拒、写请求总数恰 5", async () => {
  const fx = installFixture();
  try {
    bindAs(CUSTOMER_A);
    const router = installRouter({
      [PATH_DETAIL]: detailFixture("9004000000000000001", 2400),
      [PATH_CREATE]: [createOk("D-G4-1"), createOk("D-G4-2"), createOk("D-G4-3"), createOk("D-G4-4"), createOk("D-G4-5")],
      [PATH_READBACK]: readbackOk(CUSTOMER_A, 2400),
    });
    for (let i = 1; i <= 5; i++) {
      const prep = await prepareOrderHandler({ storeId: STORE_ID, items: [ITEM("9004000000000000001")] });
      const placed = await placeOrderConfirmedHandler({ confirmToken: tokenFrom(prep), confirmAmountYuan: 24.0 });
      assert.equal(placed.isError ?? false, false, `第 ${i} 单被误拒：${textOf(placed)}`);
    }
    const prep6 = await prepareOrderHandler({ storeId: STORE_ID, items: [ITEM("9004000000000000001")] });
    assert.equal(prep6.isError ?? false, false, "prepare 不查频次，第 6 张待确认单应能签发");
    const placed6 = await placeOrderConfirmedHandler({ confirmToken: tokenFrom(prep6), confirmAmountYuan: 24.0 });
    assert.equal(placed6.isError, true);
    assert.match(textOf(placed6), /DailyLimitExceeded/);
    assert.equal(router.countOf(PATH_CREATE), 5, "第 6 单的写请求绝不能发出");
    router.restore();
  } finally {
    fx.restore();
  }
});

// ---------- G5【读回归属不符】自己下的单读回 userId 是别人 → readbackFailed，不泄内容 ----------
test("G5：读回响应 userId 为他人 → placed=true 但 readbackFailed，企迈金额不出现，审计留 readback_mismatch", async () => {
  const fx = installFixture();
  try {
    bindAs(CUSTOMER_A);
    const router = installRouter({
      [PATH_DETAIL]: detailFixture("9005000000000000001", 2400),
      [PATH_CREATE]: createOk("D-G5"),
      [PATH_READBACK]: readbackOk(CUSTOMER_B, 9999),
    });
    const prep = await prepareOrderHandler({ storeId: STORE_ID, items: [ITEM("9005000000000000001")] });
    const placed = await placeOrderConfirmedHandler({ confirmToken: tokenFrom(prep), confirmAmountYuan: 24.0 });
    const body = JSON.parse(textOf(placed)) as Record<string, unknown>;
    assert.equal(body.placed, true);
    assert.equal(body.readbackFailed, true);
    assert.ok(!("qmaiActualAmountYuan" in body), "归属不符时读回内容必须整体丢弃");
    assert.ok(!textOf(placed).includes("99.99"), "他人订单的金额不许出现在返回体");
    const log = readFileSync(fx.accessAuditPath, "utf8");
    assert.match(log, /readback_mismatch/);
    router.restore();
  } finally {
    fx.restore();
  }
});

// ---------- G6【发出请求体逐字段核对】userId 无损 19 位、渠道常量、无预约字段、doc168 字段名 ----------
test("G6：写请求体原文——userId 无损数字、orderType=1、source=18、无预约字段、practice 字段名符合 doc168", async () => {
  const fx = installFixture();
  try {
    bindAs(CUSTOMER_A);
    const router = installRouter({
      [PATH_DETAIL]: detailFixture("9006000000000000001", 2400),
      [PATH_CREATE]: createOk("D-G6"),
      [PATH_READBACK]: readbackOk(CUSTOMER_A, 2400),
    });
    const prep = await prepareOrderHandler({ storeId: STORE_ID, items: [ITEM("9006000000000000001")] });
    const placed = await placeOrderConfirmedHandler({ confirmToken: tokenFrom(prep), confirmAmountYuan: 24.0 });
    assert.equal(placed.isError ?? false, false, textOf(placed));
    const body = router.bodiesOf(PATH_CREATE)[0];
    assert.match(body, new RegExp(`"userId":${CUSTOMER_A}[,}]`), "userId 必须以无损 19 位数字形态发出");
    assert.match(body, /"orderType":1[,}]/);
    assert.match(body, /"source":18[,}]/);
    for (const bad of ["isPre", "preTime", "isWaiterCheck", "orderSubType"]) {
      assert.ok(!body.includes(`"${bad}"`), `写请求体不得含预约字段 ${bad}`);
    }
    assert.ok(!body.includes('"practiceId"') && !body.includes('"practiceValueId"'), "practiceList 不得用推断期的旧字段名");
    assert.match(body, /"valueId":/, "practiceList 应含 doc168 的 valueId 字段");
    router.restore();
  } finally {
    fx.restore();
  }
});

// ---------- G7【差额告警取严边界】差额恰等于阈值不告警、超 1 分告警 ----------
test("G7：预估 ¥24.00（阈值=min(¥1, 5%)=¥1）——实付 ¥25.00 不告警，实付 ¥25.01 告警", async () => {
  const fx = installFixture();
  try {
    bindAs(CUSTOMER_A);
    const router = installRouter({
      [PATH_DETAIL]: detailFixture("9007000000000000001", 2400),
      [PATH_CREATE]: [createOk("D-G7-1"), createOk("D-G7-2")],
      [PATH_READBACK]: [readbackOk(CUSTOMER_A, 2500), readbackOk(CUSTOMER_A, 2501)],
    });
    const prep1 = await prepareOrderHandler({ storeId: STORE_ID, items: [ITEM("9007000000000000001")] });
    const placed1 = await placeOrderConfirmedHandler({ confirmToken: tokenFrom(prep1), confirmAmountYuan: 24.0 });
    const body1 = JSON.parse(textOf(placed1)) as Record<string, unknown>;
    assert.ok(!("warning" in body1), `差额恰在阈值上不应告警，实得：${body1.warning}`);
    assert.equal(body1.diffYuan, "1.00");

    const prep2 = await prepareOrderHandler({ storeId: STORE_ID, items: [ITEM("9007000000000000001")] });
    const placed2 = await placeOrderConfirmedHandler({ confirmToken: tokenFrom(prep2), confirmAmountYuan: 24.0 });
    const body2 = JSON.parse(textOf(placed2)) as Record<string, unknown>;
    assert.ok("warning" in body2, "差额超阈值必须告警");
    assert.match(String(body2.warning), /差额/);
    router.restore();
  } finally {
    fx.restore();
  }
});
