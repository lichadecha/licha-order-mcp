import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkOrderFields } from '../server/commerce.js';
import { PATHS } from '../server/qmai.js';
import {
  basket, count, failure, goodsId, memberA, memberB, ok, phone, place, prepare, shop, skuId, success, withBound
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
  assert.ok(prepareTool.description.includes('数量（每行数量与总杯数 totalQuantity）、优惠（这单用哪张券、省多少，或不用券）、金额（合计与预计实付）'));
  assert.ok(prepareTool.description.includes('三样没有得到顾客明确的「确认」，不得调用 place_order。总杯数 10 杯及以上、或合计 300 元及以上的大单，念完后再单独复述一次「一共 N 杯、实付约 X 元」，得到第二次确认才可下单。'));
  const placeTool = tools.find(tool => tool.name === 'place_order');
  assert.ok(placeTool.description.includes('只有在顾客对念给他听的待确认单——数量、优惠、金额三样——明确说了确认之后才能调用'));
  assert.ok(placeTool.description.includes('confirmAmountYuan 必须是刚念给顾客、顾客确认过的那个合计金额'));
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

test('PRE-07/12 缺省与显式 default 同样替顾客挑券，none 省掉筛券并只给选择与念单说明', async t => {
  const { r, s, m } = await withBound(t);
  m.couponRows = [{ id: '809', customerId: memberA, title: '会员券', userCouponCanDisAmount: 5, unUseStatus: 1, couponCenterType: 1 }];
  const omitted = await prepare(s);
  const ref = omitted.coupons.usable[0].ref;
  assert.ok(ref);
  assert.deepEqual(omitted.coupons, {
    choice: 'default', available: true, usable: [{ ref, title: '会员券', canDisYuan: '5.00', couponCenterType: 1 }],
    unusable: [], chosen: { title: '会员券', canDisYuan: '5.00', payAfterYuan: '15.00' }, autoPicked: true,
    note: '顾客有 1 张券可用于本单，系统替顾客选了『会员券』，下单时会指定用这张。念完合计要加一句：「这单会用你的『会员券』，省 5.00 元，实付大约 ¥15.00；不想用券的话跟我说。」顾客说不用，就带 couponChoice="none" 重新组单；顾客没意见就照这张待确认单下单。'
  });
  assert.equal(count(r, PATHS.coupons), 1);
  const explicit = await success(s, 'prepare_order', { ...basket, couponChoice: 'default' });
  assert.deepEqual(explicit.coupons, omitted.coupons);
  assert.equal(count(r, PATHS.coupons), 2);
  const none = await success(s, 'prepare_order', { ...basket, couponChoice: 'none' });
  assert.deepEqual(none.coupons, {
    choice: 'none', note: '顾客选了这单不用券。念完合计要加一句：「这单按你说的不用券。」下单后会核对门店系统有没有照办。'
  });
  assert.equal(none.note, '请把以上内容逐项念给顾客确认（下到哪位会员名下、门店、每杯商品与规格做法、杯数、总金额）。优惠一项一律按 coupons.note 说（coupons.autoPicked 为 true 时要把可用券逐张念给顾客并问用这张、换一张还是不用券；不要说「你没有券」）。数量、优惠、金额三样都要顾客明确确认；totalQuantity 达到 10 或合计达到 300 元时，再单独复述一次「一共 N 杯、实付约 X 元」并得到第二次确认（v1.12.2）。顾客确认后调用 place_order，传入 confirmToken 与你刚念出的总金额（元，是券前的预估合计，不是券后实付）。令牌 5 分钟内有效、只能用一次，过期请重新组单。');
  assert.equal(count(r, PATHS.coupons), 2);
});

test('R26 缺省与 default 无可用券时的完整请求等于 v1.8，none 只在顶层增加三项', async t => {
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

const threeYuan = { customerId: memberA, id: '9300000000000000789', title: '三元券', unUseStatus: 1, userCouponCanDisAmount: 3 };
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
  assert.equal(first.chosen.title, '折扣券');
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

test('PRE-06 指定与替顾客挑券的自检拒绝错层、缺项、非字符串 ID 和与登记不一致的三项', () => {
  const id = '123';
  const valid = { lastSelect: { type: -1, value: id }, attendCouponIds: [id], attendCouponType: 1 };
  for (const choice of ['specific', 'default']) {
    checkOrderFields(valid, choice, id);
    for (const key of Object.keys(valid)) {
      const { [key]: removed, ...rest } = valid;
      assert.throws(() => checkOrderFields(rest, choice, id), { message: mismatch('params.' + key) });
    }
    for (const key of [...Object.keys(valid), 'couponId', 'useCouponId']) {
      assert.throws(() => checkOrderFields({ ...valid, items: [{ [key]: id }] }, choice, id),
        { message: mismatch('params.items[0].' + key) });
    }
    for (const [key, value] of [
      ['lastSelect', { type: -1, value: 123 }], ['lastSelect', { type: -1, value: id, extra: true }],
      ['lastSelect', { type: 1, value: id }], ['attendCouponIds', [123]], ['attendCouponIds', ['124']],
      ['attendCouponIds', [id, id]], ['attendCouponType', '1'], ['couponId', id], ['useCouponId', id]
    ]) {
      assert.throws(() => checkOrderFields({ ...valid, [key]: value }, choice, id), { message: mismatch('params.' + key) });
    }
    assert.throws(() => checkOrderFields(valid, choice, '124'), { message: mismatch('params.lastSelect') });
  }
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

test('PRE-07/13 只删一行的 id，三张券照常列出，默认改挑下一张', async t => {
  const { r, s, m } = await withBound(t);
  m.couponRows = [
    { ...threeYuan }, { ...threeYuan, id: '204', title: '五元券', userCouponCanDisAmount: 5 },
    { ...threeYuan, id: '205', title: '一元券', userCouponCanDisAmount: 1 }
  ];
  const before = (await prepare(s)).coupons;
  const [threeRef, fiveRef] = before.usable.map(row => row.ref);
  delete m.couponRows[1].id;
  const after = (await prepare(s)).coupons;
  const expected = structuredClone(before.usable);
  delete expected[1].ref;
  assert.deepEqual(after.usable, expected);
  assert.equal(before.chosen.title, '五元券');
  assert.equal(after.chosen.title, '三元券');
  await failure(s, 'prepare_order', choose(fiveRef), /这单用不了/);
  const selected = await success(s, 'prepare_order', choose(threeRef));
  assert.deepEqual(selected.coupons.usable, after.usable);
  assert.equal(count(r, PATHS.create), 0);
});

test('PRE-13 两个归属字段指向乙、出现无效归属或互相矛盾时，甲看不到券且不能指定', async t => {
  const { r, s, m } = await withBound(t);
  m.couponRows = [threeYuan];
  const ref = (await prepare(s)).coupons.usable[0].ref;
  for (const ownership of [
    { customerId: memberB, user_id: memberB },
    { customerId: memberA, user_id: memberB },
    { customerId: memberB, user_id: memberA },
    { customerId: null, user_id: memberA },
    { customerId: 0 }, { customerId: memberA, user_id: '' },
    { customerId: JSON.rawJSON(memberA + '.00000001') },
    { customerId: memberA, user_id: JSON.rawJSON('9223372036854775808') }
  ]) {
    m.couponRows = [{ ...threeYuan, ...ownership }];
    const { coupons } = await prepare(s);
    assert.equal(coupons.available, true);
    assert.deepEqual(coupons.usable, []);
    assert.deepEqual(coupons.unusable, []);
    assert.ok(!Object.hasOwn(coupons, 'chosen'));
    assert.ok(!Object.hasOwn(coupons, 'autoPicked'));
    assert.ok(!Object.hasOwn(coupons, 'predicted'));
    assert.equal(await failure(s, 'prepare_order', choose(ref), /这单用不了/),
      '「三元券」这单用不了。可以换一张，或按默认、不用券组单。');
  }
  assert.equal(count(r, PATHS.create), 0);
});

test('PRE-13 任一归属字段数值匹配可指定，两个字段都缺时列出但不能挑选或指定', async t => {
  const { r, s, m } = await withBound(t);
  const { customerId, ...noOwner } = threeYuan;
  m.couponRows = [{ ...noOwner, user_id: JSON.rawJSON(memberA + '0e-1') }];
  const { coupons } = await prepare(s);
  const ref = coupons.usable[0].ref;
  assert.equal(typeof ref, 'string');
  m.couponRows = [{ ...noOwner, customerId: '0' + memberA + '.0', user_id: memberA }];
  assert.equal((await success(s, 'prepare_order', choose(ref))).coupons.chosen.title, '三元券');
  m.couponRows = [noOwner];
  const expected = { ...coupons.usable[0] };
  delete expected.ref;
  const after = (await prepare(s)).coupons;
  assert.deepEqual(after.usable, [expected]);
  assert.equal(Object.hasOwn(after, 'chosen'), false);
  assert.equal(Object.hasOwn(after, 'autoPicked'), false);
  await failure(s, 'prepare_order', choose(ref), /这单用不了/);
  assert.equal(count(r, PATHS.create), 0);
});

test('PRE-13 同实例可用性、金额、原券名或归属冲突，正序倒序均排除整张券', async t => {
  const { r, s, m } = await withBound(t);
  const commonTitle = '券'.repeat(81);
  const row = { ...threeYuan, title: commonTitle + '甲' };
  const other = { ...threeYuan, id: '206', title: '剩余券', userCouponCanDisAmount: 1 };
  m.couponRows = [row, other];
  const initial = (await prepare(s)).coupons;
  const [selected, retained] = initial.usable;
  for (const conflict of [
    { unUseStatus: 0 }, { userCouponCanDisAmount: 3.01 }, { title: commonTitle + '乙' },
    { customerId: memberB }, { customerId: memberA, user_id: null }
  ]) {
    const duplicate = { ...row, ...conflict, id: '0' + row.id + '.0' };
    for (const pair of [[row, duplicate], [duplicate, row]]) {
      m.couponRows = [...pair, other];
      const { coupons } = await prepare(s);
      assert.deepEqual(coupons.usable, [retained]);
      assert.deepEqual(coupons.unusable, []);
      assert.equal(coupons.chosen.title, other.title);
      await failure(s, 'prepare_order', choose(selected.ref), /这单用不了/);
    }
  }
  assert.equal(count(r, PATHS.create), 0);
});

test('PRE-13 同实例一致的重复行只计一次，调换顺序保持编号与所选的券', async t => {
  const { s, m } = await withBound(t);
  const unavailable = { ...threeYuan, id: '207', title: '周末券', unUseStatus: 0, unUseDesc: '限周末' };
  m.couponRows = [threeYuan, unavailable];
  const expected = (await prepare(s)).coupons;
  const ref = expected.usable[0].ref;
  const equivalent = { ...threeYuan, id: JSON.rawJSON(threeYuan.id + '.0'), userCouponCanDisAmount: '3.00' };
  for (const pair of [[threeYuan, equivalent], [equivalent, threeYuan]]) {
    m.couponRows = [...pair, unavailable, { ...unavailable }];
    assert.deepEqual((await prepare(s)).coupons, expected);
    const chosen = (await success(s, 'prepare_order', choose(ref))).coupons;
    assert.deepEqual(chosen.usable, expected.usable);
    assert.deepEqual(chosen.unusable, expected.unusable);
    assert.equal(chosen.chosen.title, threeYuan.title);
  }
});

test('PRE-07 默认在可指定、抵扣为正且抵后仍需付款的券中选最优惠的一张，并按 R26 提交', async t => {
  const { r, s, m } = await withBound(t);
  m.couponRows = [
    { ...threeYuan, id: null, title: '无编号', userCouponCanDisAmount: 19 },
    { ...threeYuan, id: '111', title: '免单券', userCouponCanDisAmount: 20 },
    { ...threeYuan, id: '112', title: '零元券', userCouponCanDisAmount: 0 },
    { ...threeYuan, id: '113', title: '自动生效券', userCouponCanDisAmount: 2, couponCenterType: 2 },
    { ...threeYuan, id: '114', title: '不可用券', userCouponCanDisAmount: 18, unUseStatus: 0 },
    threeYuan
  ];
  const draft = await prepare(s);
  assert.equal(draft.coupons.choice, 'default');
  assert.equal(draft.coupons.autoPicked, true);
  assert.equal(Object.hasOwn(draft.coupons, 'predicted'), false);
  assert.deepEqual(draft.coupons.chosen, { title: '三元券', canDisYuan: '3.00', payAfterYuan: '17.00' });
  assert.equal(draft.coupons.note, '顾客有 5 张券可用于本单，系统替顾客选了抵得最多的『三元券』（省 3.00 元，实付大约 ¥17.00），下单时会指定用这张。念完合计要把 usable 里的券逐张念给顾客（券名、能省多少），然后问：「用这张、换一张，还是这单不用券？」顾客说用这张或随便，就照这张待确认单下单；点名另一张（只能是带 ref 的），就带 couponChoice="specific" 和那张的 ref 重新组单；说不用券，就带 couponChoice="none" 重新组单。');
  await place(s, draft);
  const { raw } = r.requests.find(req => req.path === PATHS.create);
  const { params } = JSON.parse(raw);
  assert.deepEqual(params.lastSelect, { type: -1, value: threeYuan.id });
  assert.deepEqual(params.attendCouponIds, [threeYuan.id]);
  assert.equal(params.attendCouponType, 1);
});

test('PRE-07 同额券取上游第一张，即使后一张是自动生效类', async t => {
  const { s, m } = await withBound(t);
  const other = { ...threeYuan, id: '322', title: '同额券', couponCenterType: 2 };
  for (const rows of [[threeYuan, other], [other, threeYuan]]) {
    m.couponRows = rows;
    const { coupons } = await prepare(s);
    assert.equal(coupons.chosen.title, rows[0].title);
  }
});

const zeroCoupon = { ...threeYuan, id: '333', userCouponCanDisAmount: 0 };
const noRefCoupon = { ...threeYuan, id: null };
for (const [reason, rows] of [
  ['这些券缺少指定所需的信息', [zeroCoupon, noRefCoupon]],
  ['能用的券会把这单抵成 0 元，用不用要顾客自己定', [noRefCoupon, { ...threeYuan, userCouponCanDisAmount: 22 }]],
  ['抵扣金额都为 0', [zeroCoupon]]
]) {
  test('PRE-07 没挑券时请求任意层级均不含用券字段，原因：' + reason, async t => {
    const { r, s, m } = await withBound(t);
    m.couponRows = rows;
    const draft = await prepare(s);
    const { coupons } = draft;
    assert.equal(coupons.choice, 'default');
    assert.equal(coupons.usable.length, rows.length);
    for (const key of ['predicted', 'chosen', 'autoPicked']) assert.equal(Object.hasOwn(coupons, key), false);
    assert.equal(coupons.note, rows.length === 1
      ? '查到可用券但抵扣金额都为 0。念单时优惠一项说：「系统没提示会用券，以门店收银台为准。」'
      : `顾客有 2 张券可用于本单，但系统这次没法替顾客挑（${reason}）。念单时优惠一项说：「门店系统可能会自动用你的一张券，实付以下单后为准；想指定用哪张或不用券跟我说。」顾客点名 usable 里带 ref 的某一张，就带 couponChoice="specific" 和那张的 ref 重新组单；说不用券，就带 couponChoice="none" 重新组单。`);
    await place(s, draft);
    const { raw } = r.requests.find(req => req.path === PATHS.create);
    assert.doesNotMatch(raw, /"(lastSelect|attendCouponIds|attendCouponType|useCouponId|couponId)"\s*:/);
  });
}
