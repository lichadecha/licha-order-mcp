import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { basket, bind, failure, prepare, success, withBound } from '../test-support/commerce.js';

const couponId = '7200000000000000001';
const coupon = { id: couponId, title: '茶券', unUseStatus: 1, userCouponCanDisAmount: 3 };
const specific = couponRef => ({ ...basket, couponChoice: 'specific', couponRef });

async function firstRef(s) {
  const draft = await prepare(s);
  const ref = draft.coupons.usable[0].ref;
  assert.equal(typeof ref, 'string');
  assert.ok(ref.length > 0 && ref.length <= 128);
  assert.ok(!JSON.stringify(draft).includes(couponId));
  return ref;
}

async function checkExpired(r, s, ref) {
  const calls = r.requests.length;
  await failure(s, 'prepare_order', specific(ref), /这张券的编号已失效/);
  assert.equal(r.requests.length, calls);
}

test('PRE-13 同设备跨会话、会员幂等重绑、券 ID 等值写法与列表重排保留编号', async t => {
  const { r, s, m } = await withBound(t);
  const sameTitle = { ...coupon, id: '7200000000000000002' };
  m.couponRows = [coupon, sameTitle];
  const first = (await prepare(s)).coupons.usable.map(row => row.ref);
  assert.equal(new Set(first).size, 2);
  const next = await r.session(s.device);
  await bind(next, 'FAKE_CARD_A', 'card');
  m.couponRows = [sameTitle, { ...coupon, id: '07200000000000000001.0' }];
  const chosen = (await success(next, 'prepare_order', specific(first[0]))).coupons;
  assert.equal(chosen.choice, 'specific');
  assert.deepEqual(chosen.usable.map(row => row.ref), [first[1], first[0]]);
  assert.ok(!JSON.stringify(chosen).includes(couponId));
  assert.ok(!JSON.stringify(chosen).includes(sameTitle.id));
});

test('PRE-13 别的设备即使同会员也不能用编号，换绑再绑回也不能复用', async t => {
  const { r, s, m } = await withBound(t);
  m.couponRows = [coupon];
  const ref = await firstRef(s);
  const other = await r.session();
  await bind(other);
  await checkExpired(r, other, ref);
  const otherRef = await firstRef(other);
  assert.notEqual(otherRef, ref);
  await bind(s, 'FAKE_CARD_B', 'card');
  await checkExpired(r, s, ref);
  await bind(s);
  await checkExpired(r, s, ref);
  assert.notEqual(await firstRef(s), ref);
  assert.equal(await firstRef(other), otherRef);
});

test('PRE-13 绑定到期后再次绑定同会员，旧编号仍失效', async t => {
  const { r, s, m } = await withBound(t, { LICHA_BINDING_IDLE_TTL_MS: '900' });
  m.couponRows = [coupon];
  const ref = await firstRef(s);
  await delay(1000);
  await failure(s, 'prepare_order', specific(ref), /尚未绑定/);
  await bind(s);
  await checkExpired(r, s, ref);
  assert.notEqual(await firstRef(s), ref);
});

test('PRE-13 服务重启后同设备、会员和券实例重新取得的编号已变', async t => {
  const { r, s, m } = await withBound(t);
  m.couponRows = [coupon];
  const ref = await firstRef(s);
  await r.restart();
  const restored = await r.session(s.device);
  await bind(restored);
  await checkExpired(r, restored, ref);
  assert.notEqual(await firstRef(restored), ref);
});
