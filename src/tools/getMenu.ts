// N4 逛菜单柜台：分类 + 搜索双路。
// 双路逻辑：keyword 命中分类名 → 3.1.11 按分类查（无损 ID 正路，v6 已翻案）；
//           否则 → 3.1.16 搜索（绕行）。无 keyword → 返回分类列表。
// 导出纯函数，不接 MCP 协议（N7 统一接线）。

import { call } from "../client.js";
import { CHANNEL } from "../constants.js";
import { projectUpstreamMessage } from "../outboundText.js";

const MENU_TTL_MS = 5 * 60 * 1000;
const SEARCH_TTL_MS = 2 * 60 * 1000;

interface CategoryRaw {
  categoryName: string;
  frontCategoryId: string;
  categorySort?: number;
}

interface GoodsRaw {
  goodsId: string;
  name: string;
  status?: number;
  type?: number;
  showPriceLow?: number;
  showPriceHigh?: number;
  isPractice?: number | boolean;
  isAttach?: number | boolean;
  goodsSkuList?: Array<{ salePrice?: number }>;
  labelList?: Array<{ labelTypeText?: string; text?: string; image?: string }>;
}

export interface MenuCategory {
  categoryName: string;
  frontCategoryId: string;
}

export interface MenuItem {
  goodsId: string;
  name: string;
  priceYuan: string;
  hasPractice: boolean;
  hasAttach: boolean;
  labels: string[];
}

export type GetMenuResult =
  | { mode: "categories"; storeId: string; categories: MenuCategory[] }
  | { mode: "items"; storeId: string; via: "category" | "search"; categoryName?: string; items: MenuItem[]; hint?: string };

const categoryCache = new Map<string, { at: number; list: CategoryRaw[] }>();
const searchCache = new Map<string, { at: number; items: GoodsRaw[] }>();

// 分 → 元（展示层两位小数）
function fenToYuan(fen: number | undefined): string {
  if (typeof fen !== "number" || !Number.isFinite(fen)) return "价格待询";
  return (fen / 100).toFixed(2);
}

// 列表接口（3.1.11 / 3.1.16）不带估清字段，只有上下架 status 和库存；估清（clearStatus）只在 3.1.12
// 详情里有，所以列表层只能挡下架，估清仍由点单卡片那一关拦。这句话随 items 一起返回，
// 让 Agent 别把「列表里有」说成「已核实在售」（盲审 B06 / 24 号 A1）。
const CLEAR_STATUS_NOTE = "列表不含当日估清状态，是否在售以 get_item_detail 点单卡片为准";

// 脏数据过滤：0 元文案假商品（"40s萃取…"之类）按 价格>0 且 type 正常 剔除；
// 2026-09-08（24 号 A1）追加：已下架（status=20，手册 3.1.11「10 上架 / 20 下架」）不进列表——
// 老板 M6 实测「菜单搜得到、点单卡片才暴露已下架」白耗一轮对话（施工令 §8-38）。
// status 缺省不算下架：「没标记」和「下架」是两回事（与 G4 isRequired 缺省口径一致）。
function isRealGoods(g: GoodsRaw): boolean {
  const skuPrice = g.goodsSkuList?.[0]?.salePrice;
  const price = typeof skuPrice === "number" ? skuPrice : g.showPriceLow;
  const typeOk = g.type === undefined || g.type === 1 || g.type === 3;
  const notOffShelf = g.status !== 20;
  return typeof price === "number" && price > 0 && typeOk && notOffShelf;
}

function toMenuItem(g: GoodsRaw): MenuItem {
  const low = g.goodsSkuList?.[0]?.salePrice ?? g.showPriceLow;
  return {
    goodsId: String(g.goodsId),
    name: g.name,
    priceYuan: fenToYuan(low),
    hasPractice: Boolean(g.isPractice),
    hasAttach: Boolean(g.isAttach),
    labels: (g.labelList ?? [])
      .map((l) => l.text ?? l.labelTypeText)
      .filter((t): t is string => Boolean(t)),
  };
}

async function loadCategories(storeId: number): Promise<CategoryRaw[]> {
  const hit = categoryCache.get(String(storeId));
  if (hit && Date.now() - hit.at < MENU_TTL_MS) return hit.list;
  const r = await call<CategoryRaw[]>("v3/goods/item/getShopCategory", { storeId, ...CHANNEL });
  if (!r.ok || !Array.isArray(r.data)) {
    throw new Error(`分类菜单拉取失败：${projectUpstreamMessage(r.error?.message ?? r.message) || "未知错误"}（${r.error?.hint ?? "稍后再试"}）`);
  }
  const list = [...r.data].sort((a, b) => (a.categorySort ?? 99) - (b.categorySort ?? 99));
  categoryCache.set(String(storeId), { at: Date.now(), list });
  return list;
}

// 正路：3.1.11 按分类查（frontCategoryId 全程 string，client 发送前还原为无损数字）
async function listByCategory(storeId: number, frontCategoryId: string): Promise<GoodsRaw[]> {
  const r = await call<GoodsRaw[]>("v3/goods/item/getShopGoodsListByCategory", {
    storeId,
    frontCategoryId,
    ...CHANNEL,
    includeProperties: ["SKU", "LABEL"],
  });
  if (!r.ok) {
    throw new Error(`按分类查商品失败：${projectUpstreamMessage(r.error?.message ?? r.message) || "未知错误"}`);
  }
  return Array.isArray(r.data) ? r.data : [];
}

// 绕行：3.1.16 搜索（只认商品名，不认分类名；空词被 100007 拒）
async function searchGoods(storeId: number, keyword: string): Promise<GoodsRaw[]> {
  const key = `${storeId}:${keyword}`;
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < SEARCH_TTL_MS) return hit.items;
  const r = await call<GoodsRaw[]>("v3/goods/item/getShopGoodsList/search", {
    storeId,
    name: keyword,
    ...CHANNEL,
    includeProperties: ["SKU", "LABEL"],
  });
  if (!r.ok) {
    throw new Error(`搜索失败：${projectUpstreamMessage(r.error?.message ?? r.message) || "未知错误"}（${r.error?.hint ?? "换个商品名试试"}）`);
  }
  const items = Array.isArray(r.data) ? r.data : [];
  searchCache.set(key, { at: Date.now(), items });
  return items;
}

export async function getMenu(storeId: number, keyword?: string): Promise<GetMenuResult> {
  const q = keyword?.trim();

  if (!q) {
    const cats = await loadCategories(storeId);
    return {
      mode: "categories",
      storeId: String(storeId),
      categories: cats.map((c) => ({ categoryName: c.categoryName, frontCategoryId: String(c.frontCategoryId) })),
    };
  }

  // 先判 keyword 是否为分类名（包含式，忽略大小写与全半角）
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      .replace(/　/g, " ");
  const cats = await loadCategories(storeId);
  const catHit = cats.find((c) => norm(c.categoryName).includes(norm(q)) || norm(q).includes(norm(c.categoryName)));

  if (catHit) {
    const raw = await listByCategory(storeId, String(catHit.frontCategoryId));
    const items = raw.filter(isRealGoods).map(toMenuItem);
    return {
      mode: "items",
      storeId: String(storeId),
      via: "category",
      categoryName: catHit.categoryName,
      items,
      hint: items.length === 0 ? `「${catHit.categoryName}」分类下暂无可点商品` : CLEAR_STATUS_NOTE,
    };
  }

  const raw = await searchGoods(storeId, q);
  const items = raw.filter(isRealGoods).map(toMenuItem);
  let hint: string;
  if (items.length === 0) {
    hint = `没找到「${q}」相关的商品，试试换个名字或问有什么系列`;
  } else if (raw.length >= 20) {
    // 实测：搜索接口默认上限 20 条（无分页字段），泛词结果会截断
    hint = `搜索结果较多，可能只显示了前 20 条的一部分，说更具体的名字能找得更准；${CLEAR_STATUS_NOTE}`;
  } else {
    hint = CLEAR_STATUS_NOTE;
  }
  return {
    mode: "items",
    storeId: String(storeId),
    via: "search",
    items,
    hint,
  };
}
