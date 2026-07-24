// 渠道与常量（2026-07-22 实测定论）

export const BASE_URL = "https://openapi.qmai.cn/";

// 渠道常量：全接口透传。saleType=4 实测全空（门店只配堂食渠道），统一用 1。
export const CHANNEL = {
  saleType: 1,
  saleChannel: 3,
  appChannel: 1,
} as const;

// 只读白名单（硬编码）：非白名单路径直接抛 ReadOnlyViolation。
// 这是一期「物理禁写」的保险丝——任何写接口在 client 层被物理断路。
export const READONLY_WHITELIST: readonly string[] = [
  "v3/org/shop/getShopList",
  "v3/org/shop/getShopColsById",
  "v3/goods/item/getShopCategory",
  "v3/goods/item/getShopGoodsList/search",
  "v3/goods/item/getShopGoodsListByCategory",
  "v3/goods/item/getShopGoodsDetail",
  "v3/newPattern/cateringApiserver/post/order/cart/appCompute",
];

// 门店编码表（2026-07-22 store list 实测）
export const STORES = [
  { code: "01", name: "The Box（北京）", storeId: 312274 },
  { code: "02", name: "798（北京）", storeId: 312276 },
  { code: "03", name: "凤凰汇（北京）", storeId: 312277 },
  { code: "04", name: "太古里（北京）", storeId: 516149 },
  { code: "05", name: "深圳湾万象城（深圳）", storeId: 503542 },
  { code: "06", name: "万象天地（深圳）", storeId: 539316 },
  { code: "07", name: "平安金融中心（深圳）", storeId: 549331 },
] as const;
