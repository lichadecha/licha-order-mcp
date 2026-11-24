import test from 'node:test';
import assert from 'node:assert/strict';
import { bind, count, failure, memberA, memberB, ok, phoneB, setup, success, withBound } from '../test-support/commerce.js';

const tool = 'my_member_info';
const pointsPath = 'v3/crm/points/getCustomerPoints';
const levelPath = 'v3/crm/customer/getLevelExperience';
const member = { last4: '***0000', via: 'phone' };
const note = '积分可以在李茶小程序的积分商城兑换；这里只能查，不能兑换。';
const noPoints = note + '积分暂时没查到，稍后可以再问一次。';
const noLevel = note + '会员等级暂时没查到，稍后可以再问一次。';
const level = { name: 'VIP1' };

// 4.1.6、4.1.15 的 11-24 脱敏样本，保留线上 JSON 的数值写法。
const pointSample = ok({ blttUserId: null, expiredTime: null, foreverPoints: 0,
  soonExpiredPoints: JSON.rawJSON('0.0'), totalPoints: JSON.rawJSON('30.0') });
const levelSample = ok({ blttUserId: null, cardName: 'VIP1', customerId: memberA,
  expiredAt: '2027-01-01 00:00:00', level: 1, levelName: 'VIP1', totalExperienceNum: JSON.rawJSON('0.0') });

test('ORD-01 QRY-07 空参查当前绑定会员，未绑定和指定他人均不发送请求', async t => {
  const r = await setup(t);
  const s = await r.session();
  const definition = (await s.rpc('tools/list')).tools.find(entry => entry.name === tool);
  assert.equal(definition.description, '查当前绑定会员的积分和会员等级。只查当前绑定的会员本人；只查不改——本工具不能兑换积分、不能领券，顾客问积分怎么用，请引导他去李茶小程序的积分商城。需先用 bind_member 绑定。');
  assert.equal(await failure(s, tool, {}, /未绑定/), '本会话尚未绑定会员身份，请先用 bind_member 绑定');
  assert.equal(r.requests.length, 0);
  await bind(s);
  const before = r.requests.length;
  await failure(s, tool, { customerId: memberB }, /参数/);
  assert.equal(r.requests.length, before);

  r.mock.override.set(pointsPath, () => pointSample);
  r.mock.override.set(levelPath, () => levelSample);
  assert.deepEqual(await success(s, tool), { member, points: { total: '30' }, level, note });
  function checkReads(start, customerId) {
    const queries = r.requests.slice(start);
    assert.deepEqual(queries.map(q => q.path).sort(), [pointsPath, levelPath].sort());
    for (const query of queries) assert.deepEqual(JSON.parse(query.raw).params, { customerId });
  }
  checkReads(before, memberA);
  const second = await bind(s, phoneB);
  r.mock.override.set(levelPath, () => ok({ customerId: memberB, levelName: 'VIP2' }));
  r.mock.override.set(pointsPath, () => ok({ totalPoints: 40 }));
  const afterSwitch = r.requests.length;
  assert.deepEqual(await success(s, tool), { member: second.member, points: { total: '40' }, level: { name: 'VIP2' }, note });
  checkReads(afterSwitch, memberB);
});

test('QRY-07 不缓存积分，整数与小数按原数值展示，过期数量和时间按条件给出', async t => {
  const { r, s, m } = await withBound(t);
  m.override.set(levelPath, () => levelSample);
  const expiration = '2026-12-31 23:59:59';
  const cases = [
    [{ totalPoints: 0, soonExpiredPoints: 0, expiredTime: expiration }, { total: '0' }],
    [{ totalPoints: JSON.rawJSON('12.50'), soonExpiredPoints: JSON.rawJSON('2.10'), expiredTime: expiration },
      { total: '12.5', expiringSoon: '2.1', nextExpireAt: expiration + ' +08:00' }],
    [{ totalPoints: 12, soonExpiredPoints: 2, expiredTime: '2026-02-29 12:34:56' }, { total: '12', expiringSoon: '2' }],
    [{ totalPoints: JSON.rawJSON('9007199254740993'), soonExpiredPoints: 0 }, { total: '9007199254740993' }],
  ];
  for (const [data, points] of cases) {
    m.override.set(pointsPath, () => ok(data));
    assert.deepEqual(await success(s, tool), { member, points, level, note });
  }
  assert.equal(count(r, pointsPath), cases.length);
  assert.equal(count(r, levelPath), cases.length);
});

test('QRY-07 无效总积分仅影响积分项，无效将过期数仅省略过期字段', async t => {
  const { s, m } = await withBound(t);
  m.override.set(levelPath, () => levelSample);
  for (const invalid of [-1, '12.50', null, true, JSON.rawJSON('1e400')]) {
    m.override.set(pointsPath, () => ok({ totalPoints: invalid, soonExpiredPoints: 3 }));
    assert.deepEqual(await success(s, tool), { member, level, unavailable: ['points'], note: noPoints });
    m.override.set(pointsPath, () => ok({ totalPoints: 12, soonExpiredPoints: invalid, expiredTime: '2026-12-31 23:59:59' }));
    assert.deepEqual(await success(s, tool), { member, points: { total: '12' }, level, note });
  }
});

test('QRY-07 等级名须非空，回执如含会员编号须按原数值与本人一致', async t => {
  const { s, m } = await withBound(t);
  const points = { total: '30' };
  m.override.set(pointsPath, () => pointSample);
  for (const data of [{ levelName: 'VIP1' }, { levelName: 'VIP1', customerId: JSON.rawJSON(memberA + '.0') }]) {
    m.override.set(levelPath, () => ok(data));
    assert.deepEqual(await success(s, tool), { member, points, level, note });
  }
  for (const data of [{ levelName: '他人等级', customerId: memberB }, { levelName: 'VIP1', customerId: null },
    { levelName: 'VIP1', customerId: JSON.rawJSON(memberA + '.1') }, { levelName: '', cardName: 'VIP1' },
    { levelName: JSON.rawJSON(memberA) }]) {
    m.override.set(levelPath, () => ok(data));
    assert.deepEqual(await success(s, tool), { member, points, unavailable: ['level'], note: noLevel });
  }
});

test('QRY-07 QRY-08 BRW-10 两项独立读，单项可重试或降级，两项都失败给固定工具错误', async t => {
  const { r, s, m } = await withBound(t);
  m.override.set(pointsPath, () => {
    if (count(r, pointsPath) < 3) throw new Error('模拟 HTTP 500');
    return pointSample;
  });
  m.override.set(levelPath, () => levelSample);
  assert.deepEqual(await success(s, tool), { member, points: { total: '30' }, level, note });
  assert.equal(count(r, pointsPath), 3);
  assert.equal(count(r, levelPath), 1);

  const denied = () => ({ status: false, code: 100002, message: memberA });
  m.override.set(levelPath, denied);
  assert.deepEqual(await success(s, tool), { member, points: { total: '30' }, unavailable: ['level'], note: noLevel });
  m.override.set(pointsPath, denied);
  m.override.set(levelPath, () => levelSample);
  assert.deepEqual(await success(s, tool), { member, level, unavailable: ['points'], note: noPoints });
  m.override.set(levelPath, denied);
  assert.equal(await failure(s, tool, {}, /会员信息暂时没查到/), '会员信息暂时没查到（是我们这边的问题，不是你的会员有问题），稍后再试。');
  assert.equal(count(r, pointsPath), 6);
  assert.equal(count(r, levelPath), 4);
});
