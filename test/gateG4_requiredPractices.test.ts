// G4 收口门：缺任一必选做法组，确认门直接拒绝、零令牌（任务书 23 号 §3 G4）。
//
// 缺陷形态（21 号 P1-2，零网络探针复现）：详情里温度组是 isRequired:1 的必选组，
// prepare_order 的 practices 整个省略，照样签出令牌、待确认单里做法为空——
// 顾客没被问过温度，单子却已经可以提交。SKILL.md 那句「必选项逐项问完」只是给模型的嘱咐，
// 嘱咐拦不住省略：门必须设在服务端。
//
// 🚨 isDefault 施工裁决（回执 §9 G4）：必选组里某个值带 isDefault:1 也**不自动落默认**。
// 那是企迈小程序 UI 的预选态，不是顾客意愿；服务端替顾客选温度，顾客拿到一杯没要的冰饮。
// 本文件 G4-1 附 就是这条裁决的验收用例。
//
// 🚨 红线自证：fetch 整体 mock（含写路径，注册成「绝不该出现」的响应并逐条断言 0 次）；
// 五件套注入指向 mkdtemp 临时目录；识别值全用假值。
// 「零 fetch」指**写路径零请求**——必选组有哪些只能从详情里知道，本轮详情那一次读是必要的。

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
import { prepareOrderHandler } from "../src/prepareOrderTool.js";

process.env.QMAI_OPEN_KEY ??= "test-open-key-0123456789abcdef0123456789ab";
process.env.QMAI_OPEN_ID ??= "test-open-id-0000000000000000";
process.env.QMAI_GRANT_CODE ??= "test-grant-code-0000000000";

const FAKE_CUSTOMER_ID = "1234567890123456789";
const FAKE_PHONE = "13800001234";
const STORE_ID = 503542;
const realFetch = globalThis.fetch;

const PATH_DETAIL = "v3/goods/item/getShopGoodsDetail";
const PATH_CREATE = "v3/newPattern/cateringApiserver/post/order/v1/create";

/** 绝不该被调到的写响应：一旦计数不为 0，说明门漏了。 */
const CREATE_SHOULD_NOT_HAPPEN = {
  status: true,
  code: 0,
  data: { orderNo: "D-G4-SHOULD-NOT-EXIST", payAmount: 24.0 },
};

/**
 * 详情 fixture：
 *   温度（isRequired:1，「热」带 isDefault:1）
 *   糖度（isRequired:1，无 isDefault）
 *   低GI-L阿拉伯糖（isRequired:0）
 */
function detailFixture(goodsId: string, name = "G4 测试奶茶"): Record<string, unknown> {
  return {
    status: true,
    code: 0,
    data: [
      {
        goodsId,
        name,
        type: 1,
        status: 10,
        goodsSkuList: [{ skuId: "1288634197263667200", salePrice: 2400, clearStatus: 1, inventory: 99, specName: "标准杯" }],
        sortedPracticeList: [
          {
            practiceId: "1123413139990425601",
            practiceName: "温度",
            isRequired: 1,
            practiceValueList: [
              { practiceValueId: "1199823927794012164", practiceValue: "热", price: 0, isDefault: 1 },
              { practiceValueId: "1199823927794012165", practiceValue: "常温", price: 0 },
              { practiceValueId: "1199823927794012166", practiceValue: "少冰（400ml)", price: 0 },
            ],
          },
          {
            practiceId: "1123413139990425602",
            practiceName: "糖度",
            isRequired: 1,
            practiceValueList: [
              { practiceValueId: "1199823927794012171", practiceValue: "半糖", price: 0 },
              { practiceValueId: "1199823927794012172", practiceValue: "无糖", price: 0 },
            ],
          },
          {
            practiceId: "1123413632158486529",
            practiceName: "低GI-L阿拉伯糖",
            isRequired: 0,
            practiceValueList: [{ practiceValueId: "1123413632158486531", practiceValue: "70%-L阿拉伯糖", price: 0 }],
          },
        ],
        attachGoodsList: [],
      },
    ],
  };
}

/** 只有非必选组的详情（反例 4 用：非必选组省略必须照常签令牌）。 */
function optionalOnlyFixture(goodsId: string): Record<string, unknown> {
  return {
    status: true,
    code: 0,
    data: [
      {
        goodsId,
        name: "G4 全可选奶茶",
        type: 1,
        status: 10,
        goodsSkuList: [{ skuId: "1288634197263667200", salePrice: 2400, clearStatus: 1, inventory: 99, specName: "标准杯" }],
        sortedPracticeList: [
          {
            practiceId: "1123413632158486529",
            practiceName: "低GI-L阿拉伯糖",
            isRequired: 0,
            practiceValueList: [{ practiceValueId: "1123413632158486531", practiceValue: "70%-L阿拉伯糖", price: 0 }],
          },
          {
            // isRequired 字段整个缺省 → 视为非必选（「没标记」不是「必选」）。
            practiceId: "1123413632158486530",
            practiceName: "冰量",
            practiceValueList: [{ practiceValueId: "1123413632158486532", practiceValue: "正常冰", price: 0 }],
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
  const dir = mkdtempSync(join(tmpdir(), "licha-g4-"));
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

// ============================================================================
// G4-1（任务书验收反例 1）：必选组存在、practices 省略 → 拒、零令牌、写路径 0 次
// ============================================================================
test("G4-1: 必选温度/糖度组存在而 practices 整个省略 → 结构化拒绝、pending 零登记、写路径 0 次", async () => {
  const fx = installFixture();
  bindSession();
  const GOODS = "1400000000000000401";
  const router = installRouter({ [PATH_DETAIL]: detailFixture(GOODS), [PATH_CREATE]: CREATE_SHOULD_NOT_HAPPEN });
  try {
    const r = await prepareOrderHandler({ storeId: STORE_ID, items: [{ goodsId: GOODS, quantity: 1 }] });
    assert.equal(r.isError, true, "省略必选做法必须被拒");
    assert.match(textOf(r), /必选做法没选/);
    assert.match(textOf(r), /温度/, "错误必须点名缺哪一组");
    assert.match(textOf(r), /糖度/, "两组都缺就两组都点名");
    assert.match(textOf(r), /可选：热 \/ 常温 \/ 少冰（400ml\)/, "点名之外还要给出可选值，模型才问得下去");
    assert.match(textOf(r), /请逐项问顾客后重新组单/);
    assert.equal(fx.pendingStore.size(), 0, "🚨 零令牌：缺必选做法不许留下任何可提交的单");
    assert.equal(router.countOf(PATH_CREATE), 0, "🚨 写路径一次都不许碰");
    assert.equal(router.countOf(PATH_DETAIL), 1, "只读了本轮那一次详情（必选组有哪些必须从详情知道）");
  } finally {
    router.restore();
    fx.restore();
  }
});

test("G4-1 附（isDefault 裁决）: 必选温度组的「热」带 isDefault:1，省略仍拒 —— 不替顾客落默认", async () => {
  const fx = installFixture();
  bindSession();
  const GOODS = "1400000000000000402";
  const router = installRouter({ [PATH_DETAIL]: detailFixture(GOODS), [PATH_CREATE]: CREATE_SHOULD_NOT_HAPPEN });
  try {
    // 糖度传了、温度没传：温度组恰好是带 isDefault 的那一组，若自动落默认这单就会放行。
    const r = await prepareOrderHandler({ storeId: STORE_ID, items: [{ goodsId: GOODS, practices: ["半糖"], quantity: 1 }] });
    assert.equal(r.isError, true, "带 isDefault 的必选组缺省同样拒绝（不自动落默认）");
    assert.match(textOf(r), /温度/);
    assert.equal(fx.pendingStore.size(), 0, "🚨 不许出现一张温度被服务端替顾客选成「热」的单");
    assert.equal(router.countOf(PATH_CREATE), 0);
  } finally {
    router.restore();
    fx.restore();
  }
});

// ============================================================================
// G4-2（任务书验收反例 2）：传了糖度漏了温度 → 错误点名「温度」
// ============================================================================
test("G4-2: 传了糖度、漏了温度 → 错误点名「温度」且不误报已选的「糖度」，零令牌、写路径 0 次", async () => {
  const fx = installFixture();
  bindSession();
  const GOODS = "1400000000000000403";
  const router = installRouter({ [PATH_DETAIL]: detailFixture(GOODS), [PATH_CREATE]: CREATE_SHOULD_NOT_HAPPEN });
  try {
    const r = await prepareOrderHandler({ storeId: STORE_ID, items: [{ goodsId: GOODS, practices: ["无糖"], quantity: 1 }] });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /温度/, "缺的那一组必须被点名");
    assert.doesNotMatch(textOf(r), /糖度/, "已经选过的组不许被算成缺失（否则模型会重复问顾客）");
    assert.equal(fx.pendingStore.size(), 0);
    assert.equal(router.countOf(PATH_CREATE), 0);
  } finally {
    router.restore();
    fx.restore();
  }
});

test("G4-2 附: 两行单里只有第二行缺必选组 → 错误点名那一行的商品名，整单零令牌", async () => {
  const fx = installFixture();
  bindSession();
  const A = "1400000000000000404";
  const B = "1400000000000000405";
  const router = installRouter({
    [PATH_DETAIL]: [detailFixture(A, "第一杯齐全茶"), detailFixture(B, "第二杯缺温度茶")],
    [PATH_CREATE]: CREATE_SHOULD_NOT_HAPPEN,
  });
  try {
    const r = await prepareOrderHandler({
      storeId: STORE_ID,
      items: [
        { goodsId: A, practices: ["常温", "半糖"], quantity: 1 },
        { goodsId: B, practices: ["半糖"], quantity: 1 },
      ],
    });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /第二杯缺温度茶/, "点名出错的那一行商品");
    assert.doesNotMatch(textOf(r), /第一杯齐全茶/);
    assert.equal(fx.pendingStore.size(), 0, "🚨 一行缺就整单不签令牌（不许把齐全的那一行单独放行）");
    assert.equal(router.countOf(PATH_CREATE), 0);
  } finally {
    router.restore();
    fx.restore();
  }
});

// ============================================================================
// G4-3（任务书验收反例 3，防误伤）：全部必选组齐全 → 正常签令牌
// ============================================================================
test("G4-3: 温度与糖度都传齐 → 正常签令牌，finalParams 的 practiceList 含两组做法", async () => {
  const fx = installFixture();
  bindSession();
  const GOODS = "1400000000000000406";
  const router = installRouter({ [PATH_DETAIL]: detailFixture(GOODS) });
  try {
    const r = await prepareOrderHandler({
      storeId: STORE_ID,
      items: [{ goodsId: GOODS, practices: ["少冰（400ml)", "半糖"], quantity: 1 }],
    });
    assert.equal(r.isError ?? false, false, `齐全的单被误拒：${textOf(r)}`);
    const out = jsonOf(r);
    assert.match(out.confirmToken, /^[0-9a-f]{32}$/);
    assert.deepEqual(out.lines[0].practices, ["少冰（400ml)", "半糖"]);
    const lookup = fx.pendingStore.lookup(out.confirmToken);
    assert.equal(lookup.status, "ok");
    if (lookup.status !== "ok") return;
    const practiceList = (lookup.order.finalParams as any).items[0].practiceList;
    assert.equal(practiceList.length, 2);
    assert.deepEqual(
      practiceList.map((p: any) => `${p.name}:${p.value}`).sort(),
      ["温度:少冰（400ml)", "糖度:半糖"],
    );
  } finally {
    router.restore();
    fx.restore();
  }
});

// ============================================================================
// G4-4（任务书验收反例 4，防误伤）：非必选组省略 → 正常签令牌
// ============================================================================
test("G4-4: 商品只有非必选组（isRequired=0 与字段缺省各一组）、practices 整个省略 → 正常签令牌", async () => {
  const fx = installFixture();
  bindSession();
  const GOODS = "1400000000000000407";
  const router = installRouter({ [PATH_DETAIL]: optionalOnlyFixture(GOODS) });
  try {
    const r = await prepareOrderHandler({ storeId: STORE_ID, items: [{ goodsId: GOODS, quantity: 1 }] });
    assert.equal(r.isError ?? false, false, `非必选组省略不该被拒：${textOf(r)}`);
    const out = jsonOf(r);
    assert.match(out.confirmToken, /^[0-9a-f]{32}$/);
    assert.deepEqual(out.lines[0].practices, [], "没选就是没选，不许替顾客补一个做法进去");
    assert.equal(fx.pendingStore.size(), 1);
  } finally {
    router.restore();
    fx.restore();
  }
});

test("G4-4 附: 必选组齐全、非必选组省略 → 正常签令牌（必选门不牵连可选项）", async () => {
  const fx = installFixture();
  bindSession();
  const GOODS = "1400000000000000408";
  const router = installRouter({ [PATH_DETAIL]: detailFixture(GOODS) });
  try {
    const r = await prepareOrderHandler({
      storeId: STORE_ID,
      items: [{ goodsId: GOODS, practices: ["热", "无糖"], quantity: 1 }],
    });
    assert.equal(r.isError ?? false, false, `非必选组省略不该被拒：${textOf(r)}`);
    assert.deepEqual(jsonOf(r).lines[0].practices, ["热", "无糖"], "非必选的低GI组没传就不出现");
    assert.equal(fx.pendingStore.size(), 1);
  } finally {
    router.restore();
    fx.restore();
  }
});
