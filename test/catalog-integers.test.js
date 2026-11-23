import test from 'node:test';
import assert from 'node:assert/strict';
import { PATHS } from '../server/qmai.js';
import { bind, count, failure, ok, place, setup, success } from '../test-support/commerce.js';

const raw = JSON.rawJSON;
const max = '9223372036854775807';
const overflow = '9223372036854775808';
const fractional = '76543210.0000000001';
const exact = '76543210';
const storeId = '301';
const args = { storeId, items: [{ goodsId: exact, quantity: 1, practices: ['少冰'], attaches: ['茶冻'] }] };
const detailArgs = { storeId, goodsId: exact };

function product() {
  return {
    goodsId: raw('7.654321e7'), name: '测试茶',
    goodsSkuList: [{ skuId: raw('200.0'), salePrice: raw('2e3'),
      skuItemList: [{ specName: '规格', specValue: '大杯', specId: raw('3e2'), specValueId: raw('301.0') }] }],
    sortedPracticeList: [{ practiceId: raw('40.20e1'), practiceName: '温度',
      practiceValueList: [{ practiceValue: '少冰', practiceValueId: '4.03e2', price: raw('1e1') }] }],
    attachGoodsList: [{ attachGoodsName: '茶冻', attachGoodsId: raw(max + '.0'), attachGoodsPrice: raw('2.0') }]
  };
}

test('R25 分类、分类商品和搜索保留精确等值编号，过滤无效编号和不足一分的售价', async t => {
  const r = await setup(t);
  const s = await r.session();
  const invalid = [raw(fractional), raw('1e-400'), raw(overflow), '1'.repeat(20), raw('9'.repeat(400)), '0', -1];
  r.mock.override.set(PATHS.categories, () => ok([raw('7.654321e7'), ...invalid].map(frontCategoryId =>
    ({ frontCategoryId, categoryName: '茶类' }))));
  const entries = [raw('76543210.0'), raw(max + '0e-1'), ...invalid].map(goodsId => ({ ...product(), goodsId }));
  const badSku = product();
  badSku.goodsSkuList[0].skuId = raw(fractional);
  const badPrice = product();
  badPrice.goodsSkuList[0].salePrice = raw('999.999999999999999999');
  badPrice.showPriceLow = 2000;
  r.mock.override.set(PATHS.categoryItems, () => ok([...entries, badSku, badPrice]));
  r.mock.override.set(PATHS.search, () => ok([...entries, badSku, badPrice]));
  const menu = keyword => success(s, 'get_menu', { storeId, keyword });
  assert.deepEqual((await menu('')).categories, [{ frontCategoryId: exact, categoryName: '茶类' }]);
  for (const keyword of ['茶类', '奶茶']) {
    assert.deepEqual((await menu(keyword)).items.map(item => item.goodsId), [exact, max]);
  }
  assert.match(r.requests.find(req => req.path === PATHS.categoryItems).raw, /"frontCategoryId":76543210[,}]/);
});

test('R25 详情与所选规格、做法和加料的编号不可舍入或越界，等值写法按原编号创建', async t => {
  const r = await setup(t);
  const s = await r.session();
  await bind(s);
  let row;
  r.mock.override.set(PATHS.item, () => ok([row]));
  for (const value of [raw(fractional), raw(overflow), '9'.repeat(20)]) {
    for (const field of ['goodsId', 'skuId', 'specId', 'specValueId', 'practiceId', 'practiceValueId', 'attachGoodsId']) {
      row = product();
      const holders = [row, row.goodsSkuList[0], row.goodsSkuList[0].skuItemList[0],
        row.sortedPracticeList[0], row.sortedPracticeList[0].practiceValueList[0], row.attachGoodsList[0]];
      holders.find(holder => Object.hasOwn(holder, field))[field] = value;
      await failure(s, 'prepare_order', args, /商品不存在|点不了/);
    }
  }
  assert.equal(count(r, PATHS.coupons), 0);
  assert.equal(count(r, PATHS.create), 0);
  row = product();
  const draft = await success(s, 'prepare_order', args);
  assert.equal(draft.estimatedTotalYuan, '20.12');
  await place(s, draft);
  const request = r.requests.find(req => req.path === PATHS.create);
  assert.deepEqual(request.params.items, [{ goodsId: Number(exact), skuId: 200, num: 1,
    practiceList: [{ id: 402, name: '温度', value: '少冰', valueId: 403, price: 10 }],
    attachList: [{ id: max, name: '茶冻', price: 2, num: 1 }] }]);
  assert.ok(request.raw.includes('"id":' + max + ','));
});

test('R25 售价不足一分时标价格待询，预估与下单均拒绝该规格', async t => {
  const r = await setup(t);
  const s = await r.session();
  await bind(s);
  const salePrices = [raw('1999.6'), '1999.6', raw('999.999999999999999999'), raw('1e-400'), -1, 2000, raw('2000.0')];
  const row = product();
  row.goodsSkuList = salePrices.map((salePrice, i) => ({ skuId: String(i + 1), salePrice }));
  r.mock.override.set(PATHS.item, () => ok([row]));
  const detail = await success(s, 'get_item_detail', detailArgs);
  for (const [i, sku] of detail.skus.entries()) {
    const selected = { storeId, items: [{ goodsId: exact, skuId: sku.skuId, quantity: 1 }] };
    if (i < 5) {
      assert.deepEqual([sku.priceFen, sku.priceYuan, sku.available], [null, '价格待询', false]);
      assert.equal((await success(s, 'preview_order', selected)).ok, false);
      await failure(s, 'prepare_order', selected, /没有价格/);
    } else {
      assert.deepEqual([sku.priceFen, sku.priceYuan, sku.available], [2000, '20.00', true]);
      assert.equal((await success(s, 'prepare_order', selected)).estimatedTotalYuan, '20.00');
    }
  }
  assert.equal(count(r, PATHS.create), 0);
});

test('R25 现有做法或加料有无效加价时不能当成免费', async t => {
  const r = await setup(t);
  const s = await r.session();
  await bind(s);
  const row = product();
  row.sortedPracticeList[0].practiceValueList[0].price = raw('9.999999999999999999');
  row.attachGoodsList[0].attachGoodsPrice = -1;
  r.mock.override.set(PATHS.item, () => ok([row]));
  const card = await success(s, 'get_item_detail', detailArgs);
  assert.equal(card.practices[0].values[0].priceDeltaYuan, '价格待询');
  assert.equal(card.attaches[0].priceYuan, '价格待询');
  for (const options of [{ practices: ['少冰'] }, { attaches: ['茶冻'] }]) {
    const selected = { storeId, items: [{ goodsId: exact, quantity: 1, ...options }] };
    assert.equal((await success(s, 'preview_order', selected)).ok, false);
    await failure(s, 'prepare_order', selected, /价格待询/);
  }
  assert.equal(count(r, PATHS.coupons), 0);
});

test('R25 门店名录和调用方提供的商品、门店编号共用 long 上界，无效值不进入请求', async t => {
  const r = await setup(t);
  const s = await r.session();
  await bind(s);
  const invalid = [overflow, '9'.repeat(20), '9'.repeat(400)];
  r.mock.override.set(PATHS.stores, () => ok({ list: [raw(max + '0e-1'), raw(fractional), ...invalid.map(raw)]
    .map(id => ({ id, name: '测试门店', code: '01', openStatus: 1 })) }));
  r.mock.override.set(PATHS.storeStatus, () => ok({ openStatus: 1 }));
  assert.equal((await success(s, 'find_store', { query: '测试门店' })).store.storeId, max);
  assert.match(r.requests.find(req => req.path === PATHS.storeStatus).raw, new RegExp('"shopId":' + max + ','));
  const before = r.requests.length;
  for (const value of invalid) {
    await failure(s, 'get_menu', { storeId: value }, /参数/);
    await failure(s, 'get_item_detail', { storeId, goodsId: value }, /商品不存在/);
    await failure(s, 'prepare_order', { storeId, items: [{ goodsId: value, quantity: 1 }] }, /商品不存在/);
  }
  assert.equal(r.requests.length, before);
});

test('R25 目录中的状态、排序、库存和标记同样按原文判整数', async t => {
  const r = await setup(t);
  const s = await r.session();
  const almostOne = raw('0.999999999999999999');
  r.mock.override.set(PATHS.stores, () => ok({ list: [{ id: 301, name: '测试门店', openStatus: almostOne }] }));
  r.mock.override.set(PATHS.storeStatus, () => ok({ openStatus: almostOne }));
  assert.equal((await success(s, 'find_store', { query: '测试门店' })).store.openStatusText, '状态未知');
  r.mock.override.set(PATHS.categories, () => ok([
    { frontCategoryId: 1, categoryName: '无排序', categorySort: almostOne },
    { frontCategoryId: 2, categoryName: '靠前', categorySort: raw('2.0') }
  ]));
  const menu = await success(s, 'get_menu', { storeId });
  assert.deepEqual(menu.categories.map(c => c.categoryName), ['靠前', '无排序']);
  const row = product();
  row.isPractice = almostOne;
  row.goodsSkuList[0].inventory = almostOne;
  row.sortedPracticeList[0].isRequired = '0.999999999999999999';
  r.mock.override.set(PATHS.search, () => ok([row]));
  r.mock.override.set(PATHS.item, () => ok([row]));
  assert.equal((await success(s, 'get_menu', { storeId, keyword: '测试茶' })).items[0].hasPractice, false);
  const card = await success(s, 'get_item_detail', detailArgs);
  assert.equal(card.skus[0].stock, null);
  assert.equal(card.practices[0].required, false);
});

test('R25 R3 菜单编号能打开等值详情，组单多行只现读一次且照选中的规格筛券、创建', async t => {
  const r = await setup(t);
  const s = await r.session();
  await bind(s);
  const padded = '00076543210';
  r.mock.override.set(PATHS.categories, () => ok([]));
  r.mock.override.set(PATHS.search, () => ok([{ ...product(), goodsId: padded }]));
  const row = product();
  row.goodsId = raw('76543210.0');
  row.goodsSkuList = [{ skuId: '000205', salePrice: 2000 }, { skuId: 206, salePrice: 3000 }];
  r.mock.override.set(PATHS.item, () => ok([row]));
  r.mock.override.set(PATHS.stores, () => ok({ list: [{ id: 301, code: '01', name: '测试门店' }] }));
  const menu = await success(s, 'get_menu', { storeId, keyword: '测试茶' });
  const goodsId = menu.items[0].goodsId;
  const card = await success(s, 'get_item_detail', { storeId, goodsId });
  assert.equal(card.goodsId, exact);
  assert.equal((await success(s, 'get_item_detail', detailArgs)).goodsId, exact);
  assert.equal(count(r, PATHS.item), 1);

  const basket = { storeId, items: [{ goodsId, skuId: '205', quantity: 1 },
    { goodsId: exact, skuId: '000206', quantity: 1 }] };
  assert.equal((await success(s, 'preview_order', basket)).totalYuan, '50.00');
  const draft = await success(s, 'prepare_order', basket);
  assert.equal(draft.estimatedTotalYuan, '50.00');
  assert.equal(count(r, PATHS.item), 2);
  const coupons = r.requests.find(req => req.path === PATHS.coupons);
  assert.deepEqual(coupons.params.tradeMarks.map(line => line.tradeMark), [exact, exact]);
  await place(s, draft);
  const created = r.requests.find(req => req.path === PATHS.create).params.items;
  assert.deepEqual(created.map(line => [line.goodsId, line.skuId]), [[76543210, 205], [76543210, 206]]);
});

test('R25 PRE-07 按找店给出的前导零编号组单，保留对应店名与筛券所用门店编码', async t => {
  const r = await setup(t);
  const s = await r.session();
  await bind(s);
  r.mock.override.set(PATHS.stores, () => ok({ list: [{ id: '00301', code: '005', name: '测试门店', openStatus: 1 }] }));
  r.mock.override.set(PATHS.storeStatus, () => ok({}));
  r.mock.override.set(PATHS.item, () => ok([product()]));
  r.mock.override.set(PATHS.coupons, ({ multiMark }) => ok(multiMark === '005'
    ? [{ id: '801', title: '门店券', unUseStatus: 1, userCouponCanDisAmount: 1 }] : []));
  const { store } = await success(s, 'find_store', { query: '测试门店' });
  assert.equal(store.openStatusText, '营业中');
  const draft = await success(s, 'prepare_order', { ...args, storeId: store.storeId });
  assert.equal(draft.store.name, '测试门店');
  assert.equal(draft.coupons.predicted.title, '门店券');
  assert.equal(count(r, PATHS.coupons), 1);
});

for (const [kind, setConflict] of [
  ['规格', row => { row.goodsSkuList = [
    { skuId: '000205', salePrice: 3000, specName: '大杯' },
    { skuId: 205, salePrice: 2000, specName: '小杯' },
    { skuId: 999, salePrice: 1500, specName: '迷你杯' }
  ]; }],
  ['做法分组', row => row.sortedPracticeList.push({
    practiceName: '甜度', practiceId: '000402', practiceValueList: [{ practiceValue: '全糖', practiceValueId: 999 }]
  })],
  ['做法', row => row.sortedPracticeList.push({
    practiceName: '甜度', practiceId: 999, practiceValueList: [{ practiceValue: '全糖', practiceValueId: '000403' }]
  })],
  ['加料', row => row.attachGoodsList.push({ attachGoodsName: '椰果', attachGoodsId: '000' + max })]
]) {
  test(`R25 BRW-08 PRE-03 同商品的${kind}编号数值重复时阻止预估与组单`, async t => {
    const r = await setup(t);
    const s = await r.session();
    await bind(s);
    const row = product();
    setConflict(row);
    r.mock.override.set(PATHS.item, () => ok([row]));
    // 冲突影响整个商品，即使这行没选冲突项也不能签令牌。
    const selections = kind === '规格' ? [{ skuId: '000205' }, { skuId: '205' }, { skuId: '999' }] : [{}];
    for (const options of selections) {
      const basket = { storeId, items: [{ goodsId: exact, quantity: 1, ...options }] };
      const preview = await success(s, 'preview_order', basket);
      assert.equal(preview.ok, false);
      assert.match(preview.error.message, new RegExp(kind + '使用同一编号'));
      await failure(s, 'prepare_order', basket, new RegExp(kind + '使用同一编号'));
    }
    assert.equal(count(r, PATHS.coupons), 0);
    assert.equal(count(r, PATHS.create), 0);
  });
}
