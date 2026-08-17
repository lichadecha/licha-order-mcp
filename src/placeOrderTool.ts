// place_order 工具的处理逻辑，独立成模块（不放在 index.ts 里）的原因：
// index.ts 顶层有 `main().catch(...)`，import 它会触发真实的 stdio transport connect
// （见 index.ts 底部）。把这里的逻辑单独拆出来，测试才能安全地直接 import + 调用，
// 不必 spawn 子进程去验证"塞 userId 会被拒绝且 fetch 未被调用"这类需要 mock fetch 的场景。
//
// 🚨 M2 阶段仅链路骨架，完整逻辑见 M4。这里只做「拦 userId 黑盒后门 → 校验令牌 → 过护栏 →
// 调 callWrite」几步，不实现 6.2.9 完整参数组装（storeId/items/practiceList/attachList 的拼装
// 是 prepare_order 的活，M4 才交付）、不做 6.1.9 强制读回与差额比对（同为 M4）。
//
// M2 阶段没有任何工具能签发合法确认令牌——prepare_order 本身是 M4 交付物——所以此刻对本工具的
// 任何合法调用都必然在 callWrite 的令牌校验一步被拒绝（TokenNotFound）。它存在的唯一目的，是让
// 「写能力开关关闭时 tools/list 无写工具 / 开启时有」这条验收现象（T1/T2）可验。
//
// 🚨 红线提醒（写在这里，不能只写在文档里）：任何真实调用都会在企迈侧创建真实订单、
// 可能进入门店 POS 排单。开发/测试环境必须 mock 拦截 fetch，禁止用真实调用来验证本工具或护栏逻辑。

import { callWrite } from "./client.js";
import { WRITE_WHITELIST } from "./constants.js";
import { getWriteGuard } from "./writeGuard.js";

export type TextResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export function ok(data: unknown): TextResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function fail(e: unknown): TextResult {
  const message = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * 递归检查 value 里任意嵌套层级是否出现名为 "userId" 的字段，命中则返回可读的路径（如
 * "items[0].userId"），否则返回 null。
 *
 * 背景（总工验收裁决 M2 追加修复）：M2 阶段 place_order 的 orderParams 是一个透传黑盒
 * （z.record(z.string(), z.unknown())），因为 M4 才会做 6.2.9 的正式参数组装。但"userId 不做
 * 工具参数、只能由会话态注入"是 M3 定死的架构硬规矩（施工令 § 3.3）——黑盒透传如果不加防御，
 * 精神上等于开了个后门：调用方可以把 userId 悄悄塞进 orderParams 的任意字段或任意嵌套层级里，
 * M2 阶段没有会话态可以拦这件事，所以在工具入口就用黑名单直接挡。
 */
export function findUserIdField(value: unknown, path = ""): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findUserIdField(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const currentPath = path ? `${path}.${k}` : k;
      if (k === "userId") return currentPath;
      const hit = findUserIdField(v, currentPath);
      if (hit) return hit;
    }
  }
  return null;
}

export interface PlaceOrderInput {
  confirmToken: string;
  amountFen: number;
  orderParams: Record<string, unknown>;
}

export async function placeOrderHandler({ confirmToken, amountFen, orderParams }: PlaceOrderInput): Promise<TextResult> {
  try {
    const userIdPath = findUserIdField(orderParams);
    if (userIdPath) {
      // 这一步的拒绝发生在 callWrite 之前——没有白名单/护栏可言，但依然是一次"写路径上的
      // 异常尝试"，值得留痕，所以直接写审计（reason 里带上命中路径，方便事后排查是谁传的）。
      getWriteGuard().recordAudit({
        path: WRITE_WHITELIST[0],
        result: "rejected",
        reason: `UserIdInOrderParams:${userIdPath}`,
        tokenId: confirmToken || null,
        idempotencyKey: null,
        durationMs: 0,
      });
      throw new Error(
        `orderParams 不能包含 userId 字段（命中路径：${userIdPath}）：userId 只能由会话态注入（M3 架构硬规矩），不接受调用方传入`,
      );
    }
    const result = await callWrite(WRITE_WHITELIST[0], orderParams, { amountFen, confirmToken });
    return ok(result);
  } catch (e) {
    return fail(e);
  }
}
