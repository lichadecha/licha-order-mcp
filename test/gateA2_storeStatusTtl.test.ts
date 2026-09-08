// 24 号任务书 A2：门店营业状态不再用 24 小时前的旧值；营业时间缓存会过期；返回值带采样时间。
//
// 现状（3796619）：营业状态是 getShopList 列表字段，跟名录一起缓存 24h；营业时间 Map 永不过期。
// 盲审 B06 / 22 号只读反例 HOURS_TTL_REPRO：合成时钟 23 小时后仍报首次「营业中」；25 小时后名录刷新
// 但营业时间仍是首次值、getShopColsById 只读过 1 次。
//
// 全 mock；时钟用 Date.now 猴子补丁（与审计反例同法），但**只前进不回拨**——client.ts 的节流
// lastCallAt 是模块级的，若某条用例把时钟拨到 25 小时后、下一条再拨回真实时间，节流就会等 25 小时
// （第一版测试就这样卡死了）。每条用例先 resetStoreCachesForTesting()。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setReadAuditLogPathForTesting } from "../src/client.js";
import { findStore, resetStoreCachesForTesting } from "../src/tools/findStore.js";

process.env.QMAI_OPEN_KEY ??= "test-open-key-0123456789abcdef0123456789ab";
process.env.QMAI_OPEN_ID ??= "test-open-id-0000000000000000";
process.env.QMAI_GRANT_CODE ??= "test-grant-code-0000000000";

const realFetch = globalThis.fetch;
const realNow = Date.now;
// 单调偏移时钟：advance() 只累加，整个文件内 Date.now 永不后退。
let clockOffsetMs = 0;
Date.now = () => realNow() + clockOffsetMs;
function advance(ms: number): void {
  clockOffsetMs += ms;
}
const PATH_LIST = "v3/org/shop/getShopList";
const PATH_COLS = "v3/org/shop/getShopColsById";
const MIN = 60_000;
const HOUR = 60 * MIN;

type Handler = (callIndex: number) => Record<string, unknown>;
interface Router {
  countOf: (p: string) => number;
  set: (p: string, h: Handler) => void;
  restore: () => void;
}

function installRouter(routes: Record<string, Handler>): Router {
  resetStoreCachesForTesting();
  const counts = new Map<string, number>();
  const live: Record<string, Handler> = { ...routes };
  setReadAuditLogPathForTesting(join(mkdtempSync(join(tmpdir(), "licha-a2-")), "read-audit.log"));
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const key = Object.keys(live).find((k) => url.includes(k));
    if (!key) throw new Error(`mock 路由未覆盖的路径：${url}`);
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return new Response(JSON.stringify(live[key](n)), { status: 200 });
  }) as typeof fetch;
  return {
    countOf: (p) => counts.get(p) ?? 0,
    set: (p, h) => {
      live[p] = h;
    },
    restore: () => {
      globalThis.fetch = realFetch;
      setReadAuditLogPathForTesting(null);
      resetStoreCachesForTesting();
    },
  };
}

const okBody = (data: unknown) => ({ status: true, code: 0, data });
const listOf = (stores: Array<Record<string, unknown>>) => okBody({ list: stores });
const colsOf = (openStatus: number | undefined, open: string, close: string) =>
  okBody({
    ...(openStatus === undefined ? {} : { openStatus }),
    opentimes: [{ opentime: [{ worktime: [{ time: [open, close] }], workweek: [1, 2, 3, 4, 5, 6, 7] }] }],
  });

function hitOf(r: Awaited<ReturnType<typeof findStore>>) {
  assert.equal(r.matched, true, "应唯一命中");
  return (r as { store: { openStatusText: string; statusSampledAt?: string; opentimes?: string } }).store;
}

test("A2-1: 状态 TTL 到期后重取——营业中→休息中，采样时间随之更新；名录 24h 内不重拉", async () => {
  const fx = installRouter({
    [PATH_LIST]: () => listOf([{ id: 920001, name: "A2 一号店", code: "01", openStatus: 1 }]),
    [PATH_COLS]: (n) => colsOf(n === 1 ? 1 : 0, "09:00", "23:00"),
  });
  try {
    const first = hitOf(await findStore("A2 一号店"));
    assert.equal(first.openStatusText, "营业中");
    assert.ok(first.statusSampledAt, "必须带采样时间");

    advance(11 * MIN);
    const second = hitOf(await findStore("A2 一号店"));
    assert.equal(second.openStatusText, "休息中", "过了 10 分钟状态 TTL 必须重取到新状态");
    assert.notEqual(second.statusSampledAt, first.statusSampledAt, "采样时间必须更新");
    assert.equal(fx.countOf(PATH_COLS), 2);
    assert.equal(fx.countOf(PATH_LIST), 1, "名录 24h 内不重拉");
  } finally {
    fx.restore();
  }
});

test("A2-2: 状态 TTL 内不重取——5 分钟后再查，值与采样时间都不变、零请求", async () => {
  const fx = installRouter({
    [PATH_LIST]: () => listOf([{ id: 920002, name: "A2 二号店", code: "02", openStatus: 1 }]),
    [PATH_COLS]: () => colsOf(2, "10:00", "22:00"),
  });
  try {
    const first = hitOf(await findStore("A2 二号店"));
    advance(5 * MIN);
    const second = hitOf(await findStore("A2 二号店"));
    assert.equal(second.openStatusText, "繁忙");
    assert.equal(second.statusSampledAt, first.statusSampledAt);
    assert.equal(second.opentimes, "10:00-22:00（周一至周日）");
    assert.equal(fx.countOf(PATH_COLS), 1);
  } finally {
    fx.restore();
  }
});

test("A2-3: 营业时间也随状态 TTL 过期——25 小时后再查取到新营业时间（审计反例 HOURS_TTL_REPRO 翻转）", async () => {
  const fx = installRouter({
    [PATH_LIST]: () => listOf([{ id: 503542, name: "审计测试店", code: "05", openStatus: 1 }]),
    [PATH_COLS]: (n) => colsOf(1, n === 1 ? "09:00" : "10:00", n === 1 ? "23:00" : "21:00"),
  });
  try {
    const first = hitOf(await findStore("审计测试店"));
    advance(25 * HOUR);
    const second = hitOf(await findStore("审计测试店"));
    assert.equal(first.opentimes, "09:00-23:00（周一至周日）");
    assert.equal(second.opentimes, "10:00-21:00（周一至周日）", "审计反例断言的 after25Hours==first 必须翻转");
    assert.equal(fx.countOf(PATH_COLS), 2, "审计反例断言的 hours==1 必须翻转为 2");
    assert.equal(fx.countOf(PATH_LIST), 2, "名录 25 小时后照旧重拉（既有行为不变）");
  } finally {
    fx.restore();
  }
});

test("A2-4: 状态取回失败 → 「状态未知」、无采样时间、不回落名录旧值；下次查询重试", async () => {
  const fx = installRouter({
    [PATH_LIST]: () => listOf([{ id: 920004, name: "A2 四号店", code: "04", openStatus: 1 }]),
    [PATH_COLS]: (n) => (n === 1 ? { status: false, code: 500, message: "mock down" } : colsOf(1, "08:00", "23:40")),
  });
  try {
    const first = hitOf(await findStore("A2 四号店"));
    assert.equal(first.openStatusText, "状态未知", "名录里的「营业中」不许顶上");
    assert.equal(first.statusSampledAt, undefined);
    assert.equal(first.opentimes, undefined);

    advance(1 * MIN);
    const second = hitOf(await findStore("A2 四号店"));
    assert.equal(second.openStatusText, "营业中", "失败不缓存，下次重试成功");
    assert.ok(second.statusSampledAt);
    assert.equal(fx.countOf(PATH_COLS), 2);
  } finally {
    fx.restore();
  }
});

test("A2-5: 字段级接口不返回 openStatus → 回落强制重拉名录取状态（名录路径实测可靠）", async () => {
  const fx = installRouter({
    [PATH_LIST]: (n) => listOf([{ id: 920005, name: "A2 五号店", code: "05", openStatus: n === 1 ? 1 : 0 }]),
    [PATH_COLS]: () => colsOf(undefined, "09:00", "23:00"),
  });
  try {
    const hit = hitOf(await findStore("A2 五号店"));
    assert.equal(hit.openStatusText, "休息中", "状态应来自第二次（强制重拉）的名录，而不是首次名录的「营业中」");
    assert.ok(hit.statusSampledAt);
    assert.equal(hit.opentimes, "09:00-23:00（周一至周日）");
    assert.equal(fx.countOf(PATH_LIST), 2);
    assert.equal(fx.countOf(PATH_COLS), 1);
  } finally {
    fx.restore();
  }
});

test("A2-6: 多家命中 → 候选列表沿用名录状态并带名录采样时间，不逐店发请求", async () => {
  const fx = installRouter({
    [PATH_LIST]: () =>
      listOf([
        { id: 920006, name: "北京 A 店", code: "06", cityName: "北京", openStatus: 1 },
        { id: 920007, name: "北京 B 店", code: "07", cityName: "北京", openStatus: 0 },
      ]),
    [PATH_COLS]: () => colsOf(1, "09:00", "23:00"),
  });
  try {
    const r = await findStore("北京");
    assert.equal(r.matched, false);
    const cands = (r as { candidates: Array<{ openStatusText: string; statusSampledAt?: string }> }).candidates;
    assert.equal(cands.length, 2);
    assert.deepEqual(cands.map((c) => c.openStatusText), ["营业中", "休息中"]);
    assert.ok(cands.every((c) => c.statusSampledAt), "候选也要带采样时间");
    assert.equal(fx.countOf(PATH_COLS), 0, "候选不逐店取状态");
  } finally {
    fx.restore();
  }
});
