// 5.4.5 appConfirm 探针：切割 appCompute 500 假说（同服务的另一算价接口是否可用）。
// 不走 client.call（appConfirm 不在只读白名单），直接用 auth 签名发送；只读试算，不创建订单。
// 预算：最多 2 次真实调用。沙盒外运行（涉 keychain）：npx tsx scripts/probeAppConfirm.ts

import { randomInt } from "node:crypto";
import { loadCredentials, sign } from "../src/auth.js";
import { protectIds, restoreIdsForSend } from "../src/client.js";
import { BASE_URL } from "../src/constants.js";

const PATH = "v3/newPattern/cateringApiserver/post/order/appConfirm";
const STORE = 503542; // 深圳湾万象城
const LANHUANG = { goodsId: "1123942469096853505", skuId: "1199833216582828032" }; // 兰皇金观音（¥24 锚点）

async function post(params: Record<string, unknown>): Promise<void> {
  const c = loadCredentials();
  const nonce = randomInt(1_000_000, 1_000_000_000);
  const timestamp = Math.floor(Date.now() / 1000);
  const { token } = sign(c.openKey, c.grantCode, nonce, c.openId, timestamp);
  const body = restoreIdsForSend(
    JSON.stringify({ openId: c.openId, grantCode: c.grantCode, nonce, timestamp, token, params }),
  );
  const resp = await fetch(BASE_URL + PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json;charset=UTF-8" },
    body,
  });
  const text = await resp.text();
  const data = JSON.parse(protectIds(text)) as {
    status?: boolean;
    code?: number;
    message?: string;
    data?: Record<string, unknown>;
  };
  if (data.status === true) {
    const d = data.data ?? {};
    console.log(`  ✓ 通了 code=${data.code}`);
    console.log(`  totalAmount=${d["totalAmount"]} actualAmount=${d["actualAmount"]} discountAmount=${d["discountAmount"]}`);
    console.log(`  响应片段：${JSON.stringify(d).slice(0, 400)}`);
  } else {
    console.log(`  ✗ 不通 code=${data.code} message=${data.message}`);
    console.log(`  原始响应全文（找 traceId 用）：${text}`);
  }
}

async function main(): Promise<void> {
  console.log("== 5.4.5 appConfirm 探针（≤2 次调用） ==");
  console.log("\n▶ 用例 1：手册必填最小参数（items + storeId）");
  await post({
    items: [{ goodsId: LANHUANG.goodsId, skuId: LANHUANG.skuId, num: 1 }],
    storeId: STORE,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
