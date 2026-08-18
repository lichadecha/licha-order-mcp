// M5 前置修复第 3 项：审计落盘的统一出口脱敏（施工令 § 8 第 25 条，Codex 审计实物探针清单）。
//
// 被推翻的旧假设："识别值只会出现在我们认识的那几个字段里"。实物探针证明不成立：
// 会员 ID（19 位纯数字）、动态码、40+ 位高熵串放在任意普通字段里都能穿透 maskDeep；
// 数字类型的手机号（number 而非 string）穿透；写审计的顶层 reason 当时根本没过脱敏。
// 修法是把判据翻转成「默认全脱敏 + 白名单例外」，本文件逐条验证这个翻转确实生效。
//
// 🚨 红线自证：本文件不发出任何真实 HTTP 请求（只有 U-S6 用 mock fetch 走 bind_member 链路）；
// 全部审计文件落在 mkdtemp 临时目录；文件末尾有一条用例比对生产 logs/ 目录的哈希快照。
// 识别值一律用假值：假会员 ID 1234567890123456789 / 9876543210987654321、假手机号 13800001234。

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { callWrite, WriteDisabled, setReadAuditLogPathForTesting } from "../src/client.js";
import { WRITE_WHITELIST, ENABLE_ORDERING_ENV } from "../src/constants.js";
import { WriteGuard, setWriteGuardForTesting, sanitizeAuditRecord } from "../src/writeGuard.js";
import { AccessAuditLogger, setAccessAuditLoggerForTesting } from "../src/accessAudit.js";
import { SessionStore, setSessionStoreForTesting } from "../src/session.js";
import { bindMemberHandler } from "../src/bindMemberTool.js";

process.env.QMAI_OPEN_KEY ??= "test-open-key-0123456789abcdef0123456789ab";
process.env.QMAI_OPEN_ID ??= "test-open-id-0000000000000000";
process.env.QMAI_GRANT_CODE ??= "test-grant-code-0000000000";

const FAKE_MEMBER_ID = "1234567890123456789"; // 19 位假会员 ID
const FAKE_MEMBER_ID_2 = "9876543210987654321";
const FAKE_PHONE = "13800001234";
const FAKE_LONG_TOKEN = "Abc123Def456Ghi789Jkl012Mno345Pqr678Stu901Vwx"; // 45 位高熵串
const REAL_ORDER_NO = "D00281924556183175168"; // M1 真实订单号形态（D + 20 位数字），不是识别值
const realFetch = globalThis.fetch;

function freshGuard(): { guard: WriteGuard; auditLogPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "licha-sanitizer-"));
  const auditLogPath = join(dir, "write-audit.log");
  return { guard: new WriteGuard({ auditLogPath, placedOrdersPath: join(dir, "placed-orders.json") }), auditLogPath };
}

function lastLine(path: string): { raw: string; obj: any } {
  const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  const raw = lines[lines.length - 1];
  return { raw, obj: JSON.parse(raw) };
}

// ============================================================================
// U-S1：reason 内嵌会员 ID（19 位纯数字）→ 只留后四位
// ============================================================================
test("U-S1: 写审计 reason 里内嵌 19 位会员 ID → 落盘只剩后四位", () => {
  const { guard, auditLogPath } = freshGuard();
  guard.recordAudit({
    path: WRITE_WHITELIST[0],
    result: "rejected",
    reason: `PendingOrderOwnerMismatch:登记单归属 ${FAKE_MEMBER_ID}，当前绑定 ${FAKE_MEMBER_ID_2}`,
    idempotencyKey: null,
    durationMs: 0,
  });
  const { raw, obj } = lastLine(auditLogPath);
  assert.ok(!raw.includes(FAKE_MEMBER_ID), "落盘文本不得出现完整会员 ID");
  assert.ok(!raw.includes(FAKE_MEMBER_ID_2), "第二个完整会员 ID 同样不得出现");
  assert.match(obj.reason, /\*\*\*6789/);
  assert.match(obj.reason, /\*\*\*4321/);
  assert.match(obj.reason, /^PendingOrderOwnerMismatch:/, "非识别值部分保持可读，排查信息不丢");
});

// ============================================================================
// U-S2：reason 内嵌 40+ 位高熵串 → 只留后四位
// ============================================================================
test("U-S2: 写审计 reason 里内嵌 40+ 位高熵字母数字串 → 落盘只剩后四位", () => {
  const { guard, auditLogPath } = freshGuard();
  guard.recordAudit({
    path: WRITE_WHITELIST[0],
    result: "rejected",
    reason: `UpstreamEcho:${FAKE_LONG_TOKEN}`,
    idempotencyKey: null,
    durationMs: 0,
  });
  const { raw, obj } = lastLine(auditLogPath);
  assert.ok(!raw.includes(FAKE_LONG_TOKEN), "落盘文本不得出现完整高熵串");
  assert.equal(obj.reason, `UpstreamEcho:***${FAKE_LONG_TOKEN.slice(-4)}`);
});

// ============================================================================
// U-S3：顶层 reason 内嵌手机号 → 脱敏（改造前顶层 reason 根本没过脱敏）
// ============================================================================
test("U-S3: 写审计顶层 reason 内嵌手机号 → 落盘只剩后四位（顶层字段也过 sink）", () => {
  const { guard, auditLogPath } = freshGuard();
  guard.recordAudit({
    path: WRITE_WHITELIST[0],
    result: "rejected",
    reason: `CustomerNotFound:手机号${FAKE_PHONE}不存在`,
    idempotencyKey: null,
    durationMs: 0,
  });
  const { raw, obj } = lastLine(auditLogPath);
  assert.ok(!raw.includes(FAKE_PHONE), "落盘文本不得出现完整手机号");
  assert.equal(obj.reason, "CustomerNotFound:手机号***1234不存在");
});

// ============================================================================
// U-S4：数字类型的手机号 / 长数字 → 同样脱敏
// ============================================================================
test("U-S4: 数字类型（number）的手机号与 15+ 位长数字 → 同样只留后四位", () => {
  const { guard, auditLogPath } = freshGuard();
  guard.recordAudit({
    path: WRITE_WHITELIST[0],
    result: "rejected",
    reason: "NumericProbe",
    idempotencyKey: null,
    durationMs: 0,
    summary: {
      storeId: 503542, // 6 位门店编码：不该被误伤
      estimatedAmountFen: 2400, // 金额：不该被误伤
      phoneAsNumber: 13800001234, // 数字型手机号：必须脱敏
      idAsNumber: 1234567890123456, // 16 位数字：必须脱敏
      nested: { deepPhone: 13900002345 },
    },
  });
  const { raw, obj } = lastLine(auditLogPath);
  assert.ok(!raw.includes("13800001234"), "数字型手机号不得原样落盘");
  assert.ok(!raw.includes("13900002345"), "嵌套层里的数字型手机号同样不得原样落盘");
  assert.equal(obj.summary.phoneAsNumber, "***1234");
  assert.equal(obj.summary.nested.deepPhone, "***2345");
  assert.equal(obj.summary.idAsNumber, "***3456");
  assert.equal(obj.summary.storeId, 503542, "6 位门店编码不该被误伤");
  assert.equal(obj.summary.estimatedAmountFen, 2400, "金额不该被误伤");
});

// ============================================================================
// U-S5：白名单字段（orderNo / tokenId / idempotencyKey / resolvedKeys）保持完整
// ============================================================================
// resolvedKeys 尤其关键：它就是一组 sha256 幂等键，被脱敏了「已发出≠已成功」闸门在重启后
// 就永远销不掉账——这条断言同时守着第 1 项的护栏，不只是脱敏本身。
test("U-S5: orderNo / tokenId / idempotencyKey / resolvedKeys 走白名单，值保持完整", () => {
  const { guard, auditLogPath } = freshGuard();
  const tokenId = "a".repeat(32); // 令牌 ID 形态：32 位 hex
  const idemKey = createHash("sha256").update("probe").digest("hex"); // 64 位 hex，够到 40+ 规则
  guard.recordAudit({
    path: WRITE_WHITELIST[0],
    result: "allowed",
    orderNo: REAL_ORDER_NO,
    tokenId,
    idempotencyKey: idemKey,
    resolvedKeys: [idemKey],
    durationMs: 12,
  });
  const { obj } = lastLine(auditLogPath);
  assert.equal(obj.orderNo, REAL_ORDER_NO, "订单号必须完整——脱敏了整本审计就失去核对价值");
  assert.equal(obj.tokenId, tokenId);
  assert.equal(obj.idempotencyKey, idemKey, "幂等键是频次重建与幂等判重的连接键，必须完整");
  assert.deepEqual(obj.resolvedKeys, [idemKey], "resolvedKeys 是一组幂等键，脱敏会让未决闸门销不掉账");
  assert.equal(obj.path, WRITE_WHITELIST[0]);

  // 同样的订单号出现在**非白名单字段**里时，前缀字母保护它不被数字规则误拆
  const { obj: obj2 } = (() => {
    guard.recordAudit({
      path: WRITE_WHITELIST[0],
      result: "rejected",
      reason: `DuplicateOf:${REAL_ORDER_NO}`,
      idempotencyKey: null,
      durationMs: 0,
    });
    return lastLine(auditLogPath);
  })();
  assert.equal(obj2.reason, `DuplicateOf:${REAL_ORDER_NO}`, "带字母前缀的订单号不被 15+ 位数字规则误伤");
});

// ============================================================================
// U-S6：企迈 message 原文不再进落盘 reason（bind_member 全链路）
// ============================================================================
test("U-S6: bind_member 查无此人 → 落盘 reason 只有枚举+长度+code，不含企迈 message 原文", async () => {
  const dir = mkdtempSync(join(tmpdir(), "licha-sanitizer-bind-"));
  const accessLogPath = join(dir, "access-audit.log");
  setSessionStoreForTesting(new SessionStore());
  setAccessAuditLoggerForTesting(new AccessAuditLogger({ logPath: accessLogPath }));
  setReadAuditLogPathForTesting(join(dir, "read-audit.log"));
  // 企迈 message 里同时塞进手机号与会员 ID：即使出口脱敏能兜住已知形态，
  // 也不该让不受控的外部文本进日志——这条断言要的是「原文根本没进来」。
  const qmaiMessage = `会员${FAKE_MEMBER_ID}（手机号${FAKE_PHONE}）不存在`;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ status: false, code: 40001, message: qmaiMessage }), { status: 200 })) as typeof fetch;
  try {
    const r = await bindMemberHandler({ code: FAKE_PHONE, codeType: "phone" });
    assert.equal(r.isError, true);

    const { raw, obj } = lastLine(accessLogPath);
    assert.equal(obj.event, "bind_rejected");
    assert.equal(obj.reason, `CustomerNotFound:len=${qmaiMessage.length}:code=40001`);
    assert.ok(!raw.includes("不存在"), "企迈 message 原文不得出现在落盘记录里");
    assert.ok(!raw.includes(FAKE_MEMBER_ID), "message 里夹带的会员 ID 自然也不会出现");
    assert.equal(obj.codeLast4, "***1234", "绑定标识仍然只留后四位");
  } finally {
    globalThis.fetch = realFetch;
    setSessionStoreForTesting(null);
    setAccessAuditLoggerForTesting(null);
    setReadAuditLogPathForTesting(null);
  }
});

// ============================================================================
// U-S7：写能力开关兜底 —— env ≠ "1" 时 callWrite 直接抛错、请求不发出
// ============================================================================
test("U-S7: LICHA_ENABLE_ORDERING ≠ 1 → callWrite 抛 WriteDisabled，fetch 一次都没被调用", async () => {
  const { guard, auditLogPath } = freshGuard();
  setWriteGuardForTesting(guard);
  const saved = process.env[ENABLE_ORDERING_ENV];
  delete process.env[ENABLE_ORDERING_ENV];
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => callWrite(WRITE_WHITELIST[0], { storeId: 503542 }, { amountFen: 100, confirmToken: "irrelevant" }),
      (e: unknown) => e instanceof WriteDisabled,
    );
    assert.equal(fetchCalls, 0, "写能力关闭时一个请求都不该发出");
    const { obj } = lastLine(auditLogPath);
    assert.equal(obj.result, "rejected");
    assert.equal(obj.reason, "OrderingDisabled");
    assert.equal(guard.currentDailyCount(), 0, "被开关挡下的调用不占额度");
  } finally {
    if (saved !== undefined) process.env[ENABLE_ORDERING_ENV] = saved;
    globalThis.fetch = realFetch;
    setWriteGuardForTesting(null);
  }
});

// ============================================================================
// U-S8：sanitizeAuditRecord 的纯函数级断言（不落盘也成立）
// ============================================================================
test("U-S8: sanitizeAuditRecord 纯函数级——凭证字段整条丢弃、数组逐项脱敏、白名单穿透", () => {
  const out = sanitizeAuditRecord({
    openKey: "should-be-dropped-entirely",
    grantCode: "also-dropped",
    note: `会员 ${FAKE_MEMBER_ID} 手机号 ${FAKE_PHONE}`,
    list: [FAKE_MEMBER_ID, FAKE_PHONE, "safe-text"],
    orderNo: REAL_ORDER_NO,
    durationMs: 12,
  }) as Record<string, any>;
  assert.ok(!("openKey" in out), "凭证类字段名整条丢弃");
  assert.ok(!("grantCode" in out), "凭证类字段名整条丢弃");
  assert.equal(out.note, "会员 ***6789 手机号 ***1234");
  assert.deepEqual(out.list, ["***6789", "***1234", "safe-text"]);
  assert.equal(out.orderNo, REAL_ORDER_NO);
  assert.equal(out.durationMs, 12);
});

// ============================================================================
// U-S9：本文件跑完，生产 logs/ 目录哈希快照不变
// ============================================================================
// 「测试不许碰生产 logs/」是明确红线，M2/M3 各破过一次（都是没注入临时路径）。
// 这条用例把它变成机器判据：开跑时给生产 logs/ 拍一张哈希快照，全部用例跑完后再比一次。
const PROD_LOGS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "logs");

function snapshotLogs(): string {
  if (!existsSync(PROD_LOGS_DIR)) return "<no-logs-dir>";
  return readdirSync(PROD_LOGS_DIR)
    .sort()
    .map((f) => {
      const p = join(PROD_LOGS_DIR, f);
      if (!statSync(p).isFile()) return `${f}:<dir>`;
      return `${f}:${createHash("md5").update(readFileSync(p)).digest("hex")}`;
    })
    .join("\n");
}

const LOGS_SNAPSHOT_AT_START = snapshotLogs();

after(() => {
  assert.equal(snapshotLogs(), LOGS_SNAPSHOT_AT_START, "测试跑完后生产 logs/ 必须一字未变");
});

test("U-S9: 生产 logs/ 快照已登记，收尾钩子会比对（本条用例本身只做登记）", () => {
  assert.ok(LOGS_SNAPSHOT_AT_START.length > 0, "快照应已在模块加载时取得");
});
