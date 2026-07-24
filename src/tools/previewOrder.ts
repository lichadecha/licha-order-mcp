// N6 算总价：本地累加（SKU 价 + 做法加价 + 加料加价，内部一律整数「分」运算，展示层转元）。
// 主路说明：appCompute（500 悬案，v6 两种参数组合均服务端内部错）不集成进工具——
// 集成了每次算价会白烧重试；smoke 里一次性复测留证，企迈修复后再改主路。
// 导出纯函数，不接 MCP 协议（N7 统一接线）。

import { getItemDetail, type ItemDetail } from "./getItemDetail.js";

export interface OrderItemInput {
  goodsId: string;
  skuId?: string;
  practices?: string[]; // 做法值名（按名匹配，同组多选报错）
  attaches?: string[]; // 加料名（按名匹配）
  quantity: number;
}

export interface OrderLine {
  name: string;
  specName: string;
  practices: string[];
  attaches: string[];
  unitPriceYuan: string;
  quantity: number;
  lineTotalYuan: string;
}

export interface PreviewResult {
  ok: boolean;
  computedBy: "local";
  lines?: OrderLine[];
  totalYuan?: string;
  error?: { code: string | number; message: string; hint: string };
}

function yuan(fenValue: number): string {
  return (fenValue / 100).toFixed(2);
}

function fail(message: string, hint: string): PreviewResult {
  return { ok: false, computedBy: "local", error: { code: "PREVIEW_INVALID", message, hint } };
}

function isFail(r: OrderLine | PreviewResult): r is PreviewResult {
  return "computedBy" in r;
}

// 单个商品行：详情 → 选 SKU → 匹配做法/加料 → 算单价（全程整数分）
async function buildLine(storeId: number, item: OrderItemInput): Promise<OrderLine | PreviewResult> {
  let detail: ItemDetail;
  try {
    detail = await getItemDetail(storeId, item.goodsId);
  } catch (e) {
    return fail(`商品查询失败：${(e as Error).message}`, "换个商品试试");
  }
  if (!detail.available) {
    return fail(`「${detail.name}」${detail.unavailableReason ?? "现在点不了"}`, "换一款试试");
  }

  // SKU：指定则用；唯一自动选；多 SKU 未指定报错列候选
  let sku = detail.skus[0];
  if (item.skuId) {
    const hit = detail.skus.find((s) => s.skuId === item.skuId);
    if (!hit) return fail(`「${detail.name}」没有这个规格`, "重新选一下规格");
    sku = hit;
  } else if (detail.skus.length > 1) {
    return fail(`「${detail.name}」有 ${detail.skus.length} 个规格`, `可选：${detail.skus.map((s) => s.specName).join("、")}`);
  }
  if (!sku) return fail(`「${detail.name}」没有可用规格`, "换一款试试");
  if (!sku.available) return fail(`「${detail.name}」该规格暂时估清`, "换个规格或商品");

  const qty = Math.floor(item.quantity);
  if (!Number.isFinite(qty) || qty < 1 || qty > 99) {
    return fail("数量不对", "数量填 1-99 之间的整数");
  }

  // 做法按名匹配；同组（如温度组）只能选一个
  const usedGroups = new Set<string>();
  let practiceFen = 0;
  const practiceNames: string[] = [];
  for (const want of item.practices ?? []) {
    let found: { groupName: string; priceFen: number } | null = null;
    for (const group of detail.practices) {
      if (group.values.some((v) => v.name === want)) {
        found = { groupName: group.name, priceFen: group.values.find((v) => v.name === want)!.priceFen };
      }
    }
    if (!found) {
      const all = detail.practices.flatMap((g) => g.values.map((v) => v.name));
      return fail(`「${detail.name}」没有「${want}」这个做法`, `可选做法：${all.join("、") || "无"}`);
    }
    if (usedGroups.has(found.groupName)) {
      return fail(`「${found.groupName}」这一组里只能选一个做法`, "去掉一个再试");
    }
    usedGroups.add(found.groupName);
    practiceFen += found.priceFen;
    practiceNames.push(want);
  }

  // 加料按名匹配
  let attachFen = 0;
  const attachNames: string[] = [];
  for (const want of item.attaches ?? []) {
    const hit = detail.attaches.find((a) => a.name === want);
    if (!hit) {
      return fail(`「${detail.name}」没有「${want}」这个加料`, `可加：${detail.attaches.map((a) => a.name).join("、") || "无"}`);
    }
    attachFen += hit.priceFen;
    attachNames.push(hit.name);
  }

  const unitFen = sku.priceFen + practiceFen + attachFen;
  const lineFen = unitFen * qty;
  return {
    name: detail.name,
    specName: sku.specName,
    practices: practiceNames,
    attaches: attachNames,
    unitPriceYuan: yuan(unitFen),
    quantity: qty,
    lineTotalYuan: yuan(lineFen),
  };
}

export async function previewOrder(storeId: number, items: OrderItemInput[]): Promise<PreviewResult> {
  if (!Array.isArray(items) || items.length === 0) {
    return fail("单子是空的", "先告诉我要点什么");
  }
  if (items.length > 20) {
    return fail("一单最多 20 行", "分两张单试试");
  }
  const lines: OrderLine[] = [];
  let totalFen = 0;
  for (const item of items) {
    const r = await buildLine(storeId, item);
    if (isFail(r)) return r;
    lines.push(r);
    totalFen += Math.round(parseFloat(r.lineTotalYuan) * 100);
  }
  return { ok: true, computedBy: "local", lines, totalYuan: yuan(totalFen) };
}
