// N5 点单卡片：getShopGoodsDetail 封装（规格/做法/加料/估清）
// includeProperties 不显式声明就不返回对应模块（实锤级坑），全量声明。
// 导出纯函数，不接 MCP 协议（N7 统一接线）。

import { call } from "../client.js";
import { CHANNEL } from "../constants.js";
import { projectUpstreamMessage } from "../outboundText.js";

const DETAIL_TTL_MS = 5 * 60 * 1000;

interface SkuRaw {
  skuId?: string | number;
  salePrice?: number;
  inventory?: number;
  clearStatus?: number;
  specName?: string;
  skuName?: string;
}

interface PracticeGroupRaw {
  practiceId?: string | number;
  practiceName?: string;
  /** 是否必选分组（手册 3.1.x：1 必选）。缺省视为非必选——这是「没标记」，不是「必选」。 */
  isRequired?: number;
  practiceValueList?: Array<{ practiceValueId?: string | number; practiceValue?: string; price?: number; isDefault?: number }>;
}

/**
 * 商品详情的原始响应（getShopGoodsDetail 单条）。
 *
 * 为什么把它导出：ItemDetail 是给顾客看的投影（名字 + 价格），刻意丢掉了 practiceId /
 * practiceValueId / attachGoodsId / isRequired 这些企迈内部字段——下单组装和必选做法校验
 * 却必须用它们。导出原始类型，是为了让「本轮真读的那一次详情」能同时喂给算价与组装，
 * 而不是各读一次（G3：两次读可能读到两个价格，签出去的确认单就两头不着）。
 */
export interface DetailRaw {
  goodsId: string | number;
  name: string;
  type?: number;
  status?: number;
  goodsSkuList?: SkuRaw[];
  sortedPracticeList?: PracticeGroupRaw[];
  attachGoodsList?: Array<{ attachGoodsId?: string | number; attachGoodsName?: string; attachGoodsPrice?: number }>;
  labelList?: Array<{ text?: string; labelTypeText?: string }>;
  categoryList?: Array<{ categoryName?: string }>;
}

export interface SkuInfo {
  skuId: string;
  specName: string;
  priceFen: number;
  priceYuan: string;
  stock: number | null;
  available: boolean;
}

export interface PracticeGroup {
  name: string;
  values: Array<{ name: string; priceFen: number; priceDeltaYuan: string }>;
}

export interface ItemDetail {
  goodsId: string;
  name: string;
  type: number;
  isSetMeal: boolean;
  categoryName?: string;
  labels: string[];
  available: boolean;
  unavailableReason?: string;
  skus: SkuInfo[];
  practices: PracticeGroup[];
  attaches: Array<{ name: string; priceFen: number; priceYuan: string }>;
}

const cache = new Map<string, { at: number; detail: ItemDetail }>();

function fenToYuan(fen: number | undefined): string {
  if (typeof fen !== "number" || !Number.isFinite(fen)) return "价格待询";
  return (fen / 100).toFixed(2);
}

function fenOrZero(fen: number | undefined): number {
  return typeof fen === "number" && Number.isFinite(fen) ? fen : 0;
}

function deltaToYuan(fen: number | undefined): string {
  if (typeof fen !== "number" || !Number.isFinite(fen) || fen === 0) return "+0";
  return `+${(fen / 100).toFixed(2)}`;
}

function skuAvailable(s: SkuRaw): boolean {
  if (s.clearStatus === 0) return false; // 已估清（文档 id=230 实锤：0-已估清 1-未估清）
  if (typeof s.inventory === "number" && s.inventory <= 0) return false;
  return true;
}

function toDetail(g: DetailRaw): ItemDetail {
  const skus: SkuInfo[] = (g.goodsSkuList ?? []).map((s) => ({
    skuId: String(s.skuId ?? ""),
    specName: s.specName ?? s.skuName ?? "标准杯",
    priceFen: fenOrZero(s.salePrice),
    priceYuan: fenToYuan(s.salePrice),
    stock: typeof s.inventory === "number" ? s.inventory : null,
    available: skuAvailable(s),
  }));

  const practices: PracticeGroup[] = (g.sortedPracticeList ?? []).map((p) => ({
    name: p.practiceName ?? "做法",
    values: (p.practiceValueList ?? []).map((v) => ({
      name: v.practiceValue ?? "",
      priceFen: fenOrZero(v.price),
      priceDeltaYuan: deltaToYuan(v.price),
    })),
  }));

  const attaches = (g.attachGoodsList ?? []).map((a) => ({
    name: a.attachGoodsName ?? "",
    priceFen: fenOrZero(a.attachGoodsPrice),
    priceYuan: fenToYuan(a.attachGoodsPrice),
  }));

  // 可点性：下架 / 全部 SKU 估清 / 非正价条目（0 元品牌文案）
  const anySkuPrice = (g.goodsSkuList ?? []).some((s) => typeof s.salePrice === "number" && s.salePrice > 0);
  let available = true;
  let unavailableReason: string | undefined;
  if (g.status === 20) {
    available = false;
    unavailableReason = "已下架";
  } else if (!anySkuPrice) {
    available = false;
    unavailableReason = "非售卖条目";
  } else if (skus.length > 0 && skus.every((s) => !s.available)) {
    available = false;
    unavailableReason = "暂时估清，点不了";
  }

  return {
    goodsId: String(g.goodsId),
    name: g.name,
    type: g.type ?? 1,
    isSetMeal: g.type === 3,
    categoryName: g.categoryList?.[0]?.categoryName,
    labels: (g.labelList ?? []).map((l) => l.text ?? l.labelTypeText).filter((t): t is string => Boolean(t)),
    available,
    ...(unavailableReason ? { unavailableReason } : {}),
    skus,
    practices,
    attaches,
  };
}

/**
 * G3：绕过浏览缓存真读一次详情，投影与原始响应一起交出去。
 *
 * 为什么下单链路必须走这个入口：浏览缓存管的是「顾客翻菜单时别每次都打接口」，
 * 5 分钟内它可能已经和门店实际对不上（缓存 ¥20、现价 ¥120）。确认单上的金额与可售状态
 * 是要念给顾客、并直接变成真实订单的，只能来自本轮这一次真读。
 * 返回 raw 是为了让同一次读的结果同时够用于算价、可售校验与下单 ID 映射——
 * 少读一次是附带好处，真正的目的是「一张确认单只对着一个价格」。
 * 读到的结果照旧写进缓存：浏览继续受益，缓存本身不废（任务书 G3「不许做」第一条）。
 */
export async function fetchItemDetailFresh(storeId: number, goodsId: string): Promise<{ detail: ItemDetail; raw: DetailRaw }> {
  const r = await call<DetailRaw[]>("v3/goods/item/getShopGoodsDetail", {
    storeId,
    goodsIds: [goodsId],
    ...CHANNEL,
    includeProperties: ["SKU", "PRACTICE", "ATTACH", "LABEL", "CATEGORY"],
  });
  if (!r.ok) {
    throw new Error(`商品详情查询失败：${projectUpstreamMessage(r.error?.message ?? r.message) || "未知错误"}（${r.error?.hint ?? "换个商品试试"}）`);
  }
  if (!Array.isArray(r.data) || r.data.length === 0) {
    throw new Error("商品详情查询失败：商品不存在或已下架（换个商品试试）");
  }
  const raw = r.data[0];
  const detail = toDetail(raw);
  cache.set(`${storeId}:${goodsId}`, { at: Date.now(), detail });
  return { detail, raw };
}

export async function getItemDetail(storeId: number, goodsId: string): Promise<ItemDetail> {
  const key = `${storeId}:${goodsId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < DETAIL_TTL_MS) return hit.detail;

  return (await fetchItemDetailFresh(storeId, goodsId)).detail;
}
