import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PATHS } from '../server/qmai.js';
import {
  argsFor, bookRecords, failure, goodsId, memberA, number, ok, shop, skuId, success, withBound
} from '../test-support/commerce.js';

const requestTime = Date.parse('2026-11-23T00:05:00+08:00');
const tenMinutes = 10 * 60_000;

async function serviceAtRequestTime(t) {
  const dir = await mkdtemp(join(tmpdir(), 'licha-order-clock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const clock = join(dir, 'time');
  async function advanceFromRequest(ms) {
    await writeFile(clock + '.next', String(requestTime + ms));
    await rename(clock + '.next', clock);
  }
  await advanceFromRequest(0);
  const preload = `import { readFileSync } from 'node:fs'; Date.now = () => Number(readFileSync(${JSON.stringify(clock)}, 'utf8'));`;
  const service = await withBound(t, {
    TZ: 'UTC', NODE_OPTIONS: '--import=data:text/javascript;base64,' + Buffer.from(preload).toString('base64')
  });
  service.m.override.set(PATHS.orderList, () => ok({
    blttUserId: null, data: service.m.orders, total: service.m.orders.length
  }));
  return { ...service, advanceFromRequest };
}

// §3.13 脱敏模拟。19 位编号在 HTTP 响应中使用裸 JSON 数字。
function orderRow(createdAt, index = 1) {
  return {
    orderNo: number(index), userId: JSON.rawJSON(memberA), storeId: Number(shop),
    createdAt, updatedAt: '2026-11-23 00:20:00', payAt: null, status: 60,
    actualAmount: 0, totalAmount: 2600, source: null, orderId: null, refundList: [],
    itemList: [{
      goodsId: JSON.rawJSON(goodsId), itemId: JSON.rawJSON(skuId), itemName: '测试茶',
      num: 2, itemPrice: 1300, itemSpec: [], goodsPracticeList: []
    }]
  };
}

async function sendUnknown({ s, m }) {
  m.price = 1300;
  m.override.set(PATHS.create, () => ok({}));
  const draft = await success(s, 'prepare_order', { storeId: shop, items: [{ goodsId, quantity: 2 }] });
  await failure(s, 'place_order', argsFor(draft), /结果未知/);
}

test('R10 UNR-03 真实字段的本人订单在十分钟边界按商品编号和数量认领', async t => {
  const service = await serviceAtRequestTime(t);
  const { r, s, m, advanceFromRequest } = service;
  await sendUnknown(service);
  await advanceFromRequest(tenMinutes);
  const createdAt = '2026-11-23 00:15:00';
  const row = orderRow(createdAt);
  m.override.set(PATHS.orderStatus, () => ok({
    orderNo: row.orderNo, status: 60, userId: JSON.rawJSON(memberA), blttUserId: null, storeOrderNo: null
  }));
  const status = await success(s, 'get_order_status', { orderNo: row.orderNo });
  assert.equal(status.statusText, '已取消');
  assert.equal(status.unresolvedPendingWrites, 1);

  for (const change of [{ goodsId: JSON.rawJSON(skuId) }, { num: 1 }]) {
    m.orders = [{ ...row, itemList: [{ ...row.itemList[0], ...change }] }];
    assert.equal((await success(s, 'my_orders')).unresolvedPendingWrites, 1);
  }
  m.orders = [row];
  const matched = await success(s, 'my_orders');
  assert.equal(matched.resolvedPendingWrites, 1);
  assert.deepEqual(matched.orders, [{
    orderNo: row.orderNo, status: 60, statusText: '已取消', actualAmountYuan: '0.00',
    orderTime: createdAt + ' +08:00', items: ['测试茶 ×2']
  }]);
  const [record] = bookRecords(r);
  assert.equal(record.state, 'found');
  assert.equal(record.orderNo, row.orderNo);
});

test('R10 UNR-03/04 仅早于匹配窗一秒的本人订单可展示，静默期后完整页可判无单', async t => {
  const service = await serviceAtRequestTime(t);
  const { r, s, m, advanceFromRequest } = service;
  await sendUnknown(service);
  m.orders = [orderRow('2026-11-22 23:54:59')];
  const early = await success(s, 'my_orders');
  assert.deepEqual(early.orders.map(row => row.orderNo), [number(1)]);
  assert.equal(early.unresolvedPendingWrites, 1);
  await advanceFromRequest(tenMinutes + 1);
  const settled = await success(s, 'my_orders');
  assert.match(settled.pendingWriteNote, /企迈侧没有建单/);
  assert.equal(bookRecords(r)[0].state, 'absent');
});

test('UNR-04 完整空页在十分钟静默期内保持未决，期满判无单', async t => {
  const service = await serviceAtRequestTime(t);
  const { r, s, advanceFromRequest } = service;
  await sendUnknown(service);
  await advanceFromRequest(tenMinutes - 1);
  assert.equal((await success(s, 'my_orders')).unresolvedPendingWrites, 1);
  await advanceFromRequest(tenMinutes);
  const empty = await success(s, 'my_orders');
  assert.deepEqual(empty.orders, []);
  assert.equal(empty.resolvedPendingWrites, 1);
  assert.equal(bookRecords(r)[0].state, 'absent');
});

test('R10 QRY-04 查询起止两端整秒均可见，边界落在秒中时按秒起点过滤', async t => {
  const { s, m, advanceFromRequest } = await serviceAtRequestTime(t);
  m.orders = [
    orderRow('2026-11-22 00:04:59', 1), orderRow('2026-11-22 00:05:00', 2),
    orderRow('2026-11-23 00:05:00', 3), orderRow('2026-11-23 00:05:01', 4)
  ];
  const exact = await success(s, 'my_orders', { days: 1 });
  assert.deepEqual(exact.orders.map(row => row.orderNo), [number(2), number(3)]);
  await advanceFromRequest(1);
  const shifted = await success(s, 'my_orders', { days: 1 });
  assert.deepEqual(shifted.orders.map(row => row.orderNo), [number(3)]);
});
