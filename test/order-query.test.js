import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PATHS } from '../server/qmai.js';
import {
  argsFor, bookRecords, failure, goodsId, memberA, memberB, number, ok, place, prepare, shop, success, withBound
} from '../test-support/commerce.js';

async function unknownOrder(service) {
  const { r, s, m } = service;
  m.override.set(PATHS.create, () => ok({}));
  await failure(s, 'place_order', argsFor(await prepare(s)), /结果未知/);
  return r.requests.filter(request => request.path === PATHS.create).at(-1).at;
}

function candidate(at, index = 1) {
  return { orderNo: number(index), userId: memberA, storeId: shop, orderAt: at, status: 10,
    itemList: [{ goodsId, num: 1 }] };
}

test('UNR-04 WRT-18 QRY-03 非整数字符串和原始数字词素不能确认无单、实付或待支付', async t => {
  const service = await withBound(t, { LICHA_ORDER_MATCH_WINDOW_MS: '100' });
  const { s, m } = service;
  for (const encode of [value => value, JSON.rawJSON]) {
    m.override.set(PATHS.orderDetail, () => ok({ ...m.last, actualAmount: encode('1e-400') }));
    const created = await place(s, await prepare(s));
    assert.equal(created.readbackFailed, true);
    assert.equal(created.qmaiActualAmountYuan, undefined);
    m.override.set(PATHS.orderStatus, () => ok({ userId: memberA, status: encode('9.999999999999999999') }));
    const status = await success(s, 'get_order_status', { orderNo: created.orderNo });
    assert.equal(status.status, null);
    assert.match(status.paymentHint, /没查清/);
  }
  await unknownOrder(service);
  await delay(110);
  for (const total of ['1e-400', JSON.rawJSON('1e-400')]) {
    m.override.set(PATHS.orderList, () => ok({ data: [], total }));
    const result = await success(s, 'my_orders');
    assert.equal(result.unresolvedPendingWrites, 1);
    assert.equal(result.resolvedPendingWrites, undefined);
    assert.doesNotMatch(result.pendingWriteNote, /企迈侧没有建单/);
  }
  m.override.set(PATHS.orderList, () => ok({ data: [], total: '0' }));
  assert.match((await success(s, 'my_orders')).pendingWriteNote, /企迈侧没有建单/);
});

test('UNR-03 QRY-04 第十一行也参与唯一性判断，顾客仅看到十行', async t => {
  const service = await withBound(t, { LICHA_ORDER_MATCH_WINDOW_MS: '600000' });
  const { m, s } = service;
  const at = await unknownOrder(service);
  m.orders = [candidate(at), ...Array.from({ length: 9 }, (_, i) => candidate(at - 3600000, i + 2)),
    candidate(at, 11)];
  const result = await success(s, 'my_orders');
  assert.equal(result.count, 10);
  assert.deepEqual(result.orders.map(row => row.orderNo), m.orders.slice(0, 10).map(row => row.orderNo));
  assert.equal(result.unresolvedPendingWrites, 1);
  assert.equal(result.resolvedPendingWrites, undefined);
  m.orders.shift();
  assert.match((await success(s, 'my_orders')).pendingWriteNote, new RegExp(number(11)));
});

test('QRY-04 UNR-02 查询范围外的行丢弃，未来五分钟的订单不能认领未决', async t => {
  const service = await withBound(t, { LICHA_ORDER_MATCH_WINDOW_MS: '600000' });
  const { m, s } = service;
  m.override.set(PATHS.orderList, ({ orderAtStart, orderAtEnd }) => ok({
    data: [candidate(orderAtStart - 8 * 86400000), candidate(orderAtEnd + 2 * 86400000, 2)], total: 2
  }));
  const history = await success(s, 'my_orders', { days: 1 });
  assert.deepEqual(history.orders, []);
  assert.equal(history.count, 0);
  const at = await unknownOrder(service);
  m.override.delete(PATHS.orderList);
  m.orders = [candidate(at + 300000)];
  const result = await success(s, 'my_orders', { days: 1 });
  assert.equal(result.count, 0);
  assert.equal(result.unresolvedPendingWrites, 1);
  assert.doesNotMatch(result.pendingWriteNote, /小程序「我的订单」付款/);
  m.orders = [candidate(at)];
  assert.equal((await success(s, 'my_orders', { days: 1 })).resolvedPendingWrites, 1);
});

test('OUT-01 QRY-04 本人及他人的越界行都只写日志，不进入列表出参', async t => {
  const { r, s, m } = await withBound(t);
  m.override.set(PATHS.orderList, ({ orderAtStart, orderAtEnd }) => ok({
    data: [candidate(orderAtStart - 1), { ...candidate(orderAtEnd + 1, 2), userId: memberB },
      candidate(orderAtStart, 3), candidate(orderAtEnd, 4)], total: 4
  }));
  const verified = await success(s, 'my_orders', { days: 1 });
  assert.deepEqual(Object.keys(verified).sort(), ['count', 'days', 'member', 'note', 'orders']);
  assert.equal(verified.count, 2);
  assert.deepEqual(verified.orders.map(row => row.orderNo), [number(3), number(4)]);
  const access = (await readFile(join(r.logDir, 'access.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(access.find(row => row.event === 'orders_out_of_range')?.count, 2);
});

test('UNR-04/07 匹配窗已过，整页只有能按时间排除的行时确认无单', async t => {
  const service = await withBound(t, { LICHA_ORDER_MATCH_WINDOW_MS: '200' });
  const { m, s } = service;
  await unknownOrder(service);
  await delay(300);
  let total = 2;
  m.override.set(PATHS.orderList, ({ orderAtStart }) => ok({ total, data: [candidate(orderAtStart - 86400000)] }));
  assert.equal((await success(s, 'my_orders', { days: 90 })).unresolvedPendingWrites, 1);
  total = 1;
  const result = await success(s, 'my_orders', { days: 90 });
  assert.equal(result.count, 0);
  assert.equal(result.resolvedPendingWrites, 1);
  assert.equal(result.unresolvedPendingWrites, undefined);
  assert.match(result.pendingWriteNote, /企迈侧没有建单/);
});

test('UNR-04 重复旧单不能补足总数，换成一张新单后认领新单', async t => {
  const service = await withBound(t, { LICHA_ORDER_MATCH_WINDOW_MS: '200' });
  const { r, m, s } = service;
  await unknownOrder(service);
  const [{ time }] = bookRecords(r);
  const old = candidate(time - 3600000);
  m.orders = [old, old];
  await delay(250);
  const pending = await success(s, 'my_orders');
  assert.equal(pending.unresolvedPendingWrites, 1);
  assert.equal(pending.resolvedPendingWrites, undefined);
  assert.doesNotMatch(pending.pendingWriteNote, /可以重新走 prepare_order/);
  await failure(s, 'place_order', argsFor(await prepare(s)), /先调用 my_orders/);

  m.orders = [old, candidate(time, 2)];
  const matched = await success(s, 'my_orders');
  assert.equal(matched.resolvedPendingWrites, 1);
  assert.equal(matched.unresolvedPendingWrites, undefined);
  assert.equal(bookRecords(r)[0].orderNo, number(2));
});

test('QRY-04 非约定的订单列表结构报查询失败，空数组可正常显示', async t => {
  const { m, s } = await withBound(t);
  m.override.set(PATHS.orderList, () => ok({ list: [candidate(Date.now())], total: 5 }));
  await failure(s, 'my_orders', {}, /查询订单列表失败/);
  m.override.delete(PATHS.orderList);
  assert.equal((await success(s, 'my_orders')).count, 0);
});

test('UNR-07 匹配订单缺少状态时提示去小程序核对状态', async t => {
  const service = await withBound(t);
  const { m, s } = service;
  const at = await unknownOrder(service);
  m.orders = [{ ...candidate(at), status: null }];
  const result = await success(s, 'my_orders');
  assert.equal(result.resolvedPendingWrites, 1);
  assert.equal(result.orders[0].statusText, '状态未知');
  assert.match(result.pendingWriteNote, /状态未查清/);
  assert.doesNotMatch(result.pendingWriteNote, /不是待支付|小程序「我的订单」付款/);
});

test('QRY-02 QRY-03 状态接口回传另一合格单号时拒绝，省略单号可查', async t => {
  const { m, s } = await withBound(t);
  const orderNo = number(1);
  for (const userId of [memberA, memberB]) {
    m.override.set(PATHS.orderStatus, () => ok({ orderNo: number(2), userId, status: 10 }));
    const error = await failure(s, 'get_order_status', { orderNo }, /查询失败/);
    assert.ok(!error.includes(number(2)));
    assert.doesNotMatch(error, /待支付|完成付款|不属于/);
  }
  m.override.delete(PATHS.orderStatus);
  assert.equal((await success(s, 'get_order_status', { orderNo })).status, 10);
});

test('QRY-02/03 状态回执的单号已提供但不合格时，拒绝返回状态和付款提示', async t => {
  const { m, s } = await withBound(t);
  const requested = number(1);
  for (const orderNo of [number(2) + ' ', [number(2)], null, '']) {
    m.override.set(PATHS.orderStatus, () => ok({ orderNo, userId: memberA, status: 10 }));
    const error = await failure(s, 'get_order_status', { orderNo: requested }, /查询失败/);
    assert.ok(!error.includes(number(2)));
    assert.doesNotMatch(error, /待支付|付款/);
  }
  const digits = '9000000000000001';
  m.override.set(PATHS.orderStatus, () => ok({ orderNo: JSON.rawJSON(digits), userId: memberA, status: 10 }));
  await failure(s, 'get_order_status', { orderNo: digits }, /查询失败/);
  m.override.set(PATHS.orderStatus, () => ok({ orderNo: requested, userId: memberA, status: 10 }));
  assert.equal((await success(s, 'get_order_status', { orderNo: requested })).status, 10);
});
