// M4 my_orders：查当前绑定会员最近几天的订单（企迈 6.1.6）。
//
// 三条硬规矩（施工令 § 3.3 架构硬规矩第 3 条）：
//   ① userId 永不做入参——只用会话绑定值发起查询，模型没有任何途径去查别人的订单列表；
//   ② 逐单仍跑 assertOrderOwnership 兜底——查询本身就是按会话 userId 发起的，理论上不会返回
//      别人的单，但"理论上不会"不是"验证过不会"，fail closed 的成本是零，那就验；
//   ③ 出参不含 userId（连自己的也不给）。
//
// ⚠️ 响应结构实测坑（施工令 § 8 第 17 条）：data 是 { blttUserId, data, total }，
//    **订单数组在 data.data**，不是 list / records——总工 M2 验收时按 list 解析拿到空数组、
//    差点误判"没有订单"。这个坑的严重性不在于解析错，而在于它会让一次"不存在性核查"给出
//    虚假的安全感（施工令 § 4.5 第 2 条纪律的来源）。
//
// ⚠️ 金额单位（施工令 § 8 第 15 条）：本接口 actualAmount 单位是「分」（同一笔单 2400），
//    而 6.2.9 创建响应的 payAmount 是「元」（24.0）。禁止复用同名字段的解析逻辑。

import { callRead } from "./client.js";
import { getAccessAuditLogger } from "./accessAudit.js";
import { assertOrderOwnership, statusText } from "./orderStatusTool.js";
import { beijingTimeString, getWriteGuard } from "./writeGuard.js";
import { DEFAULT_SESSION_KEY, getSessionStore, type SessionBinding } from "./session.js";

export type TextResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export function ok(data: unknown): TextResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function fail(e: unknown): TextResult {
  const message = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text", text: message }], isError: true };
}

/** 企迈单页上限 10（手册 6.1.6）。二期只取第一页——「最近几单」够用，不做分页滚动。 */
const PAGE_SIZE = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

interface RawOrder {
  orderNo?: string | number;
  status?: number | string;
  actualAmount?: number | string;
  orderAt?: number | string;
  createTime?: number | string;
  userId?: string | number;
  itemList?: Array<{ itemName?: string; goodsName?: string; num?: number }>;
}

/** 6.1.6 的时间字段实测形态是 13 位毫秒时间戳（可能是字符串，大数保护会字符串化）。 */
function orderTimeText(raw: RawOrder): string | undefined {
  const v = raw.orderAt ?? raw.createTime;
  if (v == null) return undefined;
  const ms = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return beijingTimeString(ms);
}

function itemNames(raw: RawOrder): string[] {
  return (raw.itemList ?? [])
    .map((it) => {
      const name = it.itemName ?? it.goodsName;
      if (!name) return undefined;
      return typeof it.num === "number" && it.num > 1 ? `${name} ×${it.num}` : name;
    })
    .filter((n): n is string => Boolean(n));
}

export interface MyOrdersInput {
  days: number;
}

export async function myOrdersHandler({ days }: MyOrdersInput): Promise<TextResult> {
  const audit = getAccessAuditLogger();

  try {
    // ① 未绑定 → 拒，不发任何请求。
    let binding: SessionBinding;
    try {
      binding = getSessionStore().requireBinding(DEFAULT_SESSION_KEY);
    } catch (e) {
      audit.record({
        event: "unbound_call_rejected",
        result: "rejected",
        reason: "SessionNotBound",
        sessionKey: DEFAULT_SESSION_KEY,
        tool: "my_orders",
      });
      return fail(e);
    }

    // ② callRead 6.1.6。userId 只能是会话绑定值。
    const now = Date.now();
    const resp = await callRead<Record<string, unknown>>("v3/order/userAppointTimeOrderList", {
      orderAtStart: now - days * DAY_MS, // 13 位毫秒时间戳
      orderAtEnd: now,
      pageNo: 1,
      pageSize: PAGE_SIZE,
      userId: binding.customerId,
    });
    if (!resp.ok) {
      return fail(new Error(`查询订单列表失败：${resp.error?.message ?? resp.message ?? "接口异常"}`));
    }

    // ③ 订单数组在 data.data（不是 list/records）。
    const container = resp.data as { data?: unknown; total?: unknown } | null | undefined;
    const rawOrders = Array.isArray(container?.data) ? (container.data as RawOrder[]) : [];

    // ④ 逐单所有权兜底：响应含 userId 时校验，不符则整单丢弃（不返回、只计数）；
    //    缺失时不拒（查询本来就是按会话 userId 发起的），但在该单上标 unverified=true，
    //    让上层知道这一条的归属没有被独立证据确认过。
    let discarded = 0;
    const orders = rawOrders
      .map((raw) => {
        const hasUserId = raw.userId != null;
        if (hasUserId && !assertOrderOwnership(raw, binding).ok) {
          discarded++;
          audit.record({
            event: "ownership_mismatch",
            result: "rejected",
            reason: "my_orders_row_mismatch",
            orderNo: raw.orderNo != null ? String(raw.orderNo) : null,
            customerIdLast4: `***${binding.customerId.slice(-4)}`,
            sessionKey: DEFAULT_SESSION_KEY,
            tool: "my_orders",
          });
          return undefined;
        }
        // ⚠️ null 显式挡在 Number() 之前：Number(null) === 0 且是 finite 的，会把"字段缺失"
        // 悄悄变成"状态 0 / 实付 ¥0.00"。企迈确实会返回 null 字段（§ 8 第 14 条实测）。
        const status = typeof raw.status === "number" ? raw.status : raw.status == null ? NaN : Number(raw.status);
        // actualAmount 单位是分 → 展示转元（两位小数）。
        const rawAmount = raw.actualAmount;
        const actualFen = typeof rawAmount === "number" ? rawAmount : rawAmount == null ? NaN : Number(rawAmount);
        const time = orderTimeText(raw);
        return {
          orderNo: raw.orderNo != null ? String(raw.orderNo) : "",
          status: Number.isFinite(status) ? status : null,
          statusText: Number.isFinite(status) ? statusText(status) : "状态未知",
          actualAmountYuan: Number.isFinite(actualFen) ? (actualFen / 100).toFixed(2) : null,
          ...(time ? { orderTime: time } : {}),
          items: itemNames(raw),
          ...(hasUserId ? {} : { unverified: true }),
        };
      })
      .filter((o): o is NonNullable<typeof o> => o !== undefined);

    // ⑤ 「已发出≠已成功」闸门的解除点（M5 前置修复第 1 项）：本次查询是一次**真实发生的**
    // 6.1.6 读回，企迈侧到底有没有那笔状态未知的单，答案就在上面这份 orders 里。
    // 只有走到这一步才销账——闸门的钥匙是一次真实读回，不是模型的一句「我核对过了」；
    // 也正因如此，不给模型开任何「手工解除」的工具。列表为空同样算核对完成（结论是「没有那一单」）。
    const resolvedPendingWrites = getWriteGuard().resolveUnresolvedWrites({
      via: "my_orders",
      checkedOrderCount: orders.length,
    });

    return ok({
      days,
      count: orders.length,
      ...(discarded > 0 ? { discardedNotOwned: discarded } : {}),
      orders,
      ...(resolvedPendingWrites > 0
        ? {
            resolvedPendingWrites,
            pendingWriteNote:
              "此前有下单请求结果未知、下单闸门被暂时关闭；本次核对已解除闸门。" +
              "请先按上面的订单列表判断那一单是否已经存在：已存在就引导顾客付款、不要重下；不存在再重新走 prepare_order。",
          }
        : {}),
      note: `只列出最近 ${days} 天、最多 ${PAGE_SIZE} 条本人订单。要看某一单的最新状态用 get_order_status。`,
    });
  } catch (e) {
    return fail(e);
  }
}
