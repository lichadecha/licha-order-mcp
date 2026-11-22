import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PATHS } from '../server/qmai.js';
import {
  argsFor, basket, bookFile, failure, memberA, number, ok, place, prepare,
  shop, skuId, success, withBound
} from '../test-support/commerce.js';

test('WRT-17 OUT-02 按完整券名及摘要比对，类型不明的同名优惠保留不确定', async t => {
  const { s, m } = await withBound(t);
  async function compare(title, discountList) {
    m.couponRows = [{ title, unUseStatus: 1, userCouponCanDisAmount: 1 }];
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
    ? [{ title: '门店券', unUseStatus: 1, userCouponCanDisAmount: 1 }] : []));
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
  const { records } = JSON.parse(await readFile(bookFile(r), 'utf8'));
  const pending = records.find(record => record.state === 'unknown');
  assert.equal(pending.products[0].goodsId, '12345');
  m.override.set(PATHS.orderList, () => ok({ total: 1, data: [{
    orderNo: number(99), storeId: shop, userId: memberA, orderAt: pending.time,
    itemList: [{ goodsId: 12345, num: 1 }]
  }] }));
  assert.equal((await success(s, 'my_orders', {})).resolvedPendingWrites, 1);
});
