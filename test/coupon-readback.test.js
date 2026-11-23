import test from 'node:test';
import assert from 'node:assert/strict';
import { placedView } from '../server/commerce-view.js';
import { PATHS } from '../server/qmai.js';
import { basket, count, memberA, memberB, number, ok, place, success, withBound } from '../test-support/commerce.js';

test('WRT-19/20 不用券却读回有券，按实付和差额引导且不重新下单', async t => {
  const { r, s, m } = await withBound(t);
  const discountList = [
    { discountName: '活动', discountAmount: 0 },
    { discountType: 2, discountSummary: '门店券', discountAmount: 50, couponId: '内部编号' }
  ];
  for (const [actualAmount, hasWarning] of [[1950, false], [1500, true], [0, true]]) {
    m.override.set(PATHS.orderDetail, () => ok({ ...m.last, actualAmount, discountList }));
    const draft = await success(s, 'prepare_order', { ...basket, couponChoice: 'none' });
    const receipt = await place(s, draft);
    assert.deepEqual(receipt.couponApplied, {
      items: [
        { name: '活动', amountYuan: '0.00' },
        { name: '优惠', summary: '门店券', amountYuan: '0.50', isCoupon: true }
      ],
      matchesChoice: false,
      note: '顾客选了这单不用券，但门店系统读回显示还是用了券：活动（抵 ¥0.00）；门店券（抵 ¥0.50）。请先如实告诉顾客，并说明付款页改不了券；这种情况我们这边改不了，不要重新组单再下。'
    });
    assert.equal(Object.hasOwn(receipt, 'warning'), hasWarning);
    assert.equal(receipt.nextStep, actualAmount === 0
      ? '这单读回的实付是 ¥0.00。请按 couponApplied.note 如实说明优惠，请让顾客到小程序「我的订单」确认这一单的状态；不要说「去付款」。'
      : `订单已创建但尚未支付。门店系统没有按顾客的选择不用券（见 couponApplied.note），请先如实说明${hasWarning ? '并说清金额差额' : ''}：顾客接受这个金额，再引导他去小程序「我的订单」完成付款；不接受，就请他在小程序「我的订单」里取消这一单（没付款的单门店不会做，也不会扣钱）。我们不代付、不碰任何支付凭据。`);
  }
  assert.equal(count(r, PATHS.create), 3);
  assert.equal(count(r, PATHS.orderDetail), 3);
});

test('WRT-20 不用券读回其他优惠、类型不明、零优惠及无明细，逐项保留证据', async t => {
  const { s, m } = await withBound(t);
  const activity = { discountType: 3, discountName: '满减' };
  const projected = { name: '满减', amountYuan: null, isCoupon: false };
  const cases = [
    [{ discountList: [activity] }, {
      items: [projected], matchesChoice: true,
      note: '按顾客的选择没有用券；门店系统另外自动给了优惠：满减（金额未知）。这不是用券，请如实告知顾客。'
    }],
    [{ discountList: [activity, { discountSummary: '门店活动', discountType: 999, discountAmount: 100 }] }, {
      items: [projected, { name: '优惠', summary: '门店活动', amountYuan: '1.00' }],
      note: '顾客选了这单不用券；门店系统给了优惠：满减（金额未知）；门店活动（抵 ¥1.00），读回里看不出这是不是优惠券。请如实告知顾客这笔优惠，并请他在小程序「我的订单」里看一下这一单有没有用券。'
    }],
    [{ discountAmount: 0 }, {
      items: [], matchesChoice: true, note: '按顾客的选择，这单没有用券（读回显示没有任何优惠）。'
    }],
    [{}, {
      items: [], note: '顾客选了这单不用券，但读回里没取到优惠明细，无法确认门店系统有没有用券；请按读回实付如实告知，并请顾客在小程序「我的订单」里看一下这一单有没有用券。'
    }]
  ];
  for (const [fields, expected] of cases) {
    m.override.set(PATHS.orderDetail, ({ orderNo }) => ok({ orderNo, userId: memberA, actualAmount: 2000, ...fields }));
    const draft = await success(s, 'prepare_order', { ...basket, couponChoice: 'none' });
    const receipt = await place(s, draft);
    assert.deepEqual(receipt.couponApplied, expected);
    assert.equal(receipt.nextStep, '订单已创建但尚未支付。请把企迈实付金额与优惠（按 couponApplied.note）如实告诉顾客，引导顾客去小程序「我的订单」完成付款——我们不代付、不碰任何支付凭据。');
  }
});

test('WRT-18/20 四种读回失败都丢弃金额和优惠，仅不用券补充核对提醒', () => {
  const orderNo = number(1);
  const detail = { orderNo, userId: memberA, actualAmount: 1500, discountList: [{ discountType: 2 }] };
  for (const [data, problem] of [
    [null, '没读到门店系统的最终金额（响应为空）'],
    [{ ...detail, orderNo: number(2) }, '读回的内容对不上这一单，已丢弃'],
    [{ ...detail, userId: memberB }, '读回的订单归属校验不通过，内容已丢弃'],
    [{ ...detail, actualAmount: null }, '读回里没有可用的实付金额']
  ]) {
    for (const couponChoice of ['none', 'default']) {
      const receipt = placedView({ orderNo, payAmount: 15 }, data, '', { totalFen: 2000, couponChoice }, { id: memberA });
      const suffix = couponChoice === 'none' ? '这单顾客选了不用券，核对金额时请顺便看一下有没有用券。' : '';
      assert.deepEqual(receipt, {
        placed: true, orderNo, readbackFailed: true,
        readbackNote: `订单已创建成功（订单号 ${orderNo}），但${problem}。请让顾客在小程序「我的订单」核对金额后再付款。${suffix}`,
        nextStep: '订单已创建，但最终金额没有核实，不要向顾客报金额。请让顾客在小程序「我的订单」核对金额后再付款——我们不代付、不碰任何支付凭据。'
      });
    }
  }
});

test('WRT-17 默认用券仅在有优惠条目或预测时给出读回核对，只比对预测', () => {
  const orderNo = number(1);
  const draft = { totalFen: 2000, couponChoice: 'default' };
  const detail = { orderNo, userId: memberA, actualAmount: 2000, discountAmount: 0 };
  const read = () => placedView({ orderNo }, detail, '', draft, { id: memberA });
  assert.equal(Object.hasOwn(read(), 'couponApplied'), false);
  detail.discountList = [{ discountType: 2, discountName: '茶券' }];
  const items = [{ isCoupon: true, name: '茶券', amountYuan: null }];
  assert.deepEqual(read().couponApplied, {
    items, note: '门店系统自动使用了优惠券：茶券（金额未知）。请如实告知顾客「系统自动用了你的券」，不是算错。'
  });
  draft.prediction = { title: '茶券', rawTitle: '茶券' };
  assert.deepEqual(read().couponApplied, {
    items, matchesPrediction: true, note: '与组单时告知的一致：茶券（金额未知）。'
  });
});
