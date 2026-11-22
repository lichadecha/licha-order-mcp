import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { PATHS } from '../server/qmai.js';
import {
  argsFor, failure, goodsId, memberA, memberB, number, ok, place, prepare, shop, success, withBound
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

test('QRY-04 UNR-02 查询范围外的行计数、丢弃，未来五分钟的订单不能认领未决', async t => {
  const service = await withBound(t, { LICHA_ORDER_MATCH_WINDOW_MS: '600000' });
  const { m, s } = service;
  m.override.set(PATHS.orderList, ({ orderAtStart, orderAtEnd }) => ok({
    data: [candidate(orderAtStart - 8 * 86400000), candidate(orderAtEnd + 2 * 86400000, 2)], total: 2
  }));
  const history = await success(s, 'my_orders', { days: 1 });
  assert.deepEqual(history.orders, []);
  assert.equal(history.discardedOutOfRange, 2);
  const at = await unknownOrder(service);
  m.override.delete(PATHS.orderList);
  m.orders = [candidate(at + 300000)];
  const result = await success(s, 'my_orders', { days: 1 });
  assert.equal(result.count, 0);
  assert.equal(result.discardedOutOfRange, 1);
  assert.equal(result.unresolvedPendingWrites, 1);
  assert.doesNotMatch(result.pendingWriteNote, /小程序「我的订单」付款/);
  m.orders = [candidate(at)];
  assert.equal((await success(s, 'my_orders', { days: 1 })).resolvedPendingWrites, 1);
});

test('QRY-04 非约定的订单列表结构报查询失败，空数组可正常显示', async t => {
  const { m, s } = await withBound(t);
  m.override.set(PATHS.orderList, () => ok({ list: [candidate(Date.now())], total: 5 }));
  await failure(s, 'my_orders', {}, /查询订单列表失败/);
  m.override.delete(PATHS.orderList);
  assert.equal((await success(s, 'my_orders')).count, 0);
});

test('UNR-07 唯一候选状态缺失时只确认建单，不断言支付状态', async t => {
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
