// G3 收口门：确认单必须用本轮真读到的价格与可售状态（任务书 23 号 §3 G3）。
//
// 缺陷形态（盲审 B03 / 22 号 F06）：浏览缓存里 ¥20，本轮详情已经是 ¥120，
// prepare_order 仍按缓存价 ¥20 签出一张能提交的令牌，创建后读回才发现金额不对——
// 那时单子已经真的下出去了。根因是详情被读了两次、且算价用的是带缓存的那一次。
//
// 🚨 红线自证（体例沿用 m4ConfirmOrder.test.ts）：
//   ① globalThis.fetch 整体替换成按路径分发的 mock 路由器，绝无真实 HTTP 请求；
//   ② 写路径（6.2.9 创建订单）单独计数，逐条用例断言；
//   ③ 五件套注入全部指向 mkdtemp 临时目录，不碰生产 logs/；
//   ④ 识别值全用假值（手机号中段全零、19 位假会员 ID）。
//
// getItemDetail 的模块级缓存（5 分钟）跨用例复用同一个 storeId:goodsId，
// 所以每条用例用各自独立的 goodsId；需要「先有旧缓存」的用例才刻意先调一次 getItemDetail。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setReadAuditLogPathForTesting } from "../src/client.js";
import { WriteGuard, setWriteGuardForTesting } from "../src/writeGuard.js";
import { SessionStore, setSessionStoreForTesting, DEFAULT_SESSION_KEY } from "../src/session.js";
import { AccessAuditLogger, setAccessAuditLoggerForTesting } from "../src/accessAudit.js";
import { PendingOrderStore, setPendingOrderStoreForTesting } from "../src/pendingOrders.js";
import { getItemDetail } from "../src/tools/getItemDetail.js";
import { prepareOrderHandler } from "../src/prepareOrderTool.js";
import { placeOrderConfirmedHandler } from "../src/placeOrderTool.js";

process.env.QMAI_OPEN_KEY ??= "test-open-key-0123456789abcdef0123456789ab";
process.env.QMAI_OPEN_ID ??= "test-open-id-0000000000000000";
process.env.QMAI_GRANT_CODE ??= "test-grant-code-0000000000";

const FAKE_CUSTOMER_ID = "1234567890123456789";
const FAKE_PHONE = "13800001234";
const STORE_ID = 503542;
const realFetch = globalThis.fetch;

const PATH_DETAIL = "v3/goods/item/getShopGoodsDetail";
const PATH_CREATE = "v3/newPattern/cateringApiserver/post/order/v1/create";
const PATH_READBACK = "v3/order/standard/cyOrderDetail";

/** 商品详情 fixture。必选温度组一直在（G4 之后仍成立），所以每条用例都显式传做法。 */
function detailFixture(
  goodsId: string,
  salePriceFen: number,
  opts: { status?: number; clearStatus?: number } = {},
): Record<string, unknown> {
  return {
    status: true,
    code: 0,
    data: [
      {
        goodsId,
        name: "G3 测试奶茶",
        type: 1,
        status: opts.status ?? 10,
        goodsSkuList: [
          {
            skuId: "1288634197263667200",
            salePrice: salePriceFen,
            clearStatus: opts.clearStatus ?? 1,
            inventory: 99,
            specName: "标准杯",
          },
        ],
        sortedPracticeList: [
          {
            practiceId: "1123413139990425601",
            practiceName: "温度",
            isRequired: 1,
            practiceValueList: [{ practiceValueId: "1199823927794012164", practiceValue: "少冰（400ml)", price: 0, isDefault: 1 }],
          },
        ],
        attachGoodsList: [],
      },
    ],
  };
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
    if (!key) throw new Error(`mock 路由未覆盖的路径（代码调了预期之外的接口）：${url}`);
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
  pendingStore: PendingOrderStore;
  restore: () => void;
}

function installFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "licha-g3-"));
  const pendingStore = new PendingOrderStore();
  setWriteGuardForTesting(
    new WriteGuard({ auditLogPath: join(dir, "write-audit.log"), placedOrdersPath: join(dir, "placed-orders.json") }),
  );
  setPendingOrderStoreForTesting(pendingStore);
  setSessionStoreForTesting(new SessionStore());
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

function bindSession(): void {
  const store = new SessionStore();
  store.bind(DEFAULT_SESSION_KEY, { customerId: FAKE_CUSTOMER_ID, boundAt: Date.now(), boundVia: "phone", phone: FAKE_PHONE });
  setSessionStoreForTesting(store);
}

function textOf(r: { content: Array<{ type: "text"; text: string }> }): string {
  return r.content.map((c) => c.text).join("\n");
}

function jsonOf(r: { content: Array<{ type: "text"; text: string }> }): any {
  return JSON.parse(textOf(r));
}

const ITEM = (goodsId: string, quantity = 1) => ({ goodsId, practices: ["少冰（400ml)"], quantity });

// ============================================================================
// G3-1（任务书验收反例 1）：缓存 ¥20、本轮 ¥120 → 按 ¥120 撞金额上限被拒，不存在 ¥20 令牌
// ============================================================================
test("G3-1: 浏览缓存 ¥20、本轮详情 ¥120 → 确认门按 ¥120 判定并被单笔上限拒，pending 零登记、无可提交的 ¥20 令牌", async () => {
  const fx = installFixture();
  bindSession();
  const GOODS = "1300000000000000301";
  // 队列语义：第一次读（浏览预热）给 ¥20，第二次读（prepare 本轮）给 ¥120。
  const router = installRouter({ [PATH_DETAIL]: [detailFixture(GOODS, 2000), detailFixture(GOODS, 12000)] });
  try {
    const browsed = await getItemDetail(STORE_ID, GOODS);
    assert.equal(browsed.skus[0].priceYuan, "20.00", "前置条件：缓存里先是旧价 ¥20");

    const r = await prepareOrderHandler({ storeId: STORE_ID, items: [ITEM(GOODS)] });
    assert.equal(r.isError, true, "本轮 ¥120 超单笔上限，必须在 prepare 阶段就拒");
    assert.match(textOf(r), /单笔金额超上限/);
    assert.match(textOf(r), /120\.00/, "判定用的是本轮价 ¥120");
    assert.doesNotMatch(textOf(r), /¥20\.00/, "不许出现按缓存价 ¥20 的金额口径");
    assert.equal(fx.pendingStore.size(), 0, "🚨 不存在任何可提交的令牌（更不许是 ¥20 那张）");
    assert.equal(router.countOf(PATH_CREATE), 0, "拒绝时写路径一次都不许碰");
    assert.equal(router.countOf(PATH_DETAIL), 2, "浏览 1 次 + 本轮 1 次；本轮读的是真读、不是缓存");

    // 浏览缓存没被废掉，而是被本轮真读刷新了：再浏览一次不再打接口，拿到的是新价。
    const browsedAgain = await getItemDetail(STORE_ID, GOODS);
    assert.equal(router.countOf(PATH_DETAIL), 2, "缓存仍在工作（浏览没有再打接口）");
    assert.equal(browsedAgain.skus[0].priceYuan, "120.00", "缓存被本轮真读刷新成新价");
  } finally {
    router.restore();
    fx.restore();
  }
});

test("G3-1 附: 缓存 ¥20、本轮 ¥40（未超上限）→ 确认单按 ¥40 组单，登记金额也是 4000 分", async () => {
  const fx = installFixture();
  bindSession();
  const GOODS = "1300000000000000302";
  const router = installRouter({ [PATH_DETAIL]: [detailFixture(GOODS, 2000), detailFixture(GOODS, 4000)] });
  try {
    await getItemDetail(STORE_ID, GOODS);
    const r = await prepareOrderHandler({ storeId: STORE_ID, items: [ITEM(GOODS)] });
    assert.equal(r.isError ?? false, false, `合法单被误拒：${textOf(r)}`);
    const out = jsonOf(r);
    assert.equal(out.estimatedTotalYuan, "40.00", "念给顾客的金额必须是本轮价");
    assert.equal(out.lines[0].unitPriceYuan, "40.00");
    const lookup = fx.pendingStore.lookup(out.confirmToken);
    assert.equal(lookup.status, "ok");
    if (lookup.status !== "ok") return;
    assert.equal(lookup.order.estimatedAmountFen, 4000, "登记的金额是本轮价，不是缓存价 2000");
  } finally {
    router.restore();
    fx.restore();
  }
});

// ============================================================================
// G3-2（任务书验收反例 2）：本轮已知估清 / 下架 → 不签令牌
// ============================================================================
test("G3-2: 缓存在售、本轮详情估清（clearStatus=0）→ 不签令牌、pending 零登记、写路径 0 次", async () => {
  const fx = installFixture();
  bindSession();
  const GOODS = "1300000000000000303";
  const router = installRouter({
    [PATH_DETAIL]: [detailFixture(GOODS, 2400), detailFixture(GOODS, 2400, { clearStatus: 0 })],
  });
  try {
    const browsed = await getItemDetail(STORE_ID, GOODS);
    assert.equal(browsed.available, true, "前置条件：缓存里这杯还在售");

    const r = await prepareOrderHandler({ storeId: STORE_ID, items: [ITEM(GOODS)] });
    assert.equal(r.isError, true, "本轮已估清，不许签令牌");
    assert.match(textOf(r), /估清/);
    assert.equal(fx.pendingStore.size(), 0, "🚨 估清的商品不许留下任何可提交的令牌");
    assert.equal(router.countOf(PATH_CREATE), 0);
  } finally {
    router.restore();
    fx.restore();
  }
});

test("G3-2 附: 缓存在售、本轮详情下架（status=20）→ 不签令牌、pending 零登记、写路径 0 次", async () => {
  const fx = installFixture();
  bindSession();
  const GOODS = "1300000000000000304";
  const router = installRouter({
    [PATH_DETAIL]: [detailFixture(GOODS, 2400), detailFixture(GOODS, 2400, { status: 20 })],
  });
  try {
    const browsed = await getItemDetail(STORE_ID, GOODS);
    assert.equal(browsed.available, true, "前置条件：缓存里这杯还在售");

    const r = await prepareOrderHandler({ storeId: STORE_ID, items: [ITEM(GOODS)] });
    assert.equal(r.isError, true, "本轮已下架，不许签令牌");
    assert.match(textOf(r), /已下架/);
    assert.equal(fx.pendingStore.size(), 0);
    assert.equal(router.countOf(PATH_CREATE), 0);
  } finally {
    router.restore();
    fx.restore();
  }
});

// ============================================================================
// G3-3（任务书验收反例 3）：一次 prepare 里同一商品的详情只读 1 次
// ============================================================================
test("G3-3: 冷缓存下单商品一次 prepare → 详情路径恰好 1 次（不再为算价、补 ID 各查一次）", async () => {
  const fx = installFixture();
  bindSession();
  const GOODS = "1300000000000000305";
  const router = installRouter({ [PATH_DETAIL]: detailFixture(GOODS, 2400) });
  try {
    const r = await prepareOrderHandler({ storeId: STORE_ID, items: [ITEM(GOODS)] });
    assert.equal(r.isError ?? false, false, `组单应成功：${textOf(r)}`);
    assert.equal(router.countOf(PATH_DETAIL), 1, "🚨 算价与 ID 映射必须同出一次真读");
  } finally {
    router.restore();
    fx.restore();
  }
});

test("G3-3 附: 两行不同商品 → 详情 2 次（每个商品各真读一次，不合并也不重复）；同商品两行 → 仍 1 次", async () => {
  const fx = installFixture();
  bindSession();
  const A = "1300000000000000306";
  const B = "1300000000000000307";
  const routerTwo = installRouter({ [PATH_DETAIL]: [detailFixture(A, 2400), detailFixture(B, 2400)] });
  try {
    const r = await prepareOrderHandler({ storeId: STORE_ID, items: [ITEM(A), ITEM(B)] });
    assert.equal(r.isError ?? false, false, `两行组单应成功：${textOf(r)}`);
    assert.equal(routerTwo.countOf(PATH_DETAIL), 2, "两个商品各真读一次");
  } finally {
    routerTwo.restore();
  }

  const C = "1300000000000000308";
  const routerSame = installRouter({ [PATH_DETAIL]: detailFixture(C, 2400) });
  try {
    const r = await prepareOrderHandler({ storeId: STORE_ID, items: [ITEM(C), ITEM(C, 2)] });
    assert.equal(r.isError ?? false, false, `同款两行组单应成功：${textOf(r)}`);
    assert.equal(jsonOf(r).lines.length, 2, "同款两行不许合并");
    assert.equal(routerSame.countOf(PATH_DETAIL), 1, "同一商品在同一轮里只真读一次");
  } finally {
    routerSame.restore();
    fx.restore();
  }
});

// ============================================================================
// G3-4（任务书验收反例 4，防退化）：创建后读回金额与确认金额不一致 → 差额告警仍触发
// ============================================================================
test("G3-4: 全链路下单后 6.1.9 读回 ¥26 与确认 ¥24 不一致 → 原差额告警仍触发，写请求恰好 1 次", async () => {
  const fx = installFixture();
  bindSession();
  const GOODS = "1300000000000000309";
  const ORDER_NO = "D00280000000000000309";
  const router = installRouter({
    [PATH_DETAIL]: detailFixture(GOODS, 2400),
    [PATH_CREATE]: { status: true, code: 0, message: "创建订单成功", data: { orderNo: ORDER_NO, payAmount: 24.0, needPay: 1 } },
    [PATH_READBACK]: {
      status: true,
      code: 0,
      data: { orderNo: ORDER_NO, orderStatus: 10, userId: FAKE_CUSTOMER_ID, actualAmount: 2600, totalAmount: 2600, discountList: [] },
    },
  });
  try {
    const prep = await prepareOrderHandler({ storeId: STORE_ID, items: [ITEM(GOODS)] });
    assert.equal(prep.isError ?? false, false, `组单应成功：${textOf(prep)}`);
    const placed = await placeOrderConfirmedHandler({ confirmToken: jsonOf(prep).confirmToken, confirmAmountYuan: 24.0 });
    const out = jsonOf(placed);
    assert.equal(out.placed, true);
    assert.equal(out.estimatedTotalYuan, "24.00");
    assert.equal(out.qmaiActualAmountYuan, "26.00");
    assert.equal(out.diffYuan, "2.00");
    assert.ok(typeof out.warning === "string" && out.warning.length > 0, "差额 ¥2 必须仍触发 warning");
    assert.match(out.warning, /金额与预估不一致/);
    assert.equal(router.countOf(PATH_CREATE), 1, "写请求恰好一次，绝不重试");
  } finally {
    router.restore();
    fx.restore();
  }
});
