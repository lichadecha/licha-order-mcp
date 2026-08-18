// get_order_status 工具的处理逻辑，独立成模块——理由同 placeOrderTool.ts / bindMemberTool.ts
// 头部注释：index.ts 顶层的 main().catch(...) 会触发真实 stdio transport connect，测试不能安全
// import 它；处理逻辑拆到独立模块后才能直接 import + mock fetch。
//
// 本文件同时导出 assertOrderOwnership：M4 的 6.1.9（订单详情）/ 6.1.6（订单列表）工具要复用
// 同一份所有权校验，不许各自再写一份判据不一致的版本。

import { callRead } from "./client.js";
import { getAccessAuditLogger } from "./accessAudit.js";
import { DEFAULT_SESSION_KEY, getSessionStore, type SessionBinding } from "./session.js";

export type TextResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export function ok(data: unknown): TextResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function fail(e: unknown): TextResult {
  const message = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text", text: message }], isError: true };
}

export type OwnershipCheck = { ok: true } | { ok: false; reason: "missing_userId" | "mismatch" };

/**
 * 所有权校验：data.userId 缺失（fail closed，缺失 = 不能证明是你的 = 拒绝）或与当前会话绑定的
 * customerId 不一致 → 不通过。M4 的 6.1.9/6.1.6 工具复用本函数，判据必须只有这一份。
 */
export function assertOrderOwnership(data: unknown, binding: SessionBinding): OwnershipCheck {
  if (data == null || typeof data !== "object") return { ok: false, reason: "missing_userId" };
  const userId = (data as Record<string, unknown>).userId;
  if (userId == null) return { ok: false, reason: "missing_userId" };
  if (String(userId) !== binding.customerId) return { ok: false, reason: "mismatch" };
  return { ok: true };
}

// 6.1.5 status → 顾客可读文案；未知值兜底成「未知状态(N)」，不假设枚举永远完整。
const STATUS_TEXT_MAP: Record<number, string> = {
  10: "待支付",
  15: "支付中",
  20: "已支付",
  30: "待备餐",
  40: "待取餐",
  50: "已完成",
  60: "已取消",
  70: "已关闭",
};

function statusText(status: number): string {
  return STATUS_TEXT_MAP[status] ?? `未知状态(${status})`;
}

export interface OrderStatusInput {
  orderNo: string;
}

export async function getOrderStatusHandler({ orderNo }: OrderStatusInput): Promise<TextResult> {
  const sessionStore = getSessionStore();
  const audit = getAccessAuditLogger();

  try {
    // ① 未绑定 → 直接拒绝，不发任何请求。
    let binding: SessionBinding;
    try {
      binding = sessionStore.requireBinding(DEFAULT_SESSION_KEY);
    } catch (e) {
      audit.record({
        event: "unbound_call_rejected",
        result: "rejected",
        reason: "SessionNotBound",
        sessionKey: DEFAULT_SESSION_KEY,
        tool: "get_order_status",
      });
      return fail(e);
    }

    // ② callRead 6.1.5 查询订单状态。
    const resp = await callRead<Record<string, unknown>>("v3/order/status", { orderNo });

    // ③ ok=false → 透传错误信息（查无此单等）。
    if (!resp.ok) {
      return fail(new Error(resp.error?.message ?? resp.message ?? "查询失败：查无此单或接口异常"));
    }

    // ④ 所有权校验不过 → 丢弃全部响应内容，只返回不含任何订单字段的拒绝文本。
    const ownership = assertOrderOwnership(resp.data, binding);
    if (!ownership.ok) {
      audit.record({
        event: "ownership_mismatch",
        result: "rejected",
        reason: ownership.reason,
        orderNo,
        customerIdLast4: `***${binding.customerId.slice(-4)}`,
        sessionKey: DEFAULT_SESSION_KEY,
        tool: "get_order_status",
      });
      return fail(new Error("无法查询：该订单不属于当前绑定的会员"));
    }

    // ⑤ 通过 → 只返回 orderNo/status/statusText，不返回 userId（连自己的也不返回）。
    const rawStatus = resp.data?.status;
    const status = typeof rawStatus === "number" ? rawStatus : Number(rawStatus);
    return ok({ orderNo, status, statusText: statusText(status) });
  } catch (e) {
    return fail(e);
  }
}
