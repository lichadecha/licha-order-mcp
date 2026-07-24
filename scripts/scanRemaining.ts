// 盲区补扫：Black 系列 / 李茶 / 叩手礼 三分类的标签挂接
// 路径：每店 getShopCategory 取本店分类 ID → 3.1.11 按分类拉商品（带 LABEL）

import { call } from "../src/client.js";
import { CHANNEL, STORES } from "../src/constants.js";

const TARGET_CATS = ["Black系列", "李茶", "叩手礼"];

interface CatRaw {
  categoryName: string;
  frontCategoryId: string;
}

interface GoodsRaw {
  name: string;
  status?: number;
  labelList?: Array<{ labelTypeText?: string; text?: string; image?: string }>;
  goodsSkuList?: Array<{ salePrice?: number }>;
}

async function main(): Promise<void> {
  for (const s of STORES) {
    const rc = await call<CatRaw[]>("v3/goods/item/getShopCategory", { storeId: s.storeId, ...CHANNEL });
    if (!rc.ok || !Array.isArray(rc.data)) {
      console.error(`[警告] ${s.name} 分类拉取失败：${rc.error?.message}`);
      continue;
    }
    const cats = rc.data.filter((c) => TARGET_CATS.includes(c.categoryName));
    console.log(`== ${s.name} ==`);
    for (const c of cats) {
      const r = await call<GoodsRaw[]>("v3/goods/item/getShopGoodsListByCategory", {
        storeId: s.storeId,
        frontCategoryId: String(c.frontCategoryId),
        ...CHANNEL,
        includeProperties: ["SKU", "LABEL"],
      });
      const list = Array.isArray(r.data) ? r.data : [];
      const labeled = list.filter((g) => (g.labelList ?? []).length > 0);
      console.log(`  「${c.categoryName}」商品 ${list.length} 款，带标签 ${labeled.length} 款`);
      for (const g of labeled) {
        for (const l of g.labelList ?? []) {
          console.log(`    ${g.name} ｜内容:${l.text ?? "-"} ｜类型:${l.labelTypeText ?? "-"} ｜图:${(l.image ?? "").split("/").pop() || "无"}`);
        }
      }
      // 无标签商品只列名字，便于确认覆盖
      const unlabeled = list.filter((g) => (g.labelList ?? []).length === 0);
      if (unlabeled.length > 0) {
        console.log(`    （无标签：${unlabeled.map((g) => g.name).join("、")}）`);
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
