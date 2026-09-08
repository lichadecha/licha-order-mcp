// 24 号任务书 A3：同一顾客重新组单后，前一版待确认单作废，旧令牌不能再提交。
//
// 现状（3796619）：PendingOrderStore.register 只 set 新条目；place_order 校验「令牌存在 / 未过期 → 复述金额一致
// → 归属一致」即放行——同价改单（改温度 / 换同价商品）的旧令牌全部通过（盲审 B04）。
// 既有 F4 只覆盖旧 ¥24 / 新 ¥36 被金额门拦，未覆盖同价。
//
// 全 mock；fixture 与 gateG3 同法（临时目录里的 WriteGuard / PendingOrderStore / SessionStore / AccessAudit）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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
const PHONE_A = "13800001234";
const PHONE_B = "13900005678";
const STORE_ID = 503542;
const realFetch = globalThis.fetch;

const PATH_DETAIL = "v3/goods/item/getShopGoodsDetail";
const PATH_CREATE = "v3/newPattern/cateringApiserver/post/order/v1/create";
const PATH_READBACK = "v3/order/standard/cyOrderDetail";

/** 详情 fixture：温度组必选、两个同价可选值（少冰 / 热），这样「改温度」金额不变。 */
function detailFixture(goodsId: string, salePriceFen: number, name = "A3 测试奶茶"): Record<string, unknown> {
  return {
    status: true,
    code: 0,
    data: [
      {
        goodsId,
        name,
        type: 1,
        status: 10,
        goodsSkuList: [{ skuId: "1288634197263667200", salePrice: salePriceFen, clearStatus: 1, inventory: 99, specName: "标准杯" }],
        sortedPracticeList: [
          {
            practiceId: "1123413139990425601",
            practiceName: "温度",
            isRequired: 1,
            practiceValueList: [
              { practiceValueId: "1199823927794012164", practiceValue: "少冰（400ml)", price: 0 },
              { practiceValueId: "1199823927794012165", practiceValue: "热", price: 0 },
            ],
          },
        ],
        attachGoodsList: [],
      },
    ],
  };
}

function createOk(orderNo: string, payYuan: number): Record<string, unknown> {
  return { status: true, code: 0, message: "创建订单成功", data: { orderNo, payAmount: payYuan, needPay: 1 } };
}
function readbackOk(orderNo: string, userId: string, amountFen: number): Record<string, unknown> {
  return { status: true, code: 0, data: { orderNo, orderStatus: 10, userId, actualAmount: amountFen, totalAmount: amountFen, discountList: [] } };
}

function installRouter(routes: Record<string, Record<string, unknown> | Array<Record<string, unknown>>>): {
  countOf: (p: string) => number;
  restore: () => void;
} {
  const counts = new Map<string, number>();
  const cursors = new Map<string, number>();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) throw new Error(`mock 路由未覆盖的路径：${url}`);
    counts.set(key, (counts.get(key) ?? 0) + 1);
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
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

interface Fixture {
  dir: string;
  pendingStore: PendingOrderStore;
  clock: { now: number };
  restore: () => void;
}

function installFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "licha-a3-"));
  const clock = { now: Date.now() };
  const pendingStore = new PendingOrderStore({ clock: () => clock.now });
  setWriteGuardForTesting(new WriteGuard({ auditLogPath: join(dir, "write-audit.log"), placedOrdersPath: join(dir, "placed-orders.json") }));
  setPendingOrderStoreForTesting(pendingStore);
  setSessionStoreForTesting(new SessionStore());
  setAccessAuditLoggerForTesting(new AccessAuditLogger({ logPath: join(dir, "access-audit.log") }));
  setReadAuditLogPathForTesting(join(dir, "read-audit.log"));
  return {
    dir,
    pendingStore,
    clock,
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

function bind(customerId: string, phone: string): void {
  const store = new SessionStore();
  store.bind(DEFAULT_SESSION_KEY, { customerId, boundAt: Date.now(), boundVia: "phone", phone });
  setSessionStoreForTesting(store);
}

function textOf(r: { content: Array<{ type: "text"; text: string }> }): string {
  return r.content.map((c) => c.text).join("\n");
}
function jsonOf(r: { content: Array<{ type: "text"; text: string }> }): any {
  return JSON.parse(textOf(r));
}
function rejectedReasons(fx: Fixture): string[] {
  const p = join(fx.dir, "write-audit.log");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { result: string; reason: string | null })
    .filter((l) => l.result === "rejected")
    .map((l) => l.reason ?? "");
}

const ITEM = (goodsId: string, practice = "少冰（400ml)") => ({ goodsId, practices: [practice], quantity: 1 });

test("A3-1: 同顾客改温度重组（金额相同）→ 旧令牌被拒、理由 PendingOrderSuperseded、写请求 0；新令牌可提交一次", async () => {
  const fx = installFixture();
  bind(CUSTOMER_A, PHONE_A);
  const GOODS = "1300000000000000401";
  const ORDER_NO = "D00280000000000000401";
  const router = installRouter({
    [PATH_DETAIL]: detailFixture(GOODS, 2400),
    [PATH_CREATE]: createOk(ORDER_NO, 24.0),
    [PATH_READBACK]: readbackOk(ORDER_NO, CUSTOMER_A, 2400),
  });
  try {
    const oldPrep = jsonOf(await prepareOrderHandler({ storeId: STORE_ID, items: [ITEM(GOODS, "少冰（400ml)")] }));
    assert.equal(oldPrep.supersededPendingOrders, undefined, "第一张没有可作废的旧单");
    const newPrep = jsonOf(await prepareOrderHandler({ storeId: STORE_ID, items: [ITEM(GOODS, "热")] }));
    assert.equal(newPrep.estimatedTotalYuan, oldPrep.estimatedTotalYuan, "前提：同价改单");
    assert.equal(newPrep.supersededPendingOrders, 1, "新单要报告作废了 1 张旧单");
    assert.match(newPrep.supersedeNote, /作废/);

    const stale = await placeOrderConfirmedHandler({ confirmToken: oldPrep.confirmToken, confirmAmountYuan: 24.0 });
    assert.equal(stale.isError, true, "旧令牌 + 相同金额必须被拒");
    assert.match(textOf(stale), /已被更新的一版替代/);
    assert.equal(router.countOf(PATH_CREATE), 0, "写请求一次都不许发出");
    assert.ok(rejectedReasons(fx).includes("PendingOrderSuperseded"), `写审计要记 PendingOrderSuperseded，实际：${rejectedReasons(fx)}`);

    const fresh = await placeOrderConfirmedHandler({ confirmToken: newPrep.confirmToken, confirmAmountYuan: 24.0 });
    assert.equal(fresh.isError ?? false, false, `新令牌被误拒：${textOf(fresh)}`);
    assert.equal(jsonOf(fresh).placed, true);
    assert.equal(router.countOf(PATH_CREATE), 1);
  } finally {
    router.restore();
    fx.restore();
  }
});

test("A3-2: 同顾客换成另一款同价商品 → 旧令牌同样被替代、写请求 0", async () => {
  const fx = installFixture();
  bind(CUSTOMER_A, PHONE_A);
  const G1 = "1300000000000000402";
  const G2 = "1300000000000000403";
  const router = installRouter({
    [PATH_DETAIL]: [detailFixture(G1, 2400, "甲茶"), detailFixture(G2, 2400, "乙茶")],
    [PATH_CREATE]: createOk("D00280000000000000403", 24.0),
    [PATH_READBACK]: readbackOk("D00280000000000000403", CUSTOMER_A, 2400),
  });
  try {
    const oldPrep = jsonOf(await prepareOrderHandler({ storeId: STORE_ID, items: [ITEM(G1)] }));
    const newPrep = jsonOf(await prepareOrderHandler({ storeId: STORE_ID, items: [ITEM(G2)] }));
    assert.equal(newPrep.supersededPendingOrders, 1);
    const stale = await placeOrderConfirmedHandler({ confirmToken: oldPrep.confirmToken, confirmAmountYuan: 24.0 });
    assert.equal(stale.isError, true);
    assert.match(textOf(stale), /已被更新的一版替代/);
    assert.equal(router.countOf(PATH_CREATE), 0);
  } finally {
    router.restore();
    fx.restore();
  }
});

test("A3-3: 防退化——旧 ¥24 / 新 ¥36，旧令牌配新金额仍被拒、写请求 0；新令牌照常成单", async () => {
  const fx = installFixture();
  bind(CUSTOMER_A, PHONE_A);
  const G1 = "1300000000000000404";
  const G2 = "1300000000000000405";
  const router = installRouter({
    [PATH_DETAIL]: [detailFixture(G1, 2400), detailFixture(G2, 3600)],
    [PATH_CREATE]: createOk("D00280000000000000405", 36.0),
    [PATH_READBACK]: readbackOk("D00280000000000000405", CUSTOMER_A, 3600),
  });
  try {
    const oldPrep = jsonOf(await prepareOrderHandler({ storeId: STORE_ID, items: [ITEM(G1)] }));
    const newPrep = jsonOf(await prepareOrderHandler({ storeId: STORE_ID, items: [ITEM(G2)] }));
    assert.equal(newPrep.estimatedTotalYuan, "36.00");
    const stale = await placeOrderConfirmedHandler({ confirmToken: oldPrep.confirmToken, confirmAmountYuan: 36.0 });
    assert.equal(stale.isError, true);
    assert.equal(router.countOf(PATH_CREATE), 0, "不论理由是哪一道门，写请求必须为 0");
    const fresh = await placeOrderConfirmedHandler({ confirmToken: newPrep.confirmToken, confirmAmountYuan: 36.0 });
    assert.equal(jsonOf(fresh).placed, true);
    assert.equal(router.countOf(PATH_CREATE), 1);
  } finally {
    router.restore();
    fx.restore();
  }
});

test("A3-4: 买完再买——提交成功后再 prepare 不作废已提交的单（supersededPendingOrders 缺省）；重放已提交令牌仍是 TokenAlreadyUsed", async () => {
  const fx = installFixture();
  bind(CUSTOMER_A, PHONE_A);
  const GOODS = "1300000000000000406";
  const router = installRouter({
    [PATH_DETAIL]: detailFixture(GOODS, 2400),
    [PATH_CREATE]: [createOk("D00280000000000000406", 24.0), createOk("D00280000000000000407", 24.0)],
    [PATH_READBACK]: [readbackOk("D00280000000000000406", CUSTOMER_A, 2400), readbackOk("D00280000000000000407", CUSTOMER_A, 2400)],
  });
  try {
    const first = jsonOf(await prepareOrderHandler({ storeId: STORE_ID, items: [ITEM(GOODS)] }));
    const placed1 = await placeOrderConfirmedHandler({ confirmToken: first.confirmToken, confirmAmountYuan: 24.0 });
    assert.equal(jsonOf(placed1).placed, true);

    const second = jsonOf(await prepareOrderHandler({ storeId: STORE_ID, items: [ITEM(GOODS)] }));
    assert.equal(second.supersededPendingOrders, undefined, "已提交的单不是「改主意」，不许被作废");
    assert.equal(second.supersedeNote, undefined);

    const replay = await placeOrderConfirmedHandler({ confirmToken: first.confirmToken, confirmAmountYuan: 24.0 });
    assert.equal(replay.isError, true);
    assert.match(textOf(replay), /TokenAlreadyUsed/, "重放已用令牌的既有理由不许被「被替代」盖住");
    assert.equal(router.countOf(PATH_CREATE), 1, "重放不发写请求");

    const placed2 = await placeOrderConfirmedHandler({ confirmToken: second.confirmToken, confirmAmountYuan: 24.0 });
    assert.equal(jsonOf(placed2).placed, true, "第二次独立购买照常");
    assert.equal(router.countOf(PATH_CREATE), 2);
  } finally {
    router.restore();
    fx.restore();
  }
});

test("A3-5: 两位顾客各自组单 → 互不作废（按 userId 隔离）", async () => {
  const fx = installFixture();
  const GOODS = "1300000000000000408";
  const router = installRouter({ [PATH_DETAIL]: detailFixture(GOODS, 2400) });
  try {
    bind(CUSTOMER_A, PHONE_A);
    const prepA = jsonOf(await prepareOrderHandler({ storeId: STORE_ID, items: [ITEM(GOODS)] }));
    bind(CUSTOMER_B, PHONE_B);
    const prepB = jsonOf(await prepareOrderHandler({ storeId: STORE_ID, items: [ITEM(GOODS)] }));
    assert.equal(prepB.supersededPendingOrders, undefined, "B 的组单不许作废 A 的单");
    assert.equal(fx.pendingStore.lookup(prepA.confirmToken).status, "ok", "A 的待确认单仍然有效");
    assert.equal(fx.pendingStore.lookup(prepB.confirmToken).status, "ok");
  } finally {
    router.restore();
    fx.restore();
  }
});

test("A3-6: 过期优先于被替代——旧单既过期又被替代时，lookup 与 place_order 仍报「过期」", async () => {
  const fx = installFixture();
  bind(CUSTOMER_A, PHONE_A);
  const GOODS = "1300000000000000409";
  const router = installRouter({ [PATH_DETAIL]: detailFixture(GOODS, 2400) });
  try {
    const oldPrep = jsonOf(await prepareOrderHandler({ storeId: STORE_ID, items: [ITEM(GOODS)] }));
    fx.clock.now += 6 * 60_000; // 令牌 TTL 5 分钟
    const newPrep = jsonOf(await prepareOrderHandler({ storeId: STORE_ID, items: [ITEM(GOODS, "热")] }));
    // register 顺手 prune 了过期条目 → 旧单已被物理清除，不会被算进「作废」数
    assert.equal(newPrep.supersededPendingOrders, undefined, "过期单在 register 时已被 prune，不计作废");
    const stale = await placeOrderConfirmedHandler({ confirmToken: oldPrep.confirmToken, confirmAmountYuan: 24.0 });
    assert.equal(stale.isError, true);
    assert.match(textOf(stale), /已过期|无效/, "过期 / 已清除的既有理由不变");
    assert.doesNotMatch(textOf(stale), /已被更新的一版替代/);
    assert.equal(router.countOf(PATH_CREATE), 0);
  } finally {
    router.restore();
    fx.restore();
  }
});
