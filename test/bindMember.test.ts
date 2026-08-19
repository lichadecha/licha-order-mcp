// U3-U7：bind_member 工具的绑定成功、重复绑定拒绝（含"相同 code"边界）、
// 入参格式预检、查无此人兜底分支。
//
// 红线自证：globalThis.fetch 被整体替换为可计数、可指定响应体的 mock 函数；所有护栏拒绝的
// 用例都断言 fetch 调用次数没有增加。会话态与 access-audit 均注入独立临时实例，不污染
// 生产 logs/ 目录、不跨用例互相污染。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindMemberHandler } from "../src/bindMemberTool.js";
import { setReadAuditLogPathForTesting } from "../src/client.js";
import { SessionStore, setSessionStoreForTesting, DEFAULT_SESSION_KEY } from "../src/session.js";
import { AccessAuditLogger, setAccessAuditLoggerForTesting } from "../src/accessAudit.js";

process.env.QMAI_OPEN_KEY ??= "test-open-key-0123456789abcdef0123456789ab";
process.env.QMAI_OPEN_ID ??= "test-open-id-0000000000000000";
process.env.QMAI_GRANT_CODE ??= "test-grant-code-0000000000";

// bindMemberHandler 会真正调用 callRead（走 4.2.2 只读白名单），callRead 内部有一份独立于
// WriteGuard/AccessAuditLogger 的一期读侧审计日志（client.ts 的 audit()，硬编码写
// logs/audit.log）。不注入测试路径的话，本文件所有会成功闯到 callRead 这一步的用例都会把
// 记录写进生产 logs/ 目录——这正是施工令要求「测试运行后不许污染生产 logs/」要防的事，
// 在模块顶层一次性注入，整份文件的用例都安全。
setReadAuditLogPathForTesting(join(mkdtempSync(join(tmpdir(), "licha-read-audit-bindmember-")), "audit.log"));

function freshAuditLogger(): { logger: AccessAuditLogger; logPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "licha-access-audit-bind-"));
  const logPath = join(dir, "access-audit.log");
  return { logger: new AccessAuditLogger({ logPath }), logPath };
}

// 响应体用原始字符串（不经过 JS 对象再 JSON.stringify）——customerId 是 19 位大数，
// 如果先造出一个 JS number 字面量再序列化，精度早就丢了；只有原始文本里保持"未加引号的
// 大数字"这个形态，才是 M1 实测的真实响应形态，也只有这样 protectIds 的字符串化兜底才有意义。
const SUCCESS_BODY = '{"status":true,"code":0,"message":"ok","data":{"customerId":1234567890123456789}}';
const NOT_FOUND_BODY = '{"status":false,"code":40001,"message":"会员不存在"}';

function installFetchSpy(responses: string[]): { count: () => number; restore: () => void } {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (..._args: Parameters<typeof fetch>) => {
    const body = responses[Math.min(calls, responses.length - 1)];
    calls++;
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  return {
    count: () => calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test("U3: bind_member 成功 → 会话有绑定、出参只含后四位、access-audit 有 bind_success 且 code 只留后四位", async () => {
  const sessionStore = new SessionStore();
  setSessionStoreForTesting(sessionStore);
  const { logger, logPath } = freshAuditLogger();
  setAccessAuditLoggerForTesting(logger);
  const spy = installFetchSpy([SUCCESS_BODY]);
  try {
    const result = await bindMemberHandler({ code: "13800001234", codeType: "phone" });
    assert.strictEqual(result.isError, undefined, "应成功，不应是错误结果");
    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.bound, true);
    assert.strictEqual(parsed.customerIdLast4, "***6789");
    assert.strictEqual(parsed.boundVia, "phone");
    assert.ok(typeof parsed.boundAt === "string" && parsed.boundAt.length > 0);
    assert.ok(!JSON.stringify(parsed).includes("1234567890123456789"), "出参不应包含完整 customerId");

    const binding = sessionStore.getBinding(DEFAULT_SESSION_KEY);
    assert.ok(binding, "会话应已绑定");
    assert.strictEqual(binding?.customerId, "1234567890123456789");
    assert.strictEqual(binding?.boundVia, "phone");

    const log = readFileSync(logPath, "utf8");
    assert.ok(log.includes('"event":"bind_success"'));
    assert.ok(log.includes("***1234"), "code 应只留后四位");
    assert.ok(log.includes("***6789"), "customerId 应只留后四位");
    assert.ok(!log.includes("13800001234"), "不应出现完整手机号");
    assert.ok(!log.includes("1234567890123456789"), "不应出现完整 customerId");
    assert.strictEqual(spy.count(), 1, "应恰好发出一次 mock fetch");
  } finally {
    spy.restore();
    setSessionStoreForTesting(null);
    setAccessAuditLoggerForTesting(null);
  }
});

// ---------- T1 手机号回填（2026-08-19，17 号执行包 T1）----------
// 会话态多存了一个手机号，就多了一个能泄漏的地方。这条守的是「存了但不外露」：
// 会话里有完整值（prepare_order 要拿它注入 mobile/reservePhone），出参与审计里只有尾号。
// 另一半（发出去的请求体必须是完整值）在 m4ConfirmOrder.test.ts 的 T1 附 1。

test("U3-T1: phone 绑定把手机号存进会话态，但出参与 access-audit 里只有尾号；card/dynamic_code 绑定根本没有 phone 这个键", async () => {
  // —— 前半：手机号绑定 ——
  const sessionStore = new SessionStore();
  setSessionStoreForTesting(sessionStore);
  const { logger, logPath } = freshAuditLogger();
  setAccessAuditLoggerForTesting(logger);
  const spy = installFetchSpy([SUCCESS_BODY]);
  try {
    const result = await bindMemberHandler({ code: "138 0000 1234", codeType: "phone" });
    assert.strictEqual(result.isError, undefined, "应成功");

    const binding = sessionStore.getBinding(DEFAULT_SESSION_KEY);
    // 存的是**去空白后**的号：顾客口述/截屏来的号常夹空格，存原文会让后台收到带空格的电话。
    assert.strictEqual(binding?.phone, "13800001234", "会话态应存下去空白后的完整手机号");

    assert.ok(!result.content[0].text.includes("13800001234"), "bind 出参不许出现完整手机号");
    assert.ok(!readFileSync(logPath, "utf8").includes("13800001234"), "access-audit 不许出现完整手机号");
  } finally {
    spy.restore();
    setSessionStoreForTesting(null);
    setAccessAuditLoggerForTesting(null);
  }

  // —— 后半：非手机号形态，压根没有 phone 这个键（不是 undefined 值）——
  const store2 = new SessionStore();
  setSessionStoreForTesting(store2);
  const fx2 = freshAuditLogger();
  setAccessAuditLoggerForTesting(fx2.logger);
  const spy2 = installFetchSpy([SUCCESS_BODY]);
  try {
    const r2 = await bindMemberHandler({ code: "1234567890", codeType: "dynamic_code" });
    assert.strictEqual(r2.isError, undefined, "动态码绑定也应成功");
    const b2 = store2.getBinding(DEFAULT_SESSION_KEY);
    assert.ok(b2, "会话应已绑定");
    assert.ok(!("phone" in (b2 as object)), "非 phone 形态不许出现 phone 键（哪怕值是 undefined）");
  } finally {
    spy2.restore();
    setSessionStoreForTesting(null);
    setAccessAuditLoggerForTesting(null);
  }
});

test("U4: 已绑定后再次 bind（不同 code）→ 被拒，fetch 未被调用", async () => {
  const sessionStore = new SessionStore();
  sessionStore.bind(DEFAULT_SESSION_KEY, { customerId: "1234567890123456789", boundAt: Date.now(), boundVia: "phone" });
  setSessionStoreForTesting(sessionStore);
  const { logger, logPath } = freshAuditLogger();
  setAccessAuditLoggerForTesting(logger);
  const spy = installFetchSpy([SUCCESS_BODY]);
  try {
    const result = await bindMemberHandler({ code: "13900002345", codeType: "phone" });
    assert.strictEqual(result.isError, true);
    assert.ok(/一个会话只能绑定一位会员/.test(result.content[0].text));
    assert.ok(/6789/.test(result.content[0].text), "错误信息应含已绑定 customerId 后四位");
    assert.strictEqual(spy.count(), 0, "fetch 不应被调用");
    const log = readFileSync(logPath, "utf8");
    assert.ok(log.includes('"event":"bind_rejected"'));
    assert.ok(log.includes("AlreadyBound"));
  } finally {
    spy.restore();
    setSessionStoreForTesting(null);
    setAccessAuditLoggerForTesting(null);
  }
});

test("U5: 已绑定后再次 bind（相同 code）→ 同样被拒（一会话一次绑定，不判断是否同一人），fetch 未被调用", async () => {
  const sessionStore = new SessionStore();
  sessionStore.bind(DEFAULT_SESSION_KEY, { customerId: "1234567890123456789", boundAt: Date.now(), boundVia: "phone" });
  setSessionStoreForTesting(sessionStore);
  const { logger } = freshAuditLogger();
  setAccessAuditLoggerForTesting(logger);
  const spy = installFetchSpy([SUCCESS_BODY]);
  try {
    const result = await bindMemberHandler({ code: "13800001234", codeType: "phone" }); // 与已绑定时用的假想 code 相同
    assert.strictEqual(result.isError, true);
    assert.ok(/一个会话只能绑定一位会员/.test(result.content[0].text));
    assert.strictEqual(spy.count(), 0, "fetch 不应被调用——同 code 也不例外，规则是一会话一次绑定");
  } finally {
    spy.restore();
    setSessionStoreForTesting(null);
    setAccessAuditLoggerForTesting(null);
  }
});

test("U6: codeType=phone 但 code 非 11 位纯数字 → 被拒，fetch 未被调用，错误信息不含 code 原值", async () => {
  const sessionStore = new SessionStore();
  setSessionStoreForTesting(sessionStore);
  const { logger, logPath } = freshAuditLogger();
  setAccessAuditLoggerForTesting(logger);
  const spy = installFetchSpy([SUCCESS_BODY]);
  const badCode = "1380000abcd"; // 11 字符但非纯数字
  try {
    const result = await bindMemberHandler({ code: badCode, codeType: "phone" });
    assert.strictEqual(result.isError, true);
    assert.ok(!result.content[0].text.includes(badCode), "错误信息不应回显 code 原值");
    assert.ok(/长度/.test(result.content[0].text), "错误信息应说明长度不符");
    assert.ok(/数字/.test(result.content[0].text), "错误信息应说明是否全为数字");
    assert.strictEqual(spy.count(), 0, "fetch 不应被调用");
    const log = readFileSync(logPath, "utf8");
    assert.ok(log.includes('"event":"bind_rejected"'));
    assert.ok(log.includes("InvalidCodeFormat"));
    assert.ok(!log.includes(badCode), "审计日志也不应含 code 原值");
  } finally {
    spy.restore();
    setSessionStoreForTesting(null);
    setAccessAuditLoggerForTesting(null);
  }
});

test("U7: mock 4.2.2 返回查无此人 → 绑定失败、会话仍未绑定，之后可再次尝试并绑定成功", async () => {
  const sessionStore = new SessionStore();
  setSessionStoreForTesting(sessionStore);
  const { logger, logPath } = freshAuditLogger();
  setAccessAuditLoggerForTesting(logger);
  const spy = installFetchSpy([NOT_FOUND_BODY, SUCCESS_BODY]);
  try {
    const result1 = await bindMemberHandler({ code: "13800009999", codeType: "phone" });
    assert.strictEqual(result1.isError, true);
    assert.ok(/绑定失败：无法用该标识找到会员，请确认后重试/.test(result1.content[0].text));
    assert.strictEqual(sessionStore.getBinding(DEFAULT_SESSION_KEY), undefined, "会话仍应未绑定");

    const result2 = await bindMemberHandler({ code: "13800001234", codeType: "phone" });
    assert.strictEqual(result2.isError, undefined, "第二次应该成功");
    const parsed = JSON.parse(result2.content[0].text);
    assert.strictEqual(parsed.bound, true);
    assert.ok(sessionStore.getBinding(DEFAULT_SESSION_KEY), "会话现在应已绑定");

    assert.strictEqual(spy.count(), 2, "应分别发出两次 fetch（第一次查无此人、第二次成功）");
    const log = readFileSync(logPath, "utf8");
    assert.ok(log.includes("CustomerNotFound"));
    assert.ok(log.includes('"event":"bind_success"'));
  } finally {
    spy.restore();
    setSessionStoreForTesting(null);
    setAccessAuditLoggerForTesting(null);
  }
});
