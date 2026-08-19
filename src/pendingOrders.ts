// M4 待确认单登记表：prepare_order 签发确认令牌时，把「这张令牌对应的那份最终下单参数」
// 与「本地预估金额（分）」按 tokenId 登记进来；place_order 凭令牌把它取回去下单。
//
// 为什么需要这张表（施工令 § 3.2 两阶段提交 + M4 节的硬约束）：
// M2 的 place_order 让调用方把完整 orderParams 透传进来，M4 定稿要求把入参收窄成
// 「令牌 + 复述金额」两个字段——那么下单参数就必须有另一个来源。这张表就是那个来源：
// 参数由 prepare_order 组装并登记，模型手里只有一个不透明的令牌 ID，物理上没有任何途径
// 修改这份参数。「下的单 = 给顾客看过的那张单」这条承诺，在这里从"靠指纹校验发现篡改"
// 升级成"根本没有可篡改的入口"。
//
// 与 WriteGuard 令牌仓库的关系：那边存的是指纹（sha256），用来校验；这边存的是原文，用来取回。
// 两者刻意不合并——WriteGuard 是 M2 的护栏地基（callWrite 的四项校验依赖它），保持它只认指纹、
// 不持有业务参数原文，callWrite 的判据就仍然是「调用方递进来的 params 与令牌指纹是否一致」这条
// 与本表无关的独立判据。place_order 从本表取出参数后仍要过 callWrite 的指纹校验，两道锁是串联的：
// 本表保证参数没有外部入口，指纹保证取出来的参数与签发时一字不差。
//
// TTL 与令牌同寿（ORDER_GUARD.confirmTokenTtlMs，5 分钟）：登记条目活得比令牌久没有意义
// （令牌过期后怎么都下不了单），活得比令牌短会造成"令牌有效但取不到单"的语义空洞。
//
// 红线：本文件不发起任何网络请求，只做内存读写。

import { ORDER_GUARD } from "./constants.js";

/** 一张待确认单：最终下单参数原文 + 本地预估金额（分）+ 登记时间。 */
export interface PendingOrder {
  /** 6.2.9 的完整下单参数（含由会话态注入的 userId），prepare_order 组装的唯一一份。 */
  finalParams: Record<string, unknown>;
  /** 本地预估总额，单位「分」（整数）。金额护栏与复述金额比对都用它。 */
  estimatedAmountFen: number;
  /**
   * 登记（= 令牌签发）时刻的毫秒时间戳，用于 TTL 判定。
   * ⚠️ 由 register() 用本存储自己的时钟填充，调用方不传——时间基准必须与做 TTL 判定的那个
   * 时钟同源。曾经让调用方传 Date.now()，在注入了可控时钟的测试里立刻表现为"刚登记就过期"
   * （两个时钟不同源），而且会让"过期拒绝"的用例假阳性通过。
   */
  issuedAt: number;
}

/** 登记入参：不含 issuedAt——它由存储自己的时钟盖章，见 PendingOrder.issuedAt 的说明。 */
export type PendingOrderInput = Omit<PendingOrder, "issuedAt">;

interface PendingOrderStoreOptions {
  clock?: () => number;
}

export class PendingOrderStore {
  private entries = new Map<string, PendingOrder>();
  private readonly clock: () => number;

  constructor(opts?: PendingOrderStoreOptions) {
    this.clock = opts?.clock ?? Date.now;
  }

  /**
   * 登记一张待确认单。顺手惰性清理已过期条目——沿用 WriteGuard.pruneExpiredTokens 的思路：
   * 不起定时器（省掉一整套生命周期管理），在"反正要写这张表"的时刻顺手扫一遍即可，
   * 单日 ≤5 单的量级下这几乎零成本。
   */
  register(tokenId: string, order: PendingOrderInput): void {
    this.pruneExpired();
    this.entries.set(tokenId, { ...order, issuedAt: this.clock() });
  }

  /**
   * 按令牌查待确认单，返回三态：命中 / 已过期 / 查无此单。
   *
   * 为什么要把"已过期"和"查无此单"分开报，而不是一律返回 undefined：这两种情况对顾客虽然是
   * 同一句话（这张单不能下了，请重新组单），但对审计不是——"令牌过了 5 分钟"和"令牌根本不存在
   * （编造的、或来自别的进程）"是两种不同性质的事件，混成一个理由会让写审计失去分辨力。
   * M2 的令牌校验刻意把四种失败模式分开报，就是这个道理，这里不该把它糊回去。
   *
   * 刻意不是 take/pop 语义（取出即删）：令牌"用后即焚"由 WriteGuard.consumeToken 负责、
   * 判据也由它给出（TokenAlreadyUsed）。如果这里取出就删，同一令牌第二次下单命中的会是
   * 「查无此单」这个含糊理由，把真正的原因（令牌已被用过）盖住。
   *
   * 过期条目在这里也不删除——清理统一由 pruneExpired 负责（register 时顺手触发），
   * 这样"过期"这个状态在被清理之前是稳定可报的，拒绝理由不会因为查询次数而变化。
   */
  lookup(tokenId: string): { status: "ok"; order: PendingOrder } | { status: "expired" } | { status: "absent" } {
    const entry = this.entries.get(tokenId);
    if (!entry) return { status: "absent" };
    if (this.isExpired(entry)) return { status: "expired" };
    return { status: "ok", order: entry };
  }

  /** 当前登记条目数。供测试断言"过期条目确实被物理清除"（V12），生产侧不依赖它做判断。 */
  size(): number {
    return this.entries.size;
  }

  /** 物理清除全部已过期条目。register 时自动调用；也可由测试直接触发。 */
  /**
   * 作废某个会员名下的全部待确认单，返回作废条数。
   *
   * 什么时候用：会话换绑到另一位会员时（2026-08-19 老板拍板「换人就解绑」）。
   *
   * 为什么必须做，即便 place_order 已经挡得住：定稿 handler 的第 ⑤ 步会比对「登记单的 userId
   * 是否等于当前会话绑定值」，换绑后旧令牌本来就下不了单。但**留着它是脏状态**——
   * 万一又换回原来那位会员，那张早已被顾客忘掉的待确认单就"复活"了，5 分钟 TTL 内它还能下单。
   * 「顾客确认过的单」和「顾客几分钟前确认、中间换了两个人、现在突然生效的单」不是一回事。
   * 换人即作废，语义干净。
   */
  discardByUserId(userId: string): number {
    let discarded = 0;
    for (const [tokenId, order] of this.entries) {
      if (String(order.finalParams.userId ?? "") === userId) {
        this.entries.delete(tokenId);
        discarded++;
      }
    }
    return discarded;
  }

  pruneExpired(): void {
    for (const [id, entry] of this.entries) {
      if (this.isExpired(entry)) this.entries.delete(id);
    }
  }

  private isExpired(entry: PendingOrder): boolean {
    return this.clock() - entry.issuedAt > ORDER_GUARD.confirmTokenTtlMs;
  }
}

// ---------- 单例（生产用） ----------
let singleton: PendingOrderStore | null = null;

export function getPendingOrderStore(): PendingOrderStore {
  if (!singleton) singleton = new PendingOrderStore();
  return singleton;
}

/**
 * 仅供测试使用：注入自定义 PendingOrderStore（通常带可控时钟，用来推进 TTL 而不真的等 5 分钟）。
 * 传 null 清除注入、恢复生产单例。沿用 writeGuard.ts / session.ts 的测试注入模式。
 */
export function setPendingOrderStoreForTesting(store: PendingOrderStore | null): void {
  singleton = store;
}
