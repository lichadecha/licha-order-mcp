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
import { assertOrderOwnership, SETTLED_STATUSES, statusText } from "./orderStatusTool.js";
import { beijingTimeString, customerCountKey, getWriteGuard, type OrderEvidenceRow } from "./writeGuard.js";
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
function orderTimeMs(raw: RawOrder): number | undefined {
  const v = raw.orderAt ?? raw.createTime;
  if (v == null) return undefined;
  const ms = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return ms;
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
    const windowStartMs = now - days * DAY_MS;
    const resp = await callRead<Record<string, unknown>>("v3/order/userAppointTimeOrderList", {
      orderAtStart: windowStartMs, // 13 位毫秒时间戳
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
    const dataIsArray = Array.isArray(container?.data);
    const rawOrders = dataIsArray ? (container!.data as RawOrder[]) : [];
    // total = 命中总数。它大于本页返回条数就说明还有别的页——「没查到那一单」这个结论
    // 在分页不全时不成立（审计反例 page1_is_partial）。缺失/非数字一律按不可信处理。
    const rawTotal = container?.total;
    const total = typeof rawTotal === "number" ? rawTotal : rawTotal == null ? NaN : Number(rawTotal);

    // ④ 逐单所有权兜底：响应含 userId 时校验，不符则整单丢弃（不返回、只计数）；
    //    缺失时不拒（查询本来就是按会话 userId 发起的），但在该单上标 unverified=true，
    //    让上层知道这一条的归属没有被独立证据确认过。
    let discarded = 0;
    // G1 证据行：只收通过所有权校验的本人订单，带上下单时间（关联未决请求的唯一线索）。
    const evidenceRows: OrderEvidenceRow[] = [];
    const orders = rawOrders
      .map((raw) => {
        const hasUserId = raw.userId != null;
        if (hasUserId && !assertOrderOwnership(raw, binding).ok) {
          discarded++;
          audit.record({
            event: "ownership_mismatch",
            result: "rejected",
            reason: "my_orders_row_mismatch",
            // 来源判定（P-W2 第三轮微补丁）：orderNo 取自 6.1.6 响应行本身（服务端来源，
            // 调用方无从构造），与 place_order 读回那处同性质 → 留全值。
            // 这条审计要回答"企迈把谁的单混进了我的列表"，单号是唯一抓手。
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
        const orderAtMs = orderTimeMs(raw);
        const orderNoText = raw.orderNo != null ? String(raw.orderNo) : "";
        if (orderNoText) {
          evidenceRows.push({
            orderNo: orderNoText,
            ...(orderAtMs != null ? { orderAtMs } : {}),
            ...(Number.isFinite(status) ? { status } : {}),
          });
        }
        return {
          orderNo: orderNoText,
          status: Number.isFinite(status) ? status : null,
          statusText: Number.isFinite(status) ? statusText(status) : "状态未知",
          actualAmountYuan: Number.isFinite(actualFen) ? (actualFen / 100).toFixed(2) : null,
          ...(orderAtMs != null ? { orderTime: beijingTimeString(orderAtMs) } : {}),
          items: itemNames(raw),
          ...(hasUserId ? {} : { unverified: true }),
        };
      })
      .filter((o): o is NonNullable<typeof o> => o !== undefined);

    // ⑤ 「已发出≠已成功」闸门的解除点（M5 前置修复第 1 项，G1 改为按证据逐笔核对）：
    // 本次查询是一次**真实发生的** 6.1.6 读回——闸门的钥匙是真实读回，不是模型的一句
    // 「我核对过了」，也正因如此不给模型开任何「手工解除」的工具。
    //
    // 但一次真实读回不等于一次成立的核对（盲审 B01）：这份列表能不能给某一笔未决下结论，
    // 取决于「查的是不是同一个人」「时间窗有没有覆盖那一笔」「列表是不是完整的」。
    // 判据全部交给 guard，这里只负责如实汇报证据的成色——
    // complete 三条缺一不可：data 真的是数组、没有他人订单混入（混入说明这次响应不可信）、
    // total 不大于本页条数（否则还有别的页没看）。
    const evidenceComplete = dataIsArray && discarded === 0 && Number.isFinite(total) && total <= rawOrders.length;
    const outcome = getWriteGuard().resolveUnresolvedWrites({
      via: "my_orders",
      customerKey: customerCountKey(binding.customerId),
      orders: evidenceRows,
      window: { startMs: windowStartMs, endMs: now },
      complete: evidenceComplete,
    });

    const foundEntries = outcome.released.filter((r) => r.verdict === "order_found");
    const absentCount = outcome.released.length - foundEntries.length;
    const notes: string[] = [];
    if (foundEntries.length > 0) {
      // 命中单已经是终态（已完成 / 已取消 / 已关闭）时不许说「去付款」——那是审计里
      // 「对一张三天前的已完成旧单也建议直接付款」的同一个错（21 号 P0-1 发现 B）。
      const payable = foundEntries.filter((r) => r.matchedStatus == null || !SETTLED_STATUSES.has(r.matchedStatus));
      const settled = foundEntries.length - payable.length;
      notes.push(
        `核对结果：此前 ${foundEntries.length} 笔结果未知的下单请求，在企迈侧确实建了单（` +
          foundEntries.map((r) => r.matchedOrderNo ?? "?").join("、") +
          "）。**不要重下**。" +
          (payable.length > 0 ? "请引导顾客去小程序「我的订单」付款。" : "") +
          (settled > 0 ? `其中 ${settled} 笔对应的订单已是已完成／已取消／已关闭状态，无需再付款。` : ""),
      );
    }
    if (absentCount > 0) {
      notes.push(
        `核对结果：此前 ${absentCount} 笔结果未知的下单请求，在这段时间窗内没有对应订单——` +
          "企迈侧没有建单，可以重新走 prepare_order 组单。",
      );
    }
    if (outcome.kept > 0) {
      // 保留未知 = 闸门仍然关着。必须说清「还差什么证据」，否则模型只会反复调同一个工具。
      notes.push(
        `仍有 ${outcome.kept} 笔下单请求无法核对，下单闸门继续关着。` +
          "可能的原因：那一笔属于本会话之前绑定的另一位顾客（请先绑回那个人再查）、" +
          "或它发生在本次查询的时间窗之外（用更大的 days 再查一次）、" +
          "或本次响应不完整（列表里混进了别人的单、或还有下一页）、" +
          "或它刚发出不久——订单可能还在企迈侧落库，过 10 分钟再查一次这段时间窗才能下结论。" +
          "在此期间请如实告诉顾客「那一单还没核对清楚，先别重下」，不要替他猜结果。",
      );
    }

    return ok({
      days,
      count: orders.length,
      ...(discarded > 0 ? { discardedNotOwned: discarded } : {}),
      orders,
      ...(outcome.released.length > 0 ? { resolvedPendingWrites: outcome.released.length } : {}),
      ...(outcome.kept > 0 ? { unresolvedPendingWrites: outcome.kept } : {}),
      ...(notes.length > 0 ? { pendingWriteNote: notes.join("\n") } : {}),
      note: `只列出最近 ${days} 天、最多 ${PAGE_SIZE} 条本人订单。要看某一单的最新状态用 get_order_status。`,
    });
  } catch (e) {
    return fail(e);
  }
}
