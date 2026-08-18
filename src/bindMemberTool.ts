// bind_member 工具的处理逻辑，独立成模块（不放在 index.ts 里）——理由同 placeOrderTool.ts
// 头部注释：index.ts 顶层有 main().catch(...)，import 它会触发真实的 stdio transport connect，
// 单元测试不能安全地直接 import 这个文件；处理逻辑拆到独立模块后，测试才能直接 import + mock fetch。
//
// 流程（顺序固定，不许变，理由见各步注释）：
//   1. 已有绑定 → 直接拒绝，不发任何请求（一会话一次绑定，省调用且语义干净）。
//   2. 入参格式预检 → 不合格不发请求，错误信息绝不回显 code 原值（M1 真发第二轮的教训）。
//   3. callRead 4.2.2 查会员 ID。
//   4. 响应解析（M1 实测形态 + 兜底分支，防止查无此人时崩溃）。
//   5. 成功 → 绑定会话 → 审计 → 出参只含 customerId 后四位。

import { callRead } from "./client.js";
import { getAccessAuditLogger } from "./accessAudit.js";
import { beijingTimeString } from "./writeGuard.js";
import { DEFAULT_SESSION_KEY, SessionAlreadyBound, getSessionStore, type BoundVia } from "./session.js";

export type TextResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export function ok(data: unknown): TextResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function fail(e: unknown): TextResult {
  const message = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text", text: message }], isError: true };
}

// codeType → 企迈 4.2.2 customerCode.type 映射。
const CODE_TYPE_MAP: Record<BoundVia, number> = { phone: 1, card: 2, dynamic_code: 0 };

type ValidateResult = { ok: true; trimmed: string } | { ok: false; message: string };

/**
 * 入参格式预检：只检查形状（长度/是否全数字），绝不在错误信息里回显 code 原值。
 * "去空白" 指去除全部空白字符（含首尾与中间），不只是 trim——顾客口述或从小程序截屏的码
 * 常见夹带空格。
 */
function validateCodeFormat(code: string, codeType: BoundVia): ValidateResult {
  const trimmed = code.replace(/\s+/g, "");
  if (codeType === "phone") {
    const isAllDigits = /^\d+$/.test(trimmed);
    if (trimmed.length !== 11 || !isAllDigits) {
      return {
        ok: false,
        message: `code 格式不正确：codeType=phone 要求去除空白后为 11 位纯数字（收到长度：${trimmed.length}，是否全为数字：${isAllDigits ? "是" : "否"}）`,
      };
    }
    return { ok: true, trimmed };
  }
  // card / dynamic_code：长度 4-64 且非空
  if (trimmed.length < 4 || trimmed.length > 64) {
    return {
      ok: false,
      message: `code 格式不正确：codeType=${codeType} 要求去除空白后长度在 4-64 之间（收到长度：${trimmed.length}）`,
    };
  }
  return { ok: true, trimmed };
}

/**
 * 从 4.2.2 响应体里取出 customerId：正常形态是 data 为对象、取 data.customerId；
 * 兜底 data 本身直接是 string/number 的情形。protectIds 已把响应文本里的大数 ID 字符串化，
 * 这里仍统一 String() 化，不假设它一定已经是字符串。
 */
function extractCustomerId(data: unknown): string | undefined {
  if (data == null) return undefined;
  if (typeof data === "string" || typeof data === "number") return String(data);
  if (typeof data === "object") {
    const v = (data as Record<string, unknown>).customerId;
    if (v == null) return undefined;
    if (typeof v === "string" || typeof v === "number") return String(v);
  }
  return undefined;
}

export interface BindMemberInput {
  code: string;
  codeType: BoundVia;
}

export async function bindMemberHandler({ code, codeType }: BindMemberInput): Promise<TextResult> {
  const sessionStore = getSessionStore();
  const audit = getAccessAuditLogger();

  try {
    // ① 已有绑定 → 直接拒绝，不发任何请求。
    const existing = sessionStore.getBinding(DEFAULT_SESSION_KEY);
    if (existing) {
      audit.record({
        event: "bind_rejected",
        result: "rejected",
        reason: "AlreadyBound",
        customerIdLast4: `***${existing.customerId.slice(-4)}`,
        sessionKey: DEFAULT_SESSION_KEY,
        tool: "bind_member",
      });
      return fail(new SessionAlreadyBound(existing));
    }

    // ② 入参格式预检 → 不合格不发请求。
    const validated = validateCodeFormat(code, codeType);
    if (!validated.ok) {
      audit.record({
        event: "bind_rejected",
        result: "rejected",
        reason: "InvalidCodeFormat",
        sessionKey: DEFAULT_SESSION_KEY,
        tool: "bind_member",
      });
      return fail(new Error(validated.message));
    }
    const trimmedCode = validated.trimmed;
    const codeLast4 = `***${trimmedCode.slice(-4)}`;

    // ③ callRead 4.2.2 会员标识查会员ID。
    const resp = await callRead<unknown>("v3/crm/customer/getCustomerIdByCode", {
      customerCode: { code: trimmedCode, type: CODE_TYPE_MAP[codeType] },
    });

    // ④ 响应解析：拿不到 customerId 或 ok=false → 兜底分支，稳定不崩溃。
    const customerId = resp.ok ? extractCustomerId(resp.data) : undefined;
    if (!resp.ok || !customerId) {
      audit.record({
        event: "bind_rejected",
        result: "rejected",
        reason: resp.message ? `CustomerNotFound:${resp.message}` : "CustomerNotFound",
        codeLast4,
        sessionKey: DEFAULT_SESSION_KEY,
        tool: "bind_member",
      });
      return fail(new Error("绑定失败：无法用该标识找到会员，请确认后重试"));
    }

    // ⑤ 成功 → 绑定会话 → 审计 → 出参只含后四位。
    const boundAt = Date.now();
    sessionStore.bind(DEFAULT_SESSION_KEY, { customerId, boundAt, boundVia: codeType });
    const customerIdLast4 = `***${customerId.slice(-4)}`;
    audit.record({
      event: "bind_success",
      result: "allowed",
      codeLast4,
      customerIdLast4,
      sessionKey: DEFAULT_SESSION_KEY,
      tool: "bind_member",
    });
    return ok({
      bound: true,
      customerIdLast4,
      boundVia: codeType,
      boundAt: beijingTimeString(boundAt),
    });
  } catch (e) {
    return fail(e);
  }
}
