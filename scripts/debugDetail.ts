// N5 调试：打印详情接口原始响应（大数保护后），定位可点性误判

import { call } from "../src/client.js";
import { CHANNEL } from "../src/constants.js";

const r = await call("v3/goods/item/getShopGoodsDetail", {
  storeId: 503542,
  goodsIds: ["1123942469096853505"],
  ...CHANNEL,
  includeProperties: ["SKU", "PRACTICE", "ATTACH", "LABEL", "CATEGORY"],
});
const g = (Array.isArray(r.data) ? r.data : [])[0] as Record<string, unknown> | undefined;
if (!g) {
  console.log("空响应", JSON.stringify(r).slice(0, 300));
  process.exit(1);
}
console.log("name:", g.name);
console.log("status:", g.status, "| type:", g.type, "| saleChannel:", g.saleChannel, "| saleType:", g.saleType, "| isShow:", g.isShow);
console.log("goodsSkuList:", JSON.stringify(g.goodsSkuList, null, 1).slice(0, 1200));
