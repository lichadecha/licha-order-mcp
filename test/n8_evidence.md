# N8 竣工走查报告

日期：2026-08-17（北京时间）
范围：dod.md 第 2、3、4 项取证；第 1、5 项按总工要求补注
真实只读调用预算：硬顶 30 次，本轮实际消耗 **16 次**（任务一 6 次 + 任务二 0 次 + 任务三 10 次）
环境说明：本轮所有真实调用脚本（`npx tsx scripts/n8PriceAudit.ts`、`npx tsx scripts/n8ClearScan.ts`）在**沙盒内直接跑通**，未触发凭证读取失败（exit=44 / 凭证不完整），未需要 `dangerouslyDisableSandbox`。与任务书预告的"历史坑"不同，本轮环境未复现该问题，记此备查。

---

## 任务一：价格一致性接口自证（dod.md 第 2 项）

**结论：PASS**（2 商品 × 5 项比对 = 10 项断言，全部 PASS，0 FAIL）

### 方法
新建 `scripts/n8PriceAudit.ts`，在深圳湾万象城店（storeId=503542）搜「兰皇」「山竹」各取一个命中商品，对每个商品同时拿 `client.call()` 原始返回 JSON 与 `getItemDetail()` 工具解析输出，逐字段比对：SKU 价格分转元、做法加价、加料加价、标签字段（应取 `text` 非 `labelTypeText`）、`previewOrder` 的 estimated 总价算术。

### 证据（脚本实跑输出摘录）

**商品一：兰皇金观音奶茶**（goodsId=1123942469096853505）
```
[PASS] SKU价格分转元：原始分=2400 → 期望元=24.00｜工具输出 priceFen=2400 priceYuan=24.00
[PASS] 做法加价：组「温度」值「少冰（400ml)」原始分=0 → 期望=+0｜工具输出 priceFen=0 priceDeltaYuan=+0
[PASS] 加料加价：「40s萃取·茶汤固定·去冰不满杯严重」原始分=0 → 期望元=0.00｜工具输出 priceFen=0 priceYuan=0.00
[PASS] 标签字段（应取text非labelTypeText）：工具输出=[40秒萃取,可热饮]，期望=[40秒萃取,可热饮]
       （2 项 text≠labelTypeText，足以区分两字段：text="40秒萃取" vs labelTypeText="综合标签"；
         text="可热饮" vs labelTypeText="HPP轻盈奶昔"）
[PASS] estimated总价算术（SKU+做法+加料）：手算=2400分=¥24.00｜previewOrder输出=24.00
```

**商品二：李茶的山竹**（goodsId=1292269764333912064）
```
[PASS] SKU价格分转元：原始分=3800 → 期望元=38.00｜工具输出 priceFen=3800 priceYuan=38.00
[PASS] 做法加价：组「温度」值「少冰（推荐）」原始分=0 → 期望=+0｜工具输出 priceFen=0 priceDeltaYuan=+0
[PASS] 加料加价：「不去冰·搅一搅·叩叩手」原始分=0 → 期望元=0.00｜工具输出 priceFen=0 priceYuan=0.00
[PASS] 标签字段（应取text非labelTypeText）：工具输出=[NEW]，期望=[NEW]
       （1 项 text≠labelTypeText：text="NEW" vs labelTypeText="综合标签"）
[PASS] estimated总价算术（SKU+做法+加料）：手算=3800分=¥38.00｜previewOrder输出=38.00

== 完成：真实调用 6 次，FAIL 0 处 ==
```

两个样本的做法/加料本身单价恰好都是 0（免费选项），未能对"非零加价"场景做算术验证——这是样本选择的局限，不代表代码有错（`priceFen`/`priceDeltaYuan` 的映射公式本身已按分→元规则核对，公式层面无错位）。若要覆盖非零加价场景，需换一款有付费做法/加料的商品复测（本轮未纳入 6 次预算内，留待下一轮机会性补测）。

### 调用次数
2 商品 ×（1 搜索 + 1 原始详情 + 1 工具详情）= **6 次真实调用**，`previewOrder` 内部复用同进程 `getItemDetail` 缓存，0 次额外网络请求。

---

## 任务二：零写操作自证（dod.md 第 3 项）

**结论：PASS**

### 代码自证

**只读白名单（7 条，硬编码）**——`src/constants.ts:14-22`：
```
14  export const READONLY_WHITELIST: readonly string[] = [
15    "v3/org/shop/getShopList",
16    "v3/org/shop/getShopColsById",
17    "v3/goods/item/getShopCategory",
18    "v3/goods/item/getShopGoodsList/search",
19    "v3/goods/item/getShopGoodsListByCategory",
20    "v3/goods/item/getShopGoodsDetail",
21    "v3/newPattern/cateringApiserver/post/order/cart/appCompute",
22  ];
```

**白名单外请求的物理拦截点**——`src/client.ts:10-15`（`ReadOnlyViolation` 异常类）与 `src/client.ts:93-96`（唯一调用入口 `call()` 的强制校验）：
```
10  export class ReadOnlyViolation extends Error {
11    constructor(path: string) {
12      super(`ReadOnlyViolation: 路径不在只读白名单：${path}`);
13      this.name = "ReadOnlyViolation";
...
93  export async function call<T = unknown>(path: string, params: Record<string, unknown>): Promise<ApiResult<T>> {
94    if (!READONLY_WHITELIST.includes(path)) {
95      throw new ReadOnlyViolation(path);
96    }
```
`call()` 是全项目对企迈接口的唯一出口（四个工具文件均只 `import { call } from "../client.js"`），白名单校验在此处物理断路，非白名单路径无法绕过发出请求。

### 日志自证（logs/audit.log，全量扫描，非抽查）

- 总条数：**130 条**
- 去重后出现过的路径与频次：

| 路径 | 出现次数 |
|---|---|
| v3/goods/item/getShopGoodsList/search | 35 |
| v3/goods/item/getShopGoodsListByCategory | 29 |
| v3/goods/item/getShopCategory | 25 |
| v3/goods/item/getShopGoodsDetail | 24 |
| v3/org/shop/getShopList | 7 |
| v3/org/shop/getShopColsById | 7 |
| v3/newPattern/cateringApiserver/post/order/cart/appCompute | 3 |

- 去重路径数：**7 个**，与白名单 7 条**逐条一一对应**，**白名单外路径 = 0**。
- 字段结构抽查：`awk -F'\t' '{print NF}' logs/audit.log | sort -u` 结果恒为 `4`（时间戳 / path / ok-fail / 耗时ms），说明日志格式与 `src/client.ts:52`（`audit()` 函数只拼接这 4 个字段）严格一致，没有额外字段夹带参数。
- 敏感信息扫描：对全文（非抽查）grep `openkey|opentoken|grantcode|openid|token|password|secret`（忽略大小写），**0 命中**。人工抽查 10 行原文格式为 `2026-07-23T02:10:02.609Z\tv3/org/shop/getShopList\tok\t1958ms`，只含时间/路径/成败/耗时，不含参数值与凭证。

### 调用次数
**0 次**（纯本地代码阅读 + 既有日志文件分析）。

---

## 任务三：估清/下架商品提示验证（dod.md 第 4 项）

**结论：部分 PASS**——代码自证方向正确、逻辑完整；798 店机会性实测未命中估清商品，缺少 clearStatus=0 场景的真实响应做端到端确认。

### 代码自证

**clearStatus 语义判定**——`src/tools/getItemDetail.ts:80-84`：
```
80  function skuAvailable(s: SkuRaw): boolean {
81    if (s.clearStatus === 0) return false; // 已估清（文档 id=230 实锤：0-已估清 1-未估清）
82    if (typeof s.inventory === "number" && s.inventory <= 0) return false;
83    return true;
84  }
```
第 81 行判定方向正确：`clearStatus === 0` → `available=false`（已估清），未判反。

**不可点提示的生成逻辑**——`src/tools/getItemDetail.ts:111-124`：
```
111  const anySkuPrice = (g.goodsSkuList ?? []).some((s) => typeof s.salePrice === "number" && s.salePrice > 0);
112  let available = true;
113  let unavailableReason: string | undefined;
114  if (g.status === 20) {
115    available = false;
116    unavailableReason = "已下架";
117  } else if (!anySkuPrice) {
118    available = false;
119    unavailableReason = "非售卖条目";
120  } else if (skus.length > 0 && skus.every((s) => !s.available)) {
121    available = false;
122    unavailableReason = "暂时估清，点不了";
123  }
```
三种不可点场景（下架 / 非售卖条目 / 全 SKU 估清）均有明确 `unavailableReason` 文案，`previewOrder.ts:54-55` 在 `buildLine()` 里会先查 `detail.available`，不可点商品直接返回结构化失败（`「${detail.name}」${detail.unavailableReason}，换一款试试`），不会漏判进入算价流程。

### 机会性实测

新建 `scripts/n8ClearScan.ts`，扫描 798 店（storeId=312276）全部 9 个分类、43 款商品的 `goodsSkuList[].clearStatus`：
```
分类共 9 个：Black系列、经典、奶昔、抹茶、茶奶、纯茶、茶酒、李茶、叩手礼
  「Black系列」商品 1 款（累计已扫 1 款）
  「经典」商品 19 款（累计已扫 20 款）
  「奶昔」商品 2 款（累计已扫 22 款）
  「抹茶」商品 1 款（累计已扫 23 款）
  「茶奶」商品 3 款（累计已扫 26 款）
  「纯茶」商品 2 款（累计已扫 28 款）
  「茶酒」商品 3 款（累计已扫 31 款）
  「李茶」商品 9 款（累计已扫 40 款）
  「叩手礼」商品 3 款（累计已扫 43 款）

== 分类列表扫描完成：9 个分类，累计商品 43 款，累计调用 10 次 ==

[结论] 当前798店无估清商品（clearStatus=0），实测留机会性补测。
真实调用共 10 次，0 次命中，未消耗确认调用。
```
如实记录：**当前 798 店无估清商品，实测留机会性补测**。未命中，因此未触发 `getItemDetail` 二次确认调用。

### 兜底证据（既有用例，未重跑，仅代码引用）

`scripts/smokeDetail.ts:52-60` 已有一条"不存在 goodsId"的兜底用例（结构类似估清/下架但场景不同——查询失败而非查得但不可点），验证工具层遇到查不到的商品会抛结构化错误而不是崩溃或误报可点：
```
52  // 用例 3：兜底——不存在的 goodsId 应返回结构化错误（不崩）
53  console.log("\n▶ 不存在的 goodsId=1（兜底）");
54  try {
55    await getItemDetail(STORE, "1");
56    failures++;
57    console.error("  ✗ 断言失败：不存在的商品不应返回详情");
58  } catch (e) {
59    console.log(`  正确抛出结构化错误：${(e as Error).message.slice(0, 50)}…`);
60  }
```
注意：这条用例证明的是"查不到商品"的兜底，**不是** "查到商品但 clearStatus=0" 的兜底——两者是不同分支（分别对应 `getItemDetail.ts` 的"抛错"路径与"available=false"路径）。本轮没有真实的 clearStatus=0 样本，因此"估清商品→提示不可点"这条具体路径只有代码自证，没有端到端实测印证。

### 调用次数
**10 次**（1 次分类列表 + 9 次分类商品列表），0 次命中，未消耗确认调用。

---

## 发现的问题

无代码缺陷。以下是走查过程中的观察项，供总工参考，不算 bug：

1. **上游数据观察（非代码缺陷）**：兰皇金观音奶茶、李茶的山竹两个样本的"加料"字段里出现的是类似 `"40s萃取·茶汤固定·去冰不满杯严重"`、`"不去冰·搅一搅·叩叩手"` 这样的营销文案式长文本，而非常规加料名（如"加珍珠"）。这是企迈后台商品配置的原始数据（`attachGoodsList[].attachGoodsName`），我方 `getItemDetail.ts` 只是如实透传，字段映射本身没有问题；但如果这类文案被当作真实"加料"选项展示给终端顾客，可能造成误解，值得产品侧确认是否为运营误配置。
2. **任务四证据缺口**：本轮 798 店机会性实测未遇到 clearStatus=0 的商品，"估清→不可点"这条具体路径缺少真实响应的端到端印证，只能靠代码自证。若后续任意一次实测偶遇估清商品，建议顺手补一次 `getItemDetail` 确认，补齐这条证据链。
3. **环境事实更新**：任务书预告的"凭证在 keychain、沙盒内读不到"未在本轮复现——`npx tsx scripts/n8PriceAudit.ts` 与 `npx tsx scripts/n8ClearScan.ts` 均在默认沙盒内直接跑通、无需 `dangerouslyDisableSandbox`。留痴备查，不确定是环境变化还是此前问题已被绕过。

---

## 附：本轮真实调用汇总

| 任务 | 脚本 | 调用次数 |
|---|---|---|
| 任务一 | scripts/n8PriceAudit.ts | 6 |
| 任务二 | （无，纯本地） | 0 |
| 任务三 | scripts/n8ClearScan.ts | 10 |
| **合计** | | **16 / 30** |
