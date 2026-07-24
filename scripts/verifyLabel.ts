// 标签字段验证：确认「标签贴错」实为读错字段（labelTypeText=类型名，text=内容）

import { call } from "../src/client.js";
import { CHANNEL } from "../src/constants.js";

const CAT_CHUNCHHA = "1123766563862102017"; // 「纯茶」分类无损 ID（N2 锚点批次）

async function main(): Promise<void> {
  console.log("== 标签字段验证（纯茶分类商品）==");
  const r = await call<Array<{ name: string; labelList?: Array<{ labelTypeText?: string; text?: string; image?: string }> }>>(
    "v3/goods/item/getShopGoodsListByCategory",
    { storeId: 503542, frontCategoryId: CAT_CHUNCHHA, ...CHANNEL, includeProperties: ["SKU", "LABEL"] },
  );
  if (!r.ok || !Array.isArray(r.data)) throw new Error(`拉取失败：${r.error?.message}`);
  for (const g of r.data) {
    const labels = (g.labelList ?? []).map((l) => `类型=${l.labelTypeText ?? "-"} 内容=${l.text ?? "-"}${l.image ? " 图=" + l.image.split("/").pop() : ""}`);
    console.log(`  ${g.name}`);
    for (const l of labels) console.log(`    ${l}`);
    if (labels.length === 0) console.log("    （无标签）");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
