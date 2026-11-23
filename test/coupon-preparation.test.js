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

test('PRE-12 仅 prepare_order 公开可选的二选一入参，协议层拒绝其他值', async t => {
  const { r, s } = await withBound(t);
  const { tools } = await s.rpc('tools/list');
  const prepareTool = tools.find(tool => tool.name === 'prepare_order');
  assert.deepEqual(prepareTool.inputSchema.properties.couponChoice.enum, ['default', 'none']);
  assert.ok(!prepareTool.inputSchema.required.includes('couponChoice'));
  assert.match(prepareTool.description, /只有顾客明确说这单不用券时才传 "none"。不能指定用哪张券/);
  const previewTool = tools.find(tool => tool.name === 'preview_order');
  assert.ok(!Object.hasOwn(previewTool.inputSchema.properties, 'couponChoice'));
  const before = r.requests.length;
  for (const couponChoice of [null, true, false, 'NONE', '', 'default ', 1, [], {}]) {
    await failure(s, 'prepare_order', { ...basket, couponChoice }, /工具参数/);
  }
  await failure(s, 'preview_order', { ...basket, couponChoice: 'none' }, /工具参数/);
  assert.equal(r.requests.length, before);
});

test('PRE-07/12 缺省与显式 default 同样预测，none 省掉筛券并只给选择与念单说明', async t => {
  const { r, s, m } = await withBound(t);
  m.couponRows = [{ title: '会员券', userCouponCanDisAmount: 5, unUseStatus: 1, couponCenterType: 1 }];
  const omitted = await prepare(s);
  assert.deepEqual(omitted.coupons, {
    choice: 'default', available: true, usable: [{ title: '会员券', canDisYuan: '5.00', couponCenterType: 1 }],
    unusable: [], predicted: { title: '会员券', canDisYuan: '5.00', payAfterYuan: '15.00', basis: 'max_discount' },
    note: '顾客有 1 张券可用于本单。念单时要加一句：「系统默认会用你的『会员券』，省 5.00 元，实付大约 ¥15.00；不想用券的话跟我说。」这是按企迈默认用券规则的预测，下单后以读回为准。顾客说这单不用券，就带 couponChoice="none" 重新组单。'
  });
  assert.equal(count(r, PATHS.coupons), 1);
  const explicit = await success(s, 'prepare_order', { ...basket, couponChoice: 'default' });
  assert.deepEqual(explicit.coupons, omitted.coupons);
  assert.equal(count(r, PATHS.coupons), 2);
  const none = await success(s, 'prepare_order', { ...basket, couponChoice: 'none' });
  assert.deepEqual(none.coupons, {
    choice: 'none', note: '顾客选了这单不用券。念完合计要加一句：「这单按你说的不用券。」下单后会核对门店系统有没有照办。'
  });
  assert.match(none.note, /coupons.choice 为 none 时，念完合计按 coupons.note 说一句这单不用券；其余情况不提券/);
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
