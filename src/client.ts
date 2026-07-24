// fetch + 白名单 + 节流 + 重试 + 大数保护 + 审计日志

import { randomInt } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_URL, READONLY_WHITELIST } from "./constants.js";
import { loadCredentials, sign, type Credentials } from "./auth.js";

export class ReadOnlyViolation extends Error {
  constructor(path: string) {
    super(`ReadOnlyViolation: 路径不在只读白名单：${path}`);
    this.name = "ReadOnlyViolation";
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

// 统一调用入口：白名单校验 → 签名 → 发送（大数还原）→ 重试 → 解析（大数保护）
export async function call<T = unknown>(path: string, params: Record<string, unknown>): Promise<ApiResult<T>> {
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
