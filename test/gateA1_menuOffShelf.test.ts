// 24 号任务书 A1：get_menu 不再把已下架商品当正常候选。
//
// 现状（3796619）：isRealGoods 只看「价格 > 0 且 type 正常」，status=20（手册 3.1.11：10 上架 / 20 下架）
// 的商品照样进列表——老板 M6 实测「菜单搜得到、点单卡片才暴露已下架」（施工令 §8-38），
// 22 号只读反例 MENU_OFF_SHELF_REPRO 复现 returnedItems=1。
//
// 全 mock：globalThis.fetch 按路径分发；getMenu 有模块级缓存（分类 5 分钟 / 搜索 2 分钟），
// 每条用例用不同 storeId 或关键词避免互相命中。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setReadAuditLogPathForTesting } from "../src/client.js";
import { getMenu } from "../src/tools/getMenu.js";

process.env.QMAI_OPEN_KEY ??= "test-open-key-0123456789abcdef0123456789ab";
process.env.QMAI_OPEN_ID ??= "test-open-id-0000000000000000";
process.env.QMAI_GRANT_CODE ??= "test-grant-code-0000000000";

const realFetch = globalThis.fetch;
const PATH_CATEGORY = "v3/goods/item/getShopCategory";
const PATH_BY_CATEGORY = "v3/goods/item/getShopGoodsListByCategory";
const PATH_SEARCH = "v3/goods/item/getShopGoodsList/search";

type Goods = Record<string, unknown>;
function goods(goodsId: string, name: string, opts: { status?: number; price?: number; type?: number } = {}): Goods {
  const g: Goods = { goodsId, name, type: opts.type ?? 1, goodsSkuList: [{ salePrice: opts.price ?? 2400 }] };
  if (opts.status !== undefined) g.status = opts.status;
  return g;
}

function installRouter(routes: Record<string, unknown>): { countOf: (p: string) => number; restore: () => void } {
  const counts = new Map<string, number>();
  const dir = mkdtempSync(join(tmpdir(), "licha-a1-"));
  setReadAuditLogPathForTesting(join(dir, "read-audit.log"));
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) throw new Error(`mock 路由未覆盖的路径：${url}`);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return new Response(JSON.stringify({ status: true, code: 0, data: routes[key] }), { status: 200 });
  }) as typeof fetch;
  return {
    countOf: (p) => counts.get(p) ?? 0,
    restore: () => {
      globalThis.fetch = realFetch;
      setReadAuditLogPathForTesting(null);
    },
  };
}

function itemsOf(r: Awaited<ReturnType<typeof getMenu>>): Array<{ name: string }> {
  assert.equal(r.mode, "items");
  return (r as { items: Array<{ name: string }> }).items;
}
function hintOf(r: Awaited<ReturnType<typeof getMenu>>): string {
  return (r as { hint?: string }).hint ?? "";
}

test("A1-1: 搜索路——status=20 的商品被过滤，status=10 的保留", async () => {
  const fx = installRouter({
    [PATH_CATEGORY]: [{ categoryName: "茶类", frontCategoryId: "1" }],
    [PATH_SEARCH]: [goods("g1", "已下架乌龙", { status: 20 }), goods("g2", "在售乌龙", { status: 10 })],
  });
  try {
    const r = await getMenu(910001, "乌龙");
    const items = itemsOf(r);
    assert.deepEqual(items.map((i) => i.name), ["在售乌龙"]);
    assert.match(hintOf(r), /估清/, "有候选时必须提醒列表不含估清状态");
  } finally {
    fx.restore();
  }
});

test("A1-2: 分类路——同样过滤下架，只留在售", async () => {
  const fx = installRouter({
    [PATH_CATEGORY]: [{ categoryName: "审计茶类", frontCategoryId: "9" }],
    [PATH_BY_CATEGORY]: [goods("g3", "已下架测试茶", { status: 20 }), goods("g4", "在售测试茶", { status: 10 })],
  });
  try {
    const r = await getMenu(910002, "审计茶类");
    assert.equal((r as { via?: string }).via, "category");
    assert.deepEqual(itemsOf(r).map((i) => i.name), ["在售测试茶"]);
    assert.match(hintOf(r), /估清/);
  } finally {
    fx.restore();
  }
});

test("A1-3: status 字段缺省 → 照常返回（缺省 ≠ 下架）", async () => {
  const fx = installRouter({
    [PATH_CATEGORY]: [{ categoryName: "茶类", frontCategoryId: "1" }],
    [PATH_SEARCH]: [goods("g5", "没标状态的茶")],
  });
  try {
    assert.deepEqual(itemsOf(await getMenu(910003, "没标")).map((i) => i.name), ["没标状态的茶"]);
  } finally {
    fx.restore();
  }
});

test("A1-4: 防退化——0 元文案假商品仍被过滤；分类下全下架 → 空列表 + 「暂无可点商品」提示", async () => {
  const fx = installRouter({
    [PATH_CATEGORY]: [{ categoryName: "全下架类", frontCategoryId: "7" }],
    [PATH_BY_CATEGORY]: [goods("g6", "40s萃取工艺", { price: 0 }), goods("g7", "下架 A", { status: 20 }), goods("g8", "下架 B", { status: 20 })],
  });
  try {
    const r = await getMenu(910004, "全下架类");
    assert.equal(itemsOf(r).length, 0);
    assert.match(hintOf(r), /暂无可点商品/);
    assert.doesNotMatch(hintOf(r), /估清/, "没有候选时不该再提估清");
  } finally {
    fx.restore();
  }
});

test("A1-5: 审计只读反例 MENU_OFF_SHELF_REPRO 一比一——status=20 单品经分类路 → returnedItems=0", async () => {
  const fx = installRouter({
    [PATH_CATEGORY]: [{ categoryName: "审计茶类", frontCategoryId: "1234567890123456789" }],
    [PATH_BY_CATEGORY]: [{ goodsId: "2234567890123456789", name: "已下架测试茶", status: 20, type: 1, goodsSkuList: [{ salePrice: 2400 }] }],
  });
  try {
    const r = await getMenu(910005, "审计茶类");
    assert.equal(itemsOf(r).length, 0, "审计反例断言的 items.length==1 必须翻转为 0");
    assert.equal(fx.countOf(PATH_BY_CATEGORY), 1);
  } finally {
    fx.restore();
  }
});
