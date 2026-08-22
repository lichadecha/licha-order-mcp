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

// ---------- 二期写通道常量（T5 施工令 § 4.1 / § 5 M2 节，2026-08-17） ----------
// 写操作白名单（硬编码）：第一批只放一个写接口。与 READONLY_WHITELIST 物理分离——
// callRead 不认它（写路径在 callRead 里仍会命中 ReadOnlyViolation），callWrite 只认它。
export const WRITE_WHITELIST: readonly string[] = [
  "v3/newPattern/cateringApiserver/post/order/v1/create", // 6.2.9 创建商品订单（第一批唯一写接口）
];

export const ORDER_GUARD = {
  maxAmountFen: 10000, // 单笔 ≤ ¥100
  // 单日笔数护栏改成**两层**（2026-08-19 老板拍板，§8-30 登记的三期项提前做）：
  //   · maxOrdersPerDayPerCustomer —— **按顾客**计数，主护栏。防的是「有人冒用你的手机号，
  //     往你账上批量塞待付款单打扰你」；数值取 5 是为了让**单顾客体验一点不变**
  //     （改造前的全局值就是 5，一个人用的场景与改造前完全等价）。
  //   · maxOrdersPerDay —— **全局**总闸，防的是另一件事：AI 对多个身份失控。
  //     从 5 提到 10，否则换绑后两位顾客各自没到 5 单就先被全局闸拦住，
  //     「按顾客独立计数」等于没生效。
  // 两层任一撞线即拒，拒绝理由都以 DailyLimitExceeded 开头（后缀区分维度）——
  // 前缀保持不变是硬约束：总工验收文件 m4AcceptanceGauntlet 的 G4 断言了这个前缀，那份文件一行不动。
  maxOrdersPerDayPerCustomer: 5, // 每位顾客单日 ≤ 5 单（北京时间自然日）
  maxOrdersPerDay: 10, // 全局单日 ≤ 10 单（试验期总闸）
  confirmTokenTtlMs: 5 * 60 * 1000, // 确认令牌 5 分钟
} as const;

export const ENABLE_ORDERING_ENV = "LICHA_ENABLE_ORDERING";

// ---------- M3 新增：二期只读白名单（施工令 § 3.1 放行清单） ----------
// 与一期 READONLY_WHITELIST 分列独立常量，是为了保护一期「零写自证」证据链——
// 那 7 条常量一字不动。callRead 的白名单判断会同时认这两份名单。
export const READONLY_WHITELIST_PHASE2: readonly string[] = [
  "v3/crm/customer/getCustomerIdByCode", // 4.2.2 会员标识查会员ID（身份绑定）
  "v3/order/status", // 6.1.5 查询订单状态
  "v3/order/standard/cyOrderDetail", // 6.1.9 查询订单详情（M4 接工具）
  "v3/order/userAppointTimeOrderList", // 6.1.6 用户订单列表（M4 接工具）
];
