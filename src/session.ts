// M3 会话态：会员身份绑定（内存，不持久化）。
//
// 为什么不持久化（施工令 § 3.3）：会话 = 进程生命周期，绑定态跨重启保留反而是安全隐患——
// 动态码本身 30 秒即失效，一个"绑定关系"活得比签发它的凭证还久，本身就说明这层状态不该落盘。
// stdio 单进程场景下"重开会话"就是"重启进程"，绑定态随之清零，语义上刚好对得上。
//
// 为什么按会话键 Map 存储而不是单个变量：当前 stdio 单进程 = 单会话，只用得到
// DEFAULT_SESSION_KEY 这一个键；但三期要做远程化，届时会话键会换成真实的会话 ID（比如每个
// HTTP/WebSocket 连接一个），存储结构现在就按 Map<sessionKey, binding> 预埋，三期接入时
// SessionStore 的接口不用变，只是调用方传入的 key 不再永远是同一个字符串。

import { beijingTimeString } from "./writeGuard.js";

/** stdio 单进程 = 单会话，本期唯一会话键。三期远程化后由真实会话 ID 取代。 */
export const DEFAULT_SESSION_KEY = "stdio-session";

/** 绑定所用的标识形态：手机号 / 实体卡号或会员码 / 小程序动态码。 */
export type BoundVia = "phone" | "card" | "dynamic_code";

export interface SessionBinding {
  customerId: string;
  boundAt: number;
  boundVia: BoundVia;
  /**
   * 顾客报的手机号原文——**仅 boundVia === "phone" 时存在**（另两种形态压根拿不到手机号）。
   *
   * 为什么要存它（2026-08-19 老板后台四看实测）：企迈商户后台的订单详情页有「下单人」和
   * 「预留电话」两栏，它们读的是 6.2.9 请求体里的 `mobile` / `reservePhone` 字段——**不传就是空的**
   * （M6 第一枪的单两栏皆空，第二枪补传后两栏都有值）。门店拿到一张 Agent 单却看不到顾客电话，
   * 出了问题（做错、久等、要通知取餐）就只能干等顾客自己回来，这是真实的经营缺口。
   * 顺带实测结论：后台的**搜索框按手机号搜不到**这张单——「能显示」修好了，「能检索」修不了
   * （企迈后台的索引不在我们这一侧），§8-33 已按此口径定死。
   *
   * 边界纪律（三条，改这里之前先读）：
   *   1. **纯内存**——与 customerId 同寿，随进程消亡；不落盘、不进 placed-orders.json、不进任何审计日志；
   *   2. **不出参**——bind_member 出参照旧只给尾四位，prepare_order 的待确认单里连尾号都没有；
   *   3. **唯一出口是 prepare_order 组 finalParams 时注入 mobile/reservePhone**，发给企迈的请求体
   *      带完整值（企迈会员系统本来就认识这个号，不是新增泄露面），本地一切打印/落盘只留尾号。
   */
  phone?: string;
}

/** 一个会话已经绑定过会员身份，再次尝试绑定（无论是否同一个人）都会命中这个错误。 */
export class SessionAlreadyBound extends Error {
  constructor(existing: SessionBinding) {
    const last4 = existing.customerId.slice(-4);
    // 项目纪律：一切时间戳用北京时间，不用本机时区/UTC（同 writeGuard.ts 的 beijingTimeString）。
    const boundAtStr = beijingTimeString(existing.boundAt);
    super(
      `SessionAlreadyBound：本会话已绑定会员（***${last4}，绑定于 ${boundAtStr}）。` +
        `一个会话只能绑定一位会员，要换人请重开会话。`,
    );
    this.name = "SessionAlreadyBound";
  }
}

/** 会话尚未绑定任何会员身份时，需要绑定态的操作（下单、查订单）会命中这个错误。 */
export class SessionNotBound extends Error {
  constructor() {
    super("本会话尚未绑定会员身份，请先用 bind_member 绑定");
    this.name = "SessionNotBound";
  }
}

/**
 * 会话态存储：按会话键分组的绑定关系。
 *
 * 规则：一会话一次绑定，即使是同一个人再绑也拒绝——语义最清晰，也不用为了判断"是不是同一人"
 * 再多花一次接口调用（本身也没有可靠的"是不是同一人"判据，客户端标识本来就可能对应多个会员）。
 */
export class SessionStore {
  private bindings = new Map<string, SessionBinding>();

  /** 绑定；该 key 已有绑定则抛 SessionAlreadyBound，不覆盖既有绑定。 */
  bind(sessionKey: string, binding: SessionBinding): void {
    const existing = this.bindings.get(sessionKey);
    if (existing) {
      throw new SessionAlreadyBound(existing);
    }
    this.bindings.set(sessionKey, binding);
  }

  /** 返回该会话的绑定（若有），不存在返回 undefined。不抛错，供"允许未绑定"的调用方自行判断。 */
  getBinding(sessionKey: string): SessionBinding | undefined {
    return this.bindings.get(sessionKey);
  }

  /** 要求已绑定；未绑定则抛 SessionNotBound。供下单/查单等强制要求身份的工具调用。 */
  requireBinding(sessionKey: string): SessionBinding {
    const binding = this.bindings.get(sessionKey);
    if (!binding) {
      throw new SessionNotBound();
    }
    return binding;
  }
}

// ---------- 单例（生产用） ----------
let singleton: SessionStore | null = null;

export function getSessionStore(): SessionStore {
  if (!singleton) singleton = new SessionStore();
  return singleton;
}

/**
 * 仅供测试使用：注入一个自定义 SessionStore 实例，让所有 getSessionStore() 调用方
 * 转而使用它。传 null 清除注入、恢复生产单例。沿用 writeGuard.ts 的测试注入模式，
 * 让单元测试之间互不污染会话绑定状态。
 */
export function setSessionStoreForTesting(store: SessionStore | null): void {
  singleton = store;
}
