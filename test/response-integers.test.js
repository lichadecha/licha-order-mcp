import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { PATHS } from '../server/qmai.js';
import { argsFor, bind, failure, memberA, number, ok, place, prepare, setup, success, withBound } from '../test-support/commerce.js';

test('R25 BND-02/03 WRT-18 QRY-03 金额分、状态与会员编号按原文的整数值读取', async t => {
  const r = await setup(t);
  const s = await r.session();
  for (const encode of [JSON.rawJSON, String]) {
    r.mock.override.set(PATHS.member, () => ok({ customerId: encode('0.0') }));
    await failure(s, 'bind_member', { code: 'CARD', codeType: 'card' }, /去微信搜/);
    r.mock.override.set(PATHS.member, () => ok(encode(memberA + '0e-1')));
    await bind(s);
    r.mock.couponRows = [
      { title: '测试券甲', unUseStatus: encode('0.999999999999999999'), userCouponCanDisAmount: 3 },
      { title: '测试券乙', unUseStatus: encode('1.0'), couponCenterType: encode('1.999999999999999999'), userCouponCanDisAmount: 1 }
    ];
    const draft = await prepare(s);
    assert.deepEqual(draft.coupons.usable.map(coupon => coupon.title), ['测试券乙']);
    assert.equal(draft.coupons.predicted.basis, 'max_discount');
    r.mock.override.set(PATHS.orderDetail, () => ok({ ...r.mock.last, userId: encode(memberA + '.0'),
      actualAmount: encode('2000.0') }));
    const receipt = await place(s, draft);
    assert.equal(receipt.qmaiActualAmountYuan, '20.00');
    r.mock.override.set(PATHS.orderStatus, () => ok({ userId: memberA, status: encode('1e1') }));
    assert.equal((await success(s, 'get_order_status', { orderNo: receipt.orderNo })).status, 10);
    r.mock.orders = [{ orderNo: receipt.orderNo, userId: memberA, itemList: [
      { goodsName: '甲', num: encode('1.999999999999999999') }, { goodsName: '乙', num: encode('2.0') }
    ] }];
    assert.deepEqual((await success(s, 'my_orders')).orders[0].items, ['甲', '乙 ×2']);
  }
});

test('R25 UNR-03/04/07 等值时间戳都参与唯一性判断，完整空页的 0.0 可证实无单', async t => {
  const { r, m, s } = await withBound(t, { LICHA_ORDER_MATCH_WINDOW_MS: '200' });
  m.override.set(PATHS.create, () => ok({}));
  await failure(s, 'place_order', argsFor(await prepare(s)), /结果未知/);
  const at = r.requests.find(request => request.path === PATHS.create).at;
  const first = { orderNo: number(1), userId: memberA, orderAt: at, status: 10 };
  for (const secondTime of [JSON.rawJSON(at + '.0'), JSON.rawJSON(at + 'e0'), at + '.0']) {
    m.orders = [first, { ...first, orderNo: number(2), orderAt: secondTime }];
    const list = await success(s, 'my_orders');
    assert.equal(list.unresolvedPendingWrites, 1);
    assert.equal(list.resolvedPendingWrites, undefined);
    assert.doesNotMatch(list.pendingWriteNote, /小程序「我的订单」付款/);
    assert.equal(list.orders[1].orderTime, list.orders[0].orderTime);
  }
  await delay(220);
  m.override.set(PATHS.orderList, () => ok({ data: [], total: JSON.rawJSON('0.0') }));
  const empty = await success(s, 'my_orders');
  assert.equal(empty.resolvedPendingWrites, 1);
  assert.match(empty.pendingWriteNote, /企迈侧没有建单/);
});

test('R23 裸数字创建回执按结果未知处理，同号的数字列表行不能认领或证明无单', async t => {
  const { r, s, m } = await withBound(t, { LICHA_ORDER_MATCH_WINDOW_MS: '200' });
  const orderNo = '12345678901234567890';
  m.override.set(PATHS.create, () => ok({ orderNo: JSON.rawJSON(orderNo) }));
  const args = argsFor(await prepare(s));
  await failure(s, 'place_order', args, /结果未知/);
  await failure(s, 'place_order', args, /不能重复|令牌无效/);
  assert.equal(r.requests.filter(x => x.path === PATHS.create).length, 1);
  assert.equal(r.requests.filter(x => x.path === PATHS.orderDetail).length, 0);

  const row = { orderNo: JSON.rawJSON(orderNo), userId: memberA,
    orderAt: r.requests.find(x => x.path === PATHS.create).at, status: 10 };
  m.orders = [row];
  await delay(220);
  const pending = await success(s, 'my_orders');
  assert.equal(pending.count, 0);
  assert.equal(pending.unresolvedPendingWrites, 1);
  assert.equal(pending.resolvedPendingWrites, undefined);
  m.orders = [{ ...row, orderNo }];
  const verified = await success(s, 'my_orders');
  assert.equal(verified.resolvedPendingWrites, 1);
  assert.equal(verified.orders[0].orderNo, orderNo);
});

test('R23 纯数字字符串创建成功，同号裸数详情和状态回执均不可用', async t => {
  const { s, m } = await withBound(t);
  const orderNo = '12345678901234567890';
  m.override.set(PATHS.create, () => ok({ orderNo }));
  const numericRow = { orderNo: JSON.rawJSON(orderNo), userId: memberA, status: 10, actualAmount: 1985 };
  m.override.set(PATHS.orderDetail, () => ok(numericRow));
  const receipt = await place(s, await prepare(s));
  assert.equal(receipt.placed, true);
  assert.equal(receipt.orderNo, orderNo);
  assert.equal(receipt.readbackFailed, true);
  assert.equal(receipt.qmaiActualAmountYuan, undefined);
  m.override.set(PATHS.orderStatus, () => ok(numericRow));
  await failure(s, 'get_order_status', { orderNo }, /订单号与查询不符/);
  m.override.set(PATHS.orderStatus, () => ok({ ...numericRow, orderNo }));
  assert.equal((await success(s, 'get_order_status', { orderNo })).status, 10);
});

test('§4 读回与列表的大额整数分保留最后一分，包括负差额', async t => {
  const { s, m } = await withBound(t);
  m.override.set(PATHS.orderDetail, ({ orderNo }) => ok({ orderNo, userId: memberA, actualAmount: 9007199254740985 }));
  const receipt = await place(s, await prepare(s));
  assert.equal(receipt.qmaiActualAmountYuan, '90071992547409.85');
  assert.equal(receipt.diffYuan, '90071992547389.85');
  m.orders = [{ orderNo: receipt.orderNo, userId: memberA, actualAmount: 9007199254740985 }];
  assert.equal((await success(s, 'my_orders')).orders[0].actualAmountYuan, '90071992547409.85');
  m.override.set(PATHS.orderDetail, ({ orderNo }) => ok({ orderNo, userId: memberA, actualAmount: 1999 }));
  assert.equal((await place(s, await prepare(s))).diffYuan, '-0.01');
});
