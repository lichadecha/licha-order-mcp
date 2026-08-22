// 二期总工终验用例（2026-08-22，发布前独立验收）——§4.5 第 1 条纪律的落点：
// 验收方不复跑施工方的测试，而是从需求出发独立设计用例，专打「业务上合法但实现可能
// 误拒/误放」的缝。本文件四条（F1-F4）都是既有 135 条测试没打过的角度：
//
//   F1  令牌 TTL 下边界：顾客想了 4 分 59 秒才说「确认」——业务完全合法，不许误拒。
//       既有用例只测了「过期要拒」（V5-②），没测「临近但未到不误拒」；TTL 判据若写反
//       （>= 与 > 之差、单位错位），过期用例照样绿、合法确认却被拒。
//   F2  换绑后新顾客全链路：A 换成 B 后，B 正常 prepare → place 应成功，且写审计的
//       customerKey 必须是 B 的哈希——换绑若把频次记到 A 头上，B 的合法单会吃掉 A 的额度
//       （护栏算错额度比没有护栏更糟，§8-30 同款理由）。
//   F3  同款商品两行不同做法：顾客要「一杯少冰 + 一杯常温」的同款——两行同 goodsId 是
//       业务常态，组装若按 goodsId 去重/合并，就是误改顾客的单。
//   F4  顾客改主意重组单：旧令牌未过期时新旧两张待确认单并存——模型拿错旧令牌 + 复述新
//       金额，必须被 ConfirmAmountMismatch 拦住（金额不同时的防护）；拿新令牌则正常成单。
//
// 红线自证：mock fetch 路由器 + 四件套临时目录注入（体例照 m4ConfirmOrder.test.ts），
// 文件末尾比对生产 logs/ 快照，零真实网络请求。识别值全为构造假值。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { setReadAuditLogPathForTesting } from "../src/client.js";
import { ORDER_GUARD } from "../src/constants.js";
import { WriteGuard, setWriteGuardForTesting, customerCountKey } from "../src/writeGuard.js";
import { SessionStore, setSessionStoreForTesting, DEFAULT_SESSION_KEY } from "../src/session.js";
import { AccessAuditLogger, setAccessAuditLoggerForTesting } from "../src/accessAudit.js";
import { PendingOrderStore, setPendingOrderStoreForTesting } from "../src/pendingOrders.js";
import { prepareOrderHandler } from "../src/prepareOrderTool.js";
import { placeOrderConfirmedHandler } from "../src/placeOrderTool.js";
import { bindMemberHandler } from "../src/bindMemberTool.js";

process.env.QMAI_OPEN_KEY ??= "test-open-key-0123456789abcdef0123456789ab";
process.env.QMAI_OPEN_ID ??= "test-open-id-0000000000000000";
process.env.QMAI_GRANT_CODE ??= "test-grant-code-0000000000";

const CUSTOMER_A = "1200000000000000801"; // 构造假 19 位会员 ID（递增/整齐形态，一眼假）
const CUSTOMER_B = "1200000000000000802";
const PHONE_A = "13800009999"; // 中段全零假号（纪律同 §8-26：真实识别值绝不入库）
const PHONE_B = "13900002345";
const STORE_ID = 503542; // 深圳湾万象城（公开门店编码，非识别值）
const realFetch = globalThis.fetch;

const PATH_DETAIL = "v3/goods/item/getShopGoodsDetail";
const PATH_CREATE = "v3/newPattern/cateringApiserver/post/order/v1/create";
const PATH_DETAIL_ORDER = "v3/order/standard/cyOrderDetail";
const PATH_CUSTOMER_LOOKUP = "v3/crm/customer/getCustomerIdByCode";

// 商品详情 fixture：做法「温度」组给两个值，F3 的两行要各选一个。
function goodsDetailFixture(goodsId: string, salePriceFen = 2400): Record<string, unknown> {
  return {
    status: true,
    code: 0,
    data: [
      {
        goodsId,
        name: "终验测试奶茶",
        type: 1,
        status: 10,
        goodsSkuList: [
          {
            skuId: "1288634197263667200",
            salePrice: salePriceFen,
            clearStatus: 1,
            inventory: 99,
            specName: "标准杯",
            skuItemList: [{ specValue: "标准杯" }],
          },
        ],
        sortedPracticeList: [
          {
            practiceId: "1123413139990425601",
            practiceName: "温度",
            isRequired: 1,
            practiceValueList: [
              { practiceValueId: "1199823927794012164", practiceValue: "少冰（400ml)", price: 0, isDefault: 1 },
              { practiceValueId: "1199823927794012165", practiceValue: "常温", price: 0 },
            ],
          },
        ],
        attachGoodsList: [],
      },
    ],
  };
}

function customerLookupFixture(customerId: string): Record<string, unknown> {
  return { status: true, code: 0, message: "请求成功", data: { customerId, blttUserId: null } };
}

function installRouter(routes: Record<string, Record<string, unknown> | Array<Record<string, unknown>>>): {
  countOf: (pathFragment: string) => number;
  bodiesOf: (pathFragment: string) => string[];
  restore: () => void;
} {
  const counts = new Map<string, number>();
  const bodies = new Map<string, string[]>();
  const cursors = new Map<string, number>();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) throw new Error(`mock 路由未覆盖的路径（代码调了预期之外的接口）：${url}`);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const list = bodies.get(key) ?? [];
    list.push(String(init?.body ?? ""));
    bodies.set(key, list);
    const route = routes[key];
    let resp: Record<string, unknown>;
    if (Array.isArray(route)) {
      const i = cursors.get(key) ?? 0;
      resp = route[Math.min(i, route.length - 1)];
      cursors.set(key, i + 1);
    } else {
      resp = route;
    }
    return new Response(JSON.stringify(resp), { status: 200 });
  }) as typeof fetch;
  return {
    countOf: (p) => counts.get(p) ?? 0,
    bodiesOf: (p) => bodies.get(p) ?? [],
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

interface Fixture {
  writeGuard: WriteGuard;
  pendingStore: PendingOrderStore;
  writeAuditPath: string;
  restore: () => void;
}

function installFixture(clock?: () => number): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "licha-final-"));
  const writeAuditPath = join(dir, "write-audit.log");
  const writeGuard = new WriteGuard({
    auditLogPath: writeAuditPath,
    placedOrdersPath: join(dir, "placed-orders.json"),
    clock,
  });
  const pendingStore = new PendingOrderStore({ clock });
  setWriteGuardForTesting(writeGuard);
  setPendingOrderStoreForTesting(pendingStore);
  setSessionStoreForTesting(new SessionStore());
  setAccessAuditLoggerForTesting(new AccessAuditLogger({ logPath: join(dir, "access-audit.log") }));
  setReadAuditLogPathForTesting(join(dir, "read-audit.log"));
  return {
    writeGuard,
    pendingStore,
    writeAuditPath,
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

function bindDirect(customerId: string, phone: string): void {
  const store = new SessionStore();
  store.bind(DEFAULT_SESSION_KEY, { customerId, boundAt: Date.now(), boundVia: "phone", phone });
  setSessionStoreForTesting(store);
}

function snapshotProdLogs(): string {
  const dir = join(process.cwd(), "logs");
  if (!existsSync(dir)) return "<no-logs-dir>";
  return readdirSync(dir)
    .sort()
    .map((f) => {
      const p = join(dir, f);
      if (!statSync(p).isFile()) return `${f}:<dir>`;
      return `${f}:${createHash("md5").update(readFileSync(p)).digest("hex")}`;
    })
    .join("\n");
}

const PROD_LOGS_SNAPSHOT_AT_START = snapshotProdLogs();

function textOf(r: { content: Array<{ type: "text"; text: string }> }): string {
  return r.content.map((c) => c.text).join("\n");
}

function jsonOf(r: { content: Array<{ type: "text"; text: string }> }): any {
  return JSON.parse(textOf(r));
}

// ============================================================================
// F1：TTL 下边界——签发后 4 分 59 秒确认，必须放行（不误拒）
// ============================================================================
test("F1: 令牌签发后 4 分 59 秒（TTL 内最后一刻）确认 → 放行成单，不误拒", async () => {
  let now = 1_800_000_000_000; // 可控时钟起点（任意固定值，不用 Date.now 保证可复现）
  const fx = installFixture(() => now);
  const goodsId = "1200000000000000811";
  const router = installRouter({
    [PATH_DETAIL]: goodsDetailFixture(goodsId),
    [PATH_CREATE]: { status: true, code: 0, data: { orderNo: "D00280000000000000801", payAmount: 24.0 } },
    [PATH_DETAIL_ORDER]: {
      status: true,
      code: 0,
      data: { orderNo: "D00280000000000000801", userId: CUSTOMER_A, actualAmount: 2400, discountList: [] },
    },
  });
  try {
    bindDirect(CUSTOMER_A, PHONE_A);
    const prep = jsonOf(
      await prepareOrderHandler({
        storeId: STORE_ID,
        items: [{ goodsId, quantity: 1, practices: ["少冰（400ml)"] }],
      }),
    );
    assert.ok(prep.confirmToken, "prepare 应签发令牌");

    // 推进到 TTL 最后一刻：恰好 5 分钟整还差 1 秒（判据是 elapsed > ttl 才过期，
    // 这里连边界值本身都不压——业务问题只是「4 分多钟的犹豫不许被拒」）。
    now += ORDER_GUARD.confirmTokenTtlMs - 1_000;

    const r = await placeOrderConfirmedHandler({ confirmToken: prep.confirmToken, confirmAmountYuan: 24.0 });
    assert.equal(r.isError ?? false, false, `TTL 内最后一刻的合法确认被误拒：${textOf(r)}`);
    assert.equal(jsonOf(r).placed, true);
    assert.equal(router.countOf(PATH_CREATE), 1, "写请求应恰好发出一次");
  } finally {
    router.restore();
    fx.restore();
  }
});

// ============================================================================
// F2：换绑后新顾客全链路成功，且频次记到新顾客头上
// ============================================================================
test("F2: A 换绑成 B 后，B 全链路下单成功；写审计 customerKey 是 B 的哈希、不是 A 的", async () => {
  const fx = installFixture();
  const goodsId = "1200000000000000812";
  const router = installRouter({
    [PATH_CUSTOMER_LOOKUP]: [customerLookupFixture(CUSTOMER_A), customerLookupFixture(CUSTOMER_B)],
    [PATH_DETAIL]: goodsDetailFixture(goodsId),
    [PATH_CREATE]: { status: true, code: 0, data: { orderNo: "D00280000000000000802", payAmount: 24.0 } },
    [PATH_DETAIL_ORDER]: {
      status: true,
      code: 0,
      data: { orderNo: "D00280000000000000802", userId: CUSTOMER_B, actualAmount: 2400, discountList: [] },
    },
  });
  try {
    // 走真实 bind_member 链路（不用 bindDirect）——换绑分支本身也是被验对象。
    const bindA = await bindMemberHandler({ code: PHONE_A, codeType: "phone" });
    assert.equal(bindA.isError ?? false, false, `A 绑定失败：${textOf(bindA)}`);
    const bindB = await bindMemberHandler({ code: PHONE_B, codeType: "phone" });
    assert.equal(bindB.isError ?? false, false, `换绑 B 失败：${textOf(bindB)}`);
    assert.equal(jsonOf(bindB).rebound, true, "应走换绑分支");

    const prep = jsonOf(
      await prepareOrderHandler({
        storeId: STORE_ID,
        items: [{ goodsId, quantity: 1, practices: ["少冰（400ml)"] }],
      }),
    );
    const r = await placeOrderConfirmedHandler({ confirmToken: prep.confirmToken, confirmAmountYuan: 24.0 });
    assert.equal(r.isError ?? false, false, `换绑后 B 的合法单被误拒：${textOf(r)}`);

    // 写请求体挂的是 B 的 userId（不是 A 残留）。
    const createBody = router.bodiesOf(PATH_CREATE)[0];
    assert.match(createBody, new RegExp(`"userId":${CUSTOMER_B}[,}]`), "写请求体应挂新顾客 B 的 userId");
    assert.doesNotMatch(createBody, new RegExp(CUSTOMER_A), "写请求体不得残留旧顾客 A 的 userId");
    // 手机号回填也必须换成 B 的号——若还带着 A 的号，门店会打给错的人。
    assert.match(createBody, new RegExp(`"mobile":"${PHONE_B}"`), "mobile 应是 B 的号");
    assert.doesNotMatch(createBody, new RegExp(PHONE_A), "请求体不得残留 A 的手机号");

    // 频次计数键归属 B：审计里的 customerKey = sha256(B) 前 16 hex。
    const lines = readFileSync(fx.writeAuditPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const allowed = lines.find((l) => l.result === "allowed");
    assert.ok(allowed, "应有 allowed 写审计");
    assert.equal(allowed.customerKey, customerCountKey(CUSTOMER_B), "频次应记到 B 头上");
    assert.notEqual(allowed.customerKey, customerCountKey(CUSTOMER_A), "频次不得记到 A 头上");
    // 内存计数同步核对：B 占 1、A 占 0。
    assert.equal(fx.writeGuard.currentCustomerDailyCount(customerCountKey(CUSTOMER_B)!), 1);
    assert.equal(fx.writeGuard.currentCustomerDailyCount(customerCountKey(CUSTOMER_A)!), 0);
  } finally {
    router.restore();
    fx.restore();
  }
});

// ============================================================================
// F3：同款商品两行不同做法（一杯少冰 + 一杯常温）——不许合并、不许误拒
// ============================================================================
test("F3: 同 goodsId 两行不同做法 → 两行独立组装、金额为两行之和、写请求体两行做法各自正确", async () => {
  const fx = installFixture();
  const goodsId = "1200000000000000813";
  const router = installRouter({
    [PATH_DETAIL]: goodsDetailFixture(goodsId),
    [PATH_CREATE]: { status: true, code: 0, data: { orderNo: "D00280000000000000803", payAmount: 48.0 } },
    [PATH_DETAIL_ORDER]: {
      status: true,
      code: 0,
      data: { orderNo: "D00280000000000000803", userId: CUSTOMER_A, actualAmount: 4800, discountList: [] },
    },
  });
  try {
    bindDirect(CUSTOMER_A, PHONE_A);
    const prepR = await prepareOrderHandler({
      storeId: STORE_ID,
      items: [
        { goodsId, quantity: 1, practices: ["少冰（400ml)"] },
        { goodsId, quantity: 1, practices: ["常温"] },
      ],
    });
    assert.equal(prepR.isError ?? false, false, `合法的同款两行单被误拒：${textOf(prepR)}`);
    const prep = jsonOf(prepR);
    assert.equal(prep.lines.length, 2, "待确认单应保留两行，不许按 goodsId 合并");
    assert.equal(prep.estimatedTotalYuan, "48.00", "金额应为两行之和");

    const r = await placeOrderConfirmedHandler({ confirmToken: prep.confirmToken, confirmAmountYuan: 48.0 });
    assert.equal(r.isError ?? false, false, `两行单下单被误拒：${textOf(r)}`);

    // 写请求体：items 两个元素、做法各自正确（不是两行都变成同一个做法）。
    // JSON.parse 会把裸 19 位大数折精度，但这里只断言行数与做法字符串，不受影响；
    // 大数无损性已有 B5a/G6/V6 三处断言在请求体原文上验过，不在本条重复。
    const body = JSON.parse(router.bodiesOf(PATH_CREATE)[0]);
    const items = body.params.items;
    assert.equal(items.length, 2, "写请求体应有两行 items");
    const values = items.map((it: any) => it.practiceList[0].value).sort();
    assert.deepEqual(values, ["少冰（400ml)", "常温"], "两行做法应各自保留");
  } finally {
    router.restore();
    fx.restore();
  }
});

// ============================================================================
// F4：顾客改主意重组单——旧令牌 + 新金额必须被拦；新令牌正常成单
// ============================================================================
test("F4: 改主意重组后旧令牌+新金额 → ConfirmAmountMismatch 拒且零写请求；新令牌 → 正常成单", async () => {
  const fx = installFixture();
  const goodsCheap = "1200000000000000814"; // ¥24 旧单
  const goodsPricey = "1200000000000000815"; // ¥36 新单
  // 两个商品共用 PATH_DETAIL 路由：按调用次序给不同详情（队列语义）。
  const router2 = installRouter({
    [PATH_DETAIL]: [goodsDetailFixture(goodsCheap, 2400), goodsDetailFixture(goodsPricey, 3600)],
    [PATH_CREATE]: { status: true, code: 0, data: { orderNo: "D00280000000000000804", payAmount: 36.0 } },
    [PATH_DETAIL_ORDER]: {
      status: true,
      code: 0,
      data: { orderNo: "D00280000000000000804", userId: CUSTOMER_A, actualAmount: 3600, discountList: [] },
    },
  });
  try {
    bindDirect(CUSTOMER_A, PHONE_A);
    // 第一张待确认单（¥24，顾客随后改主意）。
    const oldPrep = jsonOf(
      await prepareOrderHandler({
        storeId: STORE_ID,
        items: [{ goodsId: goodsCheap, quantity: 1, practices: ["少冰（400ml)"] }],
      }),
    );
    assert.equal(oldPrep.estimatedTotalYuan, "24.00");
    // 顾客改主意，重组第二张（¥36）。两张单此刻都未过期、并存。
    const newPrep = jsonOf(
      await prepareOrderHandler({
        storeId: STORE_ID,
        items: [{ goodsId: goodsPricey, quantity: 1, practices: ["常温"] }],
      }),
    );
    assert.equal(newPrep.estimatedTotalYuan, "36.00");
    assert.notEqual(oldPrep.confirmToken, newPrep.confirmToken);

    // 模型拿错旧令牌、复述的是顾客刚确认的新金额 → 必须拦，且写请求零发出。
    const wrong = await placeOrderConfirmedHandler({ confirmToken: oldPrep.confirmToken, confirmAmountYuan: 36.0 });
    assert.equal(wrong.isError, true, "旧令牌+新金额应被拒");
    assert.match(textOf(wrong), /复述金额与待确认单不一致/);
    assert.equal(router2.countOf(PATH_CREATE), 0, "拦截时写请求一次都不许发出");

    // 拿对新令牌 → 正常成单。
    const right = await placeOrderConfirmedHandler({ confirmToken: newPrep.confirmToken, confirmAmountYuan: 36.0 });
    assert.equal(right.isError ?? false, false, `新令牌被误拒：${textOf(right)}`);
    assert.equal(jsonOf(right).placed, true);
    assert.equal(router2.countOf(PATH_CREATE), 1);
  } finally {
    router2.restore();
    fx.restore();
  }
});

// ============================================================================
// 红线自证：本文件全程未触碰生产 logs/
// ============================================================================
test("红线自证：本测试文件全程零真实网络请求，且生产 logs/ 一字未变", () => {
  assert.equal(globalThis.fetch, realFetch, "fetch 应已恢复为真实实现（且从未真实发出请求）");
  assert.equal(snapshotProdLogs(), PROD_LOGS_SNAPSHOT_AT_START, "生产 logs/ 在测试前后必须完全一致");
});
