import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { PATHS } from '../server/qmai.js';
import { argsFor, basket, bind, bindAgain, phoneB, bookRecords, count, failure, memberA, number, ok, place, prepare,
  shop, success, withBound } from '../test-support/commerce.js';

// 只在测试子进程的 SQLite API 上注入。在该连接内能观察到未提交的记录。
// 提交前的失败由第二条连接持有读锁触发，实际 COMMIT 返回 SQLITE_BUSY。
// 提交后的错误先执行真正的 COMMIT，然后模拟应用收到存储异常。
function interruptCommit(state, phase, kill = false) {
  const source = `import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
const original = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) {
  if (sql !== 'COMMIT') return original.call(this, sql);
  const row = this.prepare('SELECT record FROM records ORDER BY rowid DESC LIMIT 1').get();
  if (!row || JSON.parse(row.record).state !== ${JSON.stringify(state)}) return original.call(this, sql);
  if (${JSON.stringify(phase)} === 'after') original.call(this, sql);
  if (${kill}) process.kill(process.pid, 'SIGKILL');
  if (${JSON.stringify(phase)} === 'before') {
    const reader = new DatabaseSync(join(process.env.LICHA_DATA_DIR, 'orders.sqlite'), {readOnly:true});
    try {
      reader.exec('BEGIN');
      reader.prepare('SELECT COUNT(*) FROM records').get();
      return original.call(this, sql);
    } finally { reader.close(); }
  }
  throw Error('模拟事务已经提交，调用方却收到 I/O 错误');
};`;
  return '--import=data:text/javascript;base64,' + Buffer.from(source).toString('base64');
}

async function restartAndBind(r, s) {
  delete r.env.NODE_OPTIONS;
  await r.restart();
  const resumed = await r.session(s.device);
  await bindAgain(resumed);
  return resumed;
}

for (const phase of ['before', 'after']) {
  const point = phase === 'before' ? '实际提交被拒' : '实际已提交却报错';

  test('LED-03① 发送前记录' + point + '，零次创建，重启按已提交记录核对', async t => {
    const {r, s} = await withBound(t, {NODE_OPTIONS:interruptCommit('sent', phase), LICHA_ORDER_MATCH_WINDOW_MS:'50'});
    const other = await r.session();
    await bind(other, phoneB);
    const spare = await prepare(other);
    const draft = await prepare(s);
    await failure(s, 'place_order', argsFor(draft), /本次下单请求没有发出/);
    await failure(other, 'place_order', argsFor(spare), /账本不可用/);
    await failure(s, 'prepare_order', basket, /账本不可用/);
    assert.equal(count(r, PATHS.create), 0);

    const resumed = await restartAndBind(r, s);
    await failure(resumed, 'place_order', argsFor(draft), /令牌无效/);
    const records = bookRecords(r);
    if (phase === 'before') {
      assert.deepEqual(records, []);
    } else {
      assert.deepEqual(records.map(row => row.state), ['sent']);
      await failure(resumed, 'place_order', argsFor(await prepare(resumed)), /状态未知/);
      await delay(55);
      const list = await success(resumed, 'my_orders');
      assert.equal(list.resolvedPendingWrites, 1);
      assert.match(list.pendingWriteNote, /没有建单/);
      assert.deepEqual(bookRecords(r).map(row => row.state), ['absent']);
    }
    assert.equal(count(r, PATHS.create), 0);
    assert.equal((await place(resumed, await prepare(resumed))).placed, true);
    assert.equal(count(r, PATHS.create), 1);
  });

  for (const state of ['success', 'failed', 'unknown']) {
    test('LED-03② ' + state + ' 终态' + point + '，如实返回上游结果且只发送一次', async t => {
      const {r, s, m} = await withBound(t, {NODE_OPTIONS:interruptCommit(state, phase),
        LICHA_MAX_ORDERS_PER_CUSTOMER_PER_DAY:'1'});
      if (state === 'failed') m.override.set(PATHS.create, () => ({status:false, code:30005}));
      if (state === 'unknown') m.override.set(PATHS.create, () => ok({}));
      const draft = await prepare(s);
      if (state === 'success') assert.equal((await place(s, draft)).orderNo, number(1));
      else await failure(s, 'place_order', argsFor(draft), state === 'failed' ? /这一单没有创建/ : /结果未知/);
      await failure(s, 'prepare_order', basket, /账本不可用/);
      const resumed = await restartAndBind(r, s);
      await failure(resumed, 'place_order', argsFor(draft), /令牌无效/);
      const expected = phase === 'before' ? 'sent' : state;
      assert.deepEqual(bookRecords(r).map(row => row.state), [expected]);
      const next = await prepare(resumed);
      if (expected === 'success') {
        assert.equal(next.recentOrder.orderNo, number(1));
        await failure(resumed, 'place_order', argsFor(next), /每位会员每天最多 1 单/);
      } else if (expected !== 'failed') {
        await failure(resumed, 'place_order', argsFor(next), /状态未知/);
      }
      assert.equal(count(r, PATHS.create), 1);
      if (expected === 'failed') {
        m.override.delete(PATHS.create);
        assert.equal((await place(resumed, next)).placed, true);
        assert.equal(count(r, PATHS.create), 2);
      }
    });
  }

  for (const state of ['found', 'absent']) {
    test('LED-03③ ' + state + ' 核对结论' + point + '，当场不报解除，重启读已提交结论', async t => {
      const {r, s, m} = await withBound(t, {NODE_OPTIONS:interruptCommit(state, phase),
        LICHA_ORDER_MATCH_WINDOW_MS: state === 'found' ? '30000' : '50'});
      m.override.set(PATHS.create, () => ok({}));
      await failure(s, 'place_order', argsFor(await prepare(s)), /结果未知/);
      if (state === 'found') {
        const {at} = r.requests.find(req => req.path === PATHS.create);
        m.orders = [{userId:memberA, orderNo:number(2), orderAt:at, storeId:shop, status:10}];
      } else {
        await delay(55);
      }
      const result = await success(s, 'my_orders');
      if (state === 'found') assert.equal(result.orders[0].orderNo, number(2));
      assert.equal(result.unresolvedPendingWrites, 1);
      assert.equal(result.resolvedPendingWrites, undefined);
      assert.match(result.pendingWriteNote, /闸门还关着.*稍后再查/);
      assert.doesNotMatch(result.pendingWriteNote, /没有建单|可以重新走 prepare_order/);
      await failure(s, 'prepare_order', basket, /账本不可用/);
      const resumed = await restartAndBind(r, s);
      assert.deepEqual(bookRecords(r).map(row => row.state), [phase === 'before' ? 'unknown' : state]);
      const checked = await success(resumed, 'my_orders');
      assert.equal(checked.resolvedPendingWrites, phase === 'before' ? 1 : undefined);
      assert.equal(checked.unresolvedPendingWrites, undefined);
      assert.deepEqual(bookRecords(r).map(row => row.state), [state]);
      assert.equal(count(r, PATHS.create), 1);
    });
  }
}

for (const [state, phase, point] of [
  ['sent', 'after', '发送记录已提交、创建尚未发出'],
  ['success', 'before', '上游已建单、成功终态正在提交']
]) {
  test('LED-03/04 SIGKILL 在' + point + '，重启后只拦原会员', async t => {
    const {r, s} = await withBound(t, {NODE_OPTIONS:interruptCommit(state, phase, true)});
    const draft = await prepare(s);
    const child = r.child;
    await assert.rejects(s.call('place_order', argsFor(draft)));
    await r.stop();
    assert.equal(child.signalCode, 'SIGKILL');
    const created = state === 'sent' ? 0 : 1;
    assert.equal(count(r, PATHS.create), created);
    const resumed = await restartAndBind(r, s);
    assert.deepEqual(bookRecords(r).map(row => row.state), ['sent']);
    await failure(resumed, 'place_order', argsFor(draft), /令牌无效/);
    await failure(resumed, 'place_order', argsFor(await prepare(resumed)), /状态未知/);
    const other = await r.session();
    await bind(other, phoneB);
    assert.equal((await place(other, await prepare(other))).placed, true);
    assert.equal(count(r, PATHS.create), created + 1);
  });
}
