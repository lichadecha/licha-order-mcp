// 7 店标签挂接扫描：找出「标签内容与标签类型归属不工整」的店
// 覆盖边界：商品名含「茶/李茶」的商品（搜索泛词，每词上限 20 条，可能漏无关键词商品）

import { call } from "../src/client.js";
import { CHANNEL, STORES } from "../src/constants.js";

interface LabelRaw {
  labelTypeText?: string;
  text?: string;
  image?: string;
  labelTypeId?: string;
}

interface GoodsRaw {
  name: string;
  labelList?: LabelRaw[];
  categoryList?: Array<{ categoryName?: string }>;
}

interface LabelRow {
  goods: string;
  category: string;
  text: string;
  type: string;
  typeId: string;
  image: string;
}

async function main(): Promise<void> {
  const report: Array<{ store: string; code: string; goodsCount: number; rows: LabelRow[] }> = [];

  for (const s of STORES) {
    const seen = new Map<string, GoodsRaw>();
    for (const kw of ["奶昔"]) {
      const r = await call<GoodsRaw[]>("v3/goods/item/getShopGoodsList/search", {
        storeId: s.storeId,
        name: kw,
        ...CHANNEL,
        includeProperties: ["SKU", "LABEL", "CATEGORY"],
      });
      if (!r.ok) {
        console.error(`[警告] ${s.name} 搜索「${kw}」失败：${r.error?.message}`);
        continue;
      }
      for (const g of (Array.isArray(r.data) ? r.data : []) as GoodsRaw[]) {
        seen.set(g.name, g);
      }
    }
    const rows: LabelRow[] = [];
    for (const g of seen.values()) {
      for (const l of g.labelList ?? []) {
        rows.push({
          goods: g.name,
          category: g.categoryList?.[0]?.categoryName ?? "?",
          text: l.text ?? "-",
          type: l.labelTypeText ?? "-",
          typeId: String(l.labelTypeId ?? ""),
          image: (l.image ?? "").split("/").pop() ?? "",
        });
      }
    }
    report.push({ store: s.name, code: s.code, goodsCount: seen.size, rows });
    console.error(`[扫描] ${s.name}：商品 ${seen.size} 款，标签 ${rows.length} 条`);
  }

  console.log(JSON.stringify(report, null, 1));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
