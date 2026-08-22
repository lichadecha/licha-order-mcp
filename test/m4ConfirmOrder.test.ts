// M4 两阶段确认下单 + 读回确认：V1-V10 / V12（V11 在 toolsList.test.ts 里）。
//
// 🚨 红线自证（本文件是二期第一个会跑通"完整下单链路"的测试文件，自证责任最重）：
//   ① globalThis.fetch 被整体替换成按路径分发的 mock 路由器，绝不发出任何真实 HTTP 请求。
//      真调 6.2.9 会在企迈侧创建真实订单、可能进门店 POS，这是不可撤销的现实后果。
//   ② 每条用例都对「6.2.9 创建订单路径的实际调用次数」单独计数并断言——不是笼统地数 fetch，
//      而是精确到写路径：读路径（详情/读回）调用多少次不影响判断，写路径多调一次就是事故。
//   ③ 四件套注入齐上（WriteGuard / SessionStore / AccessAuditLogger / 只读审计路径），
//      全部指向 mkdtemp 临时目录，测试不碰生产 logs/。
//   ④ 全部识别值用假值：手机号 13800001234、customerId 1234567890123456789。
//
// getItemDetail 的模块级缓存（5 分钟）会跨用例复用同一个 storeId:goodsId 的详情——
// 所以每条用例用各自独立的 goodsId，避免"上一条用例的详情被下一条用到"这种隐蔽耦合。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { setReadAuditLogPathForTesting } from "../src/client.js";
import { ORDER_GUARD } from "../src/constants.js";
import { WriteGuard, setWriteGuardForTesting } from "../src/writeGuard.js";
import { SessionStore, setSessionStoreForTesting, DEFAULT_SESSION_KEY } from "../src/session.js";
import { AccessAuditLogger, setAccessAuditLoggerForTesting } from "../src/accessAudit.js";
import { PendingOrderStore, setPendingOrderStoreForTesting } from "../src/pendingOrders.js";
import { prepareOrderHandler } from "../src/prepareOrderTool.js";
import { placeOrderConfirmedHandler } from "../src/placeOrderTool.js";
import { myOrdersHandler } from "../src/myOrdersTool.js";

process.env.QMAI_OPEN_KEY ??= "test-open-key-0123456789abcdef0123456789ab";
process.env.QMAI_OPEN_ID ??= "test-open-id-0000000000000000";
process.env.QMAI_GRANT_CODE ??= "test-grant-code-0000000000";

const FAKE_CUSTOMER_ID = "1234567890123456789"; // 19 位假会员 ID（真实会员 ID 绝不入库）
const FAKE_PHONE = "13800001234"; // 假手机号（中段全零；真实手机号绝不入库，纪律同 §8-26）
const STORE_ID = 503542; // 深圳湾万象城（公开门店编码，非识别值）
const realFetch = globalThis.fetch;

// ---------- 接口路径常量（与 constants.ts 的白名单同源，写错会立刻在断言里暴露） ----------
const PATH_DETAIL = "v3/goods/item/getShopGoodsDetail";
const PATH_CREATE = "v3/newPattern/cateringApiserver/post/order/v1/create";
const PATH_DETAIL_ORDER = "v3/order/standard/cyOrderDetail";
const PATH_ORDER_LIST = "v3/order/userAppointTimeOrderList";

// ---------- 商品详情 fixture：19 位大数 ID，覆盖 SKU / 做法两组 / 加料 ----------
function goodsDetailFixture(goodsId: string, salePriceFen = 2400): Record<string, unknown> {
  return {
    status: true,
    code: 0,
    data: [
      {
        goodsId,
        name: "测试奶茶",
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
          {
            practiceId: "1123413632158486529",
            practiceName: "低GI-L阿拉伯糖",
            isRequired: 0,
            practiceValueList: [{ practiceValueId: "1123413632158486531", practiceValue: "70%-L阿拉伯糖", price: 0 }],
          },
        ],
        attachGoodsList: [{ attachGoodsId: "1123999888777666555", attachGoodsName: "珍珠", attachGoodsPrice: 0, clearStatus: 1 }],
      },
    ],
  };
}

/**
 * 按路径分发的 mock fetch 路由器。每个路径给一个响应或一个响应队列（按调用次序取，
 * 用尽后重复最后一个）。同时按路径分别计数——写路径的调用次数必须能被单独断言。
 */
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
    if (!key) throw new Error(`mock 路由未覆盖的路径（说明代码调了预期之外的接口）：${url}`);
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
  accessAuditPath: string;
  restore: () => void;
}

/** 四件套 + 待确认单登记表全部注入临时实例；clock 可控，用来推进 TTL 而不真的等 5 分钟。 */
function installFixture(clock?: () => number): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "licha-m4-"));
  const writeAuditPath = join(dir, "write-audit.log");
  const accessAuditPath = join(dir, "access-audit.log");
  const writeGuard = new WriteGuard({ auditLogPath: writeAuditPath, placedOrdersPath: join(dir, "placed-orders.json"), clock });
  const pendingStore = new PendingOrderStore({ clock });
  setWriteGuardForTesting(writeGuard);
  setPendingOrderStoreForTesting(pendingStore);
  setSessionStoreForTesting(new SessionStore());
  setAccessAuditLoggerForTesting(new AccessAuditLogger({ logPath: accessAuditPath }));
  setReadAuditLogPathForTesting(join(dir, "read-audit.log"));
  return {
    writeGuard,
    pendingStore,
    writeAuditPath,
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

/** 手机号绑定的会话（默认）。假号中段全零，一眼假；脱敏正则要合法手机号形态才测得出来。 */
function bindSession(): void {
  const store = new SessionStore();
  store.bind(DEFAULT_SESSION_KEY, {
    customerId: FAKE_CUSTOMER_ID,
    boundAt: Date.now(),
    boundVia: "phone",
    phone: FAKE_PHONE,
  });
  setSessionStoreForTesting(store);
}

/** 非手机号绑定的会话（会员码/动态码形态）——拿不到手机号，用来验「没有就不带键」。 */
function bindSessionWithoutPhone(boundVia: "card" | "dynamic_code" = "dynamic_code"): void {
  const store = new SessionStore();
  store.bind(DEFAULT_SESSION_KEY, { customerId: FAKE_CUSTOMER_ID, boundAt: Date.now(), boundVia });
  setSessionStoreForTesting(store);
}

/**
 * 生产 logs/ 目录的哈希快照（文件名 + 内容 md5，按名排序）。判据体例与
 * auditSanitizer.test.ts / handlerInputSanitizer.test.ts 完全一致——「测试不许碰生产 logs/」
 * 这条红线在 M2/M3 各破过一次，全项目只该有一份判据。
 */
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

/** 模块加载时（任何用例跑之前）拍一张，文件末尾的红线自证用它比对。 */
const PROD_LOGS_SNAPSHOT_AT_START = snapshotProdLogs();

function textOf(r: { content: Array<{ type: "text"; text: string }> }): string {
  return r.content.map((c) => c.text).join("\n");
}

function jsonOf(r: { content: Array<{ type: "text"; text: string }> }): any {
  return JSON.parse(textOf(r));
}

function lastAuditEntry(path: string): any {
  const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

// ============================================================================
// V1：未绑定调 prepare_order → 拒、fetch 未调用
// ============================================================================
test("V1: 未绑定会员调用 prepare_order → 拒绝，fetch 一次都没被调用，access-audit 记 unbound_call_rejected", async () => {
  const fx = installFixture();
  const router = installRouter({ [PATH_DETAIL]: goodsDetailFixture("1200000000000000001") });
  try {
    const r = await prepareOrderHandler({
      storeId: STORE_ID,
      items: [{ goodsId: "1200000000000000001", quantity: 1 }],
    });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /尚未绑定会员身份/);
    assert.equal(router.countOf(PATH_DETAIL), 0, "未绑定时不该发出任何请求（连查商品详情都不该）");

    const entry = lastAuditEntry(fx.accessAuditPath);
    assert.equal(entry.event, "unbound_call_rejected");
    assert.equal(entry.tool, "prepare_order");
    assert.equal(fx.pendingStore.size(), 0, "未绑定不该登记任何待确认单");
  } finally {
    router.restore();
    fx.restore();
  }
});

// ============================================================================
// V2：绑定后 prepare_order 成功 —— 待确认单 + 令牌 + 登记的 finalParams 字段名合规
// ============================================================================
test("V2: 绑定后 prepare_order 成功 → 返回待确认单与令牌；登记的 finalParams 含会话 userId，practiceList/attachList 字段名符合 doc168", async () => {
  const fx = installFixture();
  bindSession();
  const GOODS = "1200000000000000002";
  const router = installRouter({ [PATH_DETAIL]: goodsDetailFixture(GOODS, 2400) });
  try {
    const r = await prepareOrderHandler({
      storeId: STORE_ID,
      items: [
        {
          goodsId: GOODS,
          practices: ["少冰（400ml)", "70%-L阿拉伯糖"],
          attaches: ["珍珠"],
          quantity: 2,
        },
      ],
    });
    assert.equal(r.isError ?? false, false, `prepare_order 应成功：${textOf(r)}`);
    const out = jsonOf(r);

    // —— 待确认单本身 ——
    assert.ok(typeof out.confirmToken === "string" && out.confirmToken.length > 0, "应返回确认令牌");
    assert.equal(out.store.storeId, String(STORE_ID));
    assert.equal(out.store.name, "深圳湾万象城（深圳）");
    assert.equal(out.lines.length, 1);
    assert.equal(out.lines[0].quantity, 2);
    assert.equal(out.lines[0].unitPriceYuan, "24.00");
    assert.equal(out.lines[0].lineTotalYuan, "48.00");
    // 金额元/分换算：2 杯 × 2400 分 = 4800 分 = ¥48.00
    assert.equal(out.estimatedTotalYuan, "48.00");
    assert.equal(out.expiresInMinutes, 5);
    assert.ok(!/userId/.test(JSON.stringify(out)), "待确认单出参不许出现 userId");

    // —— 登记的 finalParams ——
    const lookup = fx.pendingStore.lookup(out.confirmToken);
    assert.equal(lookup.status, "ok", "待确认单应已登记");
    if (lookup.status !== "ok") return;
    const fp = lookup.order.finalParams as any;
    assert.equal(lookup.order.estimatedAmountFen, 4800, "登记金额应为分（4800），不是元");
    assert.equal(fp.userId, FAKE_CUSTOMER_ID, "userId 必须是会话绑定值");
    assert.equal(fp.storeId, STORE_ID);
    assert.equal(fp.orderType, 1, "orderType 固定 1 堂食");
    assert.equal(fp.source, 18, "source 固定 18 其他三方渠道");
    assert.equal(fp.channelCode, "AI_AGENT", "channelCode 固定 AI_AGENT（2026-08-18 渠道归因探针实测坐实）");
    assert.equal(fp.scene, "AI_AGENT", "scene 固定 AI_AGENT，与 channelCode 同值双保险");
    assert.equal(fp.member, true, "member 固定 true（本单必挂 userId，如实标注为会员单）");
    assert.equal(fp.mobile, FAKE_PHONE, "mobile 取会话绑定的手机号（2026-08-19 后台四看：不传则「下单人」栏空）");
    assert.equal(fp.reservePhone, FAKE_PHONE, "reservePhone 同号（映射后台「预留电话」栏）");
    assert.equal(fp.items.length, 1);

    const item = fp.items[0];
    assert.equal(item.goodsId, GOODS);
    assert.equal(item.skuId, "1288634197263667200");
    assert.equal(item.num, 2);

    // practiceList 字段名（doc168 ConfirmItemPracticeDto）：code/id/name/price/value/valueId
    assert.equal(item.practiceList.length, 2);
    const p0 = item.practiceList[0];
    assert.deepEqual(Object.keys(p0).sort(), ["id", "name", "price", "value", "valueId"]);
    assert.equal(p0.id, "1123413139990425601");
    assert.equal(p0.name, "温度");
    assert.equal(p0.value, "少冰（400ml)");
    assert.equal(p0.valueId, "1199823927794012164");
    assert.equal(p0.price, 0);

    // attachList 字段名（doc168 ConfirmItemAttachDto）：code/id/name/num/price
    assert.equal(item.attachList.length, 1);
    const a0 = item.attachList[0];
    assert.deepEqual(Object.keys(a0).sort(), ["id", "name", "num", "price"]);
    assert.equal(a0.id, "1123999888777666555");
    assert.equal(a0.name, "珍珠");
    assert.equal(a0.num, 1);
    assert.equal(a0.price, 0);

    // 调用成本可预期：每个商品行恰好 2 次详情调用——previewOrder 内的 getItemDetail 一次
    // （算价与估清校验），本文件的 ID 映射一次（取 practiceId/practiceValueId/attachGoodsId，
    // 那些 ID 被一期的 ItemDetail 投影丢掉了、而一期四个工具文件是不许改的不变量）。
    // 真实对话里模型通常已经调过 get_item_detail，getItemDetail 的 5 分钟缓存会把第一次省掉。
    assert.equal(router.countOf(PATH_DETAIL), 2, "单商品行的详情调用应恰好 2 次");

    // access-audit 记 token_issued，只记金额与行数、不记商品明细
    const entry = lastAuditEntry(fx.accessAuditPath);
    assert.equal(entry.event, "token_issued");
    assert.equal(entry.tool, "prepare_order");
    assert.equal(entry.tokenId, out.confirmToken);
    assert.equal(entry.estimatedAmountFen, 4800);
    assert.equal(entry.itemCount, 1);
    assert.equal(entry.customerIdLast4, "***6789");
    assert.ok(!/测试奶茶|珍珠|少冰/.test(readFileSync(fx.accessAuditPath, "utf8")), "审计不该出现商品明细");
  } finally {
    router.restore();
    fx.restore();
  }
});

// ============================================================================
// V3：finalParams 不含预约单字段（静态断言）
// ============================================================================
test("V3: prepare_order 组装的 finalParams 递归不含 isPre/preTime/isWaiterCheck/orderSubType", async () => {
  const fx = installFixture();
  bindSession();
  const GOODS = "1200000000000000003";
  const router = installRouter({ [PATH_DETAIL]: goodsDetailFixture(GOODS) });
  try {
    const r = await prepareOrderHandler({ storeId: STORE_ID, items: [{ goodsId: GOODS, quantity: 1 }] });
    const out = jsonOf(r);
    const lookup = fx.pendingStore.lookup(out.confirmToken);
    assert.equal(lookup.status, "ok");
    if (lookup.status !== "ok") return;

    // 递归扫描整棵参数树（不只看顶层）——预约单字段藏在 items 里同样致命。
    const forbidden = ["isPre", "preTime", "isWaiterCheck", "orderSubType"];
    const walk = (v: unknown, path = ""): void => {
      if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
      if (v !== null && typeof v === "object") {
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
          assert.ok(!forbidden.includes(k), `finalParams 出现预约单字段 ${k}（路径 ${path}.${k}）`);
          walk(val, path ? `${path}.${k}` : k);
        }
      }
    };
    walk(lookup.order.finalParams);

    // 顶层键就是全集，多一个都不行（防止将来有人顺手加字段）。演进留痕：
    //   M4 定稿 5 个 → 2026-08-18 渠道归因补丁 +channelCode/scene = 7 个
    //   → 2026-08-19 手机号回填补丁 +member/mobile/reservePhone = 10 个（手机号绑定的会话）。
    // 非手机号绑定的会话少 mobile/reservePhone 两个键，由下面「T1 附 3」单独断言。
    assert.deepEqual(Object.keys(lookup.order.finalParams).sort(), [
      "channelCode",
      "items",
      "member",
      "mobile",
      "orderType",
      "reservePhone",
      "scene",
      "source",
      "storeId",
      "userId",
    ]);
  } finally {
    router.restore();
    fx.restore();
  }
});

// ---------- V3 附：多规格商品的 skuId 反查（口径必须与一期 getItemDetail 投影一致） ----------
test("V3 附: 多规格商品指定 skuId 组单 → finalParams 里是被指定的那个 skuId，单价按该规格算", async () => {
  const fx = installFixture();
  bindSession();
  const GOODS = "1200000000000000013";
  const twoSkuFixture = {
    status: true,
    code: 0,
    data: [
      {
        goodsId: GOODS,
        name: "双规格测试奶茶",
        type: 1,
        status: 10,
        goodsSkuList: [
          { skuId: "1288634197263667201", salePrice: 2400, clearStatus: 1, specName: "中杯" },
          { skuId: "1288634197263667202", salePrice: 2800, clearStatus: 1, specName: "大杯" },
        ],
        sortedPracticeList: [],
        attachGoodsList: [],
      },
    ],
  };
  const router = installRouter({ [PATH_DETAIL]: twoSkuFixture });
  try {
    const r = await prepareOrderHandler({
      storeId: STORE_ID,
      items: [{ goodsId: GOODS, skuId: "1288634197263667202", quantity: 1 }],
    });
    assert.equal(r.isError ?? false, false, `多规格组单应成功：${textOf(r)}`);
    const out = jsonOf(r);
    assert.equal(out.lines[0].specName, "大杯");
    assert.equal(out.estimatedTotalYuan, "28.00", "应按大杯 2800 分算价");

    const lookup = fx.pendingStore.lookup(out.confirmToken);
    assert.equal(lookup.status, "ok");
    if (lookup.status !== "ok") return;
    assert.equal((lookup.order.finalParams as any).items[0].skuId, "1288634197263667202");
  } finally {
    router.restore();
    fx.restore();
  }
});

// ============================================================================
// V3 附 2 / V3 附 3：渠道归因常量回归（2026-08-18 探针实测坐实后永久加入 finalParams）
// ============================================================================
test("V3 附 2: 登记的 finalParams 含 channelCode=AI_AGENT 且 scene=AI_AGENT（渠道归因回归）", async () => {
  const fx = installFixture();
  bindSession();
  const GOODS = "1200000000000000015";
  const router = installRouter({ [PATH_DETAIL]: goodsDetailFixture(GOODS) });
  try {
    const r = await prepareOrderHandler({ storeId: STORE_ID, items: [{ goodsId: GOODS, quantity: 1 }] });
    assert.equal(r.isError ?? false, false, `prepare_order 应成功：${textOf(r)}`);
    const out = jsonOf(r);
    const lookup = fx.pendingStore.lookup(out.confirmToken);
    assert.equal(lookup.status, "ok");
    if (lookup.status !== "ok") return;
    const fp = lookup.order.finalParams as any;
    assert.equal(fp.channelCode, "AI_AGENT", "channelCode 必须固定为 AI_AGENT 常量，不接受入参");
    assert.equal(fp.scene, "AI_AGENT", "scene 必须固定为 AI_AGENT 常量，与 channelCode 同值双保险");
  } finally {
    router.restore();
    fx.restore();
  }
});

// ---------- T1 手机号回填（2026-08-19 老板后台四看实测后上车，17 号执行包 T1）----------
//
// 实测依据：企迈商户后台订单详情页的「下单人」「预留电话」两栏读的是 6.2.9 请求体的
// mobile / reservePhone——不传就是空的（M6 第一枪两栏皆空、第二枪补传后两栏都有值）。
// 同轮实测的反面结论：后台**搜索框按手机号搜不到**这张单，「能显示」修好了、「能检索」修不了。
//
// 这三条守的是三件不同的事，别合并：①发出去的必须是完整值（否则后台还是空的）
// ②留在本机的必须是尾号（§8-26 硬纪律）③拿不到手机号时必须没有这两个键（不是空串）。

test("T1 附 1: 写请求体原文含完整 mobile/reservePhone 与 member:true，而待确认单出参一个手机号字符都没有", async () => {
  const fx = installFixture();
  bindSession();
  const GOODS = "1200000000000000017";
  const router = installRouter({
    [PATH_DETAIL]: goodsDetailFixture(GOODS, 2400),
    [PATH_CREATE]: { status: true, code: 0, data: { orderNo: "D-M4-PHONE", payAmount: 24.0 } },
    [PATH_DETAIL_ORDER]: {
      status: true,
      code: 0,
      data: { orderNo: "D-M4-PHONE", userId: FAKE_CUSTOMER_ID, actualAmount: 2400, discountList: [] },
    },
  });
  try {
    const prep = await prepareOrderHandler({ storeId: STORE_ID, items: [{ goodsId: GOODS, quantity: 1 }] });
    const prepOut = jsonOf(prep);

    // 出参面：待确认单是念给顾客听的，顾客不需要我们把他自己的号复述回去（连尾号都不给）。
    assert.ok(!textOf(prep).includes(FAKE_PHONE), "待确认单出参不许出现完整手机号");
    assert.ok(!/"mobile"|"reservePhone"/.test(textOf(prep)), "待确认单出参不许出现 mobile/reservePhone 字段名");

    const placed = await placeOrderConfirmedHandler({ confirmToken: prepOut.confirmToken, confirmAmountYuan: 24.0 });
    assert.equal(placed.isError ?? false, false, `全链路应成功：${textOf(placed)}`);
    assert.equal(router.countOf(PATH_CREATE), 1, "写请求应恰好发出一次");

    // 线上面：原文正则断言，确认序列化到线上的字符串里字面就有完整号（不是 JSON.parse 后才对得上）。
    const sent = router.bodiesOf(PATH_CREATE)[0];
    assert.match(sent, new RegExp(`"mobile":"${FAKE_PHONE}"`), '请求体原文必须含完整 "mobile"');
    assert.match(sent, new RegExp(`"reservePhone":"${FAKE_PHONE}"`), '请求体原文必须含完整 "reservePhone"');
    assert.match(sent, /"member":true/, '请求体原文必须含 "member":true');
    const sentParams = JSON.parse(sent).params;
    assert.equal(sentParams.mobile, FAKE_PHONE);
    assert.equal(sentParams.reservePhone, FAKE_PHONE);
    assert.equal(sentParams.member, true);

    // 下单结果播报面：也不许把手机号带出来。
    assert.ok(!textOf(placed).includes(FAKE_PHONE), "下单结果出参不许出现完整手机号");
  } finally {
    router.restore();
    fx.restore();
  }
});

test("T1 附 2: 走完整下单链路后，三本审计日志与 placed-orders.json 里零完整手机号（落盘只留尾号）", async () => {
  const fx = installFixture();
  bindSession();
  const GOODS = "1200000000000000018";
  const router = installRouter({
    [PATH_DETAIL]: goodsDetailFixture(GOODS, 2400),
    [PATH_CREATE]: { status: true, code: 0, data: { orderNo: "D-M4-PHONE-AUDIT", payAmount: 24.0 } },
    [PATH_DETAIL_ORDER]: {
      status: true,
      code: 0,
      data: { orderNo: "D-M4-PHONE-AUDIT", userId: FAKE_CUSTOMER_ID, actualAmount: 2400, discountList: [] },
    },
  });
  try {
    const prep = await prepareOrderHandler({ storeId: STORE_ID, items: [{ goodsId: GOODS, quantity: 1 }] });
    const placed = await placeOrderConfirmedHandler({
      confirmToken: jsonOf(prep).confirmToken,
      confirmAmountYuan: 24.0,
    });
    assert.equal(placed.isError ?? false, false, `全链路应成功：${textOf(placed)}`);

    // 阳性对照（§4.5 第 2 条）：先证明这套「读文件找手机号」的检查真能扫出已知存在的号，
    // 再采信它对真实日志的「没找到」。不做这一步，下面三个 ok() 全过也说明不了任何事。
    const controlPath = join(dirname(fx.writeAuditPath), "control.log");
    writeFileSync(controlPath, `{"note":"${FAKE_PHONE}"}\n`);
    assert.ok(readFileSync(controlPath, "utf8").includes(FAKE_PHONE), "阳性对照失败：连塞进去的手机号都读不出来");

    for (const [name, path] of [
      ["写审计", fx.writeAuditPath],
      ["访问审计", fx.accessAuditPath],
      ["幂等记录", join(dirname(fx.writeAuditPath), "placed-orders.json")],
    ] as const) {
      if (!existsSync(path)) continue; // 没产生该文件本身也是合规的（比如本用例不触发访问审计）
      const text = readFileSync(path, "utf8");
      assert.ok(!text.includes(FAKE_PHONE), `${name}（${path}）里出现了完整手机号——落盘纪律被破坏`);
    }
  } finally {
    router.restore();
    fx.restore();
  }
});

test("T1 附 3: 会员码/动态码绑定拿不到手机号 → finalParams 不带 mobile/reservePhone 键（不是空串），member 照旧为 true", async () => {
  const fx = installFixture();
  bindSessionWithoutPhone("dynamic_code");
  const GOODS = "1200000000000000019";
  const router = installRouter({ [PATH_DETAIL]: goodsDetailFixture(GOODS, 2400) });
  try {
    const r = await prepareOrderHandler({ storeId: STORE_ID, items: [{ goodsId: GOODS, quantity: 1 }] });
    assert.equal(r.isError ?? false, false, `prepare_order 应成功：${textOf(r)}`);
    const lookup = fx.pendingStore.lookup(jsonOf(r).confirmToken);
    assert.equal(lookup.status, "ok");
    if (lookup.status !== "ok") return;
    const fp = lookup.order.finalParams as Record<string, unknown>;

    // 「没有这个键」和「键在但值是空串」是两回事：后者等于告诉企迈「这人没有电话」，
    // 而且会进指纹计算、改变幂等口径。断言用 in 而不是取值判空，正是为了区分这两者。
    assert.ok(!("mobile" in fp), "拿不到手机号时不许出现 mobile 键");
    assert.ok(!("reservePhone" in fp), "拿不到手机号时不许出现 reservePhone 键");
    assert.equal(fp.member, true, "member 与手机号无关，照旧为 true");
    assert.deepEqual(Object.keys(fp).sort(), [
      "channelCode",
      "items",
      "member",
      "orderType",
      "scene",
      "source",
      "storeId",
      "userId",
    ]);
  } finally {
    router.restore();
    fx.restore();
  }
});

test('V3 附 3: 发往 6.2.9 的写请求体原文含 "channelCode":"AI_AGENT" 与 "scene":"AI_AGENT"（防序列化丢失/改名回归）', async () => {
  const fx = installFixture();
  bindSession();
  const GOODS = "1200000000000000016";
  const router = installRouter({
    [PATH_DETAIL]: goodsDetailFixture(GOODS, 2400),
    [PATH_CREATE]: { status: true, code: 0, data: { orderNo: "D-M4-CHANNEL", payAmount: 24.0 } },
    [PATH_DETAIL_ORDER]: {
      status: true,
      code: 0,
      data: { orderNo: "D-M4-CHANNEL", userId: FAKE_CUSTOMER_ID, actualAmount: 2400, discountList: [] },
    },
  });
  try {
    const prep = await prepareOrderHandler({ storeId: STORE_ID, items: [{ goodsId: GOODS, quantity: 1 }] });
    const prepOut = jsonOf(prep);
    const placed = await placeOrderConfirmedHandler({ confirmToken: prepOut.confirmToken, confirmAmountYuan: 24.0 });
    assert.equal(placed.isError ?? false, false, `全链路应成功：${textOf(placed)}`);

    assert.equal(router.countOf(PATH_CREATE), 1, "写请求应恰好发出一次");
    const sent = router.bodiesOf(PATH_CREATE)[0];
    const sentParams = JSON.parse(sent).params;
    // 原文正则断言（与全文件其余用例对大数字段的口径一致）——不止 JSON.parse 后取值，
    // 而是确认序列化到线上的请求体字符串里字面就有这两个键值对，防止中途被改名或丢弃。
    assert.match(sent, /"channelCode":"AI_AGENT"/, '请求体原文必须含 "channelCode":"AI_AGENT"');
    assert.match(sent, /"scene":"AI_AGENT"/, '请求体原文必须含 "scene":"AI_AGENT"');
    assert.equal(sentParams.channelCode, "AI_AGENT");
    assert.equal(sentParams.scene, "AI_AGENT");
  } finally {
    router.restore();
    fx.restore();
  }
});

// ============================================================================
// V4：预估超 10000 分 → prepare 阶段即拒、不签发令牌
// ============================================================================
test("V4: 预估金额超单笔上限（10000 分）→ prepare_order 直接拒绝，不签发令牌、不登记待确认单", async () => {
  const fx = installFixture();
  bindSession();
  const GOODS = "1200000000000000004";
  const router = installRouter({ [PATH_DETAIL]: goodsDetailFixture(GOODS, 2400) });
  try {
    // 5 杯 × ¥24 = ¥120 > 上限 ¥100
    const r = await prepareOrderHandler({ storeId: STORE_ID, items: [{ goodsId: GOODS, quantity: 5 }] });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /单笔金额超上限/);
    assert.match(textOf(r), /120\.00/);
    assert.match(textOf(r), /100\.00/);
    assert.equal(fx.pendingStore.size(), 0, "超限时不许登记待确认单");
    assert.equal(router.countOf(PATH_CREATE), 0, "任何时候都不该碰写接口");
  } finally {
    router.restore();
    fx.restore();
  }
});

// ============================================================================
// V5：DoD 第 4 条三种拒绝场景，理由各自可区分，且都不发写请求
// ============================================================================
test("V5-①: 无令牌（编造 token）→ place_order 拒绝，写请求未发出，写审计 reason=PendingOrderNotFound", async () => {
  const fx = installFixture();
  bindSession();
  const router = installRouter({ [PATH_CREATE]: { status: true, code: 0, data: { orderNo: "D-SHOULD-NOT-EXIST" } } });
  try {
    const r = await placeOrderConfirmedHandler({ confirmToken: "totally-made-up-token", confirmAmountYuan: 24 });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /确认令牌无效/);
    assert.equal(router.countOf(PATH_CREATE), 0, "无令牌时不许发出写请求");
    assert.equal(lastAuditEntry(fx.writeAuditPath).reason, "PendingOrderNotFound");
  } finally {
    router.restore();
    fx.restore();
  }
});

test("V5-②: 令牌过期（假时钟推进 5 分钟+）→ place_order 拒绝，写请求未发出，写审计 reason=PendingOrderExpired", async () => {
  let now = 2_000_000_000_000;
  const fx = installFixture(() => now);
  bindSession();
  const GOODS = "1200000000000000005";
  const router = installRouter({
    [PATH_DETAIL]: goodsDetailFixture(GOODS),
    [PATH_CREATE]: { status: true, code: 0, data: { orderNo: "D-SHOULD-NOT-EXIST" } },
  });
  try {
    const prep = await prepareOrderHandler({ storeId: STORE_ID, items: [{ goodsId: GOODS, quantity: 1 }] });
    const token = jsonOf(prep).confirmToken;

    now += ORDER_GUARD.confirmTokenTtlMs + 1; // 快进过 TTL

    const r = await placeOrderConfirmedHandler({ confirmToken: token, confirmAmountYuan: 24 });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /已过期/);
    assert.equal(router.countOf(PATH_CREATE), 0, "令牌过期时不许发出写请求");
    assert.equal(lastAuditEntry(fx.writeAuditPath).reason, "PendingOrderExpired");
  } finally {
    router.restore();
    fx.restore();
  }
});

test("V5-③: 内容不符（复述金额与待确认单不一致）→ place_order 拒绝，写请求未发出，写审计 reason=ConfirmAmountMismatch", async () => {
  const fx = installFixture();
  bindSession();
  const GOODS = "1200000000000000006";
  const router = installRouter({
    [PATH_DETAIL]: goodsDetailFixture(GOODS),
    [PATH_CREATE]: { status: true, code: 0, data: { orderNo: "D-SHOULD-NOT-EXIST" } },
  });
  try {
    const prep = await prepareOrderHandler({ storeId: STORE_ID, items: [{ goodsId: GOODS, quantity: 1 }] });
    const out = jsonOf(prep);
    assert.equal(out.estimatedTotalYuan, "24.00");

    // 模型念给顾客的是 ¥19.9（比实际便宜），实际要下的是 ¥24 那张单 → 必须拒
    const r = await placeOrderConfirmedHandler({ confirmToken: out.confirmToken, confirmAmountYuan: 19.9 });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /复述金额与待确认单不一致/);
    assert.match(textOf(r), /19\.90/);
    assert.match(textOf(r), /24\.00/);
    assert.equal(router.countOf(PATH_CREATE), 0, "复述金额不符时不许发出写请求");
    assert.equal(lastAuditEntry(fx.writeAuditPath).reason, "ConfirmAmountMismatch:1990vs2400");

    // 三种拒绝理由互不相同（DoD 第 4 条要求"各有证据、可区分"）
    const reasons = new Set(
      readFileSync(fx.writeAuditPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).reason),
    );
    assert.ok(reasons.has("ConfirmAmountMismatch:1990vs2400"));
  } finally {
    router.restore();
    fx.restore();
  }
});

// ============================================================================
// V6：正常链路全通 —— 发出的 params 与登记一致 + 读回四项齐备
// ============================================================================
test("V6: prepare → place 全链路 —— 请求体 params 与登记 finalParams 一致（19 位 userId 原文断言），读回含企迈金额/优惠/预估/差额四项", async () => {
  const fx = installFixture();
  bindSession();
  const GOODS = "1200000000000000007";
  const router = installRouter({
    [PATH_DETAIL]: goodsDetailFixture(GOODS, 2400),
    [PATH_CREATE]: { status: true, code: 0, message: "创建订单成功", data: { orderNo: "D-M4-OK", payAmount: 24.0, needPay: 1 } },
    [PATH_DETAIL_ORDER]: {
      status: true,
      code: 0,
      data: {
        orderNo: "D-M4-OK",
        orderStatus: 10,
        userId: FAKE_CUSTOMER_ID,
        actualAmount: 2400, // ⚠️ 6.1.9 单位是「分」
        totalAmount: 2400,
        discountList: [{ discountName: "新客立减", discountAmount: 0 }],
        storeOrderNo: "A012",
      },
    },
  });
  try {
    const prep = await prepareOrderHandler({
      storeId: STORE_ID,
      items: [{ goodsId: GOODS, practices: ["少冰（400ml)"], quantity: 1 }],
    });
    const prepOut = jsonOf(prep);
    const lookup = fx.pendingStore.lookup(prepOut.confirmToken);
    assert.equal(lookup.status, "ok");
    if (lookup.status !== "ok") return;

    const r = await placeOrderConfirmedHandler({ confirmToken: prepOut.confirmToken, confirmAmountYuan: 24.0 });
    assert.equal(r.isError ?? false, false, `全链路应成功：${textOf(r)}`);
    const out = jsonOf(r);

    // —— 发出的写请求恰好一次，body.params 与登记的 finalParams 一致 ——
    assert.equal(router.countOf(PATH_CREATE), 1, "写请求应恰好发出一次");
    const sent = router.bodiesOf(PATH_CREATE)[0];
    // 19 位大数用请求体原文正则断言：restoreIdsForSend 会把它还原成无引号数字，
    // JSON.parse 在 JS 侧会把它折成精度不足的 number，不能用来断言（同 m3AcceptanceGauntlet B5a）。
    assert.match(sent, new RegExp(`"userId":${FAKE_CUSTOMER_ID}[,}]`), "请求体 userId 应为无损 19 位数字");
    assert.match(sent, new RegExp(`"goodsId":${GOODS}[,}]`));
    assert.match(sent, /"skuId":1288634197263667200[,}]/);
    assert.match(sent, /"orderType":1[,}]/);
    assert.match(sent, /"source":18[,}]/);
    // 逐字段比对登记 finalParams 与实际发出的 params（大数字段单独用原文正则，其余结构比对）
    const sentParams = JSON.parse(sent).params;
    const registered = JSON.parse(JSON.stringify(lookup.order.finalParams));
    assert.equal(sentParams.storeId, registered.storeId);
    assert.equal(sentParams.orderType, registered.orderType);
    assert.equal(sentParams.source, registered.source);
    assert.equal(sentParams.items.length, registered.items.length);
    assert.equal(sentParams.items[0].num, registered.items[0].num);
    assert.equal(sentParams.items[0].practiceList.length, registered.items[0].practiceList.length);
    assert.equal(sentParams.items[0].practiceList[0].name, registered.items[0].practiceList[0].name);
    assert.equal(sentParams.items[0].practiceList[0].value, registered.items[0].practiceList[0].value);

    // —— 读回四项 ——
    assert.equal(out.placed, true);
    assert.equal(out.orderNo, "D-M4-OK");
    assert.equal(out.qmaiActualAmountYuan, "24.00", "企迈实付金额：2400 分 → ¥24.00");
    assert.deepEqual(out.discountList, [{ discountName: "新客立减", discountAmount: 0 }]);
    assert.equal(out.estimatedTotalYuan, "24.00");
    assert.equal(out.diffYuan, "0.00");
    assert.equal(out.warning, undefined, "零差额不该告警");
    assert.equal(out.readbackFailed, undefined);
    // 6.2.9 的 payAmount 是「元」，原样带出、不与分制字段混算
    assert.equal(out.qmaiPayAmountYuanFromCreate, "24");
    assert.equal(router.countOf(PATH_DETAIL_ORDER), 1, "读回应恰好一次");

    // 写审计 allowed
    const entry = lastAuditEntry(fx.writeAuditPath);
    assert.equal(entry.result, "allowed");
    assert.equal(entry.orderNo, "D-M4-OK");
    assert.equal(entry.summary.estimatedAmountFen, 2400);
  } finally {
    router.restore();
    fx.restore();
  }
});

// ============================================================================
// V7：差额告警
// ============================================================================
test("V7: 读回金额与预估差 ¥2（超 ¥1 阈值）→ 返回体带 warning，且如实给出两侧金额与差额", async () => {
  const fx = installFixture();
  bindSession();
  const GOODS = "1200000000000000008";
  const router = installRouter({
    [PATH_DETAIL]: goodsDetailFixture(GOODS, 2400),
    [PATH_CREATE]: { status: true, code: 0, data: { orderNo: "D-M4-DIFF", payAmount: 26.0 } },
    [PATH_DETAIL_ORDER]: {
      status: true,
      code: 0,
      data: { orderNo: "D-M4-DIFF", userId: FAKE_CUSTOMER_ID, actualAmount: 2600, discountList: [] },
    },
  });
  try {
    const prep = await prepareOrderHandler({ storeId: STORE_ID, items: [{ goodsId: GOODS, quantity: 1 }] });
    const r = await placeOrderConfirmedHandler({ confirmToken: jsonOf(prep).confirmToken, confirmAmountYuan: 24 });
    const out = jsonOf(r);

    assert.equal(out.placed, true);
    assert.equal(out.qmaiActualAmountYuan, "26.00");
    assert.equal(out.estimatedTotalYuan, "24.00");
    assert.equal(out.diffYuan, "2.00");
    assert.ok(typeof out.warning === "string" && out.warning.length > 0, "差额 ¥2 应触发 warning");
    assert.match(out.warning, /金额与预估不一致/);
    assert.match(out.nextStep, /先说清金额差额并核对/);
  } finally {
    router.restore();
    fx.restore();
  }
});

// ============================================================================
// V8：读回失败不算下单失败，且绝不重试下单
// ============================================================================
test("V8: 6.1.9 读回返回空 data → 返回体 readbackFailed=true 且含 orderNo；6.2.9 只被调用 1 次（绝不重试下单）", async () => {
  const fx = installFixture();
  bindSession();
  const GOODS = "1200000000000000009";
  const router = installRouter({
    [PATH_DETAIL]: goodsDetailFixture(GOODS, 2400),
    [PATH_CREATE]: { status: true, code: 0, data: { orderNo: "D-M4-READBACK-FAIL", payAmount: 24.0 } },
    [PATH_DETAIL_ORDER]: { status: true, code: 0, data: null }, // 实测形态：查已取消订单返回空 data
  });
  try {
    const prep = await prepareOrderHandler({ storeId: STORE_ID, items: [{ goodsId: GOODS, quantity: 1 }] });
    const r = await placeOrderConfirmedHandler({ confirmToken: jsonOf(prep).confirmToken, confirmAmountYuan: 24 });
    assert.equal(r.isError ?? false, false, "读回失败不该被当成下单失败");
    const out = jsonOf(r);

    assert.equal(out.placed, true);
    assert.equal(out.orderNo, "D-M4-READBACK-FAIL", "订单号必须如实给出——单子是真的下出去了");
    assert.equal(out.readbackFailed, true);
    assert.match(out.readbackNote, /订单已创建成功/);
    assert.match(out.readbackNote, /核对/);
    assert.equal(out.qmaiActualAmountYuan, undefined, "读不回来就不许编金额");
    assert.equal(router.countOf(PATH_CREATE), 1, "读回失败绝不能触发重新下单");
  } finally {
    router.restore();
    fx.restore();
  }
});

// ---------- V8 附：读回字段为 null（企迈实测会给 null）不许被当成 ¥0.00 ----------
test("V8 附: 6.1.9 的 actualAmount 返回 null → 按读回失败处理，绝不报成「企迈实付 ¥0.00」", async () => {
  const fx = installFixture();
  bindSession();
  const GOODS = "1200000000000000014";
  const router = installRouter({
    [PATH_DETAIL]: goodsDetailFixture(GOODS, 2400),
    [PATH_CREATE]: { status: true, code: 0, data: { orderNo: "D-M4-NULL-AMOUNT", payAmount: 24.0 } },
    [PATH_DETAIL_ORDER]: {
      status: true,
      code: 0,
      data: { orderNo: "D-M4-NULL-AMOUNT", userId: FAKE_CUSTOMER_ID, actualAmount: null, discountList: [] },
    },
  });
  try {
    const prep = await prepareOrderHandler({ storeId: STORE_ID, items: [{ goodsId: GOODS, quantity: 1 }] });
    const r = await placeOrderConfirmedHandler({ confirmToken: jsonOf(prep).confirmToken, confirmAmountYuan: 24 });
    const out = jsonOf(r);
    assert.equal(out.placed, true);
    assert.equal(out.orderNo, "D-M4-NULL-AMOUNT");
    assert.equal(out.readbackFailed, true, "金额字段为 null 应算读回失败");
    assert.equal(out.qmaiActualAmountYuan, undefined);
    assert.ok(!/0\.00/.test(textOf(r)), "绝不许把 null 金额报成 ¥0.00");
    assert.equal(router.countOf(PATH_CREATE), 1, "不许重试下单");
  } finally {
    router.restore();
    fx.restore();
  }
});

// ============================================================================
// V9：令牌一次性 + 重新 prepare 后同内容仍可下单（幂等键绑令牌 ID 的既有语义不许破坏）
// ============================================================================
test("V9: 同一令牌第二次 place → TokenAlreadyUsed 拒且不发写请求；重新 prepare 拿新令牌下同样内容 → 放行", async () => {
  const fx = installFixture();
  bindSession();
  const GOODS = "1200000000000000010";
  const router = installRouter({
    [PATH_DETAIL]: goodsDetailFixture(GOODS, 2400),
    [PATH_CREATE]: [
      { status: true, code: 0, data: { orderNo: "D-M4-FIRST", payAmount: 24.0 } },
      { status: true, code: 0, data: { orderNo: "D-M4-SECOND", payAmount: 24.0 } },
    ],
    [PATH_DETAIL_ORDER]: {
      status: true,
      code: 0,
      data: { orderNo: "D-M4-ANY", userId: FAKE_CUSTOMER_ID, actualAmount: 2400, discountList: [] },
    },
  });
  try {
    const items = [{ goodsId: GOODS, practices: ["少冰（400ml)"], quantity: 1 }];

    const prep1 = await prepareOrderHandler({ storeId: STORE_ID, items });
    const token1 = jsonOf(prep1).confirmToken;
    const first = await placeOrderConfirmedHandler({ confirmToken: token1, confirmAmountYuan: 24 });
    assert.equal(first.isError ?? false, false, `第一次下单应成功：${textOf(first)}`);
    assert.equal(jsonOf(first).orderNo, "D-M4-FIRST");
    assert.equal(router.countOf(PATH_CREATE), 1);

    // 同一令牌重放 → 命中 callWrite 的 TokenAlreadyUsed（用后即焚），写请求次数不变
    const replay = await placeOrderConfirmedHandler({ confirmToken: token1, confirmAmountYuan: 24 });
    assert.equal(replay.isError, true);
    assert.match(textOf(replay), /TokenAlreadyUsed/);
    assert.equal(router.countOf(PATH_CREATE), 1, "重放不许发出第二次写请求");

    // 重新组单拿新令牌，下一模一样的内容 → 必须放行（幂等键 = fingerprint({params, tokenId})，
    // 新令牌 → 新幂等键；"同款商品终身只能买一次"是 M2 修过的缺陷，不许回归）
    const prep2 = await prepareOrderHandler({ storeId: STORE_ID, items });
    const token2 = jsonOf(prep2).confirmToken;
    assert.notEqual(token2, token1);
    const second = await placeOrderConfirmedHandler({ confirmToken: token2, confirmAmountYuan: 24 });
    assert.equal(second.isError ?? false, false, `同内容的第二次独立购买不该被误拒：${textOf(second)}`);
    assert.equal(jsonOf(second).orderNo, "D-M4-SECOND");
    assert.equal(router.countOf(PATH_CREATE), 2);
  } finally {
    router.restore();
    fx.restore();
  }
});

// ============================================================================
// V10：my_orders
// ============================================================================
test("V10-①: 未绑定调用 my_orders → 拒绝，fetch 未被调用", async () => {
  const fx = installFixture();
  const router = installRouter({ [PATH_ORDER_LIST]: { status: true, code: 0, data: { data: [], total: 0 } } });
  try {
    const r = await myOrdersHandler({ days: 7 });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /尚未绑定会员/);
    assert.equal(router.countOf(PATH_ORDER_LIST), 0, "未绑定不许发请求");
    const entry = lastAuditEntry(fx.accessAuditPath);
    assert.equal(entry.event, "unbound_call_rejected");
    assert.equal(entry.tool, "my_orders");
  } finally {
    router.restore();
    fx.restore();
  }
});

test("V10-②: 绑定后 my_orders → 从 data.data 正确解析、actualAmount 分转元、出参无 userId、请求按会话 userId 发起", async () => {
  const fx = installFixture();
  bindSession();
  const router = installRouter({
    [PATH_ORDER_LIST]: {
      status: true,
      code: 0,
      // ⚠️ 实测坑：订单数组在 data.data，不是 list/records
      data: {
        blttUserId: FAKE_CUSTOMER_ID,
        total: 2,
        data: [
          {
            orderNo: "D-LIST-1",
            status: 20,
            actualAmount: 2400, // 分
            orderAt: 1786979252000,
            userId: FAKE_CUSTOMER_ID,
            itemList: [{ itemName: "瑞香大红袍奶茶", num: 1 }],
          },
          {
            orderNo: "D-LIST-2",
            status: 60,
            actualAmount: 4800,
            orderAt: 1786979252000,
            userId: FAKE_CUSTOMER_ID,
            itemList: [{ itemName: "李茶的莲雾2.0", num: 2 }],
          },
        ],
      },
    },
  });
  try {
    const r = await myOrdersHandler({ days: 7 });
    assert.equal(r.isError ?? false, false, textOf(r));
    const out = jsonOf(r);

    assert.equal(out.count, 2);
    assert.equal(out.orders[0].orderNo, "D-LIST-1");
    assert.equal(out.orders[0].status, 20);
    assert.equal(out.orders[0].statusText, "已支付");
    assert.equal(out.orders[0].actualAmountYuan, "24.00", "2400 分 → ¥24.00");
    assert.deepEqual(out.orders[0].items, ["瑞香大红袍奶茶"]);
    assert.equal(out.orders[1].statusText, "已取消");
    assert.equal(out.orders[1].actualAmountYuan, "48.00");
    assert.deepEqual(out.orders[1].items, ["李茶的莲雾2.0 ×2"]);
    assert.ok(!/userId/.test(textOf(r)), "出参不许含 userId");
    assert.ok(!textOf(r).includes(FAKE_CUSTOMER_ID), "出参不许出现完整 customerId");

    // 请求侧：userId 用会话绑定值（19 位大数原文断言），分页与时间窗按约定
    const sent = router.bodiesOf(PATH_ORDER_LIST)[0];
    assert.match(sent, new RegExp(`"userId":${FAKE_CUSTOMER_ID}[,}]`));
    assert.match(sent, /"pageNo":1[,}]/);
    assert.match(sent, /"pageSize":10[,}]/);
  } finally {
    router.restore();
    fx.restore();
  }
});

test("V10-② 附: 订单行的 status / actualAmount 为 null → 不报成「状态 0 / ¥0.00」，如实置空", async () => {
  const fx = installFixture();
  bindSession();
  const router = installRouter({
    [PATH_ORDER_LIST]: {
      status: true,
      code: 0,
      data: {
        total: 1,
        data: [{ orderNo: "D-NULL-FIELDS", status: null, actualAmount: null, userId: FAKE_CUSTOMER_ID, itemList: [] }],
      },
    },
  });
  try {
    const r = await myOrdersHandler({ days: 7 });
    const out = jsonOf(r);
    assert.equal(out.count, 1);
    assert.equal(out.orders[0].status, null);
    assert.equal(out.orders[0].statusText, "状态未知");
    assert.equal(out.orders[0].actualAmountYuan, null, "null 金额必须置空，不能变成 0.00");
    assert.ok(!/0\.00/.test(textOf(r)));
  } finally {
    router.restore();
    fx.restore();
  }
});

test("V10-③: my_orders 响应里混入别人的订单（userId 不符）→ 该单被丢弃、不出现在结果里", async () => {
  const fx = installFixture();
  bindSession();
  const router = installRouter({
    [PATH_ORDER_LIST]: {
      status: true,
      code: 0,
      data: {
        total: 2,
        data: [
          { orderNo: "D-MINE", status: 20, actualAmount: 2400, userId: FAKE_CUSTOMER_ID, itemList: [] },
          { orderNo: "D-SOMEONE-ELSE", status: 20, actualAmount: 9900, userId: "9999999999999999999", itemList: [] },
        ],
      },
    },
  });
  try {
    const r = await myOrdersHandler({ days: 7 });
    const out = jsonOf(r);
    assert.equal(out.count, 1);
    assert.equal(out.orders[0].orderNo, "D-MINE");
    assert.equal(out.discardedNotOwned, 1);
    assert.ok(!textOf(r).includes("D-SOMEONE-ELSE"), "别人的订单号不许出现在出参里");
    assert.equal(lastAuditEntry(fx.accessAuditPath).event, "ownership_mismatch");
  } finally {
    router.restore();
    fx.restore();
  }
});

// ============================================================================
// V12：TTL 过期后待确认单登记表同步清理（不泄漏内存）
// ============================================================================
test("V12: 令牌 TTL 过期后，待确认单登记表在下一次登记时被物理清理（size 归零，不泄漏内存）", async () => {
  let now = 3_000_000_000_000;
  const fx = installFixture(() => now);
  bindSession();
  const router = installRouter({
    [PATH_DETAIL]: [goodsDetailFixture("1200000000000000011"), goodsDetailFixture("1200000000000000012")],
  });
  try {
    const prep1 = await prepareOrderHandler({ storeId: STORE_ID, items: [{ goodsId: "1200000000000000011", quantity: 1 }] });
    const token1 = jsonOf(prep1).confirmToken;
    assert.equal(fx.pendingStore.size(), 1);
    assert.equal(fx.pendingStore.lookup(token1).status, "ok");

    now += ORDER_GUARD.confirmTokenTtlMs + 1; // 过 TTL
    assert.equal(fx.pendingStore.lookup(token1).status, "expired", "过期后应报 expired（记录还在，状态可辨）");
    assert.equal(fx.pendingStore.size(), 1, "清理由下一次登记触发，此刻记录尚在");

    // 再组一张新单 → register 顺手 pruneExpired，旧条目被物理清除
    const prep2 = await prepareOrderHandler({ storeId: STORE_ID, items: [{ goodsId: "1200000000000000012", quantity: 1 }] });
    const token2 = jsonOf(prep2).confirmToken;
    assert.equal(fx.pendingStore.size(), 1, "过期条目已被清除，只剩新登记的这一张");
    assert.equal(fx.pendingStore.lookup(token1).status, "absent", "旧令牌的记录已被物理删除");
    assert.equal(fx.pendingStore.lookup(token2).status, "ok");
  } finally {
    router.restore();
    fx.restore();
  }
});

// ============================================================================
// 红线自证：本文件跑完后，生产 logs/ 目录不该被碰过
// ============================================================================
test("红线自证：本测试文件全程零真实网络请求，且生产 logs/ 一字未变", () => {
  // globalThis.fetch 在每条用例的 finally 里都恢复成 realFetch，这里确认没有残留的 mock。
  assert.equal(globalThis.fetch, realFetch, "mock fetch 应已全部恢复");
  // 判据 2026-08-19 升级：原先断言的是「write-audit.log / placed-orders.json / access-audit.log
  // 三个生产文件**不存在**」。那个判据依赖一个此后不再成立的前提——写侧从未真跑过。
  // M6 真单一跑（老板 2026-08-19 实测，日志按 LICHA_LOG_DIR 钉在项目 logs/），三个文件就都真实存在了，
  // 于是这条用例会永久变红，而它本该守的东西根本没被破坏。
  //
  // 换成哈希快照对比——这才是红线的原意：「测试不许**改动**生产 logs/」，
  // 而不是「生产 logs/ 不许存在」。顺带比原判据更严：「不存在」只挡得住从无到有，
  // 快照连「已有文件被追加一行」都挡得住。体例与 auditSanitizer.test.ts / handlerInputSanitizer.test.ts
  // 的同类用例统一，全项目一份判据。
  assert.equal(snapshotProdLogs(), PROD_LOGS_SNAPSHOT_AT_START, "本测试文件跑完后生产 logs/ 必须一字未变");
});
