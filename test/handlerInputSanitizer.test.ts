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
// ---------------------------------------------------------------------------

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setReadAuditLogPathForTesting } from "../src/client.js";
import { WRITE_WHITELIST } from "../src/constants.js";
import { WriteGuard, setWriteGuardForTesting, sanitizeAuditRecord, AUDIT_PLAIN_KEYS } from "../src/writeGuard.js";
import { AccessAuditLogger, setAccessAuditLoggerForTesting } from "../src/accessAudit.js";
import { SessionStore, setSessionStoreForTesting, DEFAULT_SESSION_KEY } from "../src/session.js";
import { PendingOrderStore, setPendingOrderStoreForTesting } from "../src/pendingOrders.js";
import { getOrderStatusHandler } from "../src/orderStatusTool.js";
import { placeOrderConfirmedHandler } from "../src/placeOrderTool.js";

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
// R4（防误杀）：正式格式订单号 D + 20 位 → 照旧完整落盘
// ============================================================================
test("R4: 正式格式 orderNo（D+20 位）走同一条拒绝路径 → 完整落盘，排查价值不丢", async () => {
  setSessionStoreForTesting(boundSessionStore(BOUND_MEMBER_ID));
  const { logger, logPath } = freshAccessAudit();
  setAccessAuditLoggerForTesting(logger);
  const spy = installFetchSpy(`{"status":true,"code":0,"data":{"status":10,"userId":${OTHER_MEMBER_ID}}}`);
  try {
    const result = await getOrderStatusHandler({ orderNo: REAL_FORMAT_ORDER_NO });
    assert.strictEqual(result.isError, true, "仍走 ownership 拒绝路径（与 R1/R3 唯一的差别是值的形态）");
    const { obj } = lastLine(logPath);
    assert.strictEqual(obj.orderNo, REAL_FORMAT_ORDER_NO, "合法订单号必须完整——脱敏了整本审计就没用了");
    assert.match(obj.time, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \+08:00$/, "time 骨架字段格式合规、照旧完整");
    assert.match(obj.dateKey, /^\d{4}-\d{2}-\d{2}$/, "dateKey 同上");
  } finally {
    spy.restore();
    setSessionStoreForTesting(null);
    setAccessAuditLoggerForTesting(null);
  }
});

// ============================================================================
// R5（防误杀）：32 位 hex 令牌 ID → 照旧完整落盘
// ============================================================================
test("R5: 正式格式 tokenId（32 位 hex）走同一条写侧拒绝路径 → 完整落盘", async () => {
  setSessionStoreForTesting(boundSessionStore(BOUND_MEMBER_ID));
  setPendingOrderStoreForTesting(new PendingOrderStore());
  const { guard, auditLogPath } = freshWriteGuard();
  setWriteGuardForTesting(guard);
  const spy = installFetchSpy('{"status":true,"code":0,"data":{}}');
  try {
    const result = await placeOrderConfirmedHandler({ confirmToken: REAL_FORMAT_TOKEN_ID, confirmAmountYuan: 24 });
    assert.strictEqual(result.isError, true, "令牌不存在仍被拒（与 R2 唯一的差别是值的形态）");
    assert.strictEqual(spy.count(), 0);
    const { obj } = lastLine(auditLogPath);
    assert.strictEqual(obj.reason, "PendingOrderNotFound");
    assert.strictEqual(obj.tokenId, REAL_FORMAT_TOKEN_ID, "合法令牌 ID 必须完整——它是排查「这张单被谁确认过」的抓手");
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
