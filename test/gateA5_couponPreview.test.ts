// 24 号任务书 A5（B1 券确认页第一步）：组单时查券、事前告知、下单读回后比对。
//
// 施工令 §8-47：企迈后端对无券指令单默认用券、Agent 单没有确认页；2026-09-08 侦察单预估 ¥26 → 实付 ¥0，
// Agent 只能事后报「金额对不上」。本步让 prepare 用 5.1.7 问企迈「本单能用哪些券、各抵多少」，预测系统默认会用
// 的那张并写进待确认单；place_order 读回后与实际用券比对。只读、不指定券、不核销、失败不阻塞。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setReadAuditLogPathForTesting } from "../src/client.js";
import { READONLY_WHITELIST, READONLY_WHITELIST_PHASE2, WRITE_WHITELIST } from "../src/constants.js";
import { WriteGuard, setWriteGuardForTesting } from "../src/writeGuard.js";
import { SessionStore, setSessionStoreForTesting, DEFAULT_SESSION_KEY } from "../src/session.js";
import { AccessAuditLogger, setAccessAuditLoggerForTesting } from "../src/accessAudit.js";
import { PendingOrderStore, setPendingOrderStoreForTesting } from "../src/pendingOrders.js";
import { prepareOrderHandler } from "../src/prepareOrderTool.js";
import { placeOrderConfirmedHandler } from "../src/placeOrderTool.js";
import { predictCoupon } from "../src/couponPreview.js";

process.env.QMAI_OPEN_KEY ??= "test-open-key-0123456789abcdef0123456789ab";
process.env.QMAI_OPEN_ID ??= "test-open-id-0000000000000000";
process.env.QMAI_GRANT_CODE ??= "test-grant-code-0000000000";

const CUSTOMER = "1234567890123456789";
const PHONE = "13800001234";
const STORE_ID = 503542; // 编码表：05 深圳湾万象城
const GOODS = "1300000000000000501";
const realFetch = globalThis.fetch;

const PATH_DETAIL = "v3/goods/item/getShopGoodsDetail";
const PATH_COUPON = "v3/bsns/customer/chooseCouponAsOne";
const PATH_CREATE = "v3/newPattern/cateringApiserver/post/order/v1/create";
const PATH_READBACK = "v3/order/standard/cyOrderDetail";

function detailFixture(goodsId: string, salePriceFen: number): Record<string, unknown> {
  return {
    status: true,
    code: 0,
    data: [
      {
        goodsId,
        name: "A5 测试奶茶",
        type: 1,
        status: 10,
        goodsSkuList: [{ skuId: "1288634197263667200", salePrice: salePriceFen, clearStatus: 1, inventory: 99, specName: "标准杯" }],
        sortedPracticeList: [
          { practiceId: "1123413139990425601", practiceName: "温度", isRequired: 1, practiceValueList: [{ practiceValueId: "1199823927794012164", practiceValue: "少冰（400ml)", price: 0 }] },
        ],
        attachGoodsList: [],
      },
    ],
  };
}

/** 5.1.7 响应行（实测字段：title / unUseStatus / unUseDesc / userCouponCanDisAmount(元) / cardId / couponCenterType）。 */
function couponRow(title: string, usable: boolean, canDisYuan: number, type: number, reason?: string): Record<string, unknown> {
  return {
    title,
    unUseStatus: usable ? 1 : 0,
    unUseDesc: usable ? null : (reason ?? "不满足使用门槛"),
    userCouponCanDisAmount: canDisYuan,
    couponCenterType: type,
    cardId: "9900000000000000777",
    customerId: CUSTOMER,
  };
}
const couponsOk = (rows: Array<Record<string, unknown>>) => ({ status: true, code: 0, data: rows });

interface Router {
  countOf: (p: string) => number;
  lastBodyOf: (p: string) => string | undefined;
  restore: () => void;
}
function installRouter(routes: Record<string, Record<string, unknown> | Array<Record<string, unknown>> | (() => never)>): Router {
  const counts = new Map<string, number>();
  const bodies = new Map<string, string>();
  const cursors = new Map<string, number>();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) throw new Error(`mock 路由未覆盖的路径：${url}`);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (typeof init?.body === "string") bodies.set(key, init.body);
    const route = routes[key];
    if (typeof route === "function") route();
    let resp: Record<string, unknown>;
    if (Array.isArray(route)) {
      const i = cursors.get(key) ?? 0;
      resp = route[Math.min(i, route.length - 1)];
      cursors.set(key, i + 1);
    } else resp = route as Record<string, unknown>;
    return new Response(JSON.stringify(resp), { status: 200 });
  }) as typeof fetch;
  return {
    countOf: (p) => counts.get(p) ?? 0,
    lastBodyOf: (p) => bodies.get(p),
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

interface Fixture {
  pendingStore: PendingOrderStore;
  restore: () => void;
}
function installFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "licha-a5-"));
  const pendingStore = new PendingOrderStore();
  setWriteGuardForTesting(new WriteGuard({ auditLogPath: join(dir, "write-audit.log"), placedOrdersPath: join(dir, "placed-orders.json") }));
  setPendingOrderStoreForTesting(pendingStore);
  const sessions = new SessionStore();
  sessions.bind(DEFAULT_SESSION_KEY, { customerId: CUSTOMER, boundAt: Date.now(), boundVia: "phone", phone: PHONE });
  setSessionStoreForTesting(sessions);
  setAccessAuditLoggerForTesting(new AccessAuditLogger({ logPath: join(dir, "access-audit.log") }));
  setReadAuditLogPathForTesting(join(dir, "read-audit.log"));
  return {
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

function textOf(r: { content: Array<{ type: "text"; text: string }> }): string {
  return r.content.map((c) => c.text).join("\n");
}
function jsonOf(r: { content: Array<{ type: "text"; text: string }> }): any {
  return JSON.parse(textOf(r));
}
const ITEM = { goodsId: GOODS, practices: ["少冰（400ml)"], quantity: 1 };
const readbackWith = (orderNo: string, actualFen: number, discounts: Array<Record<string, unknown>>) => ({
  status: true,
  code: 0,
  data: { orderNo, orderStatus: 10, userId: CUSTOMER, actualAmount: actualFen, totalAmount: 2400, discountList: discounts },
});
const discount = (summary: string, fen: number) => ({ discountName: "优惠券", discountSummary: summary, discountAmount: fen, discountType: 2, discountId: "8800000000000000123", extraMap: {} });

test("A5-1: 有可用券 → 预测取「自动生效」类里抵扣最大的，念单 note 带券名与券后实付；读回用同一张 → matchesPrediction=true", async () => {
  const fx = installFixture();
  const ORDER_NO = "D00280000000000000501";
  const router = installRouter({
    [PATH_DETAIL]: detailFixture(GOODS, 2400),
    [PATH_COUPON]: couponsOk([
      couponRow("100元代金券", true, 24.0, 1), // type=1 普通券，抵扣最大但不是自动生效类
      couponRow("单杯任意饮品5折券", true, 12.0, 2),
      couponRow("单杯任意饮品8折券", true, 4.8, 2),
      couponRow("满50减10", false, 0, 1, "未达到使用门槛"),
    ]),
    [PATH_CREATE]: { status: true, code: 0, data: { orderNo: ORDER_NO, payAmount: 12.0, needPay: 1 } },
    [PATH_READBACK]: readbackWith(ORDER_NO, 1200, [discount("单杯任意饮品5折券:¥12.00", 1200)]),
  });
  try {
    const prep = jsonOf(await prepareOrderHandler({ storeId: STORE_ID, items: [ITEM] }));
    assert.equal(prep.coupons.available, true);
    assert.equal(prep.coupons.usable.length, 3);
    assert.deepEqual(prep.coupons.unusable, [{ title: "满50减10", reason: "未达到使用门槛" }]);
    assert.equal(prep.coupons.predicted.title, "单杯任意饮品5折券", "8-25 两枪实测：自动核销的是 type=2 里抵扣最大的，不是全局最大的 100 元代金券");
    assert.equal(prep.coupons.predicted.basis, "auto_type");
    assert.equal(prep.coupons.predicted.canDisYuan, "12.00");
    assert.equal(prep.coupons.predicted.payAfterYuan, "12.00");
    assert.match(prep.coupons.note, /单杯任意饮品5折券/);
    assert.match(prep.note, /coupons\.predicted/, "组单 note 要教 Agent 什么时候提券");
    assert.equal(prep.estimatedTotalYuan, "24.00", "合计仍是券前预估");
    const pending = fx.pendingStore.lookup(prep.confirmToken);
    assert.equal(pending.status, "ok");
    assert.deepEqual((pending as any).order.predictedCoupon, { title: "单杯任意饮品5折券", canDisFen: 1200 });

    const placed = jsonOf(await placeOrderConfirmedHandler({ confirmToken: prep.confirmToken, confirmAmountYuan: 24.0 }));
    assert.equal(placed.placed, true);
    assert.equal(placed.couponApplied.matchesPrediction, true);
    assert.equal(placed.couponApplied.items[0].amountYuan, "12.00");
    assert.match(placed.couponApplied.note, /一致/);
    assert.match(placed.nextStep, /couponApplied/);
    assert.ok(placed.warning, "差额告警照旧触发（¥12 vs ¥24）——券解释与差额告警并存");
  } finally {
    router.restore();
    fx.restore();
  }
});

test("A5-2: 没有自动生效类券 → 退回全部可用券里抵扣最大的，basis=max_discount；纯函数 predictCoupon 同口径", async () => {
  const fx = installFixture();
  const router = installRouter({
    [PATH_DETAIL]: detailFixture(GOODS, 2400),
    [PATH_COUPON]: couponsOk([couponRow("3元无门槛", true, 3.0, 1), couponRow("100元代金券", true, 24.0, 1)]),
  });
  try {
    const prep = jsonOf(await prepareOrderHandler({ storeId: STORE_ID, items: [ITEM] }));
    assert.equal(prep.coupons.predicted.title, "100元代金券");
    assert.equal(prep.coupons.predicted.basis, "max_discount");
    assert.equal(prep.coupons.predicted.payAfterYuan, "0.00", "抵扣 ≥ 合计时实付封在 0");
    assert.equal(predictCoupon([{ title: "a", canDisYuan: "0.00" }], 2400), undefined, "抵扣全为 0 不预测");
  } finally {
    router.restore();
    fx.restore();
  }
});

test("A5-3: 券全部不可用 / 空列表 → usable 空、predicted 缺省、note 明说不提券；待确认单不带 predictedCoupon", async () => {
  const fx = installFixture();
  const router = installRouter({
    [PATH_DETAIL]: detailFixture(GOODS, 2400),
    [PATH_COUPON]: [couponsOk([couponRow("生日8折券", false, 0, 2, "不在有效期")]), couponsOk([])],
  });
  try {
    const first = jsonOf(await prepareOrderHandler({ storeId: STORE_ID, items: [ITEM] }));
    assert.equal(first.coupons.available, true);
    assert.equal(first.coupons.usable.length, 0);
    assert.equal(first.coupons.unusable[0].reason, "不在有效期");
    assert.equal(first.coupons.predicted, undefined);
    assert.match(first.coupons.note, /不用提券/);
    assert.equal((fx.pendingStore.lookup(first.confirmToken) as any).order.predictedCoupon, undefined);
    const second = jsonOf(await prepareOrderHandler({ storeId: STORE_ID, items: [ITEM] }));
    assert.equal(second.coupons.usable.length, 0);
    assert.match(second.coupons.note, /没有可用于本单的券/);
  } finally {
    router.restore();
    fx.restore();
  }
});

test("A5-4: 5.1.7 业务失败或传输抛错 → available=false、组单照常签令牌、只尝试 1 次不退避", async () => {
  const fx = installFixture();
  const router = installRouter({
    [PATH_DETAIL]: detailFixture(GOODS, 2400),
    [PATH_COUPON]: [{ status: false, code: 500, message: "mock down" }],
  });
  try {
    const t0 = Date.now();
    const prep = jsonOf(await prepareOrderHandler({ storeId: STORE_ID, items: [ITEM] }));
    assert.ok(prep.confirmToken, "查券失败绝不阻塞组单");
    assert.equal(prep.coupons.available, false);
    assert.match(prep.coupons.note, /没查到/);
    assert.equal(router.countOf(PATH_COUPON), 1, "业务失败不重试");
    assert.ok(Date.now() - t0 < 900, "不能因为查券失败多等一轮退避（1s+）");
  } finally {
    router.restore();
  }
  // 传输层抛错（路由里根本没有 5.1.7，与既有 prepare 用例的形态相同）
  const router2 = installRouter({ [PATH_DETAIL]: detailFixture(GOODS, 2400) });
  try {
    const t0 = Date.now();
    const prep = jsonOf(await prepareOrderHandler({ storeId: STORE_ID, items: [ITEM] }));
    assert.ok(prep.confirmToken);
    assert.equal(prep.coupons.available, false);
    assert.ok(Date.now() - t0 < 900, "抛错也只试一次");
  } finally {
    router2.restore();
    fx.restore();
  }
});

test("A5-5: 请求体形态——customerId 与 tradeMark 以 JSON 数字发出（大数还原）、multiMark 是编码表里的 shopCode、price 为元", async () => {
  const fx = installFixture();
  const router = installRouter({
    [PATH_DETAIL]: detailFixture(GOODS, 2400),
    [PATH_COUPON]: couponsOk([]),
  });
  try {
    await prepareOrderHandler({ storeId: STORE_ID, items: [{ ...ITEM, quantity: 2 }] });
    const body = router.lastBodyOf(PATH_COUPON) ?? "";
    assert.match(body, new RegExp(`"customerId":${CUSTOMER}[,}]`), "customerId 必须是 19 位数字字面量");
    assert.match(body, new RegExp(`"tradeMark":${GOODS}[,}]`), "tradeMark 必须是 19 位数字字面量（与 8-25 实测同形）");
    assert.match(body, /"multiMark":"05"/);
    assert.match(body, /"typeCate":1/);
    assert.match(body, /"num":2/);
    assert.match(body, /"price":24[,}]/, "price 单位元");
    assert.doesNotMatch(body, /"storeId"/, "5.1.7 门店定位不用 storeId");
  } finally {
    router.restore();
    fx.restore();
  }
});

test("A5-6: 出参不带 cardId / customerId 等上游原始字段（B05 精神）", async () => {
  const fx = installFixture();
  const router = installRouter({
    [PATH_DETAIL]: detailFixture(GOODS, 2400),
    [PATH_COUPON]: couponsOk([couponRow("单杯任意饮品5折券", true, 12.0, 2)]),
  });
  try {
    const raw = textOf(await prepareOrderHandler({ storeId: STORE_ID, items: [ITEM] }));
    assert.doesNotMatch(raw, /cardId/);
    assert.doesNotMatch(raw, /9900000000000000777/);
    assert.doesNotMatch(raw, new RegExp(CUSTOMER));
    assert.doesNotMatch(raw, /unUseStatus|userCouponCanDisAmount/, "只投影，不透传原始字段名");
  } finally {
    router.restore();
    fx.restore();
  }
});

test("A5-7: 读回比对——预测 A 实际用 B → matchesPrediction=false 且 note 要求更正；预测了却没用券 → 同样 false；没预测却用了券 → 提示「系统自动用了券」", async () => {
  const fx = installFixture();
  const orders = ["D00280000000000000507", "D00280000000000000508", "D00280000000000000509"];
  const router = installRouter({
    [PATH_DETAIL]: detailFixture(GOODS, 2400),
    [PATH_COUPON]: [
      couponsOk([couponRow("单杯任意饮品5折券", true, 12.0, 2)]),
      couponsOk([couponRow("单杯任意饮品5折券", true, 12.0, 2)]),
      { status: false, code: 500, message: "down" },
    ],
    [PATH_CREATE]: orders.map((o) => ({ status: true, code: 0, data: { orderNo: o, payAmount: 12.0, needPay: 1 } })),
    [PATH_READBACK]: [
      readbackWith(orders[0], 0, [discount("100元代金券:¥24.00", 2400)]),
      readbackWith(orders[1], 2400, []),
      readbackWith(orders[2], 1200, [discount("单杯任意饮品5折券:¥12.00", 1200)]),
    ],
  });
  try {
    const p1 = jsonOf(await prepareOrderHandler({ storeId: STORE_ID, items: [ITEM] }));
    const r1 = jsonOf(await placeOrderConfirmedHandler({ confirmToken: p1.confirmToken, confirmAmountYuan: 24.0 }));
    assert.equal(r1.couponApplied.matchesPrediction, false);
    assert.match(r1.couponApplied.note, /不一致/);
    assert.match(r1.couponApplied.note, /100元代金券/);

    const p2 = jsonOf(await prepareOrderHandler({ storeId: STORE_ID, items: [ITEM] }));
    const r2 = jsonOf(await placeOrderConfirmedHandler({ confirmToken: p2.confirmToken, confirmAmountYuan: 24.0 }));
    assert.equal(r2.couponApplied.matchesPrediction, false);
    assert.match(r2.couponApplied.note, /没有任何优惠/);
    assert.equal(r2.warning, undefined, "实付 = 预估，不该有差额告警");

    const p3 = jsonOf(await prepareOrderHandler({ storeId: STORE_ID, items: [ITEM] }));
    assert.equal(p3.coupons.available, false);
    const r3 = jsonOf(await placeOrderConfirmedHandler({ confirmToken: p3.confirmToken, confirmAmountYuan: 24.0 }));
    assert.equal(r3.couponApplied.matchesPrediction, undefined);
    assert.match(r3.couponApplied.note, /系统自动用了你的券/);
    assert.doesNotMatch(textOf({ content: [{ type: "text", text: JSON.stringify(r3.couponApplied) }] }), /8800000000000000123|extraMap/, "discountId / extraMap 不进投影");
  } finally {
    router.restore();
    fx.restore();
  }
});

test("A5-8: 白名单——5.1.7 进二期只读名单（5 条）、不进写名单；一期 7 条一字不动", async () => {
  assert.ok(READONLY_WHITELIST_PHASE2.includes(PATH_COUPON));
  assert.equal(READONLY_WHITELIST_PHASE2.length, 5);
  assert.ok(!WRITE_WHITELIST.includes(PATH_COUPON));
  assert.equal(WRITE_WHITELIST.length, 1, "写白名单仍只有 6.2.9 一条（DoD 第 7 条）");
  assert.equal(READONLY_WHITELIST.length, 7);
  assert.ok(!READONLY_WHITELIST.includes(PATH_COUPON), "一期名单不动，二期接口只进 PHASE2");
});
