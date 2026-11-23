import test from 'node:test';
import assert from 'node:assert/strict';
import { PATHS } from '../server/qmai.js';
import {
  argsFor, basket, bindAgain, bookRecords, count, failure, memberA, number, ok, place, prepare,
  shop, skuId, success, withBound
} from '../test-support/commerce.js';

test('PRE-09/12 WRT-01/10 同一会员跨设备切换用券选择后只有新版能提交', async t => {
  const { r, s, m } = await withBound(t);
  const other = await r.session();
  await bindAgain(other);
  const original = await prepare(s);
  const revised = await success(other, 'prepare_order', { ...basket, couponChoice: 'none' });
  assert.equal(revised.supersededPendingOrders, 1);
  await failure(s, 'place_order', argsFor(original), /被更新的一版替代/);
  await failure(other, 'place_order', { ...argsFor(revised), couponChoice: 'default' }, /多余的：couponChoice/);
  assert.equal(count(r, PATHS.create), 0);

  // 签发后上游已换规格，提交仍应发送顾客确认的规格、杯数与用券选择。
  m.override.set(PATHS.item, () => ok([{ goodsId: basket.items[0].goodsId, name: '测试茶',
    goodsSkuList: [{ skuId: '12345', salePrice: 3000, clearStatus: 1 }] }]));
  const reads = count(r, PATHS.item);
  assert.equal((await place(other, revised)).couponApplied.matchesChoice, true);
  const [create] = r.requests.filter(request => request.path === PATHS.create);
  assert.equal(create.params.items[0].skuId, skuId);
  assert.equal(create.params.items[0].num, 1);
  assert.deepEqual(create.params.lastSelect, { type: -1, value: '' });
  assert.equal(count(r, PATHS.item), reads);
  assert.equal(count(r, PATHS.create), 1);

  const unused = await success(other, 'prepare_order', { ...basket, couponChoice: 'none' });
  const restored = await prepare(s);
  assert.equal(restored.supersededPendingOrders, 1);
  await failure(other, 'place_order', argsFor(unused), /被更新的一版替代/);
  await place(s, restored);
  const latest = r.requests.filter(request => request.path === PATHS.create).at(-1);
  assert.equal(latest.params.items[0].skuId, 12345);
  assert.ok(!Object.hasOwn(latest.params, 'lastSelect'));
  assert.equal(count(r, PATHS.create), 2);
});

test('R26 WRT-10/12/14 不用券被明确拒绝只发送一次，令牌作废并释放名额', async t => {
  const { r, s, m } = await withBound(t, { LICHA_MAX_ORDERS_PER_DAY: '1' });
  m.override.set(PATHS.create, () => ({ status: false, code: 100002, message: '模拟拒绝' }));
  const draft = await success(s, 'prepare_order', { ...basket, couponChoice: 'none' });
  await failure(s, 'place_order', argsFor(draft), /下单失败：模拟拒绝/);
  await failure(s, 'place_order', argsFor(draft), /确认令牌无效/);
  assert.equal(count(r, PATHS.create), 1);
  assert.equal(count(r, PATHS.orderDetail), 0);
  assert.equal(r.requests.find(request => request.path === PATHS.create).params.attendCouponType, 1);
  assert.equal(bookRecords(r)[0].state, 'failed');
  m.override.delete(PATHS.create);
  const next = await success(s, 'prepare_order', { ...basket, couponChoice: 'none' });
  assert.equal((await place(s, next)).placed, true);
  assert.equal(count(r, PATHS.create), 2);
});

test('WRT-17 OUT-02 按完整券名及摘要比对，类型不明的同名优惠保留不确定', async t => {
  const { s, m } = await withBound(t);
  async function compare(title, discountList) {
    m.couponRows = [{ id: '809', title, unUseStatus: 1, userCouponCanDisAmount: 1 }];
    const draft = await prepare(s);
    m.override.set(PATHS.orderDetail, () => ok({ ...m.last, discountList }));
    const { couponApplied } = await place(s, draft);
    return { draft, couponApplied };
  }

  const longSummary = '有'.repeat(81) + '生日券';
  const suffix = await compare('生日券', [{ discountType: 2, discountSummary: longSummary }]);
  assert.equal(suffix.couponApplied.matchesPrediction, true);
  assert.equal(suffix.couponApplied.items[0].summary, '有'.repeat(80) + '…');
  assert.ok(!JSON.stringify(suffix.couponApplied).includes(longSummary));

  const common = '券'.repeat(80);
  const different = await compare(common + '甲', [{ discountType: 2, discountName: common + '乙' }]);
  assert.equal(different.couponApplied.matchesPrediction, false);
  assert.equal(different.draft.coupons.predicted.title, common + '…');
  assert.doesNotMatch(JSON.stringify(different), /[甲乙]/);

  const uncertain = await compare('生日券', [
    { discountType: 2, discountName: '其他券' }, { discountSummary: '生日券' }
  ]);
  assert.equal(uncertain.couponApplied.items[0].isCoupon, true);
  assert.equal(uncertain.couponApplied.items[1].isCoupon, undefined);
  assert.equal(uncertain.couponApplied.matchesPrediction, undefined);
  assert.match(uncertain.couponApplied.note, /无法确认/);
});

test('PRE-07 R13 筛券收到名录中的原始门店编码，顾客看到的编码已脱敏', async t => {
  const { r, s, m } = await withBound(t);
  m.code = '12000000000000007';
  m.override.set(PATHS.coupons, ({ multiMark }) => ok(multiMark === m.code
    ? [{ id: '801', title: '门店券', unUseStatus: 1, userCouponCanDisAmount: 1 }] : []));
  const found = await success(s, 'find_store', { query: '模拟门店' });
  assert.equal(found.store.shopCode, '***0007');
  const draft = await prepare(s);
  assert.equal(r.requests.find(x => x.path === PATHS.coupons).params.multiMark, m.code);
  assert.equal(draft.coupons.predicted.title, '门店券');
  assert.ok(!JSON.stringify({ found, draft }).includes(m.code));
});

test('PRE-03/06 WRT-10/11 R3 前导零商品可提交，账本与查单按同一商品核对', async t => {
  const { r, s, m } = await withBound(t);
  const goodsId = '00012345';
  const args = { ...basket, items: [{ goodsId, quantity: 1 }] };
  m.override.set(PATHS.item, () => ok([{ goodsId, name: '测试茶',
    goodsSkuList: [{ skuId, salePrice: 2000, clearStatus: 1 }] }]));
  const first = await success(s, 'prepare_order', args);
  assert.equal((await place(s, first)).placed, true);
  assert.deepEqual(r.requests.find(x => x.path === PATHS.item).params.goodsIds, [goodsId]);
  assert.equal(r.requests.find(x => x.path === PATHS.coupons).params.tradeMarks[0].tradeMark, goodsId);
  assert.equal(r.requests.find(x => x.path === PATHS.create).params.items[0].goodsId, 12345);

  m.override.set(PATHS.create, () => ok({}));
  const next = await success(s, 'prepare_order', args);
  await failure(s, 'place_order', argsFor(next), /结果未知/);
  const records = bookRecords(r);
  const pending = records.find(record => record.state === 'unknown');
  assert.equal(pending.products[0].goodsId, '12345');
  m.override.set(PATHS.orderList, () => ok({ total: 1, data: [{
    orderNo: number(99), storeId: shop, userId: memberA, orderAt: pending.time,
    itemList: [{ goodsId: 12345, num: 1 }]
  }] }));
  assert.equal((await success(s, 'my_orders', {})).resolvedPendingWrites, 1);
});
