// M3 身份与访问控制审计（JSON Lines）。
//
// 与 write-audit.log 分开落盘的理由：那个文件的语义是「写通道事件」，是 M2 零写自证的证据
// 载体；本文件记的是「读侧身份/访问控制事件」（绑定成功/失败、未绑定调用被拒、所有权不符），
// 两类事件的证据链用途不同，混在一起会让审计文件的语义变得模糊，所以物理分开。
//
// 脱敏：调用方传入时字段本身就该是 Last4 形态（codeLast4/customerIdLast4），落盘前再用
// writeGuard 导出的 maskDeep 兜底扫一遍——不在这里复制第二份脱敏实现，两处日后改动才不会一处
// 改一处漏。
//
// 写入失败不抛错不阻塞主链路（同 writeGuard.recordAudit 的容错注释风格）：审计是留痕手段，
// 不应该成为主流程的单点故障。

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { beijingDateKey, beijingTimeString, sanitizeAuditRecord } from "./writeGuard.js";
import { logFilePath } from "./logPaths.js";

// ---------- 默认路径（生产用；测试请通过构造参数注入临时路径，见 setAccessAuditLoggerForTesting） ----------
// 与另外两本日志同源解析（§ 8 第 24 条修复）：LICHA_LOG_DIR 优先，缺省锚定 package.json 目录下的 logs/。
// 工单只点了 client.ts 与 writeGuard.ts 两处，本文件是同一个写法的第三处——只修两处会让
// access-audit.log 继续按老规则漂，等于把同一个坑留在原地，所以一并改。
export function accessAuditLogPath(): string {
  return logFilePath("access-audit.log");
}

export type AccessAuditEvent =
  | "bind_success"
  | "bind_rejected"
  | "unbound_call_rejected"
  | "ownership_mismatch"
  // M4 新增：prepare_order 签发一次性确认令牌。记的是"这张单被确认过"这个访问控制事实
  // （谁、什么时候、多少钱、几行商品），不记商品明细——审计要能回答"有没有凭空冒出来的确认"，
  // 不需要回答"顾客点了什么"，后者属于订单数据，不该在审计日志里留副本。
  | "token_issued";

export interface AccessAuditEntry {
  event: AccessAuditEvent;
  result: "allowed" | "rejected";
  reason?: string | null;
  /** 绑定用标识（手机号/卡号/动态码）的后四位，形如 "***1234"；调用方只传后四位形态。 */
  codeLast4?: string | null;
  /** 会员 customerId 的后四位，形如 "***6789"。 */
  customerIdLast4?: string | null;
  orderNo?: string | null;
  sessionKey?: string | null;
  tool?: string | null;
  /** M4：确认令牌 ID（token_issued 事件用）。令牌 ID 本身是随机串，不是识别值。 */
  tokenId?: string | null;
  /** M4：本地预估金额，单位「分」（整数）。金额一律用分记，与写审计 summary 的口径一致。 */
  estimatedAmountFen?: number | null;
  /** M4：待确认单的商品行数（不记商品名与规格）。 */
  itemCount?: number | null;
}

interface AccessAuditLoggerOptions {
  logPath?: string;
  clock?: () => number;
}

/**
 * 防御性归一化（超出 writeGuard.maskDeep 覆盖范围的额外兜底）：不管调用方传入的是已经是
 * "***后四位" 形态，还是不小心传了完整值（完整手机号、完整 customerId），这里统一强制
 * 重新取"最后 4 个字符"并盖上 ***。之所以在 maskDeep 之外单独再做一层：maskDeep 只认
 * PHONE_RE 形态的手机号和凭证类字段名，customerId 这种纯数字长 ID 并不匹配 PHONE_RE，
 * 一旦调用方疏漏传了完整 customerId，maskDeep 兜不住——而红线 #4（识别值脱敏）优先级
 * 最高，宁可对本就合规的 "***XXXX" 输入做一次幂等的重新加工，也不接受任何漏网可能。
 */
function forceLast4(v?: string | null): string | null {
  if (v == null) return null;
  const bare = v.replace(/^\*+/, ""); // 去掉可能已有的 *** 前缀，取纯粹的值部分
  if (bare.length <= 4) return `***${bare}`;
  return `***${bare.slice(-4)}`;
}

export class AccessAuditLogger {
  private readonly logPath: string;
  private readonly clock: () => number;

  constructor(opts?: AccessAuditLoggerOptions) {
    this.logPath = opts?.logPath ?? accessAuditLogPath();
    this.clock = opts?.clock ?? Date.now;
  }

  record(entry: AccessAuditEntry): void {
    const now = this.clock();
    const line = {
      time: beijingTimeString(now),
      dateKey: beijingDateKey(now),
      event: entry.event,
      result: entry.result,
      reason: entry.reason ?? null,
      codeLast4: forceLast4(entry.codeLast4),
      customerIdLast4: forceLast4(entry.customerIdLast4),
      orderNo: entry.orderNo ?? null,
      sessionKey: entry.sessionKey ?? null,
      tool: entry.tool ?? null,
      tokenId: entry.tokenId ?? null,
      estimatedAmountFen: entry.estimatedAmountFen ?? null,
      itemCount: entry.itemCount ?? null,
    };
    try {
      mkdirSync(dirname(this.logPath), { recursive: true });
      // 统一出口脱敏兜底：调用方理应已经只传 Last4 形态，这里再扫一遍防止任何疏漏把完整识别值
      // 或凭证字段带进日志——同一份实现来自 writeGuard.ts，不在这里复制第二份。
      // 从 maskDeep 升级为 sanitizeAuditRecord（§ 8 第 25 条）：会员 ID/动态码/40+ 位长串
      // 在普通字段里能穿透 maskDeep，数字类型的手机号也穿透，改成默认全脱敏 + 白名单例外。
      appendFileSync(this.logPath, `${JSON.stringify(sanitizeAuditRecord(line))}\n`);
    } catch {
      // 写入失败不阻塞主链路：拒绝/放行的决定已经在 record 调用之前做出。
    }
  }
}

// ---------- 单例（生产用） ----------
let singleton: AccessAuditLogger | null = null;

export function getAccessAuditLogger(): AccessAuditLogger {
  if (!singleton) singleton = new AccessAuditLogger();
  return singleton;
}

/**
 * 仅供测试使用：注入一个自定义 AccessAuditLogger 实例（通常指向临时目录的日志路径），
 * 让所有 getAccessAuditLogger() 调用方转而使用它。传 null 清除注入、恢复生产单例。
 * 沿用 writeGuard.ts 的测试注入模式，避免测试污染生产 logs/ 目录。
 */
export function setAccessAuditLoggerForTesting(logger: AccessAuditLogger | null): void {
  singleton = logger;
}
