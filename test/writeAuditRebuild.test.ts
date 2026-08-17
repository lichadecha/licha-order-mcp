// T9：写审计日志重建当日计数——证明"进程重启"不能绕过频次护栏。
// T10：写审计日志内容自查——不含凭证、识别值只留后四位、不倒灌完整 params。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callWrite, WriteGuardRejected } from "../src/client.js";
import { WRITE_WHITELIST, ORDER_GUARD } from "../src/constants.js";
import { WriteGuard, setWriteGuardForTesting, PHONE_RE } from "../src/writeGuard.js";

process.env.QMAI_OPEN_KEY ??= "test-open-key-0123456789abcdef0123456789ab";
process.env.QMAI_OPEN_ID ??= "test-open-id-0000000000000000";
process.env.QMAI_GRANT_CODE ??= "test-grant-code-0000000000";

function installFetchSpy(): { count: () => number; restore: () => void } {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (..._args: Parameters<typeof fetch>) => {
    calls++;
    return new Response(
      JSON.stringify({ status: true, code: 0, message: "创建订单成功", data: { orderNo: `D-AUDIT-${calls}` } }),
      { status: 200 },
    );
  }) as typeof fetch;
  return {
    count: () => calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test("T9: 重启后当日计数从写审计日志重建，第 6 单仍被拒", async () => {
  const dir = mkdtempSync(join(tmpdir(), "licha-wg-t9-"));
  const auditLogPath = join(dir, "write-audit.log");
  const placedOrdersPath = join(dir, "placed-orders.json");

  const spy = installFetchSpy();
  try {
    // 第一个 guard 实例：跑满当日 5 单，全部走真实 callWrite 链路（只有 fetch 被 mock）。
    const guard1 = new WriteGuard({ auditLogPath, placedOrdersPath });
    setWriteGuardForTesting(guard1);
    for (let i = 0; i < ORDER_GUARD.maxOrdersPerDay; i++) {
      const params = { storeId: 1, items: [{ goodsId: `g${i}`, skuId: "s", num: 1 }], orderType: 1, source: 18, userId: "u1" };
      const { tokenId } = guard1.issueConfirmToken(params);
      const r = await callWrite(WRITE_WHITELIST[0], params, { amountFen: 100, confirmToken: tokenId });
      assert.strictEqual(r.ok, true, `第 ${i + 1} 单应成功`);
    }
    assert.strictEqual(spy.count(), ORDER_GUARD.maxOrdersPerDay);

    // 模拟"进程重启"：不复用 guard1，构造一个全新的 WriteGuard 实例指向同一份审计日志。
    // 这就是本用例要证明的核心——计数不是从 guard1 的内存里继承来的，而是 guard2 自己重新读文件算出来的。
    const guard2 = new WriteGuard({ auditLogPath, placedOrdersPath });
    setWriteGuardForTesting(guard2);

    const params6 = { storeId: 1, items: [{ goodsId: "g-6th", skuId: "s", num: 1 }], orderType: 1, source: 18, userId: "u1" };
    const { tokenId: token6 } = guard2.issueConfirmToken(params6);
    await assert.rejects(
      () => callWrite(WRITE_WHITELIST[0], params6, { amountFen: 100, confirmToken: token6 }),
      (err: unknown) => err instanceof WriteGuardRejected && /DailyLimitExceeded/.test((err as Error).message),
      "重启后的新实例应该仍然认为当日已达上限",
    );
    assert.strictEqual(spy.count(), ORDER_GUARD.maxOrdersPerDay, "第 6 单不应真的发出请求——重启没能绕过护栏");
  } finally {
    spy.restore();
    setWriteGuardForTesting(null);
  }
});

test("T10: 写审计日志——无凭证串、手机号只留后四位、不倒灌完整 params", async () => {
  const dir = mkdtempSync(join(tmpdir(), "licha-wg-t10-"));
  const auditLogPath = join(dir, "write-audit.log");
  const placedOrdersPath = join(dir, "placed-orders.json");
  const guard = new WriteGuard({ auditLogPath, placedOrdersPath });
  setWriteGuardForTesting(guard);

  const spy = installFetchSpy();
  try {
    const params = {
      storeId: 503542,
      items: [
        {
          goodsId: "1288634197238501377",
          skuId: "1288634197263667200",
          num: 2,
          practiceList: [{ id: "1", valueId: "2", name: "温度", value: "少冰" }],
        },
      ],
      orderType: 1,
      source: 18,
      userId: "1234567890123456789",
      contactPhone: "13800001234", // 防御性场景：万一顶层参数意外混入手机号
    };
    const { tokenId } = guard.issueConfirmToken(params);
    const result = await callWrite(WRITE_WHITELIST[0], params, { amountFen: 4800, confirmToken: tokenId });
    assert.strictEqual(result.ok, true);

    const logText = readFileSync(auditLogPath, "utf8");

    // 1. 不含凭证明文（本文件顶部设置的假 openKey/grantCode），也不含凭证字段名。
    assert.ok(!logText.includes(process.env.QMAI_OPEN_KEY!), "不应包含 openKey 明文");
    assert.ok(!logText.includes(process.env.QMAI_GRANT_CODE!), "不应包含 grantCode 明文");
    assert.ok(!/"openKey"|"grantCode"/i.test(logText), "不应出现凭证字段名（应整条摘除，而非仅遮盖值）");

    // 2. 识别值只留后四位：完整手机号不应出现，脱敏后的后四位允许出现。
    assert.ok(!logText.includes("13800001234"), "完整手机号不应出现在审计日志里");
    assert.ok(logText.includes("1234"), "脱敏后的后四位应该可见（便于人工核对）");

    // 3. 不倒灌完整 params：商品明细字段名与具体值不应出现，摘要只允许聚合字段
    //    （storeId / itemCount / totalQuantity / estimatedAmountFen 一类）。
    assert.ok(!logText.includes("practiceList"), "不应把 items 的做法明细字段名倒灌进日志");
    assert.ok(!logText.includes("1288634197238501377"), "不应把具体 goodsId 倒灌进日志");
    assert.ok(!logText.includes("1288634197263667200"), "不应把具体 skuId 倒灌进日志");

    const lastLine = logText.trim().split("\n").pop()!;
    const entry = JSON.parse(lastLine);
    assert.strictEqual(entry.result, "allowed");
    assert.strictEqual(entry.summary.storeId, 503542);
    assert.strictEqual(entry.summary.itemCount, 1);
    assert.strictEqual(entry.summary.totalQuantity, 2);
    assert.strictEqual(entry.summary.estimatedAmountFen, 4800);
  } finally {
    spy.restore();
    setWriteGuardForTesting(null);
  }
});

test("PHONE_RE 顺手扩展（总工验收裁决）：纯 11 位 / 86 前缀 / +86 前缀 / 0086 前缀均命中", () => {
  for (const phone of ["13800001234", "8613800001234", "+8613800001234", "008613800001234"]) {
    assert.ok(PHONE_RE.test(phone), `应命中：${phone}`);
    assert.strictEqual(phone.slice(-4), "1234", "无论前缀长短，后四位切片不受影响（自检）");
  }
  // 反例：位数不对、或者去掉前缀后不是"1 开头 + 10 位数字"的，不应该被误命中
  // （注意：本正则不校验真实手机号段前缀，"1开头的11位数字"本身就在设计范围内，
  //  所以这里只挑"长度/前缀结构对不上"的反例，不挑"1开头但号段不像手机号"的反例）。
  for (const notPhone of ["861234567890", "138000012345", "1380000123", "23800001234"]) {
    assert.ok(!PHONE_RE.test(notPhone), `不应命中：${notPhone}`);
  }
});

test("T10-补充：+86 前缀手机号在写审计里也只留后四位（不是只有纯 11 位才生效）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "licha-wg-t10b-"));
  const auditLogPath = join(dir, "write-audit.log");
  const placedOrdersPath = join(dir, "placed-orders.json");
  const guard = new WriteGuard({ auditLogPath, placedOrdersPath });
  setWriteGuardForTesting(guard);

  const spy = installFetchSpy();
  try {
    const params = {
      storeId: 503542,
      items: [{ goodsId: "g1", skuId: "s1", num: 1 }],
      orderType: 1,
      source: 18,
      userId: "1234567890123456789",
      contactPhone: "+8613900002345", // 带国家码前缀的形态
    };
    const { tokenId } = guard.issueConfirmToken(params);
    const result = await callWrite(WRITE_WHITELIST[0], params, { amountFen: 2400, confirmToken: tokenId });
    assert.strictEqual(result.ok, true);

    const logText = readFileSync(auditLogPath, "utf8");
    assert.ok(!logText.includes("+8613900002345"), "带国家码前缀的完整手机号不应出现在审计日志里");
    assert.ok(logText.includes("2345"), "脱敏后的后四位应该可见");
  } finally {
    spy.restore();
    setWriteGuardForTesting(null);
  }
});
