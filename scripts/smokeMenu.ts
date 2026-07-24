// N4 冒烟：get_menu 四用例。
// 老板判断法（07 原文）：「纯茶系列有什么」能给出商品列表（正路或绕行均可）；
// 菜单里不出现「40s萃取…」之类的假商品。

import { getMenu } from "../src/tools/getMenu.js";

const STORE = 503542;

async function main(): Promise<void> {
  console.log("== N4 冒烟：get_menu ==");
  let failures = 0;

  // 用例 1：无 keyword → 分类列表
  console.log("\n▶ getMenu(503542)");
  const cats = await getMenu(STORE);
  if (cats.mode !== "categories") throw new Error("用例1 异常：未返回分类模式");
  console.log(`  ${cats.categories.length} 个分类：${cats.categories.map((c) => c.categoryName).join("、")}`);
  if (cats.categories.length !== 9) {
    failures++;
    console.error("  ✗ 断言失败：分类数应为 9");
  }

  // 用例 2：keyword=分类名「纯茶」→ 正路 3.1.11
  console.log('\n▶ getMenu(503542, "纯茶")');
  const byCat = await getMenu(STORE, "纯茶");
  if (byCat.mode !== "items") throw new Error("用例2 异常：未返回商品模式");
  console.log(`  路径：${byCat.via === "category" ? "正路（3.1.11 按分类）" : "绕行（搜索）"}｜分类「${byCat.categoryName ?? "-"}」｜${byCat.items.length} 个商品`);
  for (const it of byCat.items) console.log(`    - ${it.name} ¥${it.priceYuan}${it.labels.length ? ` [${it.labels.join(",")}]` : ""}`);
  if (byCat.via !== "category" || byCat.items.length === 0) {
    failures++;
    console.error("  ✗ 断言失败：纯茶应走正路且返回商品");
  }

  // 用例 3：keyword=商品名「莲雾」→ 绕行搜索
  console.log('\n▶ getMenu(503542, "莲雾")');
  const bySearch = await getMenu(STORE, "莲雾");
  if (bySearch.mode !== "items") throw new Error("用例3 异常：未返回商品模式");
  console.log(`  路径：${bySearch.via === "search" ? "绕行（搜索）" : "正路"}｜${bySearch.items.length} 个商品`);
  for (const it of bySearch.items) console.log(`    - ${it.name} ¥${it.priceYuan}`);
  if (bySearch.via !== "search" || bySearch.items.length === 0) {
    failures++;
    console.error("  ✗ 断言失败：莲雾应走搜索且命中");
  }

  // 用例 4：脏数据断言——任何返回里不得出现 0 元/文案假商品
  console.log("\n▶ 脏数据检查");
  const allItems = [...(byCat.mode === "items" ? byCat.items : []), ...(bySearch.mode === "items" ? bySearch.items : [])];
  const fake = allItems.filter((it) => it.priceYuan === "价格待询" || it.name.includes("40s萃取") || it.name.includes("风味叙事"));
  if (fake.length > 0) {
    failures++;
    console.error(`  ✗ 发现假商品混入：${fake.map((f) => f.name).join("、")}`);
  } else {
    console.log("  未发现 0 元文案假商品 ✓");
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
