// N5 冒烟：get_item_detail 三用例。
// 老板判断法（07 原文）：拿一款在售商品问详情，规格/做法/加料三块齐全。

import { getMenu } from "../src/tools/getMenu.js";
import { getItemDetail } from "../src/tools/getItemDetail.js";

const STORE = 503542;
const ANCHOR_GOODS_ID = "1123942469096853505"; // 兰皇金观音奶茶（v6 无损锚点）

async function main(): Promise<void> {
  console.log("== N5 冒烟：get_item_detail ==");
  let failures = 0;

  // 用例 1：兰皇金观音奶茶 → 三块齐全 + 字段对照（v6 实测：做法组2/加料1/¥24）
  console.log("\n▶ 兰皇金观音奶茶（锚点商品）");
  const d1 = await getItemDetail(STORE, ANCHOR_GOODS_ID);
  console.log(`  ${d1.name}｜可点=${d1.available}｜分类=${d1.categoryName}｜标签=[${d1.labels.join(",")}]`);
  console.log(`  规格 ${d1.skus.length} 个：${d1.skus.map((s) => `${s.specName} ¥${s.priceYuan}${s.stock !== null ? ` 库存${s.stock}` : ""}`).join("、")}`);
  for (const p of d1.practices) {
    console.log(`  做法「${p.name}」${p.values.length} 值：${p.values.map((v) => `${v.name}${v.priceDeltaYuan !== "+0" ? `(${v.priceDeltaYuan})` : ""}`).join("/")}`);
  }
  console.log(`  加料 ${d1.attaches.length} 个：${d1.attaches.map((a) => `${a.name}(+${a.priceYuan})`).join("、") || "无"}`);
  if (!(d1.skus.length >= 1 && d1.practices.length >= 2 && d1.attaches.length >= 1)) {
    failures++;
    console.error("  ✗ 断言失败：规格/做法/加料三块不齐全");
  }
  if (d1.skus[0]?.priceYuan !== "24.00") {
    failures++;
    console.error(`  ✗ 断言失败：价格应为 24.00，实得 ${d1.skus[0]?.priceYuan}`);
  }
  if (!d1.labels.includes("40秒萃取")) {
    failures++;
    console.error(`  ✗ 断言失败：标签应含「40秒萃取」（text 字段），实得 [${d1.labels.join(",")}]`);
  }

  // 用例 2：从菜单搜索拿 goodsId 串联（李茶的莲雾2.0）→ labels 应含 NEW
  console.log("\n▶ 李茶的莲雾2.0（菜单→详情串联）");
  const menu = await getMenu(STORE, "莲雾");
  if (menu.mode !== "items" || menu.items.length === 0) throw new Error("用例2 异常：菜单搜索未命中");
  const target = menu.items.find((i) => i.name.includes("莲雾2.0")) ?? menu.items[0];
  const d2 = await getItemDetail(STORE, target.goodsId);
  console.log(`  ${d2.name}｜可点=${d2.available}｜标签=[${d2.labels.join(",")}]｜规格 ${d2.skus.length} 个 ¥${d2.skus[0]?.priceYuan}`);
  if (!d2.labels.includes("NEW")) {
    failures++;
    console.error(`  ✗ 断言失败：标签应含「NEW」，实得 [${d2.labels.join(",")}]`);
  }
  if (!d2.available) {
    failures++;
    console.error("  ✗ 断言失败：在售商品应为可点");
  }

  // 用例 3：兜底——不存在的 goodsId 应返回结构化错误（不崩）
  console.log("\n▶ 不存在的 goodsId=1（兜底）");
  try {
    await getItemDetail(STORE, "1");
    failures++;
    console.error("  ✗ 断言失败：不存在的商品不应返回详情");
  } catch (e) {
    console.log(`  正确抛出结构化错误：${(e as Error).message.slice(0, 50)}…`);
  }

  if (failures > 0) {
    console.error(`\n== 冒烟失败（${failures} 处）==`);
    process.exit(1);
  }
  console.log("\n== 冒烟 ✓ ==");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
