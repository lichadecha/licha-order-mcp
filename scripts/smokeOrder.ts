// N6 冒烟：preview_order 本地累加 + appCompute 悬案复测留证。
// 老板判断法（07 原文）：组一单两杯，MCP 总价与小程序购物车总价完全一致。

import { call } from "../src/client.js";
import { previewOrder } from "../src/tools/previewOrder.js";

const STORE = 503542;
const LANHUANG = { goodsId: "1123942469096853505", skuId: "1199833216582828032" }; // 兰皇金观音奶茶（v6 锚点）
const LIANWU = { goodsId: "1123942469096853506" }; // 占位，实际从菜单拿——见下

async function main(): Promise<void> {
  console.log("== N6 冒烟：preview_order ==");
  let failures = 0;

  // 用例 0：appCompute 悬案复测（留证，不阻塞）
  console.log("\n▶ appCompute 复测（500 悬案）");
  const probe = await call<Record<string, unknown>>("v3/newPattern/cateringApiserver/post/order/cart/appCompute", {
    items: [{ goodsId: LANHUANG.goodsId, skuId: LANHUANG.skuId, num: 1 }],
    orderType: 2,
    storeId: STORE,
  });
  if (probe.ok) {
    console.log("  意外之喜：appCompute 通了！响应：", JSON.stringify(probe.data).slice(0, 200));
    console.log("  → 后续可把主路切回 appCompute（先核对响应单位）");
  } else {
    console.log(`  仍不通：code=${probe.code ?? probe.error?.code} message=${probe.message ?? probe.error?.message}（符合预期，走本地累加）`);
  }

  // 用例 1：两杯单——兰皇（少冰+70%糖）×1 + 莲雾2.0 ×2 = 24 + 56 = 80.00
  console.log("\n▶ 两杯单（兰皇×1 + 莲雾2.0×2，期望 ¥80.00）");
  const menu = await import("../src/tools/getMenu.js");
  const m = await menu.getMenu(STORE, "莲雾");
  if (m.mode !== "items" || m.items.length === 0) throw new Error("菜单搜索未命中莲雾");
  const lianwuId = m.items.find((i) => i.name.includes("莲雾2.0"))!.goodsId;
  const r1 = await previewOrder(STORE, [
    { goodsId: LANHUANG.goodsId, practices: ["少冰（400ml)", "70%-L阿拉伯糖"], quantity: 1 },
    { goodsId: lianwuId, quantity: 2 },
  ]);
  if (!r1.ok) {
    failures++;
    console.error(`  ✗ 算价失败：${r1.error?.message}`);
  } else {
    for (const l of r1.lines ?? []) {
      console.log(`  ${l.name}（${l.specName}${l.practices.length ? "，" + l.practices.join("+") : ""}）¥${l.unitPriceYuan} ×${l.quantity} = ¥${l.lineTotalYuan}`);
    }
    console.log(`  总价：¥${r1.totalYuan}`);
    if (r1.totalYuan !== "80.00") {
      failures++;
      console.error(`  ✗ 断言失败：总价应为 80.00，实得 ${r1.totalYuan}`);
    }
  }

  // 用例 2：同组双做法冲突（少冰+热）→ 应报错
  console.log("\n▶ 同组冲突（少冰+热）");
  const r2 = await previewOrder(STORE, [
    { goodsId: LANHUANG.goodsId, practices: ["少冰（400ml)", "热（350ml)"], quantity: 1 },
  ]);
  if (r2.ok) {
    failures++;
    console.error("  ✗ 断言失败：同组双做法应报错");
  } else {
    console.log(`  正确拦截：${r2.error?.message}`);
  }

  // 用例 3：不可点商品兜底（goodsId=1 不存在）
  console.log("\n▶ 不存在商品兜底");
  const r3 = await previewOrder(STORE, [{ goodsId: "1", quantity: 1 }]);
  if (r3.ok) {
    failures++;
    console.error("  ✗ 断言失败：不存在商品不应算价成功");
  } else {
    console.log(`  正确兜底：${r3.error?.message.slice(0, 40)}…`);
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
