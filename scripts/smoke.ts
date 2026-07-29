// N2 冒烟：绕过 MCP 协议直调 client。
// 完工判据（07 老板判断法）：签名自检通过 + 9 个分类名 + 锚点比对通过。

import { selfTest } from "../src/auth.js";
import { call } from "../src/client.js";
import { CHANNEL } from "../src/constants.js";

// 无损锚点：取自 【归档】/outputs/T2_step0_v6_result.json（Python 任意精度解析，无抹零；2026-07-27 归档）。
// 对照：qmai CLI 同字段返回 …800（抹零），本锚点为 …792（真值）。
const ANCHOR = { categoryName: "茶奶", frontCategoryId: "1123766423256481792" } as const;

interface Category {
  categoryName: string;
  frontCategoryId: string;
}

async function main(): Promise<void> {
  console.log("== N2 冒烟 ==");
  selfTest();

  if (process.argv.includes("--auth-only")) {
    console.log("（--auth-only，跳过实调）");
    return;
  }

  console.log("实调 getShopCategory（深圳湾 503542）…");
  const r = await call<Category[]>("v3/goods/item/getShopCategory", {
    storeId: 503542,
    ...CHANNEL,
  });
  if (!r.ok || !Array.isArray(r.data)) {
    console.error("冒烟失败：", r.error ?? r.message);
    process.exit(1);
  }

  const cats = r.data;
  console.log(`返回 ${cats.length} 个分类：`);
  for (const c of cats) {
    console.log(`  - ${c.categoryName}（frontCategoryId=${c.frontCategoryId}）`);
  }

  const hit = cats.find((c) => c.categoryName === ANCHOR.categoryName);
  if (!hit) {
    console.error(`锚点分类「${ANCHOR.categoryName}」未找到`);
    process.exit(1);
  }
  if (String(hit.frontCategoryId) !== ANCHOR.frontCategoryId) {
    console.error(`锚点比对失败：期望 ${ANCHOR.frontCategoryId}，实得 ${hit.frontCategoryId}（疑似大数精度回归）`);
    process.exit(1);
  }
  console.log(`锚点比对通过：「茶奶」frontCategoryId=${ANCHOR.frontCategoryId}（无损）`);
  console.log("== 冒烟 ✓ ==");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
