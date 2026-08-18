// U13：access-audit 落盘内容脱敏自查。
//
// 本文件直接对 AccessAuditLogger.record() 灌入"调用方本不该这么传、但万一疏漏"的完整值
// （完整假手机号、完整假 customerId），验证落盘前的兜底归一化确实把它们截断成只留后四位——
// 这比只测试"调用方已经正确传了 Last4"更能证明红线 #4（识别值脱敏）真的有兜底，而不是
// 只靠调用方自觉。
//
// 手机号/customerId 均为文档里指定的假值（13800001234 / 1234567890123456789），不涉及任何
// 真实识别信息。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccessAuditLogger } from "../src/accessAudit.js";

const FULL_PHONE = "13800001234";
const FULL_CUSTOMER_ID = "1234567890123456789";

function freshLogger(): { logger: AccessAuditLogger; logPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "licha-access-audit-masking-"));
  const logPath = join(dir, "access-audit.log");
  return { logger: new AccessAuditLogger({ logPath }), logPath };
}

test("U13: 写入含完整假手机号/假 customerId 的条目后读回，行内不含完整值、只含后四位", () => {
  const { logger, logPath } = freshLogger();

  logger.record({
    event: "bind_success",
    result: "allowed",
    // 故意传完整值而不是调用方本该传的 "***XXXX" 形态，测的就是落盘前的兜底归一化。
    codeLast4: FULL_PHONE,
    customerIdLast4: FULL_CUSTOMER_ID,
    sessionKey: "stdio-session",
    tool: "bind_member",
  });

  const log = readFileSync(logPath, "utf8");
  assert.ok(!log.includes(FULL_PHONE), "不应出现完整手机号");
  assert.ok(!log.includes(FULL_CUSTOMER_ID), "不应出现完整 customerId");
  assert.ok(log.includes("***1234"), "手机号应只留后四位");
  assert.ok(log.includes("***6789"), "customerId 应只留后四位");

  const entry = JSON.parse(log.trim().split("\n").pop()!);
  assert.strictEqual(entry.codeLast4, "***1234");
  assert.strictEqual(entry.customerIdLast4, "***6789");
});

test("U13-补充：调用方已经正确传入 ***后四位 形态时保持不变（幂等）", () => {
  const { logger, logPath } = freshLogger();
  logger.record({
    event: "ownership_mismatch",
    result: "rejected",
    reason: "mismatch",
    customerIdLast4: "***6789",
    orderNo: "D0000999",
    sessionKey: "stdio-session",
    tool: "get_order_status",
  });
  const entry = JSON.parse(readFileSync(logPath, "utf8").trim().split("\n").pop()!);
  assert.strictEqual(entry.customerIdLast4, "***6789");
});

test("U13-补充：未传入的字段落盘为 null，不产生占位符垃圾值", () => {
  const { logger, logPath } = freshLogger();
  logger.record({ event: "unbound_call_rejected", result: "rejected", reason: "SessionNotBound", tool: "place_order" });
  const entry = JSON.parse(readFileSync(logPath, "utf8").trim().split("\n").pop()!);
  assert.strictEqual(entry.codeLast4, null);
  assert.strictEqual(entry.customerIdLast4, null);
  assert.strictEqual(entry.orderNo, null);
  assert.strictEqual(entry.sessionKey, null);
});
