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
