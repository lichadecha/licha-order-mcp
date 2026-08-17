// N8 竣工走查 · 价格一致性接口自证（dod.md 第 2 项）
// 目的：逐字段比对「client 层原始返回 JSON」vs「工具解析输出」，确认价格分转元、
// 做法/加料加价、标签字段（text 而非 labelTypeText）、estimated 总价算术均无错位。
// 预算：2 商品 × (1 搜索 + 1 原始详情 + 1 工具详情) = 6 次真实只读调用。
// previewOrder 内部会再调一次 getItemDetail，但命中同进程缓存，不产生新请求。

import { call } from "../src/client.js";
import { CHANNEL } from "../src/constants.js";
import { getItemDetail } from "../src/tools/getItemDetail.js";
import { previewOrder } from "../src/tools/previewOrder.js";

const STORE = 503542; // 深圳湾万象城
const ANCHOR_GOODS_ID = "1123942469096853505"; // 兰皇金观音奶茶（既有锚点，做法2组+加料1）

interface RawLabel {
  text?: string;
  labelTypeText?: string;
}
interface RawSku {
  skuId?: string | number;
  salePrice?: number;
  clearStatus?: number;
}
interface RawPracticeVal {
  practiceValue?: string;
  price?: number;
}
interface RawPracticeGroup {
  practiceName?: string;
  practiceValueList?: RawPracticeVal[];
}
interface RawAttach {
  attachGoodsName?: string;
  attachGoodsPrice?: number;
}
interface RawDetail {
  goodsId: string | number;
  name: string;
  goodsSkuList?: RawSku[];
  sortedPracticeList?: RawPracticeGroup[];
  attachGoodsList?: RawAttach[];
  labelList?: RawLabel[];
}
interface RawSearchGoods {
  goodsId: string | number;
  name: string;
  goodsSkuList?: Array<{ salePrice?: number }>;
  showPriceLow?: number;
}

let totalCalls = 0;
let totalFail = 0;

function pass(cond: boolean, label: string, detail: string): boolean {
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${label}：${detail}`);
  if (!cond) totalFail++;
  return cond;
}

async function searchOne(keyword: string): Promise<{ goodsId: string; name: string }> {
  totalCalls++;
  const r = await call<RawSearchGoods[]>("v3/goods/item/getShopGoodsList/search", {
    storeId: STORE,
    name: keyword,
    ...CHANNEL,
    includeProperties: ["SKU", "LABEL"],
  });
  if (!r.ok || !Array.isArray(r.data) || r.data.length === 0) {
    throw new Error(`搜索「${keyword}」失败或无结果：${r.error?.message ?? "无数据"}`);
  }
  // 优先命中既有锚点（有完整做法+加料，便于覆盖全部比对项），否则取第一个有效价格商品
  const anchorHit = r.data.find((g) => String(g.goodsId) === ANCHOR_GOODS_ID);
  const priced = r.data.find((g) => (g.goodsSkuList?.[0]?.salePrice ?? g.showPriceLow ?? 0) > 0);
  const hit = anchorHit ?? priced ?? r.data[0];
  return { goodsId: String(hit.goodsId), name: hit.name };
}

async function auditItem(keyword: string): Promise<void> {
  console.log(`\n== 审计商品：搜「${keyword}」==`);
  const { goodsId, name } = await searchOne(keyword);
  console.log(`  命中商品：${name}（goodsId=${goodsId}）`);

  // ---- 原始返回（client 层直调，绕开工具解析）----
  totalCalls++;
  const raw = await call<RawDetail[]>("v3/goods/item/getShopGoodsDetail", {
    storeId: STORE,
    goodsIds: [goodsId],
    ...CHANNEL,
    includeProperties: ["SKU", "PRACTICE", "ATTACH", "LABEL", "CATEGORY"],
  });
  if (!raw.ok || !Array.isArray(raw.data) || raw.data.length === 0) {
    throw new Error(`原始详情调用失败：${raw.error?.message ?? "无数据"}`);
  }
  const rd = raw.data[0];

  // ---- 工具解析输出 ----
  totalCalls++;
  const detail = await getItemDetail(STORE, goodsId);

  // 1. SKU 价格：分 → 元
  const rawSkuFen = rd.goodsSkuList?.[0]?.salePrice;
  const expectYuan = typeof rawSkuFen === "number" ? (rawSkuFen / 100).toFixed(2) : "价格待询";
  pass(
    detail.skus[0]?.priceYuan === expectYuan && detail.skus[0]?.priceFen === (rawSkuFen ?? 0),
    "SKU价格分转元",
    `原始分=${rawSkuFen} → 期望元=${expectYuan}｜工具输出 priceFen=${detail.skus[0]?.priceFen} priceYuan=${detail.skus[0]?.priceYuan}`,
  );

  // 2. 做法加价
  if (rd.sortedPracticeList && rd.sortedPracticeList.length > 0) {
    const rp = rd.sortedPracticeList[0];
    const rv = (rp.practiceValueList ?? [])[0];
    const rawFen = rv?.price ?? 0;
    const expectDelta = rawFen === 0 ? "+0" : `+${(rawFen / 100).toFixed(2)}`;
    const tp = detail.practices.find((p) => p.name === (rp.practiceName ?? "做法"));
    const tv = tp?.values.find((v) => v.name === (rv?.practiceValue ?? ""));
    pass(
      tv?.priceDeltaYuan === expectDelta && tv?.priceFen === rawFen,
      "做法加价",
      `组「${rp.practiceName}」值「${rv?.practiceValue}」原始分=${rawFen} → 期望=${expectDelta}｜工具输出 priceFen=${tv?.priceFen} priceDeltaYuan=${tv?.priceDeltaYuan}`,
    );
  } else {
    console.log("  [SKIP] 做法加价：该商品无做法组");
  }

  // 3. 加料加价
  if (rd.attachGoodsList && rd.attachGoodsList.length > 0) {
    const ra = rd.attachGoodsList[0];
    const rawFen = ra.attachGoodsPrice ?? 0;
    const expectYuanA = (rawFen / 100).toFixed(2);
    const ta = detail.attaches.find((a) => a.name === ra.attachGoodsName);
    pass(
      ta?.priceYuan === expectYuanA && ta?.priceFen === rawFen,
      "加料加价",
      `「${ra.attachGoodsName}」原始分=${rawFen} → 期望元=${expectYuanA}｜工具输出 priceFen=${ta?.priceFen} priceYuan=${ta?.priceYuan}`,
    );
  } else {
    console.log("  [SKIP] 加料加价：该商品无加料");
  }

  // 4. 标签字段：应取 text，非 labelTypeText
  const rawLabels = rd.labelList ?? [];
  if (rawLabels.length > 0) {
    console.log(`  [取证] 原始 labelList=${JSON.stringify(rawLabels)}`);
    const expectLabels = rawLabels.map((l) => l.text ?? l.labelTypeText).filter((t): t is string => Boolean(t));
    const matches = JSON.stringify(detail.labels) === JSON.stringify(expectLabels);
    const divergent = rawLabels.filter((l) => l.text && l.labelTypeText && l.text !== l.labelTypeText);
    const note =
      divergent.length > 0
        ? `（${divergent.length} 项 text≠labelTypeText，足以区分两字段：${divergent.map((l) => `text="${l.text}" vs labelTypeText="${l.labelTypeText}"`).join("；")}）`
        : "（本商品 text 与 labelTypeText 相同或只有一者存在，未能靠此商品区分两字段，仅证明未取错导致报错）";
    pass(matches, "标签字段（应取text非labelTypeText）", `工具输出=[${detail.labels.join(",")}]，期望=[${expectLabels.join(",")}] ${note}`);
  } else {
    console.log("  [SKIP] 标签：该商品无标签");
  }

  // 5. estimated 总价算术：SKU + 做法 + 加料（quantity=1）
  const chosenPractice = detail.practices[0]?.values[0]?.name;
  const chosenAttach = detail.attaches[0]?.name;
  let expectFen = detail.skus[0]?.priceFen ?? 0;
  if (chosenPractice) {
    for (const g of detail.practices) {
      const v = g.values.find((vv) => vv.name === chosenPractice);
      if (v) expectFen += v.priceFen;
    }
  }
  if (chosenAttach) {
    const a = detail.attaches.find((aa) => aa.name === chosenAttach);
    if (a) expectFen += a.priceFen;
  }
  const expectTotalYuan = (expectFen / 100).toFixed(2);

  // previewOrder 内部会再次 getItemDetail(STORE, goodsId) —— 命中本进程缓存，零新增网络调用
  const preview = await previewOrder(STORE, [
    {
      goodsId,
      quantity: 1,
      ...(chosenPractice ? { practices: [chosenPractice] } : {}),
      ...(chosenAttach ? { attaches: [chosenAttach] } : {}),
    },
  ]);
  const previewTotal = preview.ok ? preview.totalYuan : `ERROR:${preview.error?.message}`;
  pass(
    preview.ok === true && previewTotal === expectTotalYuan,
    "estimated总价算术（SKU+做法+加料）",
    `手算=SKU(${detail.skus[0]?.priceFen})+做法(${chosenPractice ?? "无"})+加料(${chosenAttach ?? "无"})=${expectFen}分=¥${expectTotalYuan}｜previewOrder输出=${previewTotal}`,
  );
}

async function main(): Promise<void> {
  console.log("== N8 价格一致性接口自证 ==");
  await auditItem("兰皇");
  await auditItem("山竹");
  console.log(`\n== 完成：真实调用 ${totalCalls} 次，FAIL ${totalFail} 处 ==`);
  if (totalFail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
