// get_order_status 工具的处理逻辑，独立成模块——理由同 placeOrderTool.ts / bindMemberTool.ts
// 头部注释：index.ts 顶层的 main().catch(...) 会触发真实 stdio transport connect，测试不能安全
// import 它；处理逻辑拆到独立模块后才能直接 import + mock fetch。
//
// 本文件同时导出 assertOrderOwnership 与 statusText：M4 的 6.1.9（订单详情读回）/ 6.1.6（订单
// 列表）工具要复用同一份所有权校验与同一份状态文案，不许各自再写一份判据不一致的版本。

import { callRead } from "./client.js";
import { getAccessAuditLogger } from "./accessAudit.js";
import { customerCountKey, getWriteGuard, untrustedAuditValue } from "./writeGuard.js";
import { DEFAULT_SESSION_KEY, getSessionStore, type SessionBinding } from "./session.js";
import { projectUpstreamMessage } from "./outboundText.js";

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

/** 导出给 M4 的 my_orders 复用：状态枚举与文案只允许有一份（同 assertOrderOwnership 的理由）。 */
export function statusText(status: number): string {
  return STATUS_TEXT_MAP[status] ?? `未知状态(${status})`;
}

/** 已经不需要再付款的三个终态：已完成 / 已取消 / 已关闭（G1：这类单不许提示付款）。 */
export const SETTLED_STATUSES: ReadonlySet<number> = new Set([50, 60, 70]);

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
      return fail(new Error(projectUpstreamMessage(resp.error?.message ?? resp.message) || "查询失败：查无此单或接口异常"));
    }

    // ④ 所有权校验不过 → 丢弃全部响应内容，只返回不含任何订单字段的拒绝文本。
    const ownership = assertOrderOwnership(resp.data, binding);
    if (!ownership.ok) {
      audit.record({
        event: "ownership_mismatch",
        result: "rejected",
        reason: ownership.reason,
        // 来源判定（P-W2 第三轮微补丁）：这个 orderNo 是**调用方入参**，而本分支恰恰是
        // 「归属没证实」的那一支——值的长相说明不了它是不是识别值（把会员 ID 补个 D 前缀
        // 凑成 D+20 位就能骗过格式校验），所以一律只留尾四位。
        // 排查不受影响：尾号 + time/dateKey + customerIdLast4 三者足以定位是哪一次调用；
        // 真要全单号，本会话拒绝的这张单本来就不属于当前会员，也不该从审计里给出来。
        orderNo: untrustedAuditValue(orderNo),
        customerIdLast4: `***${binding.customerId.slice(-4)}`,
        sessionKey: DEFAULT_SESSION_KEY,
        tool: "get_order_status",
      });
      return fail(new Error("无法查询：该订单不属于当前绑定的会员"));
    }

    // ⑤ 未决核对（G1 收紧，2026-09-08）：这一步意味着企迈侧确实有这张单、且属于当前会员，
    // 但**它证明不了这张单就是那笔结果未知的请求建出来的**——6.1.5 的响应只有
    // `status / storeOrderNo / userId`，没有下单时间、没有门店，一张单和一次请求之间没有
    // 任何可核对的连接点。改造前这里无条件清掉全部未决，于是「查一张三天前的已完成旧单」
    // 就能把闸门和额度一起清空（盲审 B01 / 审计反例 unrelated_old_order_clears_all）。
    //
    // 现在照样把证据交给 guard（判据只有一份，不在工具层另写一套），但如实标注这份证据的
    // 成色：没有时间字段、不是完整列表 → guard 必然保留未知。核对「有没有那一单」要用
    // my_orders 按时间段列，那条路径才有 orderAt。
    const rawStatus = resp.data?.status;
    const status = typeof rawStatus === "number" ? rawStatus : Number(rawStatus);
    const guard = getWriteGuard();
    const outcome = guard.resolveUnresolvedWrites({
      via: "get_order_status",
      customerKey: customerCountKey(binding.customerId),
      orders: [{ orderNo, ...(Number.isFinite(status) ? { status } : {}) }],
      complete: false,
    });

    // ⑥ 通过 → 只返回 orderNo/status/statusText，不返回 userId（连自己的也不返回）。
    // 付款引导按状态给（21 号 P0-1 发现 B）：已完成 / 已取消 / 已关闭的单再劝顾客付款，
    // 是在让顾客对着一张不需要付款的单找付款入口。
    const settled = SETTLED_STATUSES.has(status);
    return ok({
      orderNo,
      status,
      statusText: statusText(status),
      paymentHint: settled
        ? `这张单已经是「${statusText(status)}」，不需要再付款。`
        : status === 10
          ? "这张单还没付款，请引导顾客去小程序「我的订单」完成付款。"
          : `这张单当前是「${statusText(status)}」，按小程序订单页的提示走即可。`,
      ...(outcome.released.length > 0 ? { resolvedPendingWrites: outcome.released.length } : {}),
      ...(guard.hasUnresolvedWrite()
        ? {
            unresolvedPendingWrites: guard.describeUnresolvedWrites().total,
            pendingWriteNote:
              "此前有下单请求结果未知、下单闸门仍然关着。这一次按单号查到的单**不能**用来核对那笔请求——" +
              "6.1.5 的回执里没有下单时间，无法判断它是不是那一次建出来的。" +
              "请改用 my_orders（按时间段列最近订单）核对，那条路径带下单时间。",
          }
        : {}),
    });
  } catch (e) {
    return fail(e);
  }
}
