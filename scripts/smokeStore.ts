// N3 冒烟：find_store 三用例。
// 注意：「北京」按事实应为 4 家候选（The Box/798/凤凰汇/太古里）——
// 07 施工图与 09 任务书写的「3 家」漏算太古里，系总工笔误，已回报更正。

import { findStore } from "../src/tools/findStore.js";

async function main(): Promise<void> {
  console.log("== N3 冒烟：find_store ==");
  for (const q of ["深圳湾", "北京", "肯德基"]) {
    console.log(`\n▶ 查询「${q}」`);
    const r = await findStore(q);
    if (r.matched) {
      const s = r.store;
      console.log(
        `  唯一命中：${s.name}（storeId=${s.storeId}，shopCode=${s.shopCode}，${s.openStatusText}${s.opentimes ? `，营业时间 ${s.opentimes}` : ""}）`,
      );
    } else if (r.candidates.length > 0) {
      console.log(`  ${r.candidates.length} 家候选：`);
      for (const c of r.candidates) {
        console.log(`    - ${c.name}（shopCode=${c.shopCode}，${c.cityName}，${c.openStatusText}）`);
      }
    } else {
      console.log(`  零命中。hint：${r.hint}`);
    }
  }
  console.log("\n== 冒烟 ✓ ==");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
