// G2 收口门：账本写不进去就不许发单；重启后账本不得归零（整改任务书 23 号 §3 G2，验收反例 1-5）。
//
// 这本账本（write-audit.log + placed-orders.json）不是日志，是护栏本身：未决闸门、当日额度、
// 幂等去重三条防线全靠它在重启后恢复。改造前它的读写失败一律被 catch 吞掉、按「新装机零账本」
// 继续跑——21 号用 /dev/full、盲审用「把账本路径设成目录」都复现同一个现象：请求放行一次、
// 活进程计数 1、重建后计数 0、未决 false（22 号 F02）。那本该是最需要账本的时刻，恰恰是账本
// 什么都没留下的时刻。
//
// 本文件每条用例对应任务书 §3 G2 的一条验收反例，用例名带 G2-n 编号。
//
// 🚨 红线自证：globalThis.fetch 全程被 mock 替换，绝不发出真实 HTTP 请求；6.2.9 创建路径的
// 调用次数单独计数（「不许发单」这条断言必须精确到写路径）。全部文件落 mkdtemp 临时目录。

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callRead, callWrite, setReadAuditLogPathForTesting } from "../src/client.js";
import { WRITE_WHITELIST } from "../src/constants.js";
import {
  WriteGuard,
  setWriteGuardForTesting,
  beijingDateKey,
  beijingTimeString,
  customerCountKey,
  fingerprint,
} from "../src/writeGuard.js";
import { SessionStore, setSessionStoreForTesting, DEFAULT_SESSION_KEY } from "../src/session.js";
import { AccessAuditLogger, setAccessAuditLoggerForTesting } from "../src/accessAudit.js";
import { PendingOrderStore, setPendingOrderStoreForTesting } from "../src/pendingOrders.js";
import { placeOrderConfirmedHandler } from "../src/placeOrderTool.js";
import { prepareOrderHandler } from "../src/prepareOrderTool.js";
import { myOrdersHandler } from "../src/myOrdersTool.js";
import { getOrderStatusHandler } from "../src/orderStatusTool.js";

process.env.QMAI_OPEN_KEY ??= "test-open-key-0123456789abcdef0123456789ab";
process.env.QMAI_OPEN_ID ??= "test-open-id-0000000000000000";
process.env.QMAI_GRANT_CODE ??= "test-grant-code-0000000000";

const FAKE_CUSTOMER_ID = "1234567890123456789";
const STORE_ID = 503542;
const PATH_CREATE = WRITE_WHITELIST[0];
const PATH_ORDER_LIST = "v3/order/userAppointTimeOrderList";
const PATH_ORDER_STATUS = "v3/order/status";
const PATH_DETAIL = "v3/goods/item/getShopGoodsDetail";
const realFetch = globalThis.fetch;

const SAMPLE_PARAMS = {
  storeId: STORE_ID,
  items: [{ goodsId: "1200000000000000001", skuId: "1288634197263667200", num: 1 }],
  orderType: 1,
  source: 18,
  userId: FAKE_CUSTOMER_ID,
};

let createCalls = 0;

/** 按路径分发的 mock fetch；写路径单独计数。 */
function installRouter(routes: Record<string, () => Response>): void {
  createCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes(PATH_CREATE)) createCalls++;
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) throw new Error(`mock 路由未覆盖的路径（说明代码调了预期之外的接口）：${url}`);
    return routes[key]();
  }) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function orderListResponse(rows: Array<Record<string, unknown>>, total = rows.length): Response {
  return jsonResponse({ status: true, code: 0, data: { blttUserId: FAKE_CUSTOMER_ID, total, data: rows } });
}

function detailResponse(goodsId: string, salePriceFen = 2400): Response {
  return jsonResponse({
    status: true,
    code: 0,
    data: [
      {
        goodsId,
        name: "测试奶茶",
        type: 1,
        status: 10,
        goodsSkuList: [
          { skuId: "1288634197263667200", salePrice: salePriceFen, clearStatus: 1, inventory: 99, specName: "标准杯", skuItemList: [{ specValue: "标准杯" }] },
        ],
        sortedPracticeList: [],
        attachGoodsList: [],
      },
    ],
  });
}

interface Env {
  dir: string;
  restore: () => void;
}

/** 四件套注入（不含 WriteGuard——各用例自己按故障形态构造它）。 */
function installEnv(): Env {
  const dir = mkdtempSync(join(tmpdir(), "licha-gate-g2-"));
  const sessions = new SessionStore();
  sessions.bind(DEFAULT_SESSION_KEY, { customerId: FAKE_CUSTOMER_ID, boundAt: Date.now(), boundVia: "phone" });
  setSessionStoreForTesting(sessions);
  setPendingOrderStoreForTesting(new PendingOrderStore());
  setAccessAuditLoggerForTesting(new AccessAuditLogger({ logPath: join(dir, "access-audit.log") }));
  setReadAuditLogPathForTesting(join(dir, "read-audit.log"));
  return {
    dir,
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

/**
 * 「账本路径不可写」的跨平台造法（沿用审计反例脚本的手法）：把账本放进一个**普通文件**的
 * 子路径里。mkdirSync 在那里必然失败（ENOTDIR/EEXIST），macOS 与 Linux 行为一致——
 * 不依赖 /dev/full 这类平台专有设备，也不用 chmod（root 跑测试时 chmod 挡不住）。
 */
function unwritableLedgerPaths(dir: string): { auditLogPath: string; placedOrdersPath: string } {
  const blocker = join(dir, "ordinary-file");
  writeFileSync(blocker, "not-a-directory");
  return { auditLogPath: join(blocker, "write-audit.log"), placedOrdersPath: join(blocker, "placed-orders.json") };
}

/** 一条合法的未决审计行（G1 的关联线索齐全）。 */
function pendingLine(idempotencyKey: string, atMs: number): string {
  return JSON.stringify({
    time: beijingTimeString(atMs),
    dateKey: beijingDateKey(atMs),
    path: PATH_CREATE,
    result: "unknown",
    reason: "HTTP500",
    tokenId: null,
    idempotencyKey,
    summary: { storeId: STORE_ID, itemCount: 1, totalQuantity: 1, estimatedAmountFen: 2400 },
    orderNo: null,
    code: null,
    customerKey: customerCountKey(FAKE_CUSTOMER_ID),
    durationMs: 0,
  });
}

function textOf(r: { content: Array<{ type: "text"; text: string }> }): string {
  return r.content.map((c) => c.text).join("\n");
}

function jsonOf(r: { content: Array<{ type: "text"; text: string }> }): any {
  return JSON.parse(textOf(r));
}

/** 把一张待确认单塞进登记表，让 place_order 能走到账本闸门那一步。 */
function registerPendingOrder(guard: WriteGuard): string {
  const { tokenId } = guard.issueConfirmToken(SAMPLE_PARAMS);
  setPendingOrderStoreForTesting(
    (() => {
      const store = new PendingOrderStore();
      store.register(tokenId, { finalParams: SAMPLE_PARAMS, estimatedAmountFen: 2400 });
      return store;
    })(),
  );
  return tokenId;
}

// ============================================================================
// G2-1（任务书验收反例 1）：账本路径不可写 → fetchCalls == 0，原因含「账本」
// ============================================================================
test("G2-1: 账本路径不可写（父路径是普通文件）→ 写请求一次都不发出，原因含「账本」", async () => {
  const env = installEnv();
  const paths = unwritableLedgerPaths(env.dir);
  const guard = new WriteGuard(paths);
  setWriteGuardForTesting(guard);
  installRouter({ [PATH_CREATE]: () => jsonResponse({ status: true, code: 0, data: { orderNo: "D-SHOULD-NOT-HAPPEN" } }) });

  try {
    // 文件都还不存在 → 启动期回读没有故障可报（新装机是允许的），故障发生在**要写的那一刻**。
    assert.equal(guard.ledgerFaultReason(), null, "新装机 + 空账本：启动期不该报故障");

    const { tokenId } = guard.issueConfirmToken(SAMPLE_PARAMS);
    await assert.rejects(
      () => callWrite(PATH_CREATE, SAMPLE_PARAMS, { amountFen: 2400, confirmToken: tokenId }),
      (err: unknown) => {
        assert.equal((err as Error).name, "LedgerWriteFailed");
        assert.match((err as Error).message, /账本/, "顾客/模型可读的原因必须点出「账本」");
        assert.match((err as Error).message, /未发出/, "必须明确告知这次请求没有发出去");
        return true;
      },
    );

    assert.equal(createCalls, 0, "账本写不成时写路径一次都不许被调用（这是本门的核心断言）");
    // 内存状态也不许被推进：改造前是「先改内存、再尽力落盘」，于是活进程里有一笔未决、
    // 重启后归零——两边对不上账的根因就在这个顺序上。
    assert.equal(guard.hasUnresolvedWrite(), false, "durable 写失败不许在内存里留下半笔未决");
    assert.equal(guard.currentDailyCount(), 0, "durable 写失败不许推进当日额度");
    assert.ok(guard.ledgerFaultReason(), "写失败之后账本必须被标成故障态");

    // 重建（= 重启）：磁盘上什么都没有，内存里也什么都没有——两边一致。
    const rebuilt = new WriteGuard(paths);
    assert.equal(rebuilt.hasUnresolvedWrite(), false);
    assert.equal(rebuilt.currentDailyCount(), 0);
    assert.equal(existsSync(paths.auditLogPath), false, "账本文件确实没被创建出来");
  } finally {
    env.restore();
  }
});

test("G2-1 附: 账本不可写时 place_order 也拒绝，顾客可读原因含「账本」且写路径 0 次", async () => {
  const env = installEnv();
  const paths = unwritableLedgerPaths(env.dir);
  const guard = new WriteGuard(paths);
  setWriteGuardForTesting(guard);
  const tokenId = registerPendingOrder(guard);
  installRouter({ [PATH_CREATE]: () => jsonResponse({ status: true, code: 0, data: { orderNo: "D-SHOULD-NOT-HAPPEN" } }) });

  try {
    const r = await placeOrderConfirmedHandler({ confirmToken: tokenId, confirmAmountYuan: 24 });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /账本/, "拒绝理由要让人一眼看出是账本的问题，不是顾客的问题");
    assert.equal(createCalls, 0, "写路径一次都不许被调用");
  } finally {
    env.restore();
  }
});

// /dev/full 是 Linux 专有设备（写入必然 ENOSPC），复现的是**磁盘满**这一类失败——
// 与「父路径是普通文件」走的是不同的 errno 分支，值得单独覆盖。
//
// 手法上刻意做成「启动时账本健康、跑着跑着盘满了」：先给一份正常的空账本让构造函数回读
// 成功，再把那个路径换成指向 /dev/full 的符号链接。这比「启动就指向 /dev/full」更贴近真实
// 事故，也正好考验 durable 的价值所在——健康态下签发的令牌，在写不进去的那一刻必须被挡住。
//（顺带记一条：/dev/full 读取会无限返回 \0，直接把账本指向它会让启动期回读吃满内存。
//  那不是本门要修的现实故障形态，登记在施工回执里，不在此处处理。）
// 零跳过纪律：设备不存在时**不注册**这条 test（不是 t.skip），用例数因平台而异但从不出现 skipped。
if (existsSync("/dev/full")) {
  test("G2-1 附2: 账本运行中变得写不进去（symlink 到 /dev/full，磁盘满形态）→ 写请求一次都不发出", async () => {
    const env = installEnv();
    const auditLogPath = join(env.dir, "write-audit.log");
    const placedOrdersPath = join(env.dir, "placed-orders.json");
    writeFileSync(auditLogPath, ""); // 启动时是一份正常的空账本
    const guard = new WriteGuard({ auditLogPath, placedOrdersPath });
    setWriteGuardForTesting(guard);
    assert.equal(guard.ledgerFaultReason(), null, "启动期账本是健康的");
    installRouter({ [PATH_CREATE]: () => jsonResponse({ status: true, code: 0, data: { orderNo: "D-SHOULD-NOT-HAPPEN" } }) });

    try {
      const { tokenId } = guard.issueConfirmToken(SAMPLE_PARAMS);
      rmSync(auditLogPath);
      symlinkSync("/dev/full", auditLogPath); // 此后任何 append 必然 ENOSPC

      await assert.rejects(
        () => callWrite(PATH_CREATE, SAMPLE_PARAMS, { amountFen: 2400, confirmToken: tokenId }),
        (err: unknown) => {
          assert.equal((err as Error).name, "LedgerWriteFailed");
          assert.match((err as Error).message, /账本/);
          assert.match((err as Error).message, /ENOSPC/, "原因里要带上 errno，运维才知道是盘满");
          return true;
        },
      );
      assert.equal(createCalls, 0, "磁盘满时同样不许发出写请求");
      assert.equal(guard.hasUnresolvedWrite(), false, "内存状态不许被推进");
      assert.equal(guard.currentDailyCount(), 0);
      assert.ok(guard.ledgerFaultReason(), "写失败之后转入故障态，后续写请求继续被拒");
    } finally {
      rmSync(auditLogPath, { force: true }); // 别把 symlink 留在临时目录里
      env.restore();
    }
  });
}

// ============================================================================
// G2-2（验收反例 2）：已存在的账本读不出来 → 拒绝下单并说明原因
// ============================================================================
test("G2-2: 审计账本存在却是一个目录（读不出来）→ 三条写入口全拒，写路径 0 次", async () => {
  const env = installEnv();
  const auditLogPath = join(env.dir, "write-audit.log");
  mkdirSync(auditLogPath); // 存在、但 readFileSync 会 EISDIR
  const guard = new WriteGuard({ auditLogPath, placedOrdersPath: join(env.dir, "placed-orders.json") });
  setWriteGuardForTesting(guard);
  const tokenId = registerPendingOrder(guard);
  installRouter({
    [PATH_CREATE]: () => jsonResponse({ status: true, code: 0, data: { orderNo: "D-SHOULD-NOT-HAPPEN" } }),
    [PATH_DETAIL]: () => detailResponse("1200000000000000901"),
  });

  try {
    assert.ok(guard.ledgerFaultReason(), "启动期回读失败必须被记成故障态（不许按零账本继续）");
    assert.match(guard.ledgerFaultReason()!, /write-audit\.log/, "故障原因要指名是哪个文件");

    // ① prepare_order：拦在签令牌之前（早失败早改口）
    const prep = await prepareOrderHandler({ storeId: STORE_ID, items: [{ goodsId: "1200000000000000901", quantity: 1 }] });
    assert.equal(prep.isError, true);
    assert.match(textOf(prep), /账本/);

    // ② place_order：拦在未决闸门之前
    const placed = await placeOrderConfirmedHandler({ confirmToken: tokenId, confirmAmountYuan: 24 });
    assert.equal(placed.isError, true);
    assert.match(textOf(placed), /账本/);

    // ③ callWrite：离真实动作最近的那一道
    const { tokenId: t2 } = guard.issueConfirmToken(SAMPLE_PARAMS);
    await assert.rejects(
      () => callWrite(PATH_CREATE, SAMPLE_PARAMS, { amountFen: 2400, confirmToken: t2 }),
      (err: unknown) => (err as Error).name === "LedgerUnavailable" && /账本/.test((err as Error).message),
    );

    assert.equal(createCalls, 0, "账本不可读时写路径一次都不许被调用");
  } finally {
    env.restore();
  }
});

test("G2-2 附: 审计账本里有一行被截断（非法 JSON）→ 视为故障，拒绝下单", async () => {
  const env = installEnv();
  const auditLogPath = join(env.dir, "write-audit.log");
  // 「进程被杀在 append 中途」的真实形态：最后一行只写了一半。被截断的那一行很可能正是
  // 一条 inflight —— 跳过它等于丢掉一笔未决，而丢掉未决的后果是顾客被扣两次钱。
  // 所以这里是**故障**，不是可以静默跳过的小事（G2 总工裁决）。
  appendFileSync(auditLogPath, `${pendingLine(fingerprint({ p: "healthy" }), Date.now() - 60 * 60_000)}\n`);
  appendFileSync(auditLogPath, '{"time":"2026-09-08 12:00:00 +08:00","result":"inflig');
  const guard = new WriteGuard({ auditLogPath, placedOrdersPath: join(env.dir, "placed-orders.json") });
  setWriteGuardForTesting(guard);
  installRouter({ [PATH_CREATE]: () => jsonResponse({ status: true, code: 0, data: { orderNo: "D-SHOULD-NOT-HAPPEN" } }) });

  try {
    assert.ok(guard.ledgerFaultReason(), "单行损坏必须被记成故障");
    assert.match(guard.ledgerFaultReason()!, /第 2 行/, "要指名是哪一行，人工才修得动");

    const { tokenId } = guard.issueConfirmToken(SAMPLE_PARAMS);
    await assert.rejects(
      () => callWrite(PATH_CREATE, SAMPLE_PARAMS, { amountFen: 2400, confirmToken: tokenId }),
      (err: unknown) => (err as Error).name === "LedgerUnavailable",
    );
    assert.equal(createCalls, 0);
    // 能读懂的那一行照旧回放（故障不等于放弃已有证据——那一笔未决仍然挂着）。
    assert.equal(guard.describeUnresolvedWrites().total, 1, "合法行仍要回放，未决不许丢");
  } finally {
    env.restore();
  }
});

test("G2-2 附2: 幂等文件存在却损坏 → 视为故障，拒绝下单（幂等表清零 = 重复下单没了防线）", async () => {
  const env = installEnv();
  const placedOrdersPath = join(env.dir, "placed-orders.json");
  writeFileSync(placedOrdersPath, "{ this is not json");
  const guard = new WriteGuard({ auditLogPath: join(env.dir, "write-audit.log"), placedOrdersPath });
  setWriteGuardForTesting(guard);
  installRouter({ [PATH_CREATE]: () => jsonResponse({ status: true, code: 0, data: { orderNo: "D-SHOULD-NOT-HAPPEN" } }) });

  try {
    assert.ok(guard.ledgerFaultReason(), "幂等文件损坏必须被记成故障");
    assert.match(guard.ledgerFaultReason()!, /placed-orders\.json/);

    const { tokenId } = guard.issueConfirmToken(SAMPLE_PARAMS);
    await assert.rejects(
      () => callWrite(PATH_CREATE, SAMPLE_PARAMS, { amountFen: 2400, confirmToken: tokenId }),
      (err: unknown) => (err as Error).name === "LedgerUnavailable",
    );
    assert.equal(createCalls, 0);
  } finally {
    env.restore();
  }
});

// ============================================================================
// G2-3（验收反例 3）：正常写一笔后重启 → 未决/当日计数/幂等键完整恢复，数值与重启前一致
// ============================================================================
test("G2-3: 一笔成功 + 一笔 5xx 之后重启 → 未决、全局计数、按顾客计数、幂等键逐项与重启前相等", async () => {
  const env = installEnv();
  const auditLogPath = join(env.dir, "write-audit.log");
  const placedOrdersPath = join(env.dir, "placed-orders.json");
  const guard = new WriteGuard({ auditLogPath, placedOrdersPath });
  setWriteGuardForTesting(guard);
  let createSeq = 0;
  installRouter({
    [PATH_CREATE]: () => {
      createSeq++;
      return createSeq === 1
        ? jsonResponse({ status: true, code: 0, data: { orderNo: "D00281924556183175190" } })
        : new Response("boom", { status: 503 });
    },
  });

  try {
    const p1 = { ...SAMPLE_PARAMS, items: [{ goodsId: "g-ok", skuId: "s", num: 1 }] };
    const r1 = await callWrite(PATH_CREATE, p1, { amountFen: 2400, confirmToken: guard.issueConfirmToken(p1).tokenId });
    assert.equal(r1.ok, true);
    const idemOk = fingerprint({ params: p1, tokenId: undefined });

    const p2 = { ...SAMPLE_PARAMS, items: [{ goodsId: "g-unknown", skuId: "s", num: 1 }] };
    await callWrite(PATH_CREATE, p2, { amountFen: 2400, confirmToken: guard.issueConfirmToken(p2).tokenId });

    assert.equal(guard.ledgerFaultReason(), null, "正常链路不该产生任何账本故障");
    const before = {
      desc: guard.describeUnresolvedWrites(),
      global: guard.currentDailyCount(),
      perCustomer: guard.currentCustomerDailyCount(customerCountKey(FAKE_CUSTOMER_ID)!),
    };
    assert.equal(before.desc.total, 1, "5xx 那一笔挂着未决");
    assert.equal(before.global, 2, "成功 1 + 未知 1 = 占额 2");
    assert.equal(before.perCustomer, 2, "同一位顾客头上也是 2");

    // 幂等键：成功那一笔必须已经落进 placed-orders.json（重启后重复内容要能被拒）。
    // 幂等键 = fingerprint({ params, tokenId })，测试里拿不到那个 tokenId，所以从文件里读键。
    const persisted = Object.keys(JSON.parse(readFileSync(placedOrdersPath, "utf8")));
    assert.equal(persisted.length, 1, "成功一单应恰好落一个幂等键");
    assert.notEqual(persisted[0], idemOk); // 只是确认键含 tokenId 成分，不是裸 params 指纹
    assert.equal(guard.isDuplicate(persisted[0]), true);

    // ---- 重启：新实例、同配置，只从磁盘恢复 ----
    const rebuilt = new WriteGuard({ auditLogPath, placedOrdersPath });
    assert.equal(rebuilt.ledgerFaultReason(), null, "重建也不该报故障");
    assert.deepEqual(rebuilt.describeUnresolvedWrites(), before.desc, "未决集合（含条数与最早时间）必须逐项一致");
    assert.equal(rebuilt.currentDailyCount(), before.global, "全局当日计数必须一致");
    assert.equal(
      rebuilt.currentCustomerDailyCount(customerCountKey(FAKE_CUSTOMER_ID)!),
      before.perCustomer,
      "按顾客计数必须一致（两层是两个 Map，各走一遍重建，只测一层测不出另一层清零）",
    );
    assert.equal(rebuilt.isDuplicate(persisted[0]), true, "幂等键必须完整恢复");
  } finally {
    env.restore();
  }
});

// ============================================================================
// G2-4（验收反例 4）：修复账本后先回读再开放；回读失败时写工具仍拒绝
// ============================================================================
test("G2-4: 账本故障态不会自愈——修好文件也要重新回读（重启）才开放；修得不干净则仍拒绝", async () => {
  const env = installEnv();
  const auditLogPath = join(env.dir, "write-audit.log");
  const placedOrdersPath = join(env.dir, "placed-orders.json");
  mkdirSync(auditLogPath); // 故障形态：账本是个目录
  const faulty = new WriteGuard({ auditLogPath, placedOrdersPath });
  setWriteGuardForTesting(faulty);
  installRouter({ [PATH_CREATE]: () => jsonResponse({ status: true, code: 0, data: { orderNo: "D00281924556183175191" } }) });

  try {
    assert.ok(faulty.ledgerFaultReason(), "起步就是故障态");

    // ① 把文件系统修好，但**不重启**：同一个实例仍然拒绝。
    // 故障态是一次启动期的结论，不许在运行中自己翻篇——否则「护栏什么时候生效」
    // 就取决于外部文件的瞬时状态，没人能说清某一次下单到底有没有被保护。
    rmSync(auditLogPath, { recursive: true });
    const { tokenId } = faulty.issueConfirmToken(SAMPLE_PARAMS);
    await assert.rejects(
      () => callWrite(PATH_CREATE, SAMPLE_PARAMS, { amountFen: 2400, confirmToken: tokenId }),
      (err: unknown) => (err as Error).name === "LedgerUnavailable",
      "文件修好但没重新回读 → 仍然拒绝",
    );
    assert.equal(createCalls, 0);

    // ② 修得不干净就重启（日志里留了一行截断行）：回读仍然失败 → 写工具继续拒绝。
    appendFileSync(auditLogPath, `${pendingLine(fingerprint({ p: "left-over" }), Date.now() - 60 * 60_000)}\n`);
    appendFileSync(auditLogPath, '{"result":"inflig');
    const halfFixed = new WriteGuard({ auditLogPath, placedOrdersPath });
    setWriteGuardForTesting(halfFixed);
    assert.ok(halfFixed.ledgerFaultReason(), "回读仍失败 → 仍是故障态");
    const { tokenId: t2 } = halfFixed.issueConfirmToken(SAMPLE_PARAMS);
    await assert.rejects(
      () => callWrite(PATH_CREATE, SAMPLE_PARAMS, { amountFen: 2400, confirmToken: t2 }),
      (err: unknown) => (err as Error).name === "LedgerUnavailable",
      "回读失败时写工具必须仍然拒绝",
    );
    assert.equal(createCalls, 0);

    // ③ 真正修干净（把截断行去掉）后重启 → 回读成功，写工具重新开放，且旧证据没丢。
    writeFileSync(auditLogPath, `${pendingLine(fingerprint({ p: "left-over" }), Date.now() - 60 * 60_000)}\n`);
    const healthy = new WriteGuard({ auditLogPath, placedOrdersPath });
    setWriteGuardForTesting(healthy);
    assert.equal(healthy.ledgerFaultReason(), null, "回读成功 → 故障态清除");
    assert.equal(healthy.describeUnresolvedWrites().total, 1, "修复不等于清账：那一笔未决还在");

    // 未决闸门是另一道门，它照旧拦着——这里要证明的是「账本闸门已经放开」，
    // 所以用 callWrite 直接验：拒绝理由不再是 LedgerUnavailable。
    const { tokenId: t3 } = healthy.issueConfirmToken(SAMPLE_PARAMS);
    const r = await callWrite(PATH_CREATE, SAMPLE_PARAMS, { amountFen: 2400, confirmToken: t3 });
    assert.equal(r.ok, true, "账本健康后写通道恢复");
    assert.equal(createCalls, 1, "这一次请求确实发出去了");
  } finally {
    env.restore();
  }
});

// ============================================================================
// G2-5（验收反例 5）：只读工具在账本不可写时照常工作（防误伤）
// ============================================================================
test("G2-5: 账本不可写时只读通道照常——callRead、my_orders、get_order_status 全部正常返回", async () => {
  const env = installEnv();
  const paths = unwritableLedgerPaths(env.dir);
  const guard = new WriteGuard(paths);
  setWriteGuardForTesting(guard);
  installRouter({
    [PATH_ORDER_LIST]: () =>
      orderListResponse([
        { orderNo: "D00281924556183175192", status: 20, actualAmount: 2400, orderAt: Date.now() - 3 * 60_000, userId: FAKE_CUSTOMER_ID },
      ]),
    [PATH_ORDER_STATUS]: () => jsonResponse({ status: true, code: 0, data: { status: 20, userId: FAKE_CUSTOMER_ID } }),
    [PATH_DETAIL]: () => detailResponse("1200000000000000902"),
  });

  try {
    // ① 最底层的只读出口：完全不碰账本。
    const raw = await callRead<Record<string, unknown>>(PATH_DETAIL, { storeId: STORE_ID, goodsId: "1200000000000000902" });
    assert.equal(raw.ok, true, "只读通道不许被账本故障连坐");

    // ② my_orders：它会顺手写未决核对的审计（写不进去），但**必须照常把订单列表返回**。
    // 只读没有任何不可撤销的现实后果，为账本故障牺牲查询能力是纯粹的误伤——
    // 而且顾客此刻最需要的恰恰是「查一下我那单到底成没成」。
    const list = jsonOf(await myOrdersHandler({ days: 7 }));
    assert.equal(list.count, 1, "订单列表照常返回");
    assert.equal(list.orders[0].orderNo, "D00281924556183175192");

    // ③ get_order_status 同理。
    const status = jsonOf(await getOrderStatusHandler({ orderNo: "D00281924556183175192" }));
    assert.equal(status.statusText, "已支付");

    // ④ 但写路径仍然是关着的（只读放行不等于账本没坏）。
    installRouter({ [PATH_CREATE]: () => jsonResponse({ status: true, code: 0, data: { orderNo: "D-SHOULD-NOT-HAPPEN" } }) });
    const { tokenId } = guard.issueConfirmToken(SAMPLE_PARAMS);
    await assert.rejects(
      () => callWrite(PATH_CREATE, SAMPLE_PARAMS, { amountFen: 2400, confirmToken: tokenId }),
      (err: unknown) => /Ledger/.test((err as Error).name),
      "只读放行不许把写路径一起放行",
    );
    assert.equal(createCalls, 0);
  } finally {
    env.restore();
  }
});
