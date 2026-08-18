// orderParams 黑盒防御（总工验收裁决 M2 追加修复）。
//
// 背景：M2 阶段 place_order 的 orderParams 是一个 z.record(z.string(), z.unknown()) 透传黑盒
// （完整参数组装是 M4 的 prepare_order 才做的事）。但"userId 不做工具参数、只能由会话态注入"是
// M3 定死的架构硬规矩（施工令 § 3.3：模型永远不能自己填一个 userId 递进来）。黑盒透传如果不加
// 防御，精神上就是开了个后门——调用方可以把 userId 藏进 orderParams 的任意字段或任意嵌套层级里。
//
// 本文件覆盖两层：
//   1. findUserIdField 纯函数本身——顶层 / 嵌套对象 / 数组内对象三种形态都要能命中。
//   2. placeOrderHandler 集成——命中 userId 时应该直接拒绝、不应该走到 callWrite、fetch 未被调用。
//
// 之所以测 placeOrderHandler（从 src/placeOrderTool.ts 导入）而不是 spawn 子进程走 MCP 协议或
// 直接 import src/index.ts，有两个原因：① place_order 若通过 MCP 协议调用，执行发生在独立子
// 进程里，父进程没法 mock 子进程的 globalThis.fetch；② index.ts 顶层有 main().catch(...)，
// import 它会触发真实的 stdio transport connect。处理逻辑拆到独立的 placeOrderTool.ts 后，
// 才能在同进程内直接调用、直接 mock fetch，精确断言"零真实请求"。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findUserIdField, placeOrderHandler } from "../src/placeOrderTool.js";
import { WriteGuard, setWriteGuardForTesting } from "../src/writeGuard.js";
import { SessionStore, setSessionStoreForTesting, DEFAULT_SESSION_KEY } from "../src/session.js";

process.env.QMAI_OPEN_KEY ??= "test-open-key-0123456789abcdef0123456789ab";
process.env.QMAI_OPEN_ID ??= "test-open-id-0000000000000000";
process.env.QMAI_GRANT_CODE ??= "test-grant-code-0000000000";

// placeOrderHandler 内部会调用 getWriteGuard()（不管走哪条分支——userId 黑名单命中会调
// recordAudit，闯过黑名单还会走到 callWrite 再调 recordAudit）。不注入独立实例的话，
// 这些调用会落到生产默认路径 logs/write-audit.log，污染真实审计文件——这是本文件最初一版
// 遗漏的问题，写完 T1-T11 系列后才发现补上：每个会调用 placeOrderHandler 的用例都必须
// setWriteGuardForTesting 指向临时目录，用完在 finally 里清掉。
function freshGuard(): WriteGuard {
  const dir = mkdtempSync(join(tmpdir(), "licha-wg-useridguard-"));
  return new WriteGuard({ auditLogPath: join(dir, "write-audit.log"), placedOrdersPath: join(dir, "placed-orders.json") });
}

function installFetchSpy(): { count: () => number; restore: () => void } {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (..._args: Parameters<typeof fetch>) => {
    calls++;
    return new Response(JSON.stringify({ status: true, code: 0, data: { orderNo: "D-SHOULD-NOT-HAPPEN" } }), { status: 200 });
  }) as typeof fetch;
  return {
    count: () => calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

// ---------- 1. findUserIdField 纯函数：三种嵌套形态 ----------

test("findUserIdField: 顶层字段命中", () => {
  const hit = findUserIdField({ storeId: 1, userId: "sneaky-top-level" });
  assert.strictEqual(hit, "userId");
});

test("findUserIdField: 嵌套对象字段命中", () => {
  const hit = findUserIdField({ storeId: 1, extra: { nested: { userId: "sneaky-nested" } } });
  assert.strictEqual(hit, "extra.nested.userId");
});

test("findUserIdField: 数组内对象字段命中", () => {
  const hit = findUserIdField({
    storeId: 1,
    items: [
      { goodsId: "g1", num: 1 },
      { goodsId: "g2", num: 1, userId: "sneaky-in-array" },
    ],
  });
  assert.strictEqual(hit, "items[1].userId");
});

test("findUserIdField: 不含 userId 时返回 null", () => {
  const hit = findUserIdField({
    storeId: 503542,
    items: [{ goodsId: "g1", skuId: "s1", num: 1, practiceList: [{ id: "1", valueId: "2", name: "温度", value: "少冰" }] }],
    orderType: 1,
    source: 18,
  });
  assert.strictEqual(hit, null);
});

// ---------- 2. placeOrderHandler 集成：命中即拒绝，fetch 未被调用 ----------

test("orderParams 顶层塞 userId → 被拒，fetch 未被调用", async () => {
  setWriteGuardForTesting(freshGuard());
  const spy = installFetchSpy();
  try {
    const result = await placeOrderHandler({
      confirmToken: "irrelevant-userid-guard-blocks-first",
      amountFen: 2400,
      orderParams: { storeId: 503542, userId: "1234567890123456789", items: [{ goodsId: "g1", skuId: "s1", num: 1 }] },
    });
    assert.strictEqual(result.isError, true, "应返回错误结果");
    assert.ok(/userId/.test(result.content[0].text), "错误信息应提到 userId");
    assert.ok(/会话态/.test(result.content[0].text), "错误信息应说明 userId 只能由会话态注入");
    assert.strictEqual(spy.count(), 0, "fetch 不应被调用");
  } finally {
    spy.restore();
    setWriteGuardForTesting(null);
  }
});

test("orderParams 嵌套层级塞 userId → 被拒，fetch 未被调用", async () => {
  setWriteGuardForTesting(freshGuard());
  const spy = installFetchSpy();
  try {
    const result = await placeOrderHandler({
      confirmToken: "irrelevant-userid-guard-blocks-first",
      amountFen: 2400,
      orderParams: {
        storeId: 503542,
        items: [{ goodsId: "g1", skuId: "s1", num: 1, extra: { userId: "sneaky-nested-1234567890123456789" } }],
      },
    });
    assert.strictEqual(result.isError, true, "应返回错误结果");
    assert.ok(/userId/.test(result.content[0].text), "错误信息应提到 userId");
    assert.ok(/items\[0\]\.extra\.userId/.test(result.content[0].text), "错误信息应带上命中路径，方便排查");
    assert.strictEqual(spy.count(), 0, "fetch 不应被调用");
  } finally {
    spy.restore();
    setWriteGuardForTesting(null);
  }
});

test("orderParams 不含 userId → 不会被这道关卡拦，会继续往下走到令牌校验（TokenNotFound）", async () => {
  // M2 阶段没有任何工具能签发合法令牌，所以即使闯过了 userId 检查，也一定会在 callWrite 的
  // 令牌校验这一步被拒绝——这里验证的是"正常输入不会被 userId 黑名单误伤"，而不是完整成功路径。
  //
  // M3 补丁（会话绑定夹具）：placeOrderHandler 现在在 userId 黑名单之后、callWrite 之前新增了
  // "要求会话已绑定会员" 这一步（未绑定会直接拒绝，见 SessionNotBound 分支）。本用例的原意是
  // 验证"正常 orderParams 能闯过 userId 检查、继续走到令牌校验"，为了不让新加的绑定要求提前
  // 拦截、掩盖掉本用例真正要测的东西，这里注入一个已绑定的会话——闯过 userId 检查后会直接命中
  // 绑定态（不产生任何 access 审计事件），继续往下走到 callWrite 的令牌校验，仍然应该拿到
  // TokenNotFound，与 M2 时期的断言完全一致（未削弱）。
  setWriteGuardForTesting(freshGuard());
  const sessionStore = new SessionStore();
  sessionStore.bind(DEFAULT_SESSION_KEY, { customerId: "1234567890123456789", boundAt: Date.now(), boundVia: "phone" });
  setSessionStoreForTesting(sessionStore);
  const spy = installFetchSpy();
  try {
    const result = await placeOrderHandler({
      confirmToken: "never-issued-token-id",
      amountFen: 2400,
      orderParams: { storeId: 503542, items: [{ goodsId: "g1", skuId: "s1", num: 1 }], orderType: 1, source: 18 },
    });
    assert.strictEqual(result.isError, true);
    assert.ok(!/UserIdInOrderParams/.test(result.content[0].text), "不应该是被 userId 检查拒绝的");
    assert.ok(!/SessionNotBound|尚未绑定/.test(result.content[0].text), "不应该是被会话绑定检查拒绝的（本用例已注入绑定）");
    assert.ok(/TokenNotFound/.test(result.content[0].text), "应该是被令牌校验拒绝的（M2 阶段没有合法令牌来源）");
    assert.strictEqual(spy.count(), 0, "fetch 不应被调用");
  } finally {
    spy.restore();
    setWriteGuardForTesting(null);
    setSessionStoreForTesting(null);
  }
});
