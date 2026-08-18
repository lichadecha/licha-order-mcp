// M2 写侧护栏与幂等基础设施：确认令牌仓库、金额/频次护栏、本地幂等去重、写审计日志。
//
// 背景（施工令 § 3.1 / § 8 第 4 条）：doc168 全文已查证企迈侧无任何幂等字段——
// 「幂等」/outTradeNo/thirdOrderNo/requestId/tradeNo/clientToken 全 0 命中，uniqueId 只是商品行标识。
// 结论：重复下单只能靠本地保证，没有服务端兜底，不许假装有。
//
// M2 阶段只建这套基础设施本身（令牌签发/校验、幂等表、护栏判据、审计落盘）；
// 工具层什么时候签发令牌、什么时候校验，是 M4（prepare_order / place_order 完整逻辑）的事。
//
// 红线：本文件任何函数都不发起网络请求，只做本地判断与本地文件读写。

import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ORDER_GUARD, WRITE_WHITELIST } from "./constants.js";

// ---------- 默认路径（生产用；测试请通过构造参数注入临时路径，见 setWriteGuardForTesting） ----------
const HERE = dirname(fileURLToPath(import.meta.url));
export const WRITE_AUDIT_LOG_PATH = join(HERE, "..", "..", "logs", "write-audit.log");
export const PLACED_ORDERS_PATH = join(HERE, "..", "..", "logs", "placed-orders.json");

// ---------- 北京时间（自然日判定与审计时间戳一律用它，不用本机时区） ----------
function beijingParts(ts: number): { year: string; month: string; day: string; hour: string; minute: string; second: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ts));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  let hour = get("hour");
  if (hour === "24") hour = "00"; // 部分 ICU 实现午夜会给 "24"，纠正为 "00"
  return { year: get("year"), month: get("month"), day: get("day"), hour, minute: get("minute"), second: get("second") };
}

/** 北京时间自然日 key，如 "2026-08-17"。频次护栏与日志重建都按它分组。 */
export function beijingDateKey(ts: number = Date.now()): string {
  const p = beijingParts(ts);
  return `${p.year}-${p.month}-${p.day}`;
}

/** 人类可读北京时间字符串，写进审计日志。 */
export function beijingTimeString(ts: number = Date.now()): string {
  const p = beijingParts(ts);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} +08:00`;
}

// ---------- 内容指纹：sha256(规范化 JSON) ----------
// 规范化 = 递归按键排序，保证同一份内容无论字段书写顺序如何都得到同一个指纹。
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeysDeep((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** 对规范化后的内容做 sha256 指纹。令牌指纹与幂等键共用同一套算法（同样的下单内容 = 同一个指纹）。 */
export function fingerprint(content: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortKeysDeep(content)), "utf8").digest("hex");
}

// ---------- 脱敏：识别值（手机号等）一律只留后四位，凭证类字段名直接摘除 ----------
// 覆盖三种书写形态：纯 11 位（1开头）、86 前缀（不带+）、+86 前缀、0086 前缀。
// 总工验收裁决顺手扩展项：国家码形态一并纳入，不必再扩大到其他识别值类型。
export const PHONE_RE = /^(?:\+?86|0086)?1\d{10}$/;
// 凭证类字段名：命中即整字段丢弃，不管值是什么（比 grep 关键字更早一步，防止任何形式的凭证落盘）。
const CREDENTIAL_KEY_RE = /openkey|opentoken|grantcode|openid|password|secret/i;

// 手机号「嵌入式」正则：maskValue 用它在任意字符串值内部就地替换嵌入的手机号——不要求整个
// 字符串恰好就是手机号。总工验收裁决（M3 B7 修复）：企迈接口的 message 字段可能把手机号嵌在
// 一句话里（如"手机号13800001234不存在"），PHONE_RE 的整串匹配（^...$）接不住这种情形，会
// 导致完整号码经由 reason 一类字段落进审计日志。
//
// 负向断言 (?<!\d) / (?!\d) 是防误伤的关键：像订单号 D00281924556183175168 这种长数字串，
// 中段可能偶然长得像一个 11 位手机号，但它的前后仍然是数字——负向断言据此把这类"被更长数字
// 串包裹的子串"排除在外，只有号码前后确实不是数字（汉字、标点、字符串首尾）时才判定为真实
// 嵌入号码。第二位限定 [3-9] 额外贴合真实手机号段（13x-19x），减少误判面。
//
// 对纯 11 位 / 86 前缀 / +86 前缀 / 0086 前缀这几种整串形态，本正则的匹配行为与 PHONE_RE
// 一致（是其超集），不引入行为倒退；PHONE_RE 本身保留不动，client.ts 的 summarizeWriteParams
// 仍用它做整串检测，两处判据不必也不应该合并成一个。
const PHONE_EMBED_RE = /(?<!\d)(?:\+?86|0086)?1[3-9]\d{9}(?!\d)/g;

function maskValue(v: unknown): unknown {
  if (typeof v !== "string") return v;
  return v.replace(PHONE_EMBED_RE, (m) => `***${m.slice(-4)}`);
}

// export：M3 的 accessAudit.ts 复用同一份脱敏实现，不许复制粘贴第二份（见该文件头部注释）。
export function maskDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (CREDENTIAL_KEY_RE.test(k)) continue; // 凭证字段名：整条丢弃
      out[k] = maskDeep(v);
    }
    return out;
  }
  return maskValue(value);
}

// ---------- 确认令牌 ----------
interface TokenRecord {
  tokenId: string;
  fp: string;
  issuedAt: number;
  used: boolean;
}

export type TokenVerifyFailure = "TokenNotFound" | "TokenExpired" | "TokenAlreadyUsed" | "TokenFingerprintMismatch";

export type TokenVerifyResult = { ok: true; record: TokenRecord } | { ok: false; reason: TokenVerifyFailure };

// ---------- 写审计条目 ----------
export interface WriteAuditSummary {
  storeId?: unknown;
  itemCount?: number;
  totalQuantity?: number;
  estimatedAmountFen?: number;
  [k: string]: unknown;
}

export interface WriteAuditEntry {
  path: string;
  result: "allowed" | "rejected";
  reason?: string;
  tokenId?: string | null;
  idempotencyKey?: string | null;
  summary?: WriteAuditSummary;
  orderNo?: string | null;
  code?: number | string | null;
  durationMs: number;
}

interface WriteGuardOptions {
  clock?: () => number;
  auditLogPath?: string;
  placedOrdersPath?: string;
}

export class WriteGuard {
  private tokens = new Map<string, TokenRecord>();
  private placedOrders = new Map<string, { orderNo: string; at: number }>();
  private dailyCounts = new Map<string, number>(); // beijingDateKey -> 当日已放行写调用数
  private readonly clock: () => number;
  private readonly auditLogPath: string;
  private readonly placedOrdersPath: string;

  constructor(opts?: WriteGuardOptions) {
    this.clock = opts?.clock ?? Date.now;
    this.auditLogPath = opts?.auditLogPath ?? WRITE_AUDIT_LOG_PATH;
    this.placedOrdersPath = opts?.placedOrdersPath ?? PLACED_ORDERS_PATH;
    this.loadPlacedOrders();
    // T9 关键：当日计数不能只放内存——启动时（含"进程重启"这个场景）必须从写审计日志重建，
    // 否则重启一次就能把频次护栏清零绕过。
    this.rebuildDailyCountsFromAudit();
  }

  // ---------- 确认令牌：签发 / 校验 / 消耗 ----------

  /** 签发一次性确认令牌：随机 ID + 单内容 sha256 指纹 + 签发时间戳。M4 由 prepare_order 调用。 */
  issueConfirmToken(content: unknown): { tokenId: string; issuedAt: number } {
    this.pruneExpiredTokens(); // 顺手做惰性清理，见 pruneExpiredTokens 注释
    const tokenId = randomBytes(16).toString("hex");
    const issuedAt = this.clock();
    this.tokens.set(tokenId, { tokenId, fp: fingerprint(content), issuedAt, used: false });
    return { tokenId, issuedAt };
  }

  /**
   * 惰性清理：已过期或已用过的令牌记录不再可能通过 verifyToken，留在内存里没有意义。
   * 不用定时器，改在每次签发新令牌时顺手扫一遍——量级小（单日 ≤5 单）时这几乎零成本，
   * 且避免了"要不要另起一个定时器/要不要在进程退出时清理它"这类多余的生命周期管理问题。
   * 只清"已过期"的（不管有没有用过——过期后无论如何都通不过校验了），
   * 保留"未过期但已用过"的记录不清，是为了让 TTL 窗口内的重放仍然能被 TokenAlreadyUsed
   * 明确报出来，而不是退化成看起来更模糊的 TokenNotFound。
   */
  private pruneExpiredTokens(): void {
    const now = this.clock();
    for (const [id, rec] of this.tokens) {
      if (now - rec.issuedAt > ORDER_GUARD.confirmTokenTtlMs) {
        this.tokens.delete(id);
      }
    }
  }

  /**
   * 四项校验，任一不过即拒：存在 → 未过期 → 未被用过 → 指纹与本次入参一致。
   * 顺序刻意把"与内容无关"的检查（存在/过期/已用）放在"与内容相关"的指纹比对之前，
   * 这样"重放同一个已用令牌"命中的是 TokenAlreadyUsed，"拿别的内容套用一个未用令牌"命中的才是
   * TokenFingerprintMismatch——两种失败模式在审计里能被明确区分，不会被彼此掩盖。
   * 校验通过不在这里消耗令牌，消耗动作交给 consumeToken（用后即焚：调用方应在真正发出请求前调用）。
   */
  verifyToken(tokenId: string, content: unknown): TokenVerifyResult {
    const rec = this.tokens.get(tokenId);
    if (!rec) return { ok: false, reason: "TokenNotFound" };
    if (this.clock() - rec.issuedAt > ORDER_GUARD.confirmTokenTtlMs) return { ok: false, reason: "TokenExpired" };
    if (rec.used) return { ok: false, reason: "TokenAlreadyUsed" };
    if (rec.fp !== fingerprint(content)) return { ok: false, reason: "TokenFingerprintMismatch" };
    return { ok: true, record: rec };
  }

  /** 用后即焚：标记令牌已使用。即便后续真实请求失败，同一令牌也不可再用（要重试须重新走确认流程）。 */
  consumeToken(record: TokenRecord): void {
    record.used = true;
  }

  // ---------- 幂等 ----------

  /**
   * 幂等键命中过往已下单记录 → true。
   * 幂等键由调用方（client.ts 的 callWrite）用 fingerprint({ params, tokenId }) 算出——
   * 不是单纯 fingerprint(params)。这里不重复定义算法，只负责查表，
   * 具体理由见 client.ts callWrite 里 idempotencyKey 那段注释（总工验收裁决 M2 追加修复）。
   */
  isDuplicate(key: string): boolean {
    return this.placedOrders.has(key);
  }

  /** 记录一次成功下单，供后续同内容重复请求命中幂等拒绝。持久化到 placed-orders.json。 */
  recordPlacedOrder(key: string, orderNo: string): void {
    this.placedOrders.set(key, { orderNo, at: this.clock() });
    this.persistPlacedOrders();
  }

  // ---------- 频次（北京时间自然日） ----------

  checkDailyLimit(): { ok: true } | { ok: false; reason: string } {
    const key = beijingDateKey(this.clock());
    const count = this.dailyCounts.get(key) ?? 0;
    if (count >= ORDER_GUARD.maxOrdersPerDay) {
      return { ok: false, reason: `DailyLimitExceeded:${count}/${ORDER_GUARD.maxOrdersPerDay}` };
    }
    return { ok: true };
  }

  incrementDailyCount(): void {
    const key = beijingDateKey(this.clock());
    this.dailyCounts.set(key, (this.dailyCounts.get(key) ?? 0) + 1);
  }

  // ---------- 金额 ----------

  checkAmount(amountFen: number): { ok: true } | { ok: false; reason: string } {
    if (!Number.isFinite(amountFen) || amountFen <= 0) {
      return { ok: false, reason: `InvalidAmount:${amountFen}` };
    }
    if (amountFen > ORDER_GUARD.maxAmountFen) {
      return { ok: false, reason: `AmountExceeded:${amountFen}>${ORDER_GUARD.maxAmountFen}` };
    }
    return { ok: true };
  }

  // ---------- 审计落盘 ----------

  /**
   * 写一条审计记录（JSON Lines，一行一条）。凭证字段名整条摘除、识别值只留后四位、
   * 摘要字段本身就是白名单式（storeId/itemCount/totalQuantity/estimatedAmountFen），
   * 不接受调用方把完整 params 塞进 summary。
   */
  recordAudit(entry: WriteAuditEntry): void {
    const now = this.clock();
    const line = {
      time: beijingTimeString(now),
      dateKey: beijingDateKey(now),
      path: entry.path,
      result: entry.result,
      reason: entry.reason ?? null,
      tokenId: entry.tokenId ?? null,
      idempotencyKey: entry.idempotencyKey ?? null,
      summary: entry.summary ? maskDeep(entry.summary) : undefined,
      orderNo: entry.orderNo ?? null,
      code: entry.code ?? null,
      durationMs: entry.durationMs,
    };
    try {
      mkdirSync(dirname(this.auditLogPath), { recursive: true });
      appendFileSync(this.auditLogPath, `${JSON.stringify(line)}\n`);
    } catch {
      // 审计写入失败不阻塞主链路判定（拒绝/放行的决定已经在 recordAudit 调用之前做出）。
    }
  }

  // ---------- 持久化：placed-orders.json ----------

  private loadPlacedOrders(): void {
    try {
      if (!existsSync(this.placedOrdersPath)) return;
      const raw = JSON.parse(readFileSync(this.placedOrdersPath, "utf8")) as Record<
        string,
        { orderNo: string; at: number }
      >;
      for (const [k, v] of Object.entries(raw)) this.placedOrders.set(k, v);
    } catch {
      // 文件不存在或损坏：视为空记录，不阻塞启动（频次护栏靠审计日志重建，幂等靠这份文件——
      // 两者是独立的两道防线，其中一道文件损坏不代表全部失守）。
    }
  }

  private persistPlacedOrders(): void {
    try {
      mkdirSync(dirname(this.placedOrdersPath), { recursive: true });
      const obj: Record<string, { orderNo: string; at: number }> = {};
      for (const [k, v] of this.placedOrders) obj[k] = v;
      writeFileSync(this.placedOrdersPath, JSON.stringify(obj, null, 2));
    } catch {
      // 同上：不阻塞主链路。
    }
  }

  // ---------- 重启后重建当日计数（T9） ----------

  private rebuildDailyCountsFromAudit(): void {
    try {
      if (!existsSync(this.auditLogPath)) return;
      const text = readFileSync(this.auditLogPath, "utf8");
      for (const raw of text.split("\n")) {
        const line = raw.trim();
        if (!line) continue;
        let obj: { dateKey?: string; time?: string; path?: string; result?: string };
        try {
          obj = JSON.parse(line);
        } catch {
          continue; // 单行损坏不影响其余行的重建
        }
        if (obj.result !== "allowed") continue;
        if (typeof obj.path !== "string" || !WRITE_WHITELIST.includes(obj.path)) continue;
        const key = obj.dateKey ?? (obj.time ? beijingDateKey(Date.parse(obj.time)) : undefined);
        if (!key) continue;
        this.dailyCounts.set(key, (this.dailyCounts.get(key) ?? 0) + 1);
      }
    } catch {
      // 审计日志本身读不到：新装机场景（文件不存在已在 existsSync 短路），
      // 真正的"文件存在但读取中途出错"极少见，此处保守地不让异常阻塞构造函数。
    }
  }
}

// ---------- 单例（生产用） ----------
let singleton: WriteGuard | null = null;

export function getWriteGuard(): WriteGuard {
  if (!singleton) singleton = new WriteGuard();
  return singleton;
}

/**
 * 仅供测试使用：注入一个自定义 WriteGuard 实例（通常指向临时目录的审计/幂等文件路径），
 * 让 callWrite 内部的 getWriteGuard() 转而返回它。传 null 清除注入、恢复生产单例。
 * 这样单元测试之间互不污染，也不会把测试数据写进真实的 logs/ 目录。
 */
export function setWriteGuardForTesting(guard: WriteGuard | null): void {
  singleton = guard;
}
