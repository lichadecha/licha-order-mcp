// N8 竣工走查 · 估清/下架商品提示验证（dod.md 第 4 项）· 机会性实测
// 只扫 798 店（storeId=312276）：分类列表 + 每分类商品列表（原始 goodsSkuList[].clearStatus）。
// 找到 clearStatus=0（已估清）商品 → 调 getItemDetail 确认工具输出明确提示不可点。
// 找不到 → 如实记录「当前798店无估清商品」，不硬凑。
// 预算：1（分类列表）+ N（每分类一次，N=分类数）+ 最多2（命中确认），预估≈10次左右。

import { call } from "../src/client.js";
import { CHANNEL } from "../src/constants.js";
import { getItemDetail } from "../src/tools/getItemDetail.js";

const STORE = 312276; // 798（北京）
const MAX_CATEGORIES = 20; // 保险上限，防止分类异常多时预算失控

interface CatRaw {
  categoryName: string;
  frontCategoryId: string;
}
interface SkuRaw {
  skuId?: string | number;
  salePrice?: number;
  clearStatus?: number;
  specName?: string;
  skuName?: string;
}
interface GoodsRaw {
  goodsId: string | number;
  name: string;
  goodsSkuList?: SkuRaw[];
}

let totalCalls = 0;

async function main(): Promise<void> {
  console.log("== N8 估清扫描：798 店（storeId=312276）==\n");

  totalCalls++;
  const rc = await call<CatRaw[]>("v3/goods/item/getShopCategory", { storeId: STORE, ...CHANNEL });
  if (!rc.ok || !Array.isArray(rc.data)) {
    throw new Error(`分类拉取失败：${rc.error?.message ?? "无数据"}`);
  }
  const cats = rc.data.slice(0, MAX_CATEGORIES);
  console.log(`分类共 ${rc.data.length} 个${rc.data.length > MAX_CATEGORIES ? `（本次只扫前 ${MAX_CATEGORIES} 个，预算保护）` : ""}：${cats.map((c) => c.categoryName).join("、")}\n`);

  let goodsScanned = 0;
  const clearedHits: Array<{ goodsId: string; name: string; skuName: string }> = [];

  for (const c of cats) {
    totalCalls++;
    const r = await call<GoodsRaw[]>("v3/goods/item/getShopGoodsListByCategory", {
      storeId: STORE,
      frontCategoryId: String(c.frontCategoryId),
      ...CHANNEL,
      includeProperties: ["SKU", "LABEL"],
    });
    if (!r.ok) {
      console.log(`  [警告] 「${c.categoryName}」拉取失败：${r.error?.message}`);
      continue;
    }
    const list = Array.isArray(r.data) ? r.data : [];
    goodsScanned += list.length;
    for (const g of list) {
      for (const s of g.goodsSkuList ?? []) {
        if (s.clearStatus === 0) {
          clearedHits.push({ goodsId: String(g.goodsId), name: g.name, skuName: s.specName ?? s.skuName ?? "标准杯" });
        }
      }
    }
    console.log(`  「${c.categoryName}」商品 ${list.length} 款（累计已扫 ${goodsScanned} 款，已用 ${totalCalls} 次调用）`);
  }

  console.log(`\n== 分类列表扫描完成：${cats.length} 个分类，累计商品 ${goodsScanned} 款，累计调用 ${totalCalls} 次 ==`);

  if (clearedHits.length === 0) {
    console.log("\n[结论] 当前798店无估清商品（clearStatus=0），实测留机会性补测。");
    console.log(`真实调用共 ${totalCalls} 次，0 次命中，未消耗确认调用。`);
    return;
  }

  console.log(`\n[命中] 发现 ${clearedHits.length} 个已估清 SKU，取前 2 个调用 getItemDetail 确认工具输出：`);
  for (const hit of clearedHits.slice(0, 2)) {
    totalCalls++;
    const detail = await getItemDetail(STORE, hit.goodsId);
    console.log(`\n  商品：${detail.name}（goodsId=${hit.goodsId}，估清规格=${hit.skuName}）`);
    console.log(`  工具输出：available=${detail.available}，unavailableReason=${detail.unavailableReason ?? "（无）"}`);
    console.log(`  各 SKU：${detail.skus.map((s) => `${s.specName} available=${s.available}`).join("、")}`);
  }
  console.log(`\n真实调用共 ${totalCalls} 次。`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
