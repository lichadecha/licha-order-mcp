import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {readConfig} from '../server/config.js';
import {digest} from '../server/common.js';
import {PATHS} from '../server/qmai.js';
import {argsFor, bind, bindAgain, bookRecords, count, failure, memberA, memberB, ok, phone, phoneB,
  place, prepare, success, withBound} from '../test-support/commerce.js';

const changed = '这个手机号在李茶的会员信息有变化，为了安全需要重新验证，这次没有下单。请先只带手机号调用一次 bind_member，让系统发验证码。';
const failed = '暂时没法核对会员信息（不是你的号有问题），这次没有下单。请稍等一下再试。';

test('§3.2 绑定绝对期限默认三十天，只接受正安全整数', () => {
  const env = {LICHA_ACCESS_KEYS:'test'};
  const name = 'LICHA_BINDING_MAX_AGE_MS';
  assert.equal(readConfig(env)[name], 30 * 86400000);
  assert.equal(readConfig({...env, [name]:'1500'})[name], 1500);
  for (const value of ['', '0', '-1', '1.5', '2ms', '9007199254740992']) {
    assert.throws(() => readConfig({...env, [name]:value}), {message:'配置无效：' + name});
  }
});

async function assertAudit(r, s, outcomes) {
  const rows = (await readFile(join(r.logDir, 'access.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
    .filter(row => row.event === 'order_member_recheck');
  assert.deepEqual(rows.map(row => row.outcome), outcomes);
  for (const row of rows) {
    assert.equal(row.deviceHash, digest(s.device));
    assert.equal(row.memberHash, digest(memberA));
    assert.deepEqual(Object.keys(row).sort(), ['deviceHash', 'event', 'memberHash', 'outcome', 'time']);
  }
}

test('WRT-22 改挂撤销各设备当前和记住的同号，保留其他号码与其待确认单', async t => {
  const {r, s} = await withBound(t);
  const other = await r.session();
  const switched = await r.session();
  await bindAgain(other);
  const otherDraft = await prepare(other);
  await bindAgain(switched);
  await bind(switched, phoneB);
  const unrelated = await prepare(switched);
  const draft = await prepare(s);
  r.mock.override.set(PATHS.member, () => ok({customerId:memberB}));
  assert.equal(await failure(s, 'place_order', argsFor(draft), /会员信息有变化/), changed);
  assert.equal(count(r, PATHS.create), 0);
  assert.deepEqual(bookRecords(r), []);
  await assertAudit(r, s, ['changed']);
  for (const device of [s, other]) await failure(device, 'my_orders', {}, /尚未绑定/);
  assert.equal((await place(switched, unrelated)).placed, true);
  await bindAgain(switched, phone);
  await bindAgain(other);
  await failure(other, 'place_order', argsFor(otherDraft), /确认令牌无效/);
});

test('WRT-22 查无此会员也解除绑定、丢弃待确认单，不发送创建请求', async t => {
  const {r, s} = await withBound(t);
  const draft = await prepare(s);
  r.mock.override.set(PATHS.member, () => ok({customerId:0}));
  assert.equal(await failure(s, 'place_order', argsFor(draft), /会员信息有变化/), changed);
  assert.equal(count(r, PATHS.create), 0);
  await failure(s, 'my_orders', {}, /尚未绑定/);
  await assertAudit(r, s, ['changed']);
  r.mock.override.delete(PATHS.member);
  await bindAgain(s);
  await failure(s, 'place_order', argsFor(draft), /确认令牌无效/);
});

test('WRT-22 每次只查一次，失败保留绑定和原令牌，数字等值时放行且不占绑定限流', async t => {
  const {r, s} = await withBound(t, {LICHA_RATE_BINDS_PER_DEVICE_PER_HOUR:'2', LICHA_RATE_BINDS_GLOBAL_PER_MIN:'2'});
  const draft = await prepare(s);
  const initial = count(r, PATHS.member);
  await failure(s, 'place_order', {...argsFor(draft), confirmAmountYuan:1}, /金额与待确认单不一致/);
  assert.equal(count(r, PATHS.member), initial);
  const responses = [
    (_, {res}) => { res.statusCode = 503; res.end(); },
    () => ({status:true, data:{}}),
    () => ok({customerId:'12.0000000001'})
  ];
  for (const [index, response] of responses.entries()) {
    r.mock.override.set(PATHS.member, response);
    assert.equal(await failure(s, 'place_order', argsFor(draft), /暂时没法核对会员信息/), failed);
    assert.equal(count(r, PATHS.member), initial + index + 1);
    assert.equal(count(r, PATHS.create), 0);
    assert.deepEqual(bookRecords(r), []);
    assert.deepEqual((await success(s, 'my_orders')).member, draft.member);
  }
  r.mock.override.set(PATHS.member, () => ok('00' + memberA + '.0'));
  const before = r.requests.length;
  assert.equal((await place(s, draft)).placed, true);
  assert.deepEqual(r.requests.slice(before).map(r => r.path), [PATHS.member, PATHS.create, PATHS.orderDetail]);
  assert.deepEqual(r.requests[before].params, {customerCode:{code:phone, type:1}});
  await assertAudit(r, s, ['failed', 'failed', 'failed', 'matched']);
  r.mock.override.delete(PATHS.member);
  await bind(s, phoneB);
});

test('WRT-22 等待重查期间另一设备已更新待确认单，旧单不能取得占位', async t => {
  const {r, s} = await withBound(t, {LICHA_READ_TIMEOUT_MS:'5000'});
  const other = await r.session();
  await bindAgain(other);
  const draft = await prepare(s);
  const started = Promise.withResolvers();
  const reply = Promise.withResolvers();
  r.mock.override.set(PATHS.member, async () => {
    started.resolve();
    await reply.promise;
    return ok(memberA);
  });
  const pending = s.call('place_order', argsFor(draft));
  await started.promise;
  try { await prepare(other); } finally { reply.resolve(); }
  const result = await pending;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /已被更新的一版替代/);
  assert.equal(count(r, PATHS.create), 0);
  assert.deepEqual(bookRecords(r), []);
});
