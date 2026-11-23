import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkOrderFields } from '../server/commerce.js';
import { PATHS } from '../server/qmai.js';
import {
  basket, count, failure, goodsId, memberA, ok, phone, place, prepare, shop, skuId, success, withBound
} from '../test-support/commerce.js';

const noneFields = { lastSelect: { type: -1, value: '' }, attendCouponIds: [], attendCouponType: 1 };
const mismatch = path => `组单自检失败：下单参数里的用券字段与本单的用券选择不符（命中路径：${path}）`;

test('PRE-12/13 仅 prepare_order 公开三种用券选择和可选的券编号，协议层校验形状', async t => {
  const { r, s } = await withBound(t);
  const { tools } = await s.rpc('tools/list');
  const prepareTool = tools.find(tool => tool.name === 'prepare_order');
  assert.deepEqual(prepareTool.inputSchema.properties.couponChoice.enum, ['default', 'none', 'specific']);
  assert.ok(!prepareTool.inputSchema.required.includes('couponChoice'));
  assert.deepEqual(prepareTool.inputSchema.properties.couponRef, { type: 'string', minLength: 1, maxLength: 128 });
  assert.ok(!prepareTool.inputSchema.required.includes('couponRef'));
  assert.match(prepareTool.description, /顾客明确说这单不用券时传 "none"；顾客点名要用某一张时传 "specific"，并在 couponRef 里带上那张券的 ref/);
  const previewTool = tools.find(tool => tool.name === 'preview_order');
  assert.ok(!Object.hasOwn(previewTool.inputSchema.properties, 'couponChoice'));
  assert.ok(!Object.hasOwn(previewTool.inputSchema.properties, 'couponRef'));
  const before = r.requests.length;
  for (const couponChoice of [null, true, false, 'NONE', '', 'default ', 1, [], {}]) {
    await failure(s, 'prepare_order', { ...basket, couponChoice }, /工具参数/);
  }
  for (const couponRef of ['', 'x'.repeat(129), null, true, 1, [], {}]) {
    await failure(s, 'prepare_order', { ...basket, couponChoice: 'specific', couponRef }, /工具参数/);
  }
  for (const length of [1, 128]) {
    await failure(s, 'prepare_order', { ...basket, couponChoice: 'specific', couponRef: 'x'.repeat(length) }, /编号已失效/);
  }
  await failure(s, 'preview_order', { ...basket, couponChoice: 'none' }, /工具参数/);
  await failure(s, 'preview_order', { ...basket, couponRef: 'x' }, /工具参数/);
  assert.equal(r.requests.length, before);
});

test('PRE-07/12 缺省与显式 default 同样预测，none 省掉筛券并只给选择与念单说明', async t => {
  const { r, s, m } = await withBound(t);
  m.couponRows = [{ id: '809', title: '会员券', userCouponCanDisAmount: 5, unUseStatus: 1, couponCenterType: 1 }];
  const omitted = await prepare(s);
  const ref = omitted.coupons.usable[0].ref;
  assert.ok(ref);
  assert.deepEqual(omitted.coupons, {
    choice: 'default', available: true, usable: [{ ref, title: '会员券', canDisYuan: '5.00', couponCenterType: 1 }],
    unusable: [], predicted: { title: '会员券', canDisYuan: '5.00', payAfterYuan: '15.00', basis: 'max_discount' },
    note: '顾客有 1 张券可用于本单。念单时要加一句：「系统默认会用你的『会员券』，省 5.00 元，实付大约 ¥15.00；想换一张或不用券的话跟我说。」这是按企迈默认用券规则的预测，下单后以读回为准。顾客说这单不用券，就带 couponChoice="none" 重新组单；点名要用 usable 里的另一张，就带 couponChoice="specific" 和那张的 ref 重新组单。'
  });
  assert.equal(count(r, PATHS.coupons), 1);
  const explicit = await success(s, 'prepare_order', { ...basket, couponChoice: 'default' });
  assert.deepEqual(explicit.coupons, omitted.coupons);
  assert.equal(count(r, PATHS.coupons), 2);
  const none = await success(s, 'prepare_order', { ...basket, couponChoice: 'none' });
  assert.deepEqual(none.coupons, {
    choice: 'none', note: '顾客选了这单不用券。念完合计要加一句：「这单按你说的不用券。」下单后会核对门店系统有没有照办。'
  });
  assert.match(none.note, /coupons.choice 为 none 或 specific 时，念完合计按 coupons.note 说一句这单不用券 \/ 用哪张券；其余情况不提券/);
  assert.equal(count(r, PATHS.coupons), 2);
});

test('R26 缺省与 default 的完整请求等于 v1.8，none 只在顶层增加三项', async t => {
  const { r, s, m } = await withBound(t);
  m.override.set(PATHS.item, () => ok([{
    goodsId, name: '测试茶', goodsSkuList: [{ skuId, salePrice: 2000 }],
    sortedPracticeList: [{ practiceName: '温度', practiceId: 31,
      practiceValueList: [{ practiceValue: '少冰', practiceValueId: 32, price: 0 }] }],
    attachGoodsList: [{ attachGoodsName: '椰果', attachGoodsId: 33, attachGoodsPrice: 100 }]
  }]));
  const args = { storeId: shop, items: [{ goodsId, quantity: 2, practices: ['少冰'], attaches: ['椰果'] }] };
  const v18 = {
    storeId: Number(shop), items: [{ goodsId: BigInt(goodsId), skuId: BigInt(skuId), num: 2,
      practiceList: [{ id: 31, name: '温度', value: '少冰', valueId: 32, price: 0 }],
      attachList: [{ id: 33, name: '椰果', price: 100, num: 1 }] }],
    orderType: 1, source: 18, userId: BigInt(memberA), channelCode: 'AI_AGENT', scene: 'AI_AGENT',
    member: true, mobile: phone, reservePhone: phone
  };
  for (const choice of [{}, { couponChoice: 'default' }, { couponChoice: 'none' }]) {
    const draft = await success(s, 'prepare_order', { ...args, ...choice });
    await place(s, draft);
    const { raw } = r.requests.filter(request => request.path === PATHS.create).at(-1);
    // 读原始 JSON 数字，确保带引号或精度丢失的长 ID 也会使断言失败。
    const { params } = JSON.parse(raw, (key, value, context) =>
      typeof value === 'number' && !Number.isSafeInteger(value) ? BigInt(context.source) : value);
    assert.deepEqual(params, choice.couponChoice === 'none' ? { ...v18, ...noneFields } : v18);
  }
});

test('PRE-06 R26 递归拒绝五个用券键错层，拒绝缺项、额外项与错值', () => {
  for (const key of [...Object.keys(noneFields), 'useCouponId', 'couponId']) {
    assert.throws(() => checkOrderFields({ [key]: 0 }, 'default'), { message: mismatch('params.' + key) });
    for (const choice of ['default', 'none']) {
      const params = { ...(choice === 'none' && noneFields), items: [{ attachList: [{ [key]: 0 }] }] };
      assert.throws(() => checkOrderFields(params, choice), { message: mismatch('params.items[0].attachList[0].' + key) });
    }
  }
  for (const key of ['useCouponId', 'couponId']) {
    assert.throws(() => checkOrderFields({ ...noneFields, [key]: null }, 'none'), { message: mismatch('params.' + key) });
  }
  for (const key of Object.keys(noneFields)) {
    const params = { ...noneFields };
    delete params[key];
    assert.throws(() => checkOrderFields(params, 'none'), { message: mismatch('params.' + key) });
  }
  for (const [key, value] of [
    ['lastSelect', { type: '-1', value: '' }], ['lastSelect', { type: -1, value: null }],
    ['lastSelect', { type: -1, value: '', extra: 1 }], ['lastSelect', { type: -1 }],
    ['attendCouponIds', {}], ['attendCouponIds', [1]], ['attendCouponType', '1'], ['attendCouponType', true]
  ]) {
    assert.throws(() => checkOrderFields({ ...noneFields, [key]: value }, 'none'), { message: mismatch('params.' + key) });
  }
});

test('PRE-06/09 用券自检失败不会签发令牌，也不会替代此前的待确认单', async t => {
  const { r, s, m } = await withBound(t);
  const prior = await prepare(s);
  m.override.set(PATHS.item, () => ok([{ goodsId, name: '测试茶', goodsSkuList: [{ skuId, salePrice: 2000 }],
    sortedPracticeList: [{ practiceId: 31, practiceName: { couponId: 'unexpected' },
      practiceValueList: [{ practiceValueId: 32, practiceValue: '少冰' }] }] }]));
  for (const couponChoice of ['default', 'none']) {
    const args = { storeId: shop, items: [{ goodsId, quantity: 1, practices: ['少冰'] }], couponChoice };
    const message = await failure(s, 'prepare_order', args, /组单自检失败/);
    assert.equal(message, mismatch('params.items[0].practiceList[0].name.couponId'));
  }
  assert.equal(count(r, PATHS.coupons), 1);
  const access = (await readFile(join(r.logDir, 'access.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(access.filter(row => row.event === 'prepare_order').map(row => row.tokenId), [prior.confirmToken]);
  assert.equal((await place(s, prior)).placed, true);
});

const threeYuan = { id: '9300000000000000789', title: '三元券', unUseStatus: 1, userCouponCanDisAmount: 3 };
const choose = ref => ({ ...basket, couponChoice: 'specific', couponRef: ref });

test('PRE-13 用券选择与编号不配套时给业务文案，不问上游', async t => {
  const { r, s } = await withBound(t);
  const before = r.requests.length;
  for (const choice of [
    { couponChoice: 'specific' }, { couponRef: 'x' }, { couponChoice: 'default', couponRef: 'x' },
    { couponChoice: 'none', couponRef: 'x' }
  ]) {
    assert.equal(await failure(s, 'prepare_order', { ...basket, ...choice }, /不配套/),
      '用券选择与券编号不配套：指定用某张券时要带上那张券的 couponRef；不指定时不要带 couponRef。');
  }
  assert.equal(r.requests.length, before);
});

test('PRE-13 R26 指定非默认券按本次筛券列单，实付最低为零，创建时完整传同一字符串 ID', async t => {
  const { r, s, m } = await withBound(t);
  const auto = { ...threeYuan, id: '204', title: '折扣券', couponCenterType: 2, userCouponCanDisAmount: 5 };
  m.couponRows = [auto, threeYuan];
  const first = (await prepare(s)).coupons;
  assert.equal(first.predicted.title, '折扣券');
  const [autoRef, selectedRef] = first.usable.map(row => row.ref);
  m.couponRows = [
    { ...threeYuan, id: JSON.rawJSON(threeYuan.id + '0e-1'), userCouponCanDisAmount: 22, title: '免单券' },
    auto, { id: '205', title: '周末券', unUseStatus: 0, unUseDesc: '限周末' }
  ];
  const draft = await success(s, 'prepare_order', choose(selectedRef));
  assert.deepEqual(draft.coupons, {
    choice: 'specific', available: true, chosen: { title: '免单券', canDisYuan: '22.00', payAfterYuan: '0.00' },
    usable: [{ ref: selectedRef, title: '免单券', canDisYuan: '22.00' },
      { ref: autoRef, title: '折扣券', canDisYuan: '5.00', couponCenterType: 2 }],
    unusable: [{ title: '周末券', reason: '限周末' }],
    note: '顾客指定用『免单券』。念完合计要加一句：「这单用你的『免单券』，省 22.00 元，实付大约 ¥0.00。」下单后会核对门店系统用的是不是这张。'
  });
  assert.ok(!JSON.stringify(draft).includes(threeYuan.id));
  assert.equal(count(r, PATHS.coupons), 2);
  await place(s, draft);
  const { raw } = r.requests.find(req => req.path === PATHS.create);
  const { params } = JSON.parse(raw);
  assert.deepEqual(params.lastSelect, { type: -1, value: threeYuan.id });
  assert.deepEqual(params.attendCouponIds, [threeYuan.id]);
  assert.equal(params.attendCouponType, 1);
  assert.equal(count(r, PATHS.coupons), 2);
});

test('PRE-06 指定券自检拒绝错层、缺项、非字符串 ID 和与登记不一致的三项', () => {
  const id = '123';
  const valid = { lastSelect: { type: -1, value: id }, attendCouponIds: [id], attendCouponType: 1 };
  checkOrderFields(valid, 'specific', id);
  for (const key of Object.keys(valid)) {
    const { [key]: removed, ...rest } = valid;
    assert.throws(() => checkOrderFields(rest, 'specific', id), { message: mismatch('params.' + key) });
  }
  for (const key of [...Object.keys(valid), 'couponId', 'useCouponId']) {
    assert.throws(() => checkOrderFields({ ...valid, items: [{ [key]: id }] }, 'specific', id),
      { message: mismatch('params.items[0].' + key) });
  }
  for (const [key, value] of [
    ['lastSelect', { type: -1, value: 123 }], ['lastSelect', { type: -1, value: id, extra: true }],
    ['lastSelect', { type: 1, value: id }], ['attendCouponIds', [123]], ['attendCouponIds', ['124']],
    ['attendCouponIds', [id, id]], ['attendCouponType', '1'], ['couponId', id], ['useCouponId', id]
  ]) {
    assert.throws(() => checkOrderFields({ ...valid, [key]: value }, 'specific', id), { message: mismatch('params.' + key) });
  }
  assert.throws(() => checkOrderFields(valid, 'specific', '124'), { message: mismatch('params.lastSelect') });
  assert.throws(() => checkOrderFields(noneFields, 'specific'), { message: mismatch('params.lastSelect') });
});

test('PRE-13 指定券被移除、不可用或抵扣非正时按签发时的券名拒绝，保留旧单', async t => {
  const { r, s, m } = await withBound(t);
  m.couponRows = [threeYuan];
  const original = await prepare(s);
  const args = choose(original.coupons.usable[0].ref);
  for (const [rows, reason] of [
    [[{ ...threeYuan, id: '309' }], ''],
    [[{ ...threeYuan, title: '新名字', unUseStatus: 0, unUseDesc: '仅限周末 openToken:FAKE_SECRET' }], '：仅限周末'],
    [[{ ...threeYuan, userCouponCanDisAmount: 0, unUseDesc: '未达起用金额' }], '：未达起用金额'],
    [[{ ...threeYuan, userCouponCanDisAmount: -1 }], '']
  ]) {
    m.couponRows = rows;
    const before = count(r, PATHS.coupons);
    const message = await failure(s, 'prepare_order', args, /这单用不了/);
    assert.equal(message, '「三元券」这单用不了' + reason + '。可以换一张，或按默认、不用券组单。');
    assert.equal(count(r, PATHS.coupons) - before, 1);
  }
  assert.equal((await place(s, original)).placed, true);
});

test('PRE-13 R13 无门店编码直接拒绝，筛券失败仅问一次，均不签令牌', async t => {
  const { r, s, m } = await withBound(t);
  const other = '222222';
  m.override.set(PATHS.stores, () => ok({ list: [{ id: shop, code: '01' }, { id: other }], total: 2 }));
  m.couponRows = [threeYuan];
  const original = await prepare(s);
  const args = choose(original.coupons.usable[0].ref);
  assert.equal(await failure(s, 'prepare_order', { ...args, storeId: other }, /没法指定用券/),
    '这家门店暂时查不了券，没法指定用券。可以按默认或不用券组单。');
  assert.equal(count(r, PATHS.coupons), 1);
  m.override.set(PATHS.coupons, (_, { res }) => { res.statusCode = 503; res.end(); });
  assert.equal(await failure(s, 'prepare_order', args, /这次不能指定用券/),
    '券信息暂时没查到，没法确认这张券能不能用，所以这次不能指定用券。可以按默认或不用券组单，或稍后再试。');
  assert.equal(count(r, PATHS.coupons), 2);
  const access = (await readFile(join(r.logDir, 'access.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(access.filter(row => row.event === 'prepare_order').map(row => row.tokenId), [original.confirmToken]);
  assert.equal((await place(s, original)).placed, true);
});

test('PRE-07/13 可用行缺券实例 ID 时无法列出完整券列表，默认仍可组单，指定拒绝', async t => {
  const { s, m } = await withBound(t);
  m.couponRows = [threeYuan];
  const original = await prepare(s);
  m.couponRows.push({ title: '缺编号的券', unUseStatus: 1, userCouponCanDisAmount: 5 });
  await failure(s, 'prepare_order', choose(original.coupons.usable[0].ref), /券信息暂时没查到/);
  const { coupons } = await prepare(s);
  assert.deepEqual(coupons, {
    choice: 'default', available: false, usable: [], unusable: [], note: '券信息暂时没查到；下单后以门店系统读回的实付为准，如有优惠会在读回里体现。'
  });
});
