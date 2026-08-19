// P-W2 收尾补丁 · 第 4 项：处理器级回归测试（Codex 实测穿透口的正面复现与堵死自证）。
//
// 被推翻的旧假设：「白名单字段的值是我们自己生成的，所以一定是安全形态」。
// 实测穿透口证明不成立——orderNo / confirmToken 的值**直接来自调用方入参**：
// 把手机号当 orderNo 调一次 get_order_status，ownership 拒绝路径就把这个完整识别值
// 经由 AUDIT_PLAIN_KEYS 白名单原样写进 access-audit.log。写侧同理（confirmToken → tokenId）。
// 前几轮的脱敏测试全是「审计条目 → 落盘」这一段的单元级断言，喂进去的值都是我们自己造的
// 合规形态，所以整条链路上「外部入参能不能顺着白名单穿出去」这个问题从没被问过。
// 本文件从**处理器入口**喂恶意值，只看落盘文件里的字节，把这个问题变成机器判据。
//
// 🚨 红线自证：
//   ① 零真实企迈调用——globalThis.fetch 被替换为计数 mock；不发请求的用例断言调用次数为 0。
//   ② WriteGuard / AccessAuditLogger / SessionStore / 只读审计路径四件套全部注入 mkdtemp 临时
//      目录，测试不碰生产 logs/；文件末尾 R7 用哈希快照把这条钉成机器判据。
//   ③ 识别值一律假值：假手机号 13800001234、假会员 ID 1234567890123456789 /
//      9876543210987654321、假订单号 D00281924556183175168（M1 真实订单号形态，非识别值）。
//
// R4/R5 是**防误杀**的对照实验，与 R1/R2/R3 走同一条处理器路径、只换值的形态：
// 审计的价值就在于订单号与令牌 ID 可核对，把它们一起脱敏等于把整本审计废掉。
//
// ---------------------------------------------------------------------------
// 第 4 项⑤ m1/m3 脚本探针（python 侧，无法在 node --test 里跑，验证过程记录在此）：
// 探针脚本 scratchpad/probe_py_sanitizers.py（纯本地、零网络、全假值），2026-08-18 实跑 24 项
// 断言全部通过，覆盖：
//   · m1.scrub_text：message 同时含假手机号 13800001234 / 19 位假会员 ID / 45 位假高熵串
//     → 三者都只剩尾四位（***1234 / ***6789 / ***1Vwx），订单号 D+20 位保持完整；
//   · m1.safe_print：同一条 message 经打印出口 → 输出同样只剩尾号（近百处 print 已统一
//     改走 safe_print，机器判据：grep -nE '^[[:space:]]*print\(' m1_scout_order.py 为空）；
//   · m1.scrub_deep：落盘出口 → 字符串与 **int 形态**的会员 ID/手机号都转尾号，
//     storeId 503542 / 金额 2400 / bool 不受伤，且「原对象未被就地修改」仍成立
//     （发给企迈的真实请求 params 一字不动）；
//   · m3.sanitize_message：补上 40+ 位高熵串后，三种形态全部只剩尾号，len= 前缀保留。
// 第二支探针 scratchpad/probe_m1_pipeline.py 走 m1 的**真实代码路径**（m1.call 换成 mock、
// m1.HERE 指向临时目录，零网络、不污染 二期侦察/），2026-08-18 实跑 23 项断言全部通过：
//   · resolve_identity 收到夹带识别值的企迈 message → 打印与**返回的 note** 都只剩尾号
//     （note 会一路进结果 JSON、施工令与 handoff，是这次三个穿透口里扩散面最大的一个）；
//   · save_result 的三个落盘出口（identity.note / order_request / confirm_result）实物落盘后
//     grep 不到任何完整假手机号、假会员 ID、45 位假高熵串，订单号 D+20 位完整保留；
//   · 🚨 红线双证：发给企迈的 params 里手机号仍是完整原值，且原 order_request 对象一字未改。
// 实跑输出留在本轮交付汇报里。
//
// 第二轮微补丁（2026-08-18，字母侧豁免取消）后两支探针重跑，断言按新口径更新并全部通过：
//   · m1.scrub_text / m1.safe_print / m1.scrub_deep 与 m3.sanitize_message 对
//     「探针ID1234567890123456789贴字母」一律只留尾号（旧口径下完整穿透）；
//   · 订单号形态的断言从「文本里保持完整」改为「数字段遮成 D***5168」——py 侧没有
//     mcp-server 那样的字段级白名单，落盘与打印的订单号都会遮尾号，后果已在
//     m1_scout_order.py 的 sanitizer 注释里如实登记并上报总工待裁决。
// ---------------------------------------------------------------------------

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setReadAuditLogPathForTesting, callWrite, WriteGuardRejected } from "../src/client.js";
import { WRITE_WHITELIST, ORDER_GUARD } from "../src/constants.js";
import { WriteGuard, setWriteGuardForTesting, sanitizeAuditRecord, AUDIT_PLAIN_KEYS } from "../src/writeGuard.js";
import { AccessAuditLogger, setAccessAuditLoggerForTesting } from "../src/accessAudit.js";
import { SessionStore, setSessionStoreForTesting, DEFAULT_SESSION_KEY } from "../src/session.js";
import { PendingOrderStore, setPendingOrderStoreForTesting } from "../src/pendingOrders.js";
import { getOrderStatusHandler } from "../src/orderStatusTool.js";
import { prepareOrderHandler } from "../src/prepareOrderTool.js";
import { placeOrderConfirmedHandler, placeOrderHandler } from "../src/placeOrderTool.js";

process.env.QMAI_OPEN_KEY ??= "test-open-key-0123456789abcdef0123456789ab";
process.env.QMAI_OPEN_ID ??= "test-open-id-0000000000000000";
process.env.QMAI_GRANT_CODE ??= "test-grant-code-0000000000";

// 一期读侧审计（client.ts 的 audit()）不随四件套注入，模块顶层统一指向临时目录，
// 理由同 orderStatus.test.ts：否则 callRead 会往生产 logs/audit.log 追加行。
setReadAuditLogPathForTesting(join(mkdtempSync(join(tmpdir(), "licha-read-audit-hsan-")), "audit.log"));

const FAKE_PHONE = "13800001234"; // 假手机号（尾号 1234）
const BOUND_MEMBER_ID = "1234567890123456789"; // 19 位假会员 ID：本会话绑定方（尾号 6789）
const OTHER_MEMBER_ID = "9876543210987654321"; // 19 位假会员 ID：他人（尾号 4321）
const REAL_FORMAT_ORDER_NO = "D00281924556183175168"; // D + 20 位数字，M1 实测订单号形态
const REAL_FORMAT_TOKEN_ID = "a1b2c3d4e5f60718293a4b5c6d7e8f90"; // 32 位 hex，本地令牌签发形态
const realFetch = globalThis.fetch;

function freshAccessAudit(): { logger: AccessAuditLogger; logPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "licha-hsan-access-"));
  const logPath = join(dir, "access-audit.log");
  return { logger: new AccessAuditLogger({ logPath }), logPath };
}

function freshWriteGuard(): { guard: WriteGuard; auditLogPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "licha-hsan-write-"));
  const auditLogPath = join(dir, "write-audit.log");
  return { guard: new WriteGuard({ auditLogPath, placedOrdersPath: join(dir, "placed-orders.json") }), auditLogPath };
}

/** 只计数、只回固定响应体的 fetch mock。写路径一次都不该被碰到。 */
function installFetchSpy(body: string): { count: () => number; restore: () => void } {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  return { count: () => calls, restore: () => { globalThis.fetch = realFetch; } };
}

function boundSessionStore(customerId: string): SessionStore {
  const store = new SessionStore();
  store.bind(DEFAULT_SESSION_KEY, { customerId, boundAt: Date.now(), boundVia: "phone" });
  return store;
}

function lastLine(path: string): { raw: string; obj: any } {
  const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  const raw = lines[lines.length - 1];
  return { raw, obj: JSON.parse(raw) };
}

// ============================================================================
// R1：恶意 orderNo（假手机号）→ get_order_status 的 ownership 拒绝路径 → access-audit 只留尾号
// ============================================================================
test("R1: 把假手机号当 orderNo 调 get_order_status → access-audit 落盘只剩尾号，无完整号码", async () => {
  setSessionStoreForTesting(boundSessionStore(BOUND_MEMBER_ID));
  const { logger, logPath } = freshAccessAudit();
  setAccessAuditLoggerForTesting(logger);
  // 6.1.5 mock：单子属于别人 → assertOrderOwnership 判 mismatch，走 audit.record 的拒绝分支。
  const spy = installFetchSpy(`{"status":true,"code":0,"data":{"status":10,"userId":${OTHER_MEMBER_ID}}}`);
  try {
    const result = await getOrderStatusHandler({ orderNo: FAKE_PHONE });
    assert.strictEqual(result.isError, true, "应被 ownership 校验拒绝");
    assert.strictEqual(spy.count(), 1, "6.1.5 是只读接口，发一次；写路径零调用");

    const { raw, obj } = lastLine(logPath);
    assert.strictEqual(obj.event, "ownership_mismatch", "确认命中的正是拒绝路径（不是别的分支）");
    assert.ok(!raw.includes(FAKE_PHONE), "落盘整行不得出现完整手机号——这就是本补丁前的穿透口");
    assert.strictEqual(obj.orderNo, "***1234", "orderNo 位置的手机号只留尾四位");
    assert.ok(!raw.includes(OTHER_MEMBER_ID), "响应里他人的完整会员 ID 同样不得落盘");
    assert.strictEqual(obj.customerIdLast4, "***6789", "绑定方会员 ID 照旧只留尾号");
  } finally {
    spy.restore();
    setSessionStoreForTesting(null);
    setAccessAuditLoggerForTesting(null);
  }
});

// ============================================================================
// R2：恶意 confirmToken（假手机号）→ place_order 的 PendingOrderNotFound → write-audit 只留尾号
// ============================================================================
test("R2: 把假手机号当 confirmToken 调 place_order → write-audit 落盘只剩尾号，且请求未发出", async () => {
  setSessionStoreForTesting(boundSessionStore(BOUND_MEMBER_ID));
  setPendingOrderStoreForTesting(new PendingOrderStore()); // 空仓 → lookup 必然 notFound
  const { guard, auditLogPath } = freshWriteGuard();
  setWriteGuardForTesting(guard);
  const spy = installFetchSpy('{"status":true,"code":0,"data":{}}');
  try {
    const result = await placeOrderConfirmedHandler({ confirmToken: FAKE_PHONE, confirmAmountYuan: 24 });
    assert.strictEqual(result.isError, true, "无效令牌应被拒");
    assert.strictEqual(spy.count(), 0, "🚨 令牌校验在 fetch 之前，任何请求都不许发出");

    const { raw, obj } = lastLine(auditLogPath);
    assert.strictEqual(obj.reason, "PendingOrderNotFound", "确认命中的正是工单指定的拒绝路径");
    assert.ok(!raw.includes(FAKE_PHONE), "落盘整行不得出现完整手机号");
    assert.strictEqual(obj.tokenId, "***1234", "tokenId 位置的手机号只留尾四位");
    assert.strictEqual(obj.path, WRITE_WHITELIST[0], "path 是白名单成员，照旧完整（审计骨架不能糊）");
  } finally {
    spy.restore();
    setSessionStoreForTesting(null);
    setPendingOrderStoreForTesting(null);
    setWriteGuardForTesting(null);
  }
});

// ============================================================================
// R3：恶意 orderNo（19 位假会员 ID）→ 同样只留尾号
// ============================================================================
test("R3: 把 19 位假会员 ID 当 orderNo 调 get_order_status → access-audit 只剩尾号", async () => {
  setSessionStoreForTesting(boundSessionStore(BOUND_MEMBER_ID));
  const { logger, logPath } = freshAccessAudit();
  setAccessAuditLoggerForTesting(logger);
  const spy = installFetchSpy(`{"status":true,"code":0,"data":{"status":10,"userId":${OTHER_MEMBER_ID}}}`);
  try {
    const result = await getOrderStatusHandler({ orderNo: OTHER_MEMBER_ID });
    assert.strictEqual(result.isError, true);
    const { raw, obj } = lastLine(logPath);
    assert.strictEqual(obj.event, "ownership_mismatch");
    assert.ok(!raw.includes(OTHER_MEMBER_ID), "19 位会员 ID 不得以任何形式完整落盘");
    assert.strictEqual(obj.orderNo, "***4321", "orderNo 位置的会员 ID 只留尾四位");
  } finally {
    spy.restore();
    setSessionStoreForTesting(null);
    setAccessAuditLoggerForTesting(null);
  }
});

// ============================================================================
// R4：正式格式订单号 D + 20 位，来源仍是调用方入参 → 同样只留尾号
// ============================================================================
// 第三轮微补丁改了这条的口径。改前它断言「格式合法 → 完整落盘」，那是把明文权交给了值的
// 长相；Codex 微验用「19 位假会员 ID 补个 D 前缀凑成 D+20 位」直接骗过去了。裁决：明文权
// 改由来源授予，本路径的 orderNo 是调用方入参 → 一律遮。
// 「防误杀」的职责移交给 S4/S5 两条——它们守的是真正有明文权的来源（本地签发的令牌、
// 企迈响应回传的单号），而不是"长得像"。
test("R4: 正式格式 orderNo（D+20 位）但来源是入参 → 同样只留尾号（明文权看来源不看长相）", async () => {
  setSessionStoreForTesting(boundSessionStore(BOUND_MEMBER_ID));
  const { logger, logPath } = freshAccessAudit();
  setAccessAuditLoggerForTesting(logger);
  const spy = installFetchSpy(`{"status":true,"code":0,"data":{"status":10,"userId":${OTHER_MEMBER_ID}}}`);
  try {
    const result = await getOrderStatusHandler({ orderNo: REAL_FORMAT_ORDER_NO });
    assert.strictEqual(result.isError, true, "仍走 ownership 拒绝路径（与 R1/R3 唯一的差别是值的形态）");
    const { obj } = lastLine(logPath);
    assert.strictEqual(obj.orderNo, "***5168", "格式再合法也不给明文：这一支的 orderNo 来自调用方入参");
    assert.match(obj.time, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \+08:00$/, "time 骨架字段格式合规、照旧完整");
    assert.match(obj.dateKey, /^\d{4}-\d{2}-\d{2}$/, "dateKey 同上");
  } finally {
    spy.restore();
    setSessionStoreForTesting(null);
    setAccessAuditLoggerForTesting(null);
  }
});

// ============================================================================
// R5：32 位 hex 令牌形态，但登记表从没见过（lookup=absent）→ 同样只留尾号
// ============================================================================
// 同 R4：第三轮微补丁把明文权从"长相"换成"来源"。32 位 hex 谁都拼得出来，
// 登记表没有这张令牌就说明它不是我们签发的（或已随过期被 prune 清掉）→ 不给明文。
// 真令牌的明文权由 S4 守（lookup=expired）。
test("R5: 32 位 hex 令牌形态但 lookup=absent → 只留尾号（不是本地签发的就没有明文权）", async () => {
  setSessionStoreForTesting(boundSessionStore(BOUND_MEMBER_ID));
  setPendingOrderStoreForTesting(new PendingOrderStore());
  const { guard, auditLogPath } = freshWriteGuard();
  setWriteGuardForTesting(guard);
  const spy = installFetchSpy('{"status":true,"code":0,"data":{}}');
  try {
    const result = await placeOrderConfirmedHandler({ confirmToken: REAL_FORMAT_TOKEN_ID, confirmAmountYuan: 24 });
    assert.strictEqual(result.isError, true, "令牌不存在仍被拒（与 R2 唯一的差别是值的形态）");
    assert.strictEqual(spy.count(), 0);
    const { obj, raw } = lastLine(auditLogPath);
    assert.strictEqual(obj.reason, "PendingOrderNotFound");
    assert.strictEqual(obj.tokenId, "***8f90", "登记表没见过它 → 来源未证实，只留尾号");
    assert.ok(!raw.includes(REAL_FORMAT_TOKEN_ID), "整行不得出现这串调用方自带的完整值");
  } finally {
    spy.restore();
    setSessionStoreForTesting(null);
    setPendingOrderStoreForTesting(null);
    setWriteGuardForTesting(null);
  }
});

// ============================================================================
// R6：白名单双校验的结构性自证（逐键格式不符 → 掉回 sanitizer；原型链键不放行）
// ============================================================================
// 这条守的是「将来有人加白名单键忘了加值格式校验」——编译期与启动期两道闸之外的第三道
// （行为级）：每个白名单键都喂一个"名字对、格式不对"的恶意值，一个都不许明文放行。
test("R6: AUDIT_PLAIN_KEYS 逐键喂格式不符的恶意值 → 全部脱敏；Object 原型链上的键不被放行", () => {
  const probes: Record<string, unknown> = {
    orderNo: FAKE_PHONE, // 名字对，格式不对（不是 D+16~24 位数字）
    tokenId: OTHER_MEMBER_ID, // 不是 32 位 hex
    idempotencyKey: FAKE_PHONE, // 不是 64 位 hex
    resolvedKeys: [OTHER_MEMBER_ID], // 数组元素不是 sha256
    path: `v3/order/status?phone=${FAKE_PHONE}`, // 不是白名单成员（典型的 query 夹带形态）
    time: `随手写的时间 ${OTHER_MEMBER_ID}`, // 不是北京时间戳格式
    dateKey: OTHER_MEMBER_ID, // 不是 YYYY-MM-DD
    customerKey: OTHER_MEMBER_ID, // 不是 16 位 hex（真值是 sha256(userId) 前 16 位）
  };
  // 覆盖完整性：白名单里每一个键都在探针里被测到，将来加键漏测会在这里失败。
  for (const key of AUDIT_PLAIN_KEYS) {
    assert.ok(key in probes, `白名单键 ${key} 没有对应探针：加键必须同时补探针与值格式校验`);
  }
  const out = JSON.stringify(sanitizeAuditRecord(probes));
  assert.ok(!out.includes(FAKE_PHONE), "任何白名单键都不得让完整手机号明文穿出");
  assert.ok(!out.includes(OTHER_MEMBER_ID), "任何白名单键都不得让完整会员 ID 明文穿出");

  // 原型链：一条名为 toString / constructor 的字段，不许因为「在 Object.prototype 上取到了
  // 同名函数」而被误判成有校验函数、进而明文放行（查表故意用 Map 而不是对象取属性）。
  const proto = sanitizeAuditRecord({ toString: FAKE_PHONE, constructor: OTHER_MEMBER_ID }) as Record<string, unknown>;
  assert.strictEqual(proto.toString, "***1234", "toString 字段照普通字段脱敏");
  assert.strictEqual(proto.constructor, "***4321", "constructor 字段照普通字段脱敏");
});

// ============================================================================
// R8：字母紧贴 15+ 位数字（总工探针形态）→ 处理器级同样只留尾号
// ============================================================================
// P-W2 第二轮微补丁的正面回归。被打穿的旧口径：LONG_DIGITS_RE 的负向断言连**字母侧**一起
// 豁免（(?<![0-9A-Za-z])），本意是保住文本里的订单号，实测放行了「字母贴会员 ID」——
// 企迈英文键名回显（ID/no/uid 后面直接跟号）是这种形态最常见的来源。豁免取消后只看数字侧。
test("R8: 字母紧贴 19 位假会员 ID 当 orderNo 调 get_order_status → 数字段只留尾号", async () => {
  setSessionStoreForTesting(boundSessionStore(BOUND_MEMBER_ID));
  const { logger, logPath } = freshAccessAudit();
  setAccessAuditLoggerForTesting(logger);
  const spy = installFetchSpy(`{"status":true,"code":0,"data":{"status":10,"userId":${OTHER_MEMBER_ID}}}`);
  try {
    // orderNo 位置塞「ID + 19 位假会员 ID」：既不是合法订单号格式（白名单双校验不放行），
    // 又是字母紧贴长数字（旧口径的漏网形态）。
    const result = await getOrderStatusHandler({ orderNo: `ID${OTHER_MEMBER_ID}` });
    assert.strictEqual(result.isError, true);
    const { raw, obj } = lastLine(logPath);
    assert.strictEqual(obj.event, "ownership_mismatch");
    assert.ok(!raw.includes(OTHER_MEMBER_ID), "字母紧贴也不许让完整会员 ID 落盘（第二轮被打穿的口）");
    // 第三轮微补丁后这一支先过来源判定（入参 → 整值遮成尾四位），比第二轮的正则层更早生效，
    // 所以落盘是 "***4321" 而不是 "ID***4321"。正则层仍在（见 R9 的单元级断言），只是轮不到它。
    assert.strictEqual(obj.orderNo, "***4321", "来源判定层先生效：入参来源整值只留尾四位");
  } finally {
    spy.restore();
    setSessionStoreForTesting(null);
    setAccessAuditLoggerForTesting(null);
  }
});

// ============================================================================
// R9：自由文本 reason 里的「字母贴长数字」→ 尾号；同一条记录的白名单 orderNo → 全值
// ============================================================================
// 总工探针的原样复现（reason 文本「探针ID1234567890123456789贴字母」），外加本轮裁决依据的
// 正面自证：订单号的审计价值由白名单 orderNo 字段承接，所以「文本遮尾号」与「字段留全值」
// 必须在同一条记录里同时成立——缺后者，遮文本就是真的在削弱审计。
test("R9: reason 含字母贴 19 位假 ID → 只留尾号；白名单 orderNo（D+20 位）同条记录仍完整", () => {
  const { guard, auditLogPath } = freshWriteGuard();
  guard.recordAudit({
    path: WRITE_WHITELIST[0],
    result: "rejected",
    reason: `探针ID${OTHER_MEMBER_ID}贴字母`,
    orderNo: REAL_FORMAT_ORDER_NO,
    idempotencyKey: null,
    durationMs: 0,
  });
  const { raw, obj } = lastLine(auditLogPath);
  assert.ok(!raw.includes(OTHER_MEMBER_ID), "落盘整行不得出现完整会员 ID");
  assert.strictEqual(obj.reason, "探针ID***4321贴字母", "字母贴长数字的数字段只留尾四位");
  assert.strictEqual(obj.orderNo, REAL_FORMAT_ORDER_NO, "白名单 orderNo 字段仍是全值（审计价值在这里承接）");

  // 同一条口径下：自由文本里的订单号数字段被遮成 D***5168，仍能认出事件类型，
  // 要全值就回到 orderNo 字段取——这正是本轮裁决的依据成立的样子。
  guard.recordAudit({
    path: WRITE_WHITELIST[0],
    result: "rejected",
    reason: `DuplicateOf:${REAL_FORMAT_ORDER_NO}`,
    orderNo: REAL_FORMAT_ORDER_NO,
    idempotencyKey: null,
    durationMs: 0,
  });
  const { obj: obj2 } = lastLine(auditLogPath);
  assert.strictEqual(obj2.reason, "DuplicateOf:D***5168");
  assert.strictEqual(obj2.orderNo, REAL_FORMAT_ORDER_NO);
});

// ============================================================================
// S1-S5：来源判定（P-W2 第三轮微补丁）——明文权由「值从哪儿来」授予，不由「长得像不像」授予
// ============================================================================
//
// Codex 微验打穿的是格式校验层：19 位假会员 ID 补个 D 前缀 → D+20 位、变形成 32 位 hex →
// 冒充令牌 ID，格式全对所以完整落盘。根因是「值的长相由攻击者控制」，那条路上没有能守住的判据。
// 裁决后的判据：调用点声明来源——自己生成/服务端回传的值可留全值，调用方入参一律只留尾号。
// S1-S3 打伪装（三种合法形态），S4-S5 守防误杀（两种真有明文权的来源）。缺 S4/S5，这套判定
// 就只剩"全遮"，审计会失去排查力；缺 S1-S3，格式伪装照旧穿透。五条是一组，不能只留一半。

// ---------- 下单链路 fixture（S4/S5 用；结构对齐 m4ConfirmOrder.test.ts，那份文件不动） ----------
const PATH_DETAIL = "v3/goods/item/getShopGoodsDetail";
const PATH_CREATE = "v3/newPattern/cateringApiserver/post/order/v1/create";
const PATH_DETAIL_ORDER = "v3/order/standard/cyOrderDetail";
const STORE_ID = 503542; // 深圳湾万象城（公开门店编码，非识别值）

function goodsDetailFixture(goodsId: string): Record<string, unknown> {
  return {
    status: true,
    code: 0,
    data: [
      {
        goodsId,
        name: "测试奶茶",
        type: 1,
        status: 10,
        goodsSkuList: [
          {
            skuId: "1288634197263667200",
            salePrice: 2400,
            clearStatus: 1,
            inventory: 99,
            specName: "标准杯",
            skuItemList: [{ specValue: "标准杯" }],
          },
        ],
        sortedPracticeList: [
          {
            practiceId: "1123413139990425601",
            practiceName: "温度",
            isRequired: 1,
            practiceValueList: [{ practiceValueId: "1199823927794012164", practiceValue: "少冰（400ml)", price: 0, isDefault: 1 }],
          },
        ],
        attachGoodsList: [],
      },
    ],
  };
}

/** 按路径分发的 mock fetch 路由器，按路径分别计数——写路径的调用次数必须能单独断言。 */
function installRouter(routes: Record<string, Record<string, unknown>>): {
  countOf: (p: string) => number;
  restore: () => void;
} {
  const counts = new Map<string, number>();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) throw new Error(`mock 路由未覆盖的路径（说明代码调了预期之外的接口）：${url}`);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  }) as typeof fetch;
  return { countOf: (p) => counts.get(p) ?? 0, restore: () => { globalThis.fetch = realFetch; } };
}

/** 四件套 + 待确认单登记表全部注入临时实例；clock 可控，用来推进 TTL 而不真的等 5 分钟。 */
function installFullFixture(clock?: () => number): {
  pendingStore: PendingOrderStore;
  writeAuditPath: string;
  accessAuditPath: string;
  restore: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "licha-hsan-full-"));
  const writeAuditPath = join(dir, "write-audit.log");
  const accessAuditPath = join(dir, "access-audit.log");
  setWriteGuardForTesting(new WriteGuard({ auditLogPath: writeAuditPath, placedOrdersPath: join(dir, "placed-orders.json"), clock }));
  const pendingStore = new PendingOrderStore({ clock });
  setPendingOrderStoreForTesting(pendingStore);
  setSessionStoreForTesting(boundSessionStore(BOUND_MEMBER_ID));
  setAccessAuditLoggerForTesting(new AccessAuditLogger({ logPath: accessAuditPath }));
  setReadAuditLogPathForTesting(join(dir, "read-audit.log"));
  return {
    pendingStore,
    writeAuditPath,
    accessAuditPath,
    restore: () => {
      setWriteGuardForTesting(null);
      setPendingOrderStoreForTesting(null);
      setSessionStoreForTesting(null);
      setAccessAuditLoggerForTesting(null);
      setReadAuditLogPathForTesting(null);
      globalThis.fetch = realFetch;
    },
  };
}

// ============================================================================
// S1：D + 19 位假会员 ID 当 orderNo（差一位的伪装）→ 只留尾号
// ============================================================================
test("S1: orderNo 传「D + 19 位假会员 ID」→ access-audit 只留尾号", async () => {
  setSessionStoreForTesting(boundSessionStore(BOUND_MEMBER_ID));
  const { logger, logPath } = freshAccessAudit();
  setAccessAuditLoggerForTesting(logger);
  const spy = installFetchSpy(`{"status":true,"code":0,"data":{"status":10,"userId":${OTHER_MEMBER_ID}}}`);
  try {
    const result = await getOrderStatusHandler({ orderNo: `D${OTHER_MEMBER_ID}` });
    assert.strictEqual(result.isError, true);
    const { raw, obj } = lastLine(logPath);
    assert.strictEqual(obj.event, "ownership_mismatch");
    assert.ok(!raw.includes(OTHER_MEMBER_ID), "整行不得出现完整会员 ID");
    assert.strictEqual(obj.orderNo, "***4321");
  } finally {
    spy.restore();
    setSessionStoreForTesting(null);
    setAccessAuditLoggerForTesting(null);
  }
});

// ============================================================================
// S2：假会员 ID 补一位凑成 D + 20 位（格式校验完全通过的伪装）→ 只留尾号
// ============================================================================
// 这条就是 Codex 微验的原样复现：D + 20 位数字 = 白名单 orderNo 的合法形态，
// 格式层放行，唯一能挡住它的是来源判定。
test("S2: 假会员 ID 补一位凑成合法 D+20 位 orderNo → 仍只留尾号（格式层放行，来源层拦住）", async () => {
  setSessionStoreForTesting(boundSessionStore(BOUND_MEMBER_ID));
  const { logger, logPath } = freshAccessAudit();
  setAccessAuditLoggerForTesting(logger);
  const disguised = `D${OTHER_MEMBER_ID}0`; // D + 20 位：^D\d{16,24}$ 完全匹配
  const spy = installFetchSpy(`{"status":true,"code":0,"data":{"status":10,"userId":${OTHER_MEMBER_ID}}}`);
  try {
    const result = await getOrderStatusHandler({ orderNo: disguised });
    assert.strictEqual(result.isError, true);
    const { raw, obj } = lastLine(logPath);
    assert.ok(!raw.includes(OTHER_MEMBER_ID), "伪装成合法订单号也不许把会员 ID 带进落盘");
    assert.ok(!raw.includes(disguised), "整个伪装值都不该出现");
    assert.strictEqual(obj.orderNo, "***3210", "只留尾四位");
  } finally {
    spy.restore();
    setSessionStoreForTesting(null);
    setAccessAuditLoggerForTesting(null);
  }
});

// ============================================================================
// S3：假会员 ID 变形为 32 位 hex 当 confirmToken（lookup=absent）→ 只留尾号 + 零调用
// ============================================================================
test("S3: 假会员 ID 变形成 32 位 hex 当 confirmToken（lookup=absent）→ 只留尾号，请求零发出", async () => {
  setSessionStoreForTesting(boundSessionStore(BOUND_MEMBER_ID));
  setPendingOrderStoreForTesting(new PendingOrderStore());
  const { guard, auditLogPath } = freshWriteGuard();
  setWriteGuardForTesting(guard);
  // 19 位假会员 ID 补足到 32 位十六进制字符（^[0-9a-f]{32}$ 完全匹配），尾四位仍是 4321 的变形值
  const disguised = `${OTHER_MEMBER_ID}abcdef0123456`;
  assert.match(disguised, /^[0-9a-f]{32}$/, "构造的伪装值必须真的符合令牌 ID 格式，否则这条用例没意义");
  const spy = installFetchSpy('{"status":true,"code":0,"data":{}}');
  try {
    const result = await placeOrderConfirmedHandler({ confirmToken: disguised, confirmAmountYuan: 24 });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(spy.count(), 0, "🚨 令牌校验在 fetch 之前，任何请求都不许发出");
    const { raw, obj } = lastLine(auditLogPath);
    assert.strictEqual(obj.reason, "PendingOrderNotFound");
    assert.ok(!raw.includes(OTHER_MEMBER_ID), "整行不得出现完整会员 ID");
    assert.strictEqual(obj.tokenId, "***3456", "格式合法但登记表没见过 → 只留尾四位");
  } finally {
    spy.restore();
    setSessionStoreForTesting(null);
    setPendingOrderStoreForTesting(null);
    setWriteGuardForTesting(null);
  }
});

// ============================================================================
// S4（防误杀）：本地真实签发的令牌过期（lookup=expired）→ 审计 tokenId 仍是全值
// ============================================================================
// expired 意味着登记表确实签发过它——值是本地 randomBytes 生成的，不可能是伪装的识别值。
// 「哪张令牌超时了」是真实排查需求，遮成尾号就对不上 prepare_order 那侧的记录。
test("S4: 真实签发的令牌推进时钟至过期（lookup=expired）→ write-audit 的 tokenId 仍完整", async () => {
  let now = 1_760_000_000_000; // 固定基准，不用 Date.now()，避免用例随时间漂
  const fx = installFullFixture(() => now);
  const router = installRouter({ [PATH_DETAIL]: goodsDetailFixture("1200000000000000901") });
  try {
    const prep = await prepareOrderHandler({ storeId: STORE_ID, items: [{ goodsId: "1200000000000000901", quantity: 1 }] });
    const token = JSON.parse(prep.content[0].text).confirmToken as string;
    assert.match(token, /^[0-9a-f]{32}$/, "prepare_order 应签发 32 位 hex 令牌");
    assert.strictEqual(fx.pendingStore.lookup(token).status, "ok", "刚签发时应命中");

    now += ORDER_GUARD.confirmTokenTtlMs + 1000; // 推进时钟越过 5 分钟 TTL
    assert.strictEqual(fx.pendingStore.lookup(token).status, "expired", "推进后应判为过期而非 absent");

    const result = await placeOrderConfirmedHandler({ confirmToken: token, confirmAmountYuan: 24 });
    assert.strictEqual(result.isError, true, "过期令牌应被拒");
    assert.strictEqual(router.countOf(PATH_CREATE), 0, "🚨 过期令牌不许发出写请求");
    const { obj } = lastLine(fx.writeAuditPath);
    assert.strictEqual(obj.reason, "PendingOrderExpired");
    assert.strictEqual(obj.tokenId, token, "本地签发过的令牌留全值——排查「哪张令牌超时」要用它");
  } finally {
    router.restore();
    fx.restore();
  }
});

// ============================================================================
// S5（防误杀）：下单成功后读回归属不符 → access-audit 的 orderNo 仍是全值
// ============================================================================
// 这条走完整链路（prepare_order → place_order → callWrite 真发 mock → 6.1.9 读回），
// 读回的 orderNo 来自企迈响应（服务端来源，调用方碰不到）→ 留全值。
// 「自己刚下的单读回来却不属于自己」是必须人工追到底的异常，遮了单号就查不动。
test("S5: 正常下单链路读回 ownership_mismatch（6.1.9 回显他人 userId）→ access-audit 的 orderNo 仍完整", async () => {
  const fx = installFullFixture();
  const SERVER_ORDER_NO = "D00281924556183179999"; // 企迈响应回传的单号（服务端来源）
  const router = installRouter({
    [PATH_DETAIL]: goodsDetailFixture("1200000000000000902"),
    [PATH_CREATE]: { status: true, code: 0, message: "创建订单成功", data: { orderNo: SERVER_ORDER_NO, payAmount: 24.0, needPay: 1 } },
    // 读回回显**他人** userId → readbackOrder 内的 ownership_mismatch
    [PATH_DETAIL_ORDER]: {
      status: true,
      code: 0,
      data: { orderNo: SERVER_ORDER_NO, orderStatus: 10, userId: OTHER_MEMBER_ID, actualAmount: 2400, totalAmount: 2400 },
    },
  });
  try {
    const prep = await prepareOrderHandler({ storeId: STORE_ID, items: [{ goodsId: "1200000000000000902", quantity: 1 }] });
    const token = JSON.parse(prep.content[0].text).confirmToken as string;
    const result = await placeOrderConfirmedHandler({ confirmToken: token, confirmAmountYuan: 24 });
    assert.strictEqual(result.isError ?? false, false, `下单本身应成功：${result.content[0].text}`);
    const out = JSON.parse(result.content[0].text);
    assert.strictEqual(out.readbackFailed, true, "读回归属不符应标记失败");
    assert.strictEqual(router.countOf(PATH_CREATE), 1, "🚨 写请求恰好一次，绝不重试");

    const { raw, obj } = lastLine(fx.accessAuditPath);
    assert.strictEqual(obj.event, "ownership_mismatch");
    assert.match(obj.reason, /^readback_/, "确认命中的是读回那一支（不是 get_order_status 那支）");
    assert.strictEqual(obj.orderNo, SERVER_ORDER_NO, "服务端来源的单号留全值——这条异常靠它追");
    assert.ok(!raw.includes(OTHER_MEMBER_ID), "他人的完整会员 ID 照旧不许落盘（脱敏层仍在工作）");
    assert.strictEqual(obj.customerIdLast4, "***6789");
  } finally {
    router.restore();
    fx.restore();
  }
});

// ============================================================================
// T1-T4：导出面封口（P-W2 第四轮微补丁）——明文授予权收敛到 callWrite 的唯一判定点
// ============================================================================
//
// 前三轮把 MCP 协议入口（模型能看见的那几个工具）逐个堵住了，但这个包是公开库：任何人
// `import { placeOrderHandler, callWrite }` 就绕过了协议层，直接踩在旧导出与写通道上。
// Codex 终验点出的三条残留路径都在这个面上：旧 handler 的 UserIdInOrderParams 与
// TokenNotFound、以及直接调 callWrite。
//
// 修法不是再逐个调用点补脱敏（那条路的正确性依赖人的自觉，多一个入口就多一个漏点），
// 而是把明文授予权收敛到 callWrite 构造 auditBase 的那一处——它是 callWrite 内全部审计
// 路径的公共底座，封住它等于封住整条写通道。判据仍是第三轮那条：来源，不是长相。
// T1-T3 打伪装（同一串合格的 32 位 hex，内嵌 19 位假会员 ID），T4 守防误杀（真令牌全值）。

// 32 位 hex 的伪装令牌：前 19 位就是假会员 ID，后 13 位补足格式（尾四位 3456）。
// 格式校验层完全放行——能挡住它的只有「令牌仓库里查不到」这个来源判据。
const DISGUISED_TOKEN = `${OTHER_MEMBER_ID}abcdef0123456`;

/** callWrite 直调用的最小合法参数（storeId 是公开门店编码，非识别值）。 */
function minimalOrderParams(): Record<string, unknown> {
  return { storeId: STORE_ID, orderType: 1, source: 18, items: [{ goodsId: "1200000000000000801", num: 1 }] };
}

// ============================================================================
// T1：伪装 token 直调旧导出 placeOrderHandler → UserIdInOrderParams 拒绝路径
// ============================================================================
test("T1: 伪装 token 直调旧 placeOrderHandler（orderParams 带 userId）→ 写审计只留尾号，fetch 零调用", async () => {
  assert.match(DISGUISED_TOKEN, /^[0-9a-f]{32}$/, "伪装值必须真的符合令牌格式，否则这条用例没意义");
  const { guard, auditLogPath } = freshWriteGuard();
  setWriteGuardForTesting(guard);
  const spy = installFetchSpy('{"status":true,"code":0,"data":{}}');
  try {
    const result = await placeOrderHandler({
      confirmToken: DISGUISED_TOKEN,
      amountFen: 2400,
      orderParams: { storeId: STORE_ID, userId: OTHER_MEMBER_ID },
    });
    assert.strictEqual(result.isError, true, "orderParams 带 userId 应被黑名单拒");
    assert.strictEqual(spy.count(), 0, "🚨 这一步在 callWrite 之前，任何请求都不许发出");
    const { raw, obj } = lastLine(auditLogPath);
    assert.match(obj.reason, /^UserIdInOrderParams:/, "确认命中的正是这条残留路径");
    assert.ok(!raw.includes(DISGUISED_TOKEN), "落盘整行不得出现完整伪装 token");
    assert.ok(!raw.includes(OTHER_MEMBER_ID), "内嵌的完整会员 ID 同样不得出现");
    assert.strictEqual(obj.tokenId, "***3456", "未经任何本地验证的入参 token → 只留尾四位");
  } finally {
    spy.restore();
    setWriteGuardForTesting(null);
  }
});

// ============================================================================
// T2：伪装 token 直调旧 handler → 走进 callWrite 命中 TokenNotFound
// ============================================================================
// 与 T1 的差别只在 orderParams 不带 userId：于是穿过黑名单、穿过绑定检查，一路走到
// callWrite 的令牌四项校验。这条路径的审计由 auditBase 派生，验的是第 2 项那处封口。
test("T2: 伪装 token 直调旧 placeOrderHandler → callWrite 判 TokenNotFound，审计只留尾号，fetch 零调用", async () => {
  setSessionStoreForTesting(boundSessionStore(BOUND_MEMBER_ID));
  const { guard, auditLogPath } = freshWriteGuard();
  setWriteGuardForTesting(guard);
  const spy = installFetchSpy('{"status":true,"code":0,"data":{}}');
  try {
    const result = await placeOrderHandler({
      confirmToken: DISGUISED_TOKEN,
      amountFen: 2400,
      orderParams: minimalOrderParams(),
    });
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /TokenNotFound/, "确认命中的是令牌四项校验的第一项");
    assert.strictEqual(spy.count(), 0, "🚨 令牌校验在 fetch 之前，请求不许发出");
    const { raw, obj } = lastLine(auditLogPath);
    assert.strictEqual(obj.reason, "TokenNotFound");
    assert.ok(!raw.includes(DISGUISED_TOKEN), "落盘整行不得出现完整伪装 token");
    assert.ok(!raw.includes(OTHER_MEMBER_ID), "内嵌的完整会员 ID 同样不得出现");
    assert.strictEqual(obj.tokenId, "***3456");
    assert.match(obj.idempotencyKey, /^[0-9a-f]{64}$/, "幂等键照旧完整（本地 sha256，不是识别值）");
  } finally {
    spy.restore();
    setSessionStoreForTesting(null);
    setWriteGuardForTesting(null);
  }
});

// ============================================================================
// T3：伪装 token 直调导出的 callWrite（完全绕开工具层）
// ============================================================================
test("T3: 伪装 token 直调导出的 callWrite → TokenNotFound 拒，审计只留尾号，fetch 零调用", async () => {
  const { guard, auditLogPath } = freshWriteGuard();
  setWriteGuardForTesting(guard);
  const spy = installFetchSpy('{"status":true,"code":0,"data":{}}');
  try {
    await assert.rejects(
      () => callWrite(WRITE_WHITELIST[0], minimalOrderParams(), { amountFen: 2400, confirmToken: DISGUISED_TOKEN }),
      (e: unknown) => e instanceof WriteGuardRejected && /TokenNotFound/.test((e as Error).message),
      "直调 callWrite 也必须被令牌校验拦下",
    );
    assert.strictEqual(spy.count(), 0, "🚨 请求不许发出");
    const { raw, obj } = lastLine(auditLogPath);
    assert.strictEqual(obj.reason, "TokenNotFound");
    assert.ok(!raw.includes(DISGUISED_TOKEN));
    assert.ok(!raw.includes(OTHER_MEMBER_ID));
    assert.strictEqual(obj.tokenId, "***3456", "封口在 auditBase，直调 callWrite 也自动安全");
  } finally {
    spy.restore();
    setWriteGuardForTesting(null);
  }
});

// ============================================================================
// T4（防误杀）：本地真实签发的令牌走 callWrite → 成功路径与重放路径都留全值
// ============================================================================
// isLocallyIssued 查的是令牌仓库：真令牌在库里 → 全值。第二段刻意验「已用、未过期」这一态——
// pruneExpiredTokens 保留这类记录，所以 TokenAlreadyUsed 的重放审计仍能留全值，
// 「哪张令牌被重放了」是真实排查需求，不能连它也遮掉。
test("T4: 真实签发令牌走 callWrite（成功 + TokenAlreadyUsed 重放）→ 审计 tokenId 全值", async () => {
  const { guard, auditLogPath } = freshWriteGuard();
  setWriteGuardForTesting(guard);
  const params = minimalOrderParams();
  const { tokenId } = guard.issueConfirmToken(params); // 本地签发：值进了令牌仓库
  assert.match(tokenId, /^[0-9a-f]{32}$/);
  assert.strictEqual(guard.isLocallyIssued(tokenId), true, "刚签发的令牌应判为本地签发");
  assert.strictEqual(guard.isLocallyIssued(DISGUISED_TOKEN), false, "外部伪装值必然判 false");
  const spy = installFetchSpy('{"status":true,"code":0,"message":"创建订单成功","data":{"orderNo":"D00281924556183178888","payAmount":24.0,"needPay":1}}');
  try {
    // —— 第一段：成功路径 ——
    const result = await callWrite(WRITE_WHITELIST[0], params, { amountFen: 2400, confirmToken: tokenId });
    assert.strictEqual(result.ok, true, "护栏全过应成功");
    assert.strictEqual(spy.count(), 1, "真实请求恰好发出一次（mock，零真调）");
    const { obj } = lastLine(auditLogPath);
    assert.strictEqual(obj.result, "allowed");
    assert.strictEqual(obj.tokenId, tokenId, "本地签发 → 全值：排查「这张单凭哪张令牌下的」要用它");

    // —— 第二段：同一令牌重放 → TokenAlreadyUsed（consumeToken 已标记，且记录未过期仍在库） ——
    await assert.rejects(
      () => callWrite(WRITE_WHITELIST[0], params, { amountFen: 2400, confirmToken: tokenId }),
      (e: unknown) => e instanceof WriteGuardRejected && /TokenAlreadyUsed/.test((e as Error).message),
    );
    assert.strictEqual(spy.count(), 1, "🚨 重放不许再发第二次请求");
    assert.strictEqual(guard.isLocallyIssued(tokenId), true, "已用但未过期 → 仍算本地签发");
    const { obj: obj2 } = lastLine(auditLogPath);
    assert.strictEqual(obj2.reason, "TokenAlreadyUsed");
    assert.strictEqual(obj2.tokenId, tokenId, "重放审计同样留全值——「哪张令牌被重放」要能查");
  } finally {
    spy.restore();
    setWriteGuardForTesting(null);
  }
});

// ============================================================================
// R7：本文件跑完，生产 logs/ 目录哈希快照不变
// ============================================================================
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

test("R7: 生产 logs/ 快照已登记，收尾钩子会比对（本条用例本身只做登记）", () => {
  assert.ok(LOGS_SNAPSHOT_AT_START.length > 0, "快照应已在模块加载时取得");
});
