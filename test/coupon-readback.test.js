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

test('WRT-18/20/21 四种读回失败都丢弃金额和优惠，按顾客用券选择补充核对提醒', () => {
  const orderNo = number(1);
  const detail = { orderNo, userId: memberA, actualAmount: 1500, discountList: [{ discountType: 2 }] };
  for (const [data, problem] of [
    [null, '没读到门店系统的最终金额（响应为空）'],
    [{ ...detail, orderNo: number(2) }, '读回的内容对不上这一单，已丢弃'],
    [{ ...detail, userId: memberB }, '读回的订单归属校验不通过，内容已丢弃'],
    [{ ...detail, actualAmount: null }, '读回里没有可用的实付金额']
  ]) {
    for (const [couponChoice, suffix] of [
      ['default', ''],
      ['none', '这单顾客选了不用券，核对金额时请顺便看一下有没有用券。'],
      ['specific', '这单顾客指定了用『茶券』，核对金额时请顺便看一下用的是不是这张。']
    ]) {
      const draft = { totalFen: 2000, couponChoice };
      if (couponChoice === 'specific') draft.chosenCoupon = { id: '205', title: '茶券' };
      const receipt = placedView({ orderNo, payAmount: 15 }, data, '', draft, { id: memberA });
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

const activity = { discountType: 3, discountName: '满减', discountAmount: 100 };

function readDiscounts(couponChoice, discountList, discountAmount) {
  const orderNo = number(1);
  const detail = { orderNo, userId: memberA, actualAmount: 1800, discountAmount, discountList };
  const draft = { totalFen: 2000, couponChoice };
  if (couponChoice === 'default') draft.prediction = { title: '茶券', rawTitle: '茶券' };
  return placedView({ orderNo }, detail, '', draft, { id: memberA }).couponApplied;
}

test('WRT-17/20 默认和不用券都逐条展示认不出的优惠，保留用券结论的不确定性', () => {
  for (const unknown of [null, 7, '内部文字', [{ discountType: 2 }]]) {
    for (const choice of ['default', 'none']) {
      const applied = readDiscounts(choice, [activity, unknown], 200);
      const description = '满减（抵 ¥1.00）；优惠（金额未知）';
      assert.deepEqual(applied, {
        items: [{ name: '满减', amountYuan: '1.00', isCoupon: false }, { name: '优惠', amountYuan: null }],
        note: choice === 'none'
          ? `顾客选了这单不用券；门店系统给了优惠：${description}，读回里看不出这是不是优惠券。请如实告知顾客这笔优惠，并请他在小程序「我的订单」里看一下这一单有没有用券。`
          : `门店系统自动给了优惠：${description}。读回里看不出这是不是优惠券，请如实告知顾客有这笔优惠。`
      });
    }
  }
});

test('WRT-17/20 明细金额之和与合计不符时不能断言没用券，相符时沿用原结论', () => {
  const rows = [activity, { discountType: 5, discountAmount: 50 }];
  for (const choice of ['default', 'none']) {
    for (const total of [0, 149, 151]) {
      const applied = readDiscounts(choice, rows, total);
      assert.equal(Object.hasOwn(applied, 'matchesPrediction'), false);
      assert.equal(Object.hasOwn(applied, 'matchesChoice'), false);
      assert.match(applied.note, /读回里看不出这是不是优惠券/);
    }
    for (const [list, total] of [[rows, 150], [rows, undefined], [[activity, { discountType: 5 }], 150]]) {
      const applied = readDiscounts(choice, list, total);
      if (choice === 'none') assert.equal(applied.matchesChoice, true);
      else assert.equal(applied.matchesPrediction, false);
      assert.match(applied.note, /这不是用券/);
    }
  }
});

test('WRT-17/20 有明确券时，未知条目或合计不符均保留已用券的结论', () => {
  const coupon = { discountType: 2, discountName: '茶券', discountAmount: 100 };
  for (const rows of [[activity, null, coupon], [activity, coupon]]) {
    assert.equal(readDiscounts('none', rows, 300).matchesChoice, false);
    assert.equal(readDiscounts('default', rows, 300).matchesPrediction, true);
  }
});

const chosenCoupon = { id: '9012345678901234567', title: '三元券' };
const selected = { discountType: 2, discountId: chosenCoupon.id, discountName: '三元券', discountAmount: 300 };
const other = { ...selected, discountId: '9012345678901234568' };
function specificReceipt(fields) {
  const orderNo = number(1);
  return placedView({ orderNo }, { orderNo, userId: memberA, actualAmount: 2000, ...fields },
    '', { totalFen: 2000, couponChoice: 'specific', chosenCoupon }, { id: memberA });
}

test('WRT-21/R25 通过下单入口按读回券实例的精确整数值核对，输出只带投影', async t => {
  const { s, m, r } = await withBound(t);
  m.couponRows = [{ ...chosenCoupon, unUseStatus: 1, userCouponCanDisAmount: 3 }];
  const initial = await success(s, 'prepare_order', basket);
  const couponRef = initial.coupons.usable[0].ref;
  for (const discountId of [JSON.rawJSON(chosenCoupon.id + '0e-1'), '000' + chosenCoupon.id + '.00']) {
    m.override.set(PATHS.orderDetail, () => ok({ ...m.last, actualAmount: 1600, discountAmount: 400,
      discountList: [{ ...selected, discountId, discountName: '优惠券', extraMap: { received: chosenCoupon.id } }, activity] }));
    const draft = await success(s, 'prepare_order', { ...basket, couponChoice: 'specific', couponRef });
    const receipt = await place(s, draft);
    assert.deepEqual(receipt.couponApplied, {
      items: [{ name: '优惠券', amountYuan: '3.00', isCoupon: true }, { name: '满减', amountYuan: '1.00', isCoupon: false }],
      matchesChoice: true, note: '按顾客的选择用了『三元券』：优惠券（抵 ¥3.00）；满减（抵 ¥1.00）。'
    });
    assert.ok(!JSON.stringify(receipt).includes(chosenCoupon.id));
  }
  assert.equal(count(r, PATHS.create), 2);
});

test('WRT-21 同名异券和额外用券都不符合选择，付款指引随差额和零实付变化', () => {
  for (const rows of [[other], [selected, other]]) {
    for (const [actualAmount, hasWarning] of [[1950, false], [1700, true], [0, true]]) {
      const receipt = specificReceipt({ actualAmount, discountList: rows });
      assert.equal(receipt.couponApplied.matchesChoice, false);
      assert.equal(receipt.couponApplied.note, `顾客指定了『三元券』，但门店系统读回用的是：${rows.map(() => '三元券（抵 ¥3.00）').join('；')}。请先如实告诉顾客，并说明付款页改不了券；这种情况我们这边改不了，不要重新组单再下。`);
      assert.equal(Object.hasOwn(receipt, 'warning'), hasWarning);
      assert.equal(receipt.nextStep, actualAmount === 0
        ? '这单读回的实付是 ¥0.00。请按 couponApplied.note 如实说明优惠，请让顾客到小程序「我的订单」确认这一单的状态；不要说「去付款」。'
        : `订单已创建但尚未支付。门店系统没有按顾客指定的券办（见 couponApplied.note），请先如实说明${hasWarning ? '并说清金额差额' : ''}：顾客接受这个金额，再引导他去小程序「我的订单」完成付款；不接受，就请他在小程序「我的订单」里取消这一单（没付款的单门店不会做，也不会扣钱）。我们不代付、不碰任何支付凭据。`);
      assert.ok(!JSON.stringify(receipt).includes(other.discountId));
    }
  }
});

test('WRT-21 仅有非券优惠或明确零优惠时如实说明没有用上任何券', () => {
  for (const [fields, description] of [
    [{ discountList: [activity], discountAmount: 100 }, '；门店系统另给的优惠：满减（抵 ¥1.00）'],
    [{ discountAmount: 0 }, '']
  ]) {
    const { couponApplied } = specificReceipt(fields);
    assert.equal(couponApplied.matchesChoice, false);
    assert.equal(couponApplied.note, `顾客指定了『三元券』，但读回显示这单没有用上任何券${description}。请先如实告诉顾客，并说明付款页改不了券；这种情况我们这边改不了，不要重新组单再下。`);
  }
});

test('WRT-21 证据不全时保留明细并请顾客核对，金额未知本身不阻断身份核对', () => {
  for (const fields of [
    {}, { discountAmount: 300 }, { discountList: [{ ...selected, discountId: undefined }] },
    { discountList: [{ ...selected, discountId: chosenCoupon.id + '.00001' }] },
    { discountList: [selected, null] }, { discountList: [{ ...selected, discountType: 999 }] },
    { discountList: [selected], discountAmount: 299 }, { discountList: [activity], discountAmount: 0 },
    { discountList: [selected, { ...selected, discountId: null }] }
  ]) {
    const { couponApplied } = specificReceipt(fields);
    assert.equal(couponApplied.items.length, fields.discountList?.length ?? 0);
    assert.equal(Object.hasOwn(couponApplied, 'matchesChoice'), false);
    assert.equal(Object.hasOwn(couponApplied, 'matchesPrediction'), false);
    assert.match(couponApplied.note, /^顾客指定了『三元券』，读回里没法确认用的是不是这张/);
    assert.match(couponApplied.note, /请如实告知顾客，并请他在小程序「我的订单」里看一下这一单用的是哪张券。$/);
  }
  const { couponApplied } = specificReceipt({ discountList: [{ ...selected, discountAmount: null }] });
  assert.equal(couponApplied.matchesChoice, true);
  assert.equal(couponApplied.note, '按顾客的选择用了『三元券』：三元券（金额未知）。');
});
