// N3 找店柜台：getShopList 全量缓存（24h TTL 懒加载）+ 包含式模糊匹配 + 营业时间按需取。
// 导出纯函数，不接 MCP 协议（N7 统一接线）。
//
// 2026-09-08（24 号 A2）缓存拆两层：
//   · 名录（店名 / 地址 / storeId，用于模糊匹配）——门店一年增减不了几次，24h 够用；
//   · 营业状态 + 营业时间——一天开关门几次，改造前它们跟着名录一起活 24h（营业时间缓存甚至永不过期），
//     盲审 B06 / 22 号只读反例 HOURS_TTL：合成时钟 23 小时后仍报首次「营业中」、25 小时后营业时间仍是首次值。
//     现在单独 10 分钟 TTL，唯一命中时按需刷新，并把采样时间一起返回——Agent 能说「这是 X 分钟前的状态」，
//     而不是把一天前的值当此刻。

import { call } from "../client.js";
import { beijingTimeString } from "../writeGuard.js";
import { projectUpstreamMessage } from "../outboundText.js";

const TTL_MS = 24 * 60 * 60 * 1000;
// 状态 TTL 取 10 分钟（施工判断点，24 号 §9）：一次点单对话通常在 10 分钟内结束，不会重复拉；
// 门店开/关门/繁忙的变化粒度是小时级，10 分钟内的滞后顾客感知不到。再短就是给每轮对话加一次请求。
const STATUS_TTL_MS = 10 * 60 * 1000;
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
  /** 营业状态的采样时间（北京时间字串）。取不到状态时缺省，此时 openStatusText 为「状态未知」。 */
  statusSampledAt?: string;
  opentimes?: string;
}

export interface Candidate {
  name: string;
  storeId: string;
  shopCode: string;
  address: string;
  cityName: string;
  openStatusText: string;
  /** 候选列表沿用名录里的状态（不逐店发请求），采样时间就是名录拉取时间。 */
  statusSampledAt?: string;
}

/** 单店实时层：营业状态 + 营业时间 + 采样时间。sampledAt 为 null 表示这次没取到，不缓存、下次重试。 */
interface StoreLive {
  sampledAt: number | null;
  openStatus?: number;
  opentimes?: string;
}

export type FindStoreResult =
  | { matched: true; store: StoreHit }
  | { matched: false; candidates: Candidate[]; hint?: string };

let cache: CachedStores | null = null;
const liveCache = new Map<string, StoreLive>();

/** 仅供测试：清空名录与实时层缓存。两层缓存都是模块级单例，不清的话用例之间会互相命中。 */
export function resetStoreCachesForTesting(): void {
  cache = null;
  liveCache.clear();
}

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

async function loadStores(force = false): Promise<StoreRaw[]> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.list;
  const r = await call<{ list?: StoreRaw[] }>("v3/org/shop/getShopList", { pageNum: 1, pageSize: 50 });
  if (!r.ok || !Array.isArray(r.data?.list)) {
    throw new Error(`门店列表拉取失败：${projectUpstreamMessage(r.error?.message ?? r.message) || "未知错误"}（${r.error?.hint ?? "稍后再试"}）`);
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

/**
 * 仅唯一命中时按需调用：一次 getShopColsById 同时取营业状态与营业时间（手册 2.1.7：cols 可含 2.1.1 的
 * 通用字段 openStatus——**此组合未实测**，v0.5.3 Mac 顺手观察）。响应里没有可用的 openStatus 时，
 * 回落到强制重拉一次名录（getShopList 带 openStatus 是实测过的路径）取状态；两条路都取不到 → 状态未知。
 * 取不到不缓存（sampledAt=null），下次查询重试；取到了缓存 STATUS_TTL_MS。
 */
async function fetchLive(storeId: string): Promise<StoreLive> {
  const hit = liveCache.get(storeId);
  if (hit && hit.sampledAt != null && Date.now() - hit.sampledAt < STATUS_TTL_MS) return hit;
  const r = await call<{ openStatus?: unknown; opentimes?: unknown }>("v3/org/shop/getShopColsById", {
    shopId: Number(storeId),
    cols: ["openStatus", "opentimes"],
  });
  if (!r.ok) return { sampledAt: null };
  const opentimes = formatOpentimes(r.data?.opentimes);
  let openStatus = typeof r.data?.openStatus === "number" ? r.data.openStatus : undefined;
  if (openStatus === undefined) {
    // 字段级接口没给状态：回落到名录接口（实测有 openStatus），强制重拉一次。
    try {
      const fresh = await loadStores(true);
      const row = fresh.find((s) => String(s.id) === storeId);
      if (typeof row?.openStatus === "number") openStatus = row.openStatus;
    } catch {
      // 名录也拉不到：下面按「状态未知」处理，不回落旧值
    }
  }
  if (openStatus === undefined && !opentimes) return { sampledAt: null };
  const live: StoreLive = { sampledAt: Date.now(), ...(openStatus !== undefined ? { openStatus } : {}), ...(opentimes ? { opentimes } : {}) };
  liveCache.set(storeId, live);
  return live;
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
    const live = await fetchLive(storeId);
    // 状态只认实时层：取到了就报它的值和采样时间；没取到就「状态未知」，不拿名录里可能已经一天前的旧值顶上。
    const statusKnown = live.sampledAt != null && live.openStatus !== undefined;
    return {
      matched: true,
      store: {
        name: s.name,
        storeId,
        shopCode: String(s.code ?? ""),
        address: s.address ?? "",
        cityName: s.cityName ?? "",
        openStatusText: statusKnown ? openStatusText(live.openStatus) : "状态未知",
        ...(statusKnown ? { statusSampledAt: beijingTimeString(live.sampledAt as number) } : {}),
        ...(live.opentimes ? { opentimes: live.opentimes } : {}),
      },
    };
  }

  if (hits.length > 1) {
    // 候选列表不逐店发请求（多命中时可能是七家店全中），沿用名录的状态，但把名录采样时间一起给出去。
    const rosterSampledAt = cache ? beijingTimeString(cache.at) : undefined;
    const candidates: Candidate[] = hits
      .map((s) => ({
        name: s.name,
        storeId: String(s.id),
        shopCode: String(s.code ?? ""),
        address: s.address ?? "",
        cityName: s.cityName ?? "",
        openStatusText: openStatusText(s.openStatus),
        ...(rosterSampledAt ? { statusSampledAt: rosterSampledAt } : {}),
      }))
      .sort((a, b) => a.shopCode.localeCompare(b.shopCode));
    return { matched: false, candidates };
  }

  return { matched: false, candidates: [], hint: "没找到这家店，试试商场名或城市名" };
}
