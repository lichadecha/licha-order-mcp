import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { couponTextMask, projectText } from '../server/common.js';
import { PATHS } from '../server/qmai.js';
import {
  argsFor, basket, count, failure, goodsId, memberA, memberB, ok, place, prepare, shop, skuId, success, withBound
} from '../test-support/commerce.js';

const shortId = '7654327';
const longId = '9023418536723459076';
const rawIds = `甲${shortId}乙${longId}丙`;
const maskedIds = '甲***乙***9076丙';
const available = { id: shortId, customerId: memberA, title: '三元券', unUseStatus: 1, userCouponCanDisAmount: 3 };
const select = couponRef => ({ ...basket, couponChoice: 'specific', couponRef });

test('OUT-02 券 ID 与手机号形态重叠时，以完整识别值取尾号', () => {
  const mask = couponTextMask([{ id: '138000000001' }, { id: '76543270e-1' }]);
  assert.equal(projectText('长券138000000001，短券76543270e-1（7654327），电话13765432749', mask),
    '长券***0001，短券***（***），电话***2749');
});

function checkNoIds(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const id of [shortId, longId]) assert.ok(!text.includes(id), '输出含完整券实例 ID');
}

async function checkLogs(r, ref) {
  for (const name of ['access', 'upstream', 'write']) {
    const log = await readFile(join(r.logDir, name + '.jsonl'), 'utf8');
    checkNoIds(log);
    assert.ok(!log.includes(ref), name + ' 日志含完整券编号');
  }
}

test('OUT-02 筛券时用整次响应里的 ID 遮盖券名和原因，含后续被筛掉的行', async t => {
  const { s, m } = await withBound(t);
  m.override.set(PATHS.stores, () => ok({ list: [
    { id: shop, code: '01', name: '茶店' + rawIds, openStatus: 1 }
  ], total: 1 }));
  m.override.set(PATHS.item, () => ok([{ goodsId, name: '红茶' + rawIds, type: 1, status: 10,
    goodsSkuList: [{ skuId, specName: '常规杯' + rawIds, salePrice: 2000, clearStatus: 1, inventory: 99 }] }]));
  const main = { ...available, id: longId, title: '会员券' + rawIds };
  m.couponRows = [main, { id: '42', title: '满额券' + rawIds, unUseDesc: '换店' + rawIds },
    { ...available, customerId: memberB }];
  const draft = await prepare(s);
  const { usable, predicted, unusable } = draft.coupons;
  assert.equal(draft.store.name, '茶店' + maskedIds);
  assert.equal(draft.lines[0].name, '红茶' + maskedIds);
  assert.equal(draft.lines[0].specName, '常规杯' + maskedIds);
  assert.equal(usable[0].title, '会员券' + maskedIds);
  assert.equal(predicted.title, usable[0].title);
  assert.deepEqual(unusable, [{ title: '满额券' + maskedIds, reason: '换店' + maskedIds }]);
  checkNoIds(draft);

  const chosen = await success(s, 'prepare_order', select(usable[0].ref));
  assert.equal(chosen.coupons.chosen.title, usable[0].title);
  checkNoIds(chosen);
  m.couponRows[0] = { ...main, unUseStatus: 0, unUseDesc: '换店' + rawIds };
  const message = await failure(s, 'prepare_order', select(usable[0].ref), /这单用不了/);
  assert.ok(message.includes('换店' + maskedIds));
  checkNoIds(message);
});

test('OUT-02 指定失效时，签发编号时的券名也遮盖本次才出现的实例 ID', async t => {
  const { s, m } = await withBound(t);
  m.couponRows = [{ ...available, id: longId, title: '活动' + shortId }];
  const { ref } = (await prepare(s)).coupons.usable[0];
  m.couponRows = [available];
  const message = await failure(s, 'prepare_order', select(ref), /这单用不了/);
  assert.ok(message.includes('「活动***」'));
  checkNoIds(message);
});

test('OUT-02 默认与指定单读回的优惠名、摘要和念单核对均遮盖已知券 ID', async t => {
  const { r, s, m } = await withBound(t);
  m.couponRows = [{ ...available, title: '三元券' + rawIds }, { id: longId, unUseStatus: 0 }];
  m.override.set(PATHS.orderDetail, () => ok({ ...m.last, actualAmount: 1700, discountAmount: 300,
    discountList: [{ discountId: shortId, discountType: 2, discountAmount: 300,
      discountName: '三元券' + rawIds, discountSummary: '摘要' + rawIds }] }));
  const initial = await prepare(s);
  const { ref } = initial.coupons.usable[0];
  for (const choice of ['default', 'specific']) {
    const draft = choice === 'default' ? initial : await success(s, 'prepare_order', select(ref));
    const result = await place(s, draft);
    assert.equal(result.couponApplied.items[0].name, '三元券' + maskedIds);
    assert.equal(result.couponApplied.items[0].summary, '摘要' + maskedIds);
    assert.equal(result.couponApplied[choice === 'default' ? 'matchesPrediction' : 'matchesChoice'], true);
    checkNoIds(result);
  }
  await checkLogs(r, ref);
});

test('OUT-02 默认与指定单的创建错误、读回错误按待确认单遮盖 ID 后再截断', async t => {
  const { r, s, m } = await withBound(t);
  m.couponRows = [available, { id: longId, unUseStatus: 0 }];
  const { ref } = (await prepare(s)).coupons.usable[0];
  const padding = '详'.repeat(76);
  for (const choice of ['default', 'specific']) {
    const draft = () => choice === 'default' ? prepare(s) : success(s, 'prepare_order', select(ref));
    m.override.set(PATHS.create, () => ({ status: false, code: 100002, message: '受限' + rawIds }));
    const message = await failure(s, 'place_order', argsFor(await draft()), /下单失败/);
    assert.ok(message.includes('受限' + maskedIds));
    checkNoIds(message);

    m.override.delete(PATHS.create);
    m.override.set(PATHS.orderDetail, () => ({ status: false, code: 100002,
      message: padding + shortId + '停用' }));
    const result = await place(s, await draft());
    assert.equal(result.readbackFailed, true);
    assert.ok(result.readbackNote.includes(padding + '***停…'));
    checkNoIds(result);
  }
  await checkLogs(r, ref);
});

test('WRT-01 多余字段逐段投影，区分本设备券编号、普通字段与数组下标，原始参数被拒时零创建', async t => {
  const { r, s, m } = await withBound(t);
  m.couponRows = [available];
  const draft = await prepare(s);
  const { ref } = draft.coupons.usable[0];
  const sameDevice = await r.session(s.device);
  const args = argsFor(draft);
  for (const [input, expected] of [
    [{ ...args, [ref]: true }, '（券编号）'],
    [{ ...args, confirmAmountYuan: { [ref]: 20 } }, 'confirmAmountYuan.（券编号）'],
    [{ ...args, confirmAmountYuan: { userId: 1 } }, 'confirmAmountYuan.userId'],
    [{ ...args, ['__proto__']: '原始字段' }, '__proto__'],
    [{ ...args, ['a'.repeat(30) + '_-']: true }, 'a'.repeat(30) + '_-'],
    ...['', 'a'.repeat(33), '045678', '13800000000', 'a1', '中文', 'x.y', 'x[0]', '换\n行']
      .map(key => [{ ...args, [key]: true }, '（略）']),
    [{ ...args, confirmToken: { '999': 1 } }, 'confirmToken.（略）'],
    [{ ...args, confirmAmountYuan: [0] }, 'confirmAmountYuan[0]'],
    [{ ...args, confirmAmountYuan: [[{ [ref]: true }]] }, 'confirmAmountYuan[0][0].（券编号）'],
    [{ ...args, confirmToken: [...Array(999).fill(null), { '045678': true }] }, 'confirmToken[999].（略）'],
    [{ ...args, confirmToken: [...Array(1000).fill(null), { userId: 1 }] }, 'confirmToken[（略）].userId']
  ]) {
    const message = await failure(sameDevice, 'place_order', input, /收到多余的/);
    assert.equal(message, 'place_order 只接受 confirmToken 与 confirmAmountYuan 两个参数（收到多余的：' + expected +
      '）。会员身份只能由服务端按设备绑定注入，不接受调用方传入。');
  }
  assert.equal(count(r, PATHS.create), 0);
  await checkLogs(r, ref);
});
