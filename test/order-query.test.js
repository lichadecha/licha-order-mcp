import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PATHS } from '../server/qmai.js';
import { rowTime } from '../server/commerce-view.js';
import {
  argsFor, bookRecords, count, failure, goodsId, memberA, memberB, number, ok, place, prepare, shop, success, withBound
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

test('UNR-04/07 匹配窗已过，区间总数为零时多返回一张越界旧单仍可确认无单', async t => {
  const service = await withBound(t, { LICHA_ORDER_MATCH_WINDOW_MS: '200' });
  const { m, s } = service;
  await unknownOrder(service);
  await delay(300);
  let total = 2;
  m.override.set(PATHS.orderList, ({ orderAtStart }) => ok({ total, data: [candidate(orderAtStart - 86400000)] }));
  assert.equal((await success(s, 'my_orders', { days: 90 })).unresolvedPendingWrites, 1);
  total = 0;
  const result = await success(s, 'my_orders', { days: 1 });
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

test('QRY-06 订单号不合 R23 时本地拒绝，不回显原值、不调用企迈', async t => {
  const { r, s } = await withBound(t);
  const before = r.requests.length;
  for (const orderNo of ['13800000000', 'a'.repeat(41), 'abc-123456789', '单12345678901', number(1) + '\n']) {
    const error = await failure(s, 'get_order_status', { orderNo }, /订单号格式不对/);
    assert.equal(error, '订单号格式不对：请照小程序订单页上的订单号报（字母 D 开头加一串数字）。');
  }
  assert.equal(r.requests.length, before);
});

test('QRY-02 QRY-06 即使同一会员，单号不符也拒绝读回', async t => {
  const { m, s } = await withBound(t);
  const orderNo = 'aB1234567890';
  const receiptOrderNo = number(2);
  m.override.set(PATHS.orderStatus, () => ok({ orderNo: receiptOrderNo, userId: memberA, status: 10 }));
  assert.equal(await failure(s, 'get_order_status', { orderNo }, /读回的不是这一单/),
    '无法查询：门店系统读回的不是这一单，请核对订单号后再试。');
  m.override.set(PATHS.orderStatus, () => ok({ orderNo: receiptOrderNo, userId: memberB, status: 10 }));
  const error = await failure(s, 'get_order_status', { orderNo }, /读回的不是这一单/);
  assert.ok(!error.includes(receiptOrderNo));
  assert.doesNotMatch(error, /待支付|完成付款/);
});

test('QRY-06 状态回执不带单号时只返回已查到的状态', async t => {
  const {s} = await withBound(t);
  const result = await success(s, 'get_order_status', {orderNo:'9'.repeat(40)});
  assert.equal(Object.hasOwn(result, 'orderNo'), false);
  assert.equal(result.status, 10);
});

test('QRY-02/03 状态回执的单号已提供但不合格时，拒绝返回状态和付款提示', async t => {
  const { m, s } = await withBound(t);
  const requested = number(1);
  for (const orderNo of [number(2) + ' ', [number(2)], null, '']) {
    m.override.set(PATHS.orderStatus, () => ok({ orderNo, userId: memberA, status: 10 }));
    const error = await failure(s, 'get_order_status', { orderNo: requested }, /读回的不是这一单/);
    assert.ok(!error.includes(number(2)));
    assert.doesNotMatch(error, /待支付|付款/);
  }
  const digits = '9000000000000001';
  m.override.set(PATHS.orderStatus, () => ok({ orderNo: JSON.rawJSON(digits), userId: memberA, status: 10 }));
  await failure(s, 'get_order_status', { orderNo: digits }, /读回的不是这一单/);
  m.override.set(PATHS.orderStatus, () => ok({ orderNo: requested, userId: memberA, status: 10 }));
  assert.equal((await success(s, 'get_order_status', { orderNo: requested })).status, 10);
});

test('UNR-04 区间总数为一，错页只返回两天前的订单时保持未决并阻止再次创建', async t => {
  const service = await withBound(t, { LICHA_ORDER_MATCH_WINDOW_MS: '200' });
  const { r, m, s } = service;
  await unknownOrder(service);
  const [{ time }] = bookRecords(r);
  await delay(250);
  const newOrder = candidate(time, 2);
  m.orders = [newOrder];
  m.override.set(PATHS.orderList, () => ok({ data: [candidate(time - 2 * 86400000)], total: 1 }));
  const result = await success(s, 'my_orders', { days: 1 });
  assert.equal(result.count, 0);
  assert.deepEqual(result.orders, []);
  assert.equal(result.unresolvedPendingWrites, 1);
  assert.equal(result.resolvedPendingWrites, undefined);
  assert.doesNotMatch(result.pendingWriteNote, /企迈侧没有建单/);
  await failure(s, 'place_order', argsFor(await prepare(s)), /先调用 my_orders/);
  assert.equal(count(r, PATHS.create), 1);

  m.override.delete(PATHS.orderList);
  const corrected = await success(s, 'my_orders', { days: 1 });
  assert.equal(corrected.resolvedPendingWrites, 1);
  assert.equal(bookRecords(r)[0].orderNo, newOrder.orderNo);
});

test('UNR-04 区间总数为一，返回的一张区间内旧单在匹配窗外时确认无单', async t => {
  const service = await withBound(t, { LICHA_ORDER_MATCH_WINDOW_MS: '200' });
  const { m, s } = service;
  const at = await unknownOrder(service);
  m.orders = [candidate(at - 3600000)];
  await delay(250);
  const result = await success(s, 'my_orders', { days: 1 });
  assert.deepEqual(result.orders.map(row => row.orderNo), [number(1)]);
  assert.equal(result.resolvedPendingWrites, 1);
  assert.equal(result.unresolvedPendingWrites, undefined);
  assert.match(result.pendingWriteNote, /企迈侧没有建单/);
});

test('UNR-04 A 已建单，错页只返回未标会员的 B 旧单时，第二次确认不发送', async t => {
  const { r, m, s } = await withBound(t, { LICHA_ORDER_MATCH_WINDOW_MS: '200' });
  const old = { ...candidate(Date.now() - 3600000), userId: memberB };
  m.orders.push(old);
  m.override.set(PATHS.create, ({ userId }) => {
    m.orders.push({ ...candidate(Date.now(), 2), userId });
    return ok({}); // 上游已登记，但回执缺单号。
  });
  await failure(s, 'place_order', argsFor(await prepare(s)), /结果未知/);
  m.override.delete(PATHS.create);
  const { userId, ...withoutOwner } = old;
  m.override.set(PATHS.orderList, ({ userId: queried }) => ok({
    data: [withoutOwner], total: m.orders.filter(row => row.userId === queried).length
  }));
  await delay(250);
  const pending = await success(s, 'my_orders', { days: 1 });
  assert.equal(pending.unresolvedPendingWrites, 1);
  assert.equal(pending.resolvedPendingWrites, undefined);
  assert.doesNotMatch(pending.pendingWriteNote, /企迈侧没有建单/);
  assert.deepEqual(bookRecords(r).map(row => row.state), ['unknown']);
  await failure(s, 'place_order', argsFor(await prepare(s)), /先调用 my_orders/);
  assert.equal(count(r, PATHS.create), 1);
  assert.equal(m.orders.filter(row => row.userId === memberA).length, 1);

  // 同页多出缺归属的旧单，不影响认领唯一吻合的本人新单。
  m.override.set(PATHS.orderList, () => ok({ data: [withoutOwner, m.orders[1]], total: 1 }));
  const matched = await success(s, 'my_orders', { days: 1 });
  assert.equal(matched.resolvedPendingWrites, 1);
  assert.equal(bookRecords(r)[0].orderNo, number(2));
});

test('UNR-04 总数为零，归属缺失的越界行仍阻止判无单，换成完整空页后解除', async t => {
  const service = await withBound(t, { LICHA_ORDER_MATCH_WINDOW_MS: '200' });
  const { r, m, s } = service;
  await unknownOrder(service);
  await delay(250);
  m.override.set(PATHS.orderList, ({ orderAtStart }) => ok({
    data: [{ orderNo: number(1), orderAt: orderAtStart - 1 }], total: 0
  }));
  const pending = await success(s, 'my_orders', { days: 1 });
  assert.deepEqual(pending.orders, []);
  assert.equal(pending.unverifiedNotShown, undefined);
  assert.equal(pending.unresolvedPendingWrites, 1);
  assert.equal(bookRecords(r)[0].state, 'unknown');

  m.override.delete(PATHS.orderList);
  const empty = await success(s, 'my_orders', { days: 1 });
  assert.equal(empty.resolvedPendingWrites, 1);
  assert.match(empty.pendingWriteNote, /企迈侧没有建单/);
  assert.equal(bookRecords(r)[0].state, 'absent');
});

test('UNR-04 时段外出现他人订单时整页不能证明无单，换成本人的越界行才解除', async t => {
  const service = await withBound(t, { LICHA_ORDER_MATCH_WINDOW_MS: '10' });
  const { r, m, s } = service;
  await unknownOrder(service);
  await delay(20);
  let outsideOwner = memberB;
  m.override.set(PATHS.orderList, ({ orderAtStart }) => ok({
    data: [candidate(orderAtStart + 60000), { ...candidate(orderAtStart - 1, 2), userId: outsideOwner }],
    total: 1
  }));
  const pending = await success(s, 'my_orders', { days: 1 });
  assert.deepEqual(pending.orders.map(row => row.orderNo), [number(1)]);
  assert.equal(pending.discardedNotOwned, undefined);
  assert.equal(pending.unresolvedPendingWrites, 1);
  assert.equal(bookRecords(r)[0].state, 'unknown');
  outsideOwner = memberA;
  const resolved = await success(s, 'my_orders', { days: 1 });
  assert.equal(resolved.resolvedPendingWrites, 1);
  assert.equal(bookRecords(r)[0].state, 'absent');
});

test('R10 先读北京时间的 createdAt，缺失时按顺序读取旧毫秒字段', () => {
  const leapDay = { createdAt: '2024-02-29 00:00:00' };
  const millis = Date.UTC(2024, 1, 28, 16);
  assert.equal(rowTime({ ...leapDay, orderAt: millis + 1, createTime: millis + 2 }), millis);
  assert.equal(rowTime({ orderAt: millis + 1, createTime: millis + 2 }), millis + 1);
  assert.equal(rowTime({ createdAt: null, createTime: String(millis + 2) }), millis + 2);
});

test('R10 无效日历日期、缺秒、时区后缀和非字符串均无下单时间', () => {
  for (const createdAt of [
    '2026-02-29 10:11:12', '2026-04-31 10:11:12', '2026-11-23 24:00:00',
    '2026-11-23 10:11', '2026-11-23 10:11:12+08:00', '2026-11-23 10:11:12Z',
    '2026-11-23 10:11:12.000', '2026-11-23T10:11:12', 1795400000000, ['2026-11-23 10:11:12']
  ]) {
    assert.equal(rowTime({ createdAt, orderAt: 1795400000000 }), null, String(createdAt));
  }
  assert.equal(rowTime({ updatedAt: '2026-11-23 10:11:12' }), null);
});

test('QRY-04 UNR-03/04 本人订单的 createdAt 无效时省略时间，过静默期仍保持未决', async t => {
  const service = await withBound(t, { LICHA_ORDER_MATCH_WINDOW_MS: '10' });
  const { r, s, m } = service;
  await unknownOrder(service);
  const [pending] = bookRecords(r);
  m.orders = [{ ...candidate(pending.time), createdAt: '2026-04-31 10:11:12' }];
  await delay(20);
  const result = await success(s, 'my_orders');
  assert.equal(result.orders[0].orderNo, number(1));
  assert.equal(result.orders[0].orderTime, undefined);
  assert.equal(result.unresolvedPendingWrites, 1);
  assert.equal(result.resolvedPendingWrites, undefined);
  assert.equal(bookRecords(r)[0].state, 'unknown');
});
