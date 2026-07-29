// N3 找店柜台：getShopList 全量缓存（24h TTL 懒加载）+ 包含式模糊匹配 + 营业时间按需取。
// 导出纯函数，不接 MCP 协议（N7 统一接线）。

import { call } from "../client.js";

const TTL_MS = 24 * 60 * 60 * 1000;
const ANCHOR_STORE_ID = "503542"; // 校验锚：深圳湾万象城
const EXPECT_TOTAL = 7; // 偏离仅警告（门店会增减，不硬断）

interface StoreRaw {
  id: number | string;
  code?: string;
  name: string;
  address?: string;
  fullAddress?: string;
  cityName?: string;
  openStatus?: number;
  operateStatus?: string;
}

interface CachedStores {
  at: number;
  list: StoreRaw[];
}

export interface StoreHit {
  name: string;
  storeId: string;
  shopCode: string;
  address: string;
  cityName: string;
  openStatusText: string;
  opentimes?: string;
}

export interface Candidate {
  name: string;
  storeId: string;
  shopCode: string;
  address: string;
  cityName: string;
  openStatusText: string;
}

export type FindStoreResult =
  | { matched: true; store: StoreHit }
  | { matched: false; candidates: Candidate[]; hint?: string };

let cache: CachedStores | null = null;
const opentimesCache = new Map<string, string>();

function openStatusText(s: unknown): string {
  switch (s) {
    case 0:
      return "休息中";
    case 1:
      return "营业中";
    case 2:
      return "繁忙";
    default:
      return "状态未知";
  }
}

// 忽略大小写与全半角
function norm(text: string): string {
  return text
    .toLowerCase()
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/　/g, " ");
}

async function loadStores(): Promise<StoreRaw[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.list;
  const r = await call<{ list?: StoreRaw[] }>("v3/org/shop/getShopList", { pageNum: 1, pageSize: 50 });
  if (!r.ok || !Array.isArray(r.data?.list)) {
    throw new Error(`门店列表拉取失败：${r.error?.message ?? r.message ?? "未知错误"}（${r.error?.hint ?? "稍后再试"}）`);
  }
  const list = r.data.list;
  if (!list.some((s) => String(s.id) === ANCHOR_STORE_ID)) {
    console.warn("[findStore] 校验锚缺失：全量门店中未找到 503542（深圳湾万象城）");
  }
  if (list.length !== EXPECT_TOTAL) {
    console.warn(`[findStore] 门店总数=${list.length}，偏离 ${EXPECT_TOTAL}（门店可能增减，继续运行）`);
  }
  cache = { at: Date.now(), list };
  return list;
}

// opentimes 原文 → 人话。v6 实测结构：data.opentimes = [{channelId, opentime:[{worktime:[{time:[开,关]}],workweek:[...]}], status}]
// 注意嵌套字段名是 opentime（无 s）；workweek 在门店列表里为数字、在 cols 接口里为字符串，兼容两者。
function formatOpentimes(raw: unknown): string | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  type Seg = { worktime?: Array<{ time?: Array<string | null> | null }>; workweek?: Array<string | number | null> };
  const first = raw[0] as { opentime?: Seg[]; opentimes?: Seg[] };
  const seg = (first?.opentime ?? first?.opentimes)?.[0];
  const time = seg?.worktime?.[0]?.time;
  if (!time || time.length < 2 || !time[0] || !time[1]) return undefined;
  const week = (seg?.workweek ?? []).map(Number).filter((n) => !Number.isNaN(n));
  const weekText = week.length === 7 ? "周一至周日" : week.length > 0 ? `周${week.join("、")}` : "";
  return `${time[0]}-${time[1]}${weekText ? `（${weekText}）` : ""}`;
}

// 仅唯一命中时按需调用；结果并入缓存（随门店缓存生命周期）
async function fetchOpentimes(storeId: string): Promise<string | undefined> {
  const hit = opentimesCache.get(storeId);
  if (hit) return hit;
  const r = await call<{ opentimes?: unknown }>("v3/org/shop/getShopColsById", {
    shopId: Number(storeId),
    cols: ["opentimes"],
  });
  const text = r.ok ? formatOpentimes(r.data?.opentimes) : undefined;
  if (text) opentimesCache.set(storeId, text);
  return text;
}

export async function findStore(query: string): Promise<FindStoreResult> {
  const q = norm(query.trim());
  const list = await loadStores();
  const hits = list.filter((s) => {
    const fields = [s.name, s.address, s.fullAddress, s.cityName, s.code].filter(Boolean) as string[];
    return fields.some((f) => norm(f).includes(q));
  });

  if (hits.length === 1) {
    const s = hits[0];
    const storeId = String(s.id);
    const opentimes = await fetchOpentimes(storeId);
    return {
      matched: true,
      store: {
        name: s.name,
        storeId,
        shopCode: String(s.code ?? ""),
        address: s.address ?? "",
        cityName: s.cityName ?? "",
        openStatusText: openStatusText(s.openStatus),
        ...(opentimes ? { opentimes } : {}),
      },
    };
  }

  if (hits.length > 1) {
    const candidates: Candidate[] = hits
      .map((s) => ({
        name: s.name,
        storeId: String(s.id),
        shopCode: String(s.code ?? ""),
        address: s.address ?? "",
        cityName: s.cityName ?? "",
        openStatusText: openStatusText(s.openStatus),
      }))
      .sort((a, b) => a.shopCode.localeCompare(b.shopCode));
    return { matched: false, candidates };
  }

  return { matched: false, candidates: [], hint: "没找到这家店，试试商场名或城市名" };
}
