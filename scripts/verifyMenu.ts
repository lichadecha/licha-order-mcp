// N4 全面检测（加固验证，一次性诊断脚本）
// ① 搜索上限/分页 ② 跨店覆盖 ③ 正路完整性 ④ 缓存 TTL
// 顺带取证 labelList 原始字段（复用①的响应，0 额外调用）

import { call } from "../src/client.js";
import { CHANNEL } from "../src/constants.js";
import { getMenu } from "../src/tools/getMenu.js";

const STORE = 503542; // 深圳湾万象城
const STORE_BJ = 312274; // The Box（北京）
const CAT_JINGDIAN = "1123766292129968128"; // 「经典」分类无损 ID（N2 锚点批次）

interface GoodsLike {
  name?: string;
  goodsSkuList?: Array<{ salePrice?: number }>;
  showPriceLow?: number;
  labelList?: Array<Record<string, unknown>>;
}

async function main(): Promise<void> {
  console.log("== N4 全面检测 ==\n");

  // ① 搜索上限/分页（搜「茶」）
  console.log("① 搜索上限/分页（搜「茶」）");
  const r1 = await call<unknown>("v3/goods/item/getShopGoodsList/search", {
    storeId: STORE,
    name: "茶",
    ...CHANNEL,
    includeProperties: ["SKU", "LABEL"],
  });
  if (!r1.ok) throw new Error(`①失败：${r1.error?.message}`);
  const d1 = r1.data;
  let list1: GoodsLike[] = [];
  if (Array.isArray(d1)) {
    list1 = d1 as GoodsLike[];
    console.log(`  返回：数组直返，${list1.length} 条，无分页字段`);
  } else if (d1 && typeof d1 === "object") {
    const obj = d1 as Record<string, unknown>;
    console.log(`  返回：对象，keys=${Object.keys(obj).join(",")}`);
    for (const k of ["list", "data", "goodsList", "records"]) {
      if (Array.isArray(obj[k])) list1 = obj[k] as GoodsLike[];
    }
    console.log(`  列表长度=${list1.length}，total=${String(obj.total ?? "无字段")}`);
  }
  console.log(`  → 判断：${list1.length >= 20 ? "命中条数≥20，存在截断风险，需处理" : "未达 20，暂无截断迹象"}`);

  // 取证：labelList 完整字段（复用①响应）
  const withLabel = list1.find((g) => Array.isArray(g.labelList) && g.labelList.length > 0);
  if (withLabel && withLabel.labelList) {
    console.log(`\n  [取证] 商品「${withLabel.name}」labelList[0] 完整字段：`);
    console.log("  " + JSON.stringify(withLabel.labelList[0], null, 1).replace(/\n/g, "\n  "));
  } else {
    console.log("\n  [取证] 本轮搜索结果无带标签商品");
  }

  // ② 跨店覆盖（The Box 312274）
  console.log("\n② 跨店覆盖（The Box 312274）");
  const catsBj = await getMenu(STORE_BJ);
  if (catsBj.mode !== "categories") throw new Error("②异常：未返回分类模式");
  console.log(`  分类 ${catsBj.categories.length} 个：${catsBj.categories.map((c) => c.categoryName).join("、")}`);
  const pureBj = await getMenu(STORE_BJ, "纯茶");
  if (pureBj.mode !== "items") throw new Error("②异常：未返回商品模式");
  console.log(`  「纯茶」路径=${pureBj.via}，商品 ${pureBj.items.length} 个：${pureBj.items.map((i) => `${i.name} ¥${i.priceYuan}`).join("、") || "（空）"}`);

  // ③ 正路完整性（「经典」大分类是否截断）
  console.log("\n③ 正路完整性（「经典」分类）");
  const r3 = await call<GoodsLike[]>("v3/goods/item/getShopGoodsListByCategory", {
    storeId: STORE,
    frontCategoryId: CAT_JINGDIAN,
    ...CHANNEL,
    includeProperties: ["SKU", "LABEL"],
  });
  if (!r3.ok) throw new Error(`③失败：${r3.error?.message}`);
  const list3 = Array.isArray(r3.data) ? r3.data : [];
  const real3 = list3.filter((g) => {
    const p = g.goodsSkuList?.[0]?.salePrice ?? g.showPriceLow;
    return typeof p === "number" && p > 0;
  });
  console.log(`  返回 ${list3.length} 条，价格>0 的 ${real3.length} 个（滤掉 ${list3.length - real3.length} 个 0 元条目）`);
  console.log(`  → 判断：${list3.length >= 20 ? "达 20 条，需关注截断" : "未达 20，暂无截断迹象"}`);

  // ④ 缓存 TTL 行为（同参数连调，第二次应走缓存）
  console.log("\n④ 缓存 TTL 行为（getMenu 连调两次）");
  const t0 = Date.now();
  await getMenu(STORE);
  const t1 = Date.now();
  await getMenu(STORE);
  const t2 = Date.now();
  console.log(`  首次 ${t1 - t0}ms，第二次 ${t2 - t1}ms → ${t2 - t1 < (t1 - t0) / 3 ? "缓存生效 ✓" : "缓存疑似未生效，需排查"}`);

  console.log("\n== 检测完成 ==");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
