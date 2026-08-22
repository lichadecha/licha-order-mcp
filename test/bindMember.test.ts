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
import { PendingOrderStore, setPendingOrderStoreForTesting } from "../src/pendingOrders.js";
import { WriteGuard, setWriteGuardForTesting, beijingTimeString } from "../src/writeGuard.js";

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
// 接口本身失败的形态（构造值）——测的是 LookupFailed 那条路径。
const NOT_FOUND_BODY = '{"status":false,"code":40001,"message":"会员不存在"}';
// ⚠️ 企迈**真实**的「这个号没注册过」形态（2026-08-19 实测，三个未注册号 + 同号重复查，稳定一致）：
// 它是一个彻头彻尾的成功响应，只是 customerId 为 0。此前本文件只有上面那个构造的失败形态，
// 于是「假装绑定成功」这个缺陷一直测不出来——测试假设的失败形态与接口真实行为不是一回事。
const ZERO_CUSTOMER_BODY = '{"status":true,"code":0,"message":"请求成功","data":{"blttUserId":null,"customerId":0}}';

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

// ---------- 非会员绑定（2026-08-19 实测缺陷修复）----------
// 缺陷原貌：企迈对未注册手机号返回 {"code":0,"status":true,"data":{"customerId":0}}——
// 接口层面完全成功。旧代码 String(0)="0" 是非空字符串、`!customerId` 判断放行，于是
// **绑定"成功"、会话绑到 customerId="0"**，后续单子挂到不存在的会员上，顾客在自己
// 小程序里永远看不到那张单。这三条守住修复。

test("U3-Z1: 未注册手机号（企迈返回 customerId:0，接口成功）→ 必须判为查无此人、会话不许留下绑定", async () => {
  const sessionStore = new SessionStore();
  setSessionStoreForTesting(sessionStore);
  const { logger, logPath } = freshAuditLogger();
  setAccessAuditLoggerForTesting(logger);
  const spy = installFetchSpy([ZERO_CUSTOMER_BODY]);
  try {
    const result = await bindMemberHandler({ code: "13800001234", codeType: "phone" });

    assert.strictEqual(result.isError, true, "customerId=0 必须判为失败——这是本缺陷的核心");
    assert.strictEqual(sessionStore.getBinding(DEFAULT_SESSION_KEY), undefined, "会话不许留下任何绑定");
    // 反面断言：绝不能出现「已绑定尾号 ***0」这种荒谬播报
    assert.ok(!result.content[0].text.includes("***0"), "不许把 0 当成会员 ID 播报尾号");

    const log = readFileSync(logPath, "utf8");
    assert.ok(log.includes('"event":"bind_rejected"'), "应记一条 bind_rejected");
    assert.ok(log.includes("NotAMember"), "reason 应标为 NotAMember（不是接口故障）");
    assert.strictEqual(spy.count(), 1);
  } finally {
    spy.restore();
    setSessionStoreForTesting(null);
    setAccessAuditLoggerForTesting(null);
  }
});

test("U3-Z2: 「不是会员」与「接口故障」两条路径的话术必须不同——前者引导去注册，后者让稍后重试", async () => {
  // 前半：不是会员
  setSessionStoreForTesting(new SessionStore());
  const fx1 = freshAuditLogger();
  setAccessAuditLoggerForTesting(fx1.logger);
  const spy1 = installFetchSpy([ZERO_CUSTOMER_BODY]);
  let notMemberMsg = "";
  try {
    notMemberMsg = (await bindMemberHandler({ code: "13800001234", codeType: "phone" })).content[0].text;
  } finally {
    spy1.restore();
    setSessionStoreForTesting(null);
    setAccessAuditLoggerForTesting(null);
  }
  assert.match(notMemberMsg, /还不是李茶的茶会员/, "非会员要说清「你还不是会员」");
  assert.match(notMemberMsg, /小程序注册/, "非会员要给出下一步：去小程序注册");
  assert.ok(!/重试|再试一次/.test(notMemberMsg), "非会员不许让他重试——重报同一个号只会再失败一次");

  // 后半：接口故障
  setSessionStoreForTesting(new SessionStore());
  const fx2 = freshAuditLogger();
  setAccessAuditLoggerForTesting(fx2.logger);
  const spy2 = installFetchSpy([NOT_FOUND_BODY]);
  let failMsg = "";
  try {
    failMsg = (await bindMemberHandler({ code: "13800001234", codeType: "phone" })).content[0].text;
  } finally {
    spy2.restore();
    setSessionStoreForTesting(null);
    setAccessAuditLoggerForTesting(null);
  }
  assert.ok(!/还不是李茶的茶会员/.test(failMsg), "接口故障时不许暗示顾客没注册——那是甩锅给用户");
  assert.match(failMsg, /再试/, "接口故障要让顾客稍后再试");
  assert.ok(readFileSync(fx2.logPath, "utf8").includes("LookupFailed"), "reason 应标为 LookupFailed");
});

test("U3-Z3: customerId 的三种「空」形态都判为查无此人（数字 0 / 字符串 \"0\" / 空串）", async () => {
  const bodies = [
    ['{"status":true,"code":0,"data":{"customerId":0}}', "数字 0"],
    ['{"status":true,"code":0,"data":{"customerId":"0"}}', '字符串 "0"'],
    ['{"status":true,"code":0,"data":{"customerId":""}}', "空串"],
  ] as const;
  for (const [body, label] of bodies) {
    const store = new SessionStore();
    setSessionStoreForTesting(store);
    const fx = freshAuditLogger();
    setAccessAuditLoggerForTesting(fx.logger);
    const spy = installFetchSpy([body]);
    try {
      const r = await bindMemberHandler({ code: "13800001234", codeType: "phone" });
      assert.strictEqual(r.isError, true, `${label} 应判为查无此人`);
      assert.strictEqual(store.getBinding(DEFAULT_SESSION_KEY), undefined, `${label} 不许留下绑定`);
    } finally {
      spy.restore();
      setSessionStoreForTesting(null);
      setAccessAuditLoggerForTesting(null);
    }
  }
});

// ---------- 换绑（2026-08-19 老板拍板「换人就解绑，别让用户这么麻烦」）----------
// 行为变更：原 U4/U5 断言的是「已绑定后再绑一律被拒（连是不是同一人都不判，省一次调用）」。
// 那条规矩配的是 SKILL 里「要换人请新开一个对话」这句话术——而它被实测证伪（MCP server 进程
// 在 WorkBuddy 里常驻、跨对话复用，开新对话不换会话键，§8-41）。规矩既挡不住真正的风险
// （手机号绑定本就无验证，第一次就能绑任何人的号，风险 2026-08-18 已盘清并接受），
// 又把正常换人的顾客卡死，故改为：同一人幂等、换人则换绑。
// 代价是每次重复绑定都多一次 4.2.2 只读调用——不调接口就不知道新号是不是同一个人。

test("U4-R1: 已绑定后报另一个人的号 → 换绑成功，出参说清「从谁换成谁」，审计留 rebind_success", async () => {
  const sessionStore = new SessionStore();
  const OLD_ID = "1111111111111111111";
  sessionStore.bind(DEFAULT_SESSION_KEY, { customerId: OLD_ID, boundAt: Date.now(), boundVia: "phone", phone: "13800001234" });
  setSessionStoreForTesting(sessionStore);
  const { logger, logPath } = freshAuditLogger();
  setAccessAuditLoggerForTesting(logger);
  const spy = installFetchSpy([SUCCESS_BODY]); // 返回 customerId 1234567890123456789（与 OLD_ID 不同）
  try {
    const result = await bindMemberHandler({ code: "13900002345", codeType: "phone" });
    assert.strictEqual(result.isError, undefined, `换绑应成功：${result.content[0].text}`);
    const parsed = JSON.parse(result.content[0].text);

    assert.strictEqual(parsed.rebound, true, "出参要显式标出这是一次换绑");
    assert.strictEqual(parsed.customerIdLast4, "***6789", "新绑定的是新会员");
    assert.strictEqual(parsed.previousCustomerIdLast4, "***1111", "要说清换掉的是谁（只给尾号）");
    assert.match(parsed.note, /已从\*\*\*1111换成\*\*\*6789/, "note 要让顾客一听就能纠错");

    const binding = sessionStore.getBinding(DEFAULT_SESSION_KEY);
    assert.strictEqual(binding?.customerId, "1234567890123456789", "会话态应已换成新会员");
    assert.strictEqual(binding?.phone, "13900002345", "手机号也要跟着换（否则下单会带上一位顾客的电话）");

    const log = readFileSync(logPath, "utf8");
    assert.ok(log.includes('"event":"rebind_success"'), "换人是审计上最该一眼看见的事，要有独立事件");
    assert.ok(log.includes("PreviousCustomer:***1111"), "审计要记换掉的是谁");
    assert.ok(!log.includes(OLD_ID) && !log.includes("13900002345"), "审计里不许出现任何完整识别值");
    assert.strictEqual(spy.count(), 1, "换绑要真调一次 4.2.2——不调就不知道新号是不是同一个人");
  } finally {
    spy.restore();
    setSessionStoreForTesting(null);
    setAccessAuditLoggerForTesting(null);
  }
});

test("U4-R2: 换绑时作废前一位顾客还没确认的待确认单（换回来也不许复活）", async () => {
  const sessionStore = new SessionStore();
  const OLD_ID = "1111111111111111111";
  sessionStore.bind(DEFAULT_SESSION_KEY, { customerId: OLD_ID, boundAt: Date.now(), boundVia: "phone" });
  setSessionStoreForTesting(sessionStore);
  const pendingStore = new PendingOrderStore();
  setPendingOrderStoreForTesting(pendingStore);
  // 旧顾客有两张待确认单，另有一张属于第三人（不该被牵连作废）
  pendingStore.register("tok-old-1", { finalParams: { userId: OLD_ID, storeId: 1 }, estimatedAmountFen: 2400 });
  pendingStore.register("tok-old-2", { finalParams: { userId: OLD_ID, storeId: 1 }, estimatedAmountFen: 4800 });
  pendingStore.register("tok-other", { finalParams: { userId: "2222222222222222222", storeId: 1 }, estimatedAmountFen: 1200 });
  const { logger, logPath } = freshAuditLogger();
  setAccessAuditLoggerForTesting(logger);
  const spy = installFetchSpy([SUCCESS_BODY]);
  try {
    const result = await bindMemberHandler({ code: "13900002345", codeType: "phone" });
    assert.strictEqual(result.isError, undefined);
    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.discardedPendingOrders, 2, "旧顾客那两张单都要作废");
    assert.match(parsed.note, /2 张单已作废/, "要告诉顾客旧单没了、得重新组");

    assert.strictEqual(pendingStore.lookup("tok-old-1").status, "absent", "旧单必须查不到");
    assert.strictEqual(pendingStore.lookup("tok-old-2").status, "absent", "旧单必须查不到");
    assert.strictEqual(pendingStore.lookup("tok-other").status, "ok", "第三人的单不许被牵连");
    assert.ok(readFileSync(logPath, "utf8").includes("DiscardedPendingOrders:2"), "作废数量要入审计");
  } finally {
    spy.restore();
    setPendingOrderStoreForTesting(null);
    setSessionStoreForTesting(null);
    setAccessAuditLoggerForTesting(null);
  }
});

test("U5-R1: 同一个人又报一次号 → 幂等成功，状态一个字节都不改（不作废他正在确认的单）", async () => {
  const sessionStore = new SessionStore();
  const SAME_ID = "1234567890123456789"; // 与 SUCCESS_BODY 返回的一致
  const boundAt = Date.now() - 60_000;
  sessionStore.bind(DEFAULT_SESSION_KEY, { customerId: SAME_ID, boundAt, boundVia: "card" });
  setSessionStoreForTesting(sessionStore);
  const pendingStore = new PendingOrderStore();
  setPendingOrderStoreForTesting(pendingStore);
  pendingStore.register("tok-mine", { finalParams: { userId: SAME_ID, storeId: 1 }, estimatedAmountFen: 2400 });
  const { logger, logPath } = freshAuditLogger();
  setAccessAuditLoggerForTesting(logger);
  const spy = installFetchSpy([SUCCESS_BODY]);
  try {
    const result = await bindMemberHandler({ code: "13800001234", codeType: "phone" });
    assert.strictEqual(result.isError, undefined, "同一个人重复报号不该报错");
    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.rebound, undefined, "这不是换绑，不许标成换绑");
    assert.strictEqual(parsed.boundVia, "card", "原绑定形态要保留（没换人就什么都不该改）");
    assert.strictEqual(parsed.boundAt, beijingTimeString(boundAt), "绑定时间也不许被刷新");

    assert.strictEqual(
      pendingStore.lookup("tok-mine").status,
      "ok",
      "关键：顾客可能正对着这张待确认单说「就是我」——把它作废掉才是真添麻烦",
    );
    assert.ok(readFileSync(logPath, "utf8").includes("AlreadyBoundSamePerson"), "审计要能区分「同人重报」与首次绑定");
  } finally {
    spy.restore();
    setPendingOrderStoreForTesting(null);
    setSessionStoreForTesting(null);
    setAccessAuditLoggerForTesting(null);
  }
});

test("U5-R2: 有未决写请求时不许换人——否则那笔「成没成还不知道」的单就没人能核对了", async () => {
  const sessionStore = new SessionStore();
  const OLD_ID = "1111111111111111111";
  sessionStore.bind(DEFAULT_SESSION_KEY, { customerId: OLD_ID, boundAt: Date.now(), boundVia: "phone" });
  setSessionStoreForTesting(sessionStore);
  const dir = mkdtempSync(join(tmpdir(), "licha-rebind-guard-"));
  const guard = new WriteGuard({ auditLogPath: join(dir, "write-audit.log"), placedOrdersPath: join(dir, "placed.json") });
  setWriteGuardForTesting(guard);
  // 造一个「已发出、还没等到终态」的写请求（inflight 未销账）
  guard.recordAudit({
    path: "v3/newPattern/cateringApiserver/post/order/v1/create",
    result: "inflight",
    reason: "RequestAboutToBeSent",
    tokenId: "ffffffffffffffffffffffffffffffff",
    idempotencyKey: "a".repeat(64),
    durationMs: 1,
  });
  const { logger, logPath } = freshAuditLogger();
  setAccessAuditLoggerForTesting(logger);
  const spy = installFetchSpy([SUCCESS_BODY]);
  try {
    const result = await bindMemberHandler({ code: "13900002345", codeType: "phone" });
    assert.strictEqual(result.isError, true, "有未决写请求时换人必须被拒");
    assert.match(result.content[0].text, /暂时不能换人/);
    assert.match(result.content[0].text, /核对/, "要告诉顾客怎么解开：先把那一单核对掉");
    assert.strictEqual(
      sessionStore.getBinding(DEFAULT_SESSION_KEY)?.customerId,
      OLD_ID,
      "绑定必须保持在原来那位顾客身上——核对那笔未决单要用他的身份",
    );
    assert.ok(readFileSync(logPath, "utf8").includes("RebindBlockedByUnresolvedWrite"), "拒绝理由要入审计");
  } finally {
    spy.restore();
    setWriteGuardForTesting(null);
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
    // 话术 2026-08-19 按失败类型拆开：本用例喂的是 status:false（接口本身失败）→
    // 说「不是你的号有问题、稍等再试」，不许暗示顾客没注册（那类是 customerId=0，见 U3-Z2）。
    assert.match(result1.content[0].text, /绑定暂时没成功/);
    assert.ok(!/还不是李茶的茶会员/.test(result1.content[0].text), "接口故障不许甩锅说顾客没注册");
    assert.strictEqual(sessionStore.getBinding(DEFAULT_SESSION_KEY), undefined, "会话仍应未绑定");

    const result2 = await bindMemberHandler({ code: "13800001234", codeType: "phone" });
    assert.strictEqual(result2.isError, undefined, "第二次应该成功");
    const parsed = JSON.parse(result2.content[0].text);
    assert.strictEqual(parsed.bound, true);
    assert.ok(sessionStore.getBinding(DEFAULT_SESSION_KEY), "会话现在应已绑定");

    assert.strictEqual(spy.count(), 2, "应分别发出两次 fetch（第一次查无此人、第二次成功）");
    const log = readFileSync(logPath, "utf8");
    assert.ok(log.includes("LookupFailed"), "本用例喂的是 status:false 形态 → 归 LookupFailed（NotAMember 是 customerId=0 那类）");
    assert.ok(log.includes('"event":"bind_success"'));
  } finally {
    spy.restore();
    setSessionStoreForTesting(null);
    setAccessAuditLoggerForTesting(null);
  }
});
