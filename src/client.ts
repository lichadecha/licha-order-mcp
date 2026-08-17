// fetch + 白名单 + 节流 + 重试 + 大数保护 + 审计日志

import { randomInt } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_URL, READONLY_WHITELIST, WRITE_WHITELIST } from "./constants.js";
import { loadCredentials, sign, type Credentials } from "./auth.js";
import { fingerprint, getWriteGuard, PHONE_RE, type WriteAuditSummary } from "./writeGuard.js";

export class ReadOnlyViolation extends Error {
  constructor(path: string) {
    super(`ReadOnlyViolation: 路径不在只读白名单：${path}`);
    this.name = "ReadOnlyViolation";
  }
}

// ---------- 二期写通道错误类（与 ReadOnlyViolation 并列） ----------

export class WriteNotAllowed extends Error {
  constructor(path: string) {
    super(`WriteNotAllowed: 路径不在写白名单：${path}`);
    this.name = "WriteNotAllowed";
  }
}

export class WriteGuardRejected extends Error {
  constructor(reason: string) {
    super(`WriteGuardRejected: ${reason}`);
    this.name = "WriteGuardRejected";
  }
}

export interface ApiError {
  code: number | string;
  message: string;
  hint: string;
}

export interface ApiResult<T = unknown> {
  ok: boolean;
  code?: number;
  message?: string;
  data?: T;
  error?: ApiError;
}

// ---------- 大数黄金规则 ----------
// ID 长 19 位超 float64 精度：响应文本在 JSON.parse 前把长数字 ID 字符串化；
// 发送前再把字符串 ID 还原为 JSON 数字（v6 实测数字形式服务端可正确处理）。
// 代码内所有 ID 全程 string。
const ID_NUM_RE = /"(\w*[iI]d)"\s*:\s*(\d{15,})/g;
const ID_STR_RE = /"(\w*[iI]d)"\s*:\s*"(\d{15,})"/g;

export function protectIds(text: string): string {
  return text.replace(ID_NUM_RE, '"$1":"$2"');
}

export function restoreIdsForSend(text: string): string {
  return text.replace(ID_STR_RE, '"$1":$2');
}

// ---------- 审计日志（只记 path/时间/成败，不记参数值与凭证） ----------
const AUDIT_LOG = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "logs", "audit.log");

function audit(path: string, ok: boolean, ms: number): void {
  try {
    mkdirSync(dirname(AUDIT_LOG), { recursive: true });
    appendFileSync(AUDIT_LOG, `${new Date().toISOString()}\t${path}\t${ok ? "ok" : "fail"}\t${ms}ms\n`);
  } catch {
    // 日志失败不阻塞主链路
  }
}

// ---------- 节流：最小间隔 210ms ≈ 5 req/s（平台上限 10 QPS，留半） ----------
let lastCallAt = 0;

async function throttle(): Promise<void> {
  const wait = 210 - (Date.now() - lastCallAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

function backoff(attempt: number): Promise<void> {
  const ms = [1000, 2000, 4000][attempt] ?? 4000;
  return new Promise((r) => setTimeout(r, ms));
}

function humanHint(code: unknown): string {
  switch (code) {
    case 110004:
      return "验签失败，检查凭证配置";
    case 100002:
      return "参数格式不对";
    case 100007:
      return "搜索词为空或不支持";
    default:
      return "接口暂时异常，换个问法试试";
  }
}

let creds: Credentials | null = null;

function getCreds(): Credentials {
  if (!creds) creds = loadCredentials();
  return creds;
}

// 只读出口：白名单校验 → 签名 → 发送（大数还原）→ 重试 → 解析（大数保护）
// 二期改造：原 call() 原样改名为 callRead()，逻辑与 READONLY_WHITELIST 一字未动——
// 这是一期「零写自证」证据链不被推翻的前提。文末 `export const call = callRead` 保留别名，
// 四个一期工具文件的 import 一行都不用改。
export async function callRead<T = unknown>(path: string, params: Record<string, unknown>): Promise<ApiResult<T>> {
  if (!READONLY_WHITELIST.includes(path)) {
    throw new ReadOnlyViolation(path);
  }
  const c = getCreds();
  const nonce = randomInt(1_000_000, 1_000_000_000);
  const timestamp = Math.floor(Date.now() / 1000);
  const { token } = sign(c.openKey, c.grantCode, nonce, c.openId, timestamp);
  // params 必须是 JSON 对象（实测：序列化成字符串会被 100002 拒）
  const body = restoreIdsForSend(
    JSON.stringify({ openId: c.openId, grantCode: c.grantCode, nonce, timestamp, token, params }),
  );

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    await throttle();
    const t0 = Date.now();
    try {
      const resp = await fetch(BASE_URL + path, {
        method: "POST",
        headers: { "Content-Type": "application/json;charset=UTF-8" },
        body,
      });
      const text = await resp.text();
      audit(path, resp.ok, Date.now() - t0);
      if (resp.status >= 500) {
        lastError = new Error(`HTTP ${resp.status}`);
        if (attempt < 2) await backoff(attempt);
        continue;
      }
      const data = JSON.parse(protectIds(text)) as { status?: boolean; code?: number; message?: string; data?: T };
      if (data.status === true) {
        return { ok: true, code: data.code, message: data.message, data: data.data };
      }
      return {
        ok: false,
        code: data.code,
        message: data.message,
        error: {
          code: data.code ?? "unknown",
          message: data.message ?? "未知错误",
          hint: humanHint(data.code),
        },
      };
    } catch (e) {
      lastError = e;
      if (attempt < 2) await backoff(attempt);
    }
  }
  return {
    ok: false,
    error: { code: "TRANSPORT", message: String(lastError), hint: "网络异常，稍后再试" },
  };
}

// 别名：保留一期唯一出口名字，四个一期工具文件的 import 一行不改。
export const call = callRead;

// ---------- 写出口：与 callRead 物理分离的独立函数，只认 WRITE_WHITELIST ----------
//
// 物理分离的含义：白名单判断、护栏检查、审计通道三者都是独立代码路径，不共享 callRead 的
// READONLY_WHITELIST 分支或一期 audit() 日志——读路径永远走不到这里，这里也不接受白名单外的路径。
// 二者只共享纯工具函数（签名/大数保护/节流），这些函数不涉及任何白名单判断。
//
// 不做自动重试：写请求一旦真实发出，网络异常时盲目重试可能造成重复下单（企迈侧无幂等字段兜底，
// § 8 第 4 条已查证）。出错就明确失败，把"是否需要去小程序确认订单状态"的判断交给上层。

export interface CallWriteOptions {
  /** 本地预估金额（分）。必传，金额护栏用；> ORDER_GUARD.maxAmountFen 直接拒绝、不发请求。 */
  amountFen: number;
  /** 一次性确认令牌 ID（M4 由 prepare_order 签发）。四项校验任一不过即拒、不发请求。 */
  confirmToken: string;
}

function extractOrderNo(data: unknown): string | undefined {
  if (data && typeof data === "object" && "orderNo" in data) {
    const v = (data as Record<string, unknown>).orderNo;
    if (typeof v === "string") return v;
    if (v != null) return String(v);
  }
  return undefined;
}

// 审计摘要：白名单式提取（storeId / 商品行数 / 数量 / 本地预估金额分），
// 不透传完整 params——"识别值一律脱敏""不许把完整 params 倒灌进日志"在这里落地。
// 顶层参数若混入形如手机号的字符串字段（正常 6.2.9 params 不应该有），只记脱敏后的后四位，
// 帮助人工排查但不泄露完整号码；写审计记录落盘前 WriteGuard.recordAudit 还会再做一次全量脱敏兜底。
function summarizeWriteParams(params: Record<string, unknown>, amountFen: number): WriteAuditSummary {
  const items = Array.isArray(params.items) ? (params.items as Array<Record<string, unknown>>) : [];
  const totalQuantity = items.reduce((sum, it) => sum + (typeof it?.num === "number" ? it.num : 0), 0);
  const summary: WriteAuditSummary = {
    storeId: params.storeId,
    itemCount: items.length,
    totalQuantity,
    estimatedAmountFen: amountFen,
  };
  // PHONE_RE 从 writeGuard.ts 统一导出（覆盖纯 11 位 / 86 前缀 / +86 前缀 / 0086 前缀），
  // 不在这里另开一份定义——避免两处正则日后改一处漏一处、脱敏范围不一致。
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "string" && PHONE_RE.test(v)) {
      summary[`${k}Last4`] = `***${v.slice(-4)}`;
    }
  }
  return summary;
}

export async function callWrite<T = unknown>(
  path: string,
  params: Record<string, unknown>,
  opts: CallWriteOptions,
): Promise<ApiResult<T>> {
  const guard = getWriteGuard();
  const t0 = Date.now();
  const summary = summarizeWriteParams(params, opts.amountFen);
  const auditBase = { path, tokenId: opts.confirmToken ?? null, summary };

  // ① 写白名单——不在名单里，连指纹都不算，直接拒绝（先记审计、再抛错、请求不发出）。
  if (!WRITE_WHITELIST.includes(path)) {
    guard.recordAudit({ ...auditBase, result: "rejected", reason: "WriteNotAllowed", idempotencyKey: null, durationMs: Date.now() - t0 });
    throw new WriteNotAllowed(path);
  }

  // 幂等键 = fingerprint({ params, tokenId })，不是单纯 fingerprint(params)。
  //
  // 总工验收裁决（M2 追加修复）：单纯按内容算幂等键的后果是"同款商品终身只能买一次"——
  // 顾客上午买一杯瑞香大红袍，下午想再买一模一样的一杯，内容指纹相同，会被误判成重复下单永久拒绝。
  // 幂等要防的是"同一次下单意图被技术性重复提交"（网络重试、并发调用撞在令牌校验与消耗之间的窗口），
  // 不是"内容相同的两次独立购买"。令牌一次性、每次 prepare_order 都新签发，
  // 所以两次独立购买天然是两个不同的 tokenId → 不同的幂等键 → 都能下单；
  // 而同一令牌被重复提交时，"用后即焚"是第一道防线（会在下面的令牌校验命中 TokenAlreadyUsed），
  // 幂等键在此处是第二道防线——防的是校验通过、consumeToken 与幂等记录之间的窗口期被并发利用。
  const idempotencyKey = fingerprint({ params, tokenId: opts.confirmToken });
  const auditWithKey = { ...auditBase, idempotencyKey };

  // ② 金额护栏
  const amountCheck = guard.checkAmount(opts.amountFen);
  if (!amountCheck.ok) {
    guard.recordAudit({ ...auditWithKey, result: "rejected", reason: amountCheck.reason, durationMs: Date.now() - t0 });
    throw new WriteGuardRejected(amountCheck.reason);
  }

  // ③ 频次护栏（北京时间自然日，启动时已从写审计日志重建，重启绕不过）
  const dailyCheck = guard.checkDailyLimit();
  if (!dailyCheck.ok) {
    guard.recordAudit({ ...auditWithKey, result: "rejected", reason: dailyCheck.reason, durationMs: Date.now() - t0 });
    throw new WriteGuardRejected(dailyCheck.reason);
  }

  // ④ 确认令牌四项校验（存在 → 未过期 → 未用过 → 指纹一致）
  const tokenCheck = guard.verifyToken(opts.confirmToken, params);
  if (!tokenCheck.ok) {
    guard.recordAudit({ ...auditWithKey, result: "rejected", reason: tokenCheck.reason, durationMs: Date.now() - t0 });
    throw new WriteGuardRejected(tokenCheck.reason);
  }
  guard.consumeToken(tokenCheck.record); // 用后即焚：真正发请求前立即消耗，请求成败都不可再用

  // ⑤ 幂等：同一份下单内容此前已经下单成功过 → 拒绝（企迈侧无幂等字段，只能本地防）
  if (guard.isDuplicate(idempotencyKey)) {
    guard.recordAudit({ ...auditWithKey, result: "rejected", reason: "DuplicateIdempotencyKey", durationMs: Date.now() - t0 });
    throw new WriteGuardRejected("DuplicateIdempotencyKey：这份下单内容此前已经下单成功过");
  }

  // ---- 全部护栏通过：真实发出唯一一次请求（不重试） ----
  const c = getCreds();
  const nonce = randomInt(1_000_000, 1_000_000_000);
  const timestamp = Math.floor(Date.now() / 1000);
  const { token } = sign(c.openKey, c.grantCode, nonce, c.openId, timestamp);
  const body = restoreIdsForSend(
    JSON.stringify({ openId: c.openId, grantCode: c.grantCode, nonce, timestamp, token, params }),
  );

  try {
    await throttle();
    const resp = await fetch(BASE_URL + path, {
      method: "POST",
      headers: { "Content-Type": "application/json;charset=UTF-8" },
      body,
    });
    const text = await resp.text();
    const ms = Date.now() - t0;
    if (resp.status >= 500) {
      guard.recordAudit({ ...auditWithKey, result: "rejected", reason: `HTTP${resp.status}`, durationMs: ms });
      return {
        ok: false,
        error: { code: "TRANSPORT", message: `HTTP ${resp.status}`, hint: "服务异常，稍后再试；先去小程序查订单状态，不要立即重复下单" },
      };
    }
    const data = JSON.parse(protectIds(text)) as { status?: boolean; code?: number; message?: string; data?: T };
    if (data.status === true) {
      const orderNo = extractOrderNo(data.data);
      guard.recordPlacedOrder(idempotencyKey, orderNo ?? "");
      guard.incrementDailyCount();
      guard.recordAudit({ ...auditWithKey, result: "allowed", orderNo: orderNo ?? null, code: data.code ?? null, durationMs: ms });
      return { ok: true, code: data.code, message: data.message, data: data.data };
    }
    guard.recordAudit({ ...auditWithKey, result: "rejected", reason: `ApiRejected:${data.code}`, code: data.code ?? null, durationMs: ms });
    return {
      ok: false,
      code: data.code,
      message: data.message,
      error: { code: data.code ?? "unknown", message: data.message ?? "未知错误", hint: humanHint(data.code) },
    };
  } catch (e) {
    guard.recordAudit({ ...auditWithKey, result: "rejected", reason: "TransportError", durationMs: Date.now() - t0 });
    return {
      ok: false,
      error: { code: "TRANSPORT", message: String(e), hint: "网络异常，先去小程序查订单状态，不要立即重复下单" },
    };
  }
}
