// B7 修复回归测试：maskValue（经 maskDeep 导出）从"整串必须恰好是手机号才脱敏"升级为
// "字符串内嵌入的手机号也就地替换"，同时不得误伤形似手机号的长数字串（如订单号中段）。
//
// 背景：总工独立验收（test/m3AcceptanceGauntlet.test.ts 的 B7）抓到 bindMemberTool.ts 把
// 企迈 4.2.2 失败响应的 message 原文透传进 access-audit 的 reason 字段——当 message 里嵌了
// 一句"手机号13800001234不存在"时，旧的 PHONE_RE（^...$ 整串锚定）接不住这种嵌入形态，完整
// 号码会原样落进审计日志。修复方案是把 writeGuard.ts 的 maskValue 升级为基于负向断言的
// 全局替换（PHONE_EMBED_RE），本文件直接对 maskDeep 做低层级验证，作为 B7 场景之外的
// 独立正则回归证据；B7 本身的端到端场景由总工的 m3AcceptanceGauntlet.test.ts 覆盖，不重复。

import { test } from "node:test";
import assert from "node:assert/strict";
import { maskDeep } from "../src/writeGuard.js";

test("嵌入式手机号：reason 一类的句子里嵌了手机号 → 只替换号码本身，前后文原样保留", () => {
  const masked = maskDeep({ reason: "手机号13800001234不存在" }) as { reason: string };
  assert.strictEqual(masked.reason, "手机号***1234不存在");
  assert.ok(!masked.reason.includes("13800001234"), "不应残留完整手机号");
});

test("嵌入式手机号：句尾/句首两种边界位置都能命中", () => {
  const tail = maskDeep({ reason: "该会员手机号为13800001234" }) as { reason: string };
  assert.strictEqual(tail.reason, "该会员手机号为***1234");

  const head = maskDeep({ reason: "13800001234号码查无此人" }) as { reason: string };
  assert.strictEqual(head.reason, "***1234号码查无此人");
});

test("防误伤：订单号 D00281924556183175168 中段形似手机号的子串不被替换", () => {
  const orderNo = "D00281924556183175168";
  const masked = maskDeep({ orderNo }) as { orderNo: string };
  assert.strictEqual(masked.orderNo, orderNo, "长数字串中段不应被误判成手机号");
});

test("防误伤：19 位纯数字 customerId 整串不被误伤（前后都是数字，负向断言应全程排除）", () => {
  const customerId = "1234567890123456789";
  const masked = maskDeep({ customerId }) as { customerId: string };
  assert.strictEqual(masked.customerId, customerId);
});

test("整串形态回归：纯 11 位 / 86 前缀 / +86 前缀 / 0086 前缀仍然整串脱敏（不是新正则的行为倒退）", () => {
  for (const [input, expected] of [
    ["13800001234", "***1234"],
    ["8613800001234", "***1234"],
    ["+8613800001234", "***1234"],
    ["008613800001234", "***1234"],
  ] as const) {
    const masked = maskDeep({ v: input }) as { v: string };
    assert.strictEqual(masked.v, expected, `整串 ${input} 应脱敏为 ${expected}`);
  }
});

test("多个嵌入号码：同一句子里出现两个手机号都应被各自替换", () => {
  const masked = maskDeep({ reason: "13800001234 和 13900002345 都查不到" }) as { reason: string };
  assert.strictEqual(masked.reason, "***1234 和 ***2345 都查不到");
});
