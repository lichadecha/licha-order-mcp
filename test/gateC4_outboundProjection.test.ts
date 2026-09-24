// 25 号任务书 C4（盲审 B05）：MCP 外部出口投影。
//
// 日志层脱敏（P-W2）早就齐了，漏的是**返回给客户端**那一侧：企迈 message 原样拼进出参、place_order 把读回的
// discountList 整个带出。盲审合成的假手机号 / customerId / `openKey=` 片段都能从这些口子进 MCP JSON。
// 本文件：① 纯函数规则；② place_order 出参只剩 couponApplied 投影；③ 上游 message 在全部出口被遮蔽、我们自己的
// hint 仍在；④ 出口投影不依赖写开关。全 mock、零真实请求、测试落盘一律在 mkdtemp 临时目录。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectUpstreamMessage } from "../src/outboundText.js";
import { setReadAuditLogPathForTesting } from "../src/client.js";
import { WriteGuard, setWriteGuardForTesting } from "../src/writeGuard.js";
import { SessionStore, setSessionStoreForTesting, DEFAULT_SESSION_KEY } from "../src/session.js";
import { AccessAuditLogger, setAccessAuditLoggerForTesting } from "../src/accessAudit.js";
import { PendingOrderStore, setPendingOrderStoreForTesting } from "../src/pendingOrders.js";
import { prepareOrderHandler } from "../src/prepareOrderTool.js";
import { placeOrderConfirmedHandler } from "../src/placeOrderTool.js";
import { getOrderStatusHandler } from "../src/orderStatusTool.js";
import { myOrdersHandler } from "../src/myOrdersTool.js";
import { getMenu } from "../src/tools/getMenu.js";
import { getItemDetail } from "../src/tools/getItemDetail.js";
import { findStore, resetStoreCachesForTesting } from "../src/tools/findStore.js";

process.env.QMAI_OPEN_KEY ??= "test-open-key-0123456789abcdef0123456789ab";
process.env.QMAI_OPEN_ID ??= "test-open-id-0000000000000000";
process.env.QMAI_GRANT_CODE ??= "test-grant-code-0000000000";

const CUSTOMER = "1234567890123456789";
const PHONE = "13800001234";
const FAKE_PHONE = "13900009876";
const FAKE_LONG_ID = "9876543210987654321";
const STORE_ID = 503542;
const GOODS = "1300000000000000501";
const realFetch = globalThis.fetch;

const PATH_CATEGORY = "v3/goods/item/getShopCategory";
const PATH_SEARCH = "v3/goods/item/getShopGoodsList/search";
const PATH_DETAIL = "v3/goods/item/getShopGoodsDetail";
const PATH_SHOPS = "v3/org/shop/getShopList";
const PATH_STATUS = "v3/order/status";
const PATH_LIST = "v3/order/userAppointTimeOrderList";
const PATH_COUPON = "v3/bsns/customer/chooseCouponAsOne";
const PATH_CREATE = "v3/newPattern/cateringApiserver/post/order/v1/create";
const PATH_READBACK = "v3/order/standard/cyOrderDetail";

/** 盲审 B05 合成的脏 message：假手机号 + 凭证片段 + 19 位 ID + URL，一条里全有。 */
const DIRTY_MESSAGE =
  `会员 ${FAKE_PHONE} 不存在；openKey=abcdef0123456789 token: zzz-999 customerId ${FAKE_LONG_ID} 详见 https://open.qmai.com/home/documentCenter?id=9`;
const DIRTY_FRAGMENTS = [FAKE_PHONE, "openKey", "abcdef0123456789", "zzz-999", FAKE_LONG_ID, "https://", "documentCenter"];
const dirtyUpstream = { status: false, code: 30005, message: DIRTY_MESSAGE };

function assertClean(text: string, where: string): void {
  for (const frag of DIRTY_FRAGMENTS) {
    assert.ok(!text.includes(frag), `${where}：出参不许含「${frag}」——实际文本：${text}`);
  }
}

interface Router {
  countOf: (p: string) => number;
  restore: () => void;
}
function installRouter(routes: Record<string, Record<string, unknown> | Array<Record<string, unknown>>>): Router {
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

function installFixture(): { restore: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "licha-c4-"));
  setWriteGuardForTesting(new WriteGuard({ auditLogPath: join(dir, "write-audit.log"), placedOrdersPath: join(dir, "placed-orders.json") }));
  setPendingOrderStoreForTesting(new PendingOrderStore());
  const sessions = new SessionStore();
  sessions.bind(DEFAULT_SESSION_KEY, { customerId: CUSTOMER, boundAt: Date.now(), boundVia: "phone", phone: PHONE });
  setSessionStoreForTesting(sessions);
  setAccessAuditLoggerForTesting(new AccessAuditLogger({ logPath: join(dir, "access-audit.log") }));
  setReadAuditLogPathForTesting(join(dir, "read-audit.log"));
  resetStoreCachesForTesting();
  return {
    restore: () => {
      setWriteGuardForTesting(null);
      setPendingOrderStoreForTesting(null);
      setSessionStoreForTesting(null);
      setAccessAuditLoggerForTesting(null);
      setReadAuditLogPathForTesting(null);
      resetStoreCachesForTesting();
      globalThis.fetch = realFetch;
    },
  };
}

function textOf(r: { content: Array<{ type: "text"; text: string }> }): string {
  return r.content.map((c) => c.text).join("\n");
}
async function thrownMessage(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  assert.fail("预期抛错但没有抛");
}

function detailFixture(goodsId: string, salePriceFen: number): Record<string, unknown> {
  return {
    status: true,
    code: 0,
    data: [
      {
        goodsId,
        name: "C4 测试奶茶",
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
const ITEM = { goodsId: GOODS, practices: ["少冰（400ml)"], quantity: 1 };
const couponRow = (title: string, canDisYuan: number, type: number) => ({
  title, unUseStatus: 1, unUseDesc: null, userCouponCanDisAmount: canDisYuan, couponCenterType: type, cardId: "9900000000000000777", customerId: CUSTOMER,
});

// ============================================================================
// C4-0：纯函数规则
// ============================================================================
test("C4-0: projectUpstreamMessage——手机号与 15 位以上数字串遮成尾号、URL 与 key=/token= 片段整段抹掉、80 字截断、非字符串返回空串", () => {
  const out = projectUpstreamMessage(DIRTY_MESSAGE);
  assertClean(out, "纯函数");
  assert.ok(out.includes("***9876"), `手机号留尾号：${out}`);
  assert.ok(out.includes("***4321"), `19 位 ID 留尾号：${out}`);
  assert.ok(out.includes("会员") && out.includes("不存在"), `正常业务文字要保留：${out}`);

  assert.equal(projectUpstreamMessage("secretKey: abc, 然后继续"), ", 然后继续".trim());
  assert.equal(projectUpstreamMessage("access_token=xyz"), "");
  assert.equal(projectUpstreamMessage("订单 D00289888998393221120 已取消"), "订单 D***1120 已取消", "单号里的长数字段同样遮尾号——宁遮勿漏，Agent 手里有入参 orderNo 可对照");

  const long = "错".repeat(100);
  const cut = projectUpstreamMessage(long);
  assert.equal(Array.from(cut).length, 81, "80 字 + 省略号");
  assert.ok(cut.endsWith("…"));
  assert.equal(projectUpstreamMessage("正好八十字以内的普通提示"), "正好八十字以内的普通提示");

  assert.equal(projectUpstreamMessage(undefined), "");
  assert.equal(projectUpstreamMessage(null), "");
  assert.equal(projectUpstreamMessage(12345), "");
  assert.equal(projectUpstreamMessage({ message: FAKE_PHONE }), "", "对象不展开——不知道里面有什么就一个字也不出");
});

// ============================================================================
// C4-1：place_order 读回 discountList 不再整个带出，只剩 couponApplied 投影
// ============================================================================
test("C4-1: 读回 discountList 条目带 customerId / 假手机号 / credential → place_order 出参无 discountList、文本不含脏值；couponApplied 名称与金额保留", async () => {
  const fx = installFixture();
  const ORDER_NO = "D00280000000000000701";
  const dirtyDiscount = {
    discountName: "优惠券",
    discountSummary: "单杯任意饮品5折券:¥12.00",
    discountAmount: 1200,
    discountType: 2,
    discountId: "8800000000000000123",
    customerId: FAKE_LONG_ID,
    phone: FAKE_PHONE,
    credential: "openKey=abcdef0123456789",
    extraMap: { token: "zzz-999", url: "https://open.qmai.com/home/documentCenter?id=9" },
  };
  const router = installRouter({
    [PATH_DETAIL]: detailFixture(GOODS, 2400),
    [PATH_COUPON]: { status: true, code: 0, data: [couponRow("单杯任意饮品5折券", 12.0, 2)] },
    [PATH_CREATE]: { status: true, code: 0, data: { orderNo: ORDER_NO, payAmount: 12.0, needPay: 1 } },
    [PATH_READBACK]: { status: true, code: 0, data: { orderNo: ORDER_NO, orderStatus: 10, userId: CUSTOMER, actualAmount: 1200, totalAmount: 2400, discountList: [dirtyDiscount] } },
  });
  try {
    const prep = JSON.parse(textOf(await prepareOrderHandler({ storeId: STORE_ID, items: [ITEM] })));
    const placedRes = await placeOrderConfirmedHandler({ confirmToken: prep.confirmToken, confirmAmountYuan: 24.0 });
    const text = textOf(placedRes);
    const placed = JSON.parse(text);
    assert.equal(placed.placed, true);
    assert.equal(router.countOf(PATH_CREATE), 1, "写请求恰 1 次");
    assert.equal("discountList" in placed, false, "原字段整个不再带出");
    assertClean(text, "place_order 出参");
    assert.ok(!text.includes("8800000000000000123"), "A5-7：discountId 不进投影，不退化");
    assert.equal(placed.couponApplied.items.length, 1);
    assert.equal(placed.couponApplied.items[0].name, "优惠券");
    assert.equal(placed.couponApplied.items[0].summary, "单杯任意饮品5折券:¥12.00");
    assert.equal(placed.couponApplied.items[0].amountYuan, "12.00");
    assert.equal(placed.couponApplied.matchesPrediction, true);
    assert.ok(placed.warning, "差额告警照旧（¥12 vs ¥24）");
  } finally {
    router.restore();
    fx.restore();
  }
});

// ============================================================================
// C4-2：上游 message 在全部出口被遮蔽，我们自己的下一步 hint 仍在
// ============================================================================
test("C4-2a: 一期只读四工具——get_menu（分类 / 搜索两支）、get_item_detail、find_store 的上游 message 出口", async () => {
  const fx = installFixture();
  const router = installRouter({
    [PATH_CATEGORY]: [dirtyUpstream, { status: true, code: 0, data: [] }],
    [PATH_SEARCH]: dirtyUpstream,
    [PATH_DETAIL]: dirtyUpstream,
    [PATH_SHOPS]: dirtyUpstream,
  });
  try {
    const m1 = await thrownMessage(getMenu(STORE_ID));
    assert.match(m1, /^分类菜单拉取失败：/);
    assertClean(m1, "get_menu 分类支");
    assert.ok(m1.includes("***9876"), `尾号形态保留供排障：${m1}`);

    const m2 = await thrownMessage(getMenu(STORE_ID + 1, "不存在的商品名"));
    assert.match(m2, /^搜索失败：/);
    assert.match(m2, /（.+试试）$/, "我们自己的 hint 仍在（humanHint 映射或缺省文案）");
    assertClean(m2, "get_menu 搜索支");

    // 换一个没被本文件其他用例的 prepare 拉过的 goodsId——getItemDetail 有详情缓存，命中就不发请求也不抛。
    const m3 = await thrownMessage(getItemDetail(STORE_ID, "1300000000000000999"));
    assert.match(m3, /^商品详情查询失败：/);
    assert.match(m3, /（.+试试）$/);
    assertClean(m3, "get_item_detail");

    const m4 = await thrownMessage(findStore("深圳湾"));
    assert.match(m4, /^门店列表拉取失败：/);
    assert.match(m4, /（.+(试试|再试)）$/);
    assertClean(m4, "find_store");
  } finally {
    router.restore();
    fx.restore();
  }
});

test("C4-2b: 二期工具——get_order_status、my_orders、place_order 下单失败 三处上游 message 出口", async () => {
  const fx = installFixture();
  const router = installRouter({
    [PATH_STATUS]: dirtyUpstream,
    [PATH_LIST]: dirtyUpstream,
    [PATH_DETAIL]: detailFixture(GOODS, 2400),
    [PATH_COUPON]: { status: true, code: 0, data: [] },
    [PATH_CREATE]: dirtyUpstream,
  });
  try {
    const s = await getOrderStatusHandler({ orderNo: "D00280000000000000702" });
    assert.equal(s.isError, true);
    assertClean(textOf(s), "get_order_status");
    assert.ok(textOf(s).includes("***9876"), textOf(s));

    const l = await myOrdersHandler({ days: 7 });
    assert.equal(l.isError, true);
    assert.match(textOf(l), /查询订单列表失败：/);
    assertClean(textOf(l), "my_orders");

    const prep = JSON.parse(textOf(await prepareOrderHandler({ storeId: STORE_ID, items: [ITEM] })));
    const p = await placeOrderConfirmedHandler({ confirmToken: prep.confirmToken, confirmAmountYuan: 24.0 });
    assert.equal(p.isError, true);
    assert.match(textOf(p), /下单失败：/);
    assertClean(textOf(p), "place_order 下单失败");
    assert.equal(router.countOf(PATH_CREATE), 1);
  } finally {
    router.restore();
    fx.restore();
  }
});

test("C4-2c: place_order 读回失败（6.1.9 status=false 脏 message）→ readbackNote 遮蔽，订单号与「已创建成功」口径保留", async () => {
  const fx = installFixture();
  const ORDER_NO = "D00280000000000000703";
  const router = installRouter({
    [PATH_DETAIL]: detailFixture(GOODS, 2400),
    [PATH_COUPON]: { status: true, code: 0, data: [] },
    [PATH_CREATE]: { status: true, code: 0, data: { orderNo: ORDER_NO, payAmount: 24.0, needPay: 1 } },
    [PATH_READBACK]: dirtyUpstream,
  });
  try {
    const prep = JSON.parse(textOf(await prepareOrderHandler({ storeId: STORE_ID, items: [ITEM] })));
    const res = await placeOrderConfirmedHandler({ confirmToken: prep.confirmToken, confirmAmountYuan: 24.0 });
    const text = textOf(res);
    const placed = JSON.parse(text);
    assert.equal(placed.placed, true);
    assert.equal(placed.orderNo, ORDER_NO);
    assert.equal(placed.readbackFailed, true);
    assert.match(placed.readbackNote, /订单已创建成功，但读回企迈金额失败/);
    assertClean(text, "place_order readbackNote");
  } finally {
    router.restore();
    fx.restore();
  }
});

// ============================================================================
// C4-3：出口投影不依赖写开关——默认只读态下 get_menu 错误同样脱敏
// ============================================================================
test("C4-3: 写开关关闭（默认只读态）→ get_menu 上游错误同样脱敏", async () => {
  const fx = installFixture();
  const saved = process.env.LICHA_ENABLE_ORDERING;
  delete process.env.LICHA_ENABLE_ORDERING;
  const router = installRouter({ [PATH_CATEGORY]: dirtyUpstream });
  try {
    const m = await thrownMessage(getMenu(STORE_ID + 7));
    assert.match(m, /^分类菜单拉取失败：/);
    assertClean(m, "只读态 get_menu");
  } finally {
    if (saved === undefined) delete process.env.LICHA_ENABLE_ORDERING;
    else process.env.LICHA_ENABLE_ORDERING = saved;
    router.restore();
    fx.restore();
  }
});
