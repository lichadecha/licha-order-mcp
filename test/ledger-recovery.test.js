import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import { PATHS } from '../server/qmai.js';
import { argsFor, basket, bind, bookFile, count, failure, memberA, number, ok, place, prepare, shop,
  success, withBound } from '../test-support/commerce.js';

function failCommittedWrite(state) {
  const source = `import fs from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { syncBuiltinESMExports } from 'node:module';
const directory = process.env.LICHA_DATA_DIR;
const db = DatabaseSync.prototype, exec = db.exec;
let readOnly = false;
db.exec = function(sql) {
  const result = exec.call(this, sql);
  if (sql !== 'DELETE FROM pending_snapshot WHERE id=1') return result;
  const rows = JSON.parse(fs.readFileSync(join(directory, 'orders.json'), 'utf8')).records;
  if (!rows.some(row => row.state === ${JSON.stringify(state)})) return result;
  if (this.prepare('SELECT 1 FROM pending_snapshot WHERE id=1').get()) throw Error('撤销记录没有删除');
  fs.chmodSync(directory, 0o500);
  exec.call(this, 'PRAGMA query_only=ON');
  readOnly = true;
  throw Error('模拟 SQLite 实际提交后回报 I/O 错误');
};
// chmod 对特权测试进程无效。此时也让文件创建、回写、标记删除走只读错误。
for (const method of ['openSync', 'renameSync', 'writeFileSync', 'unlinkSync']) {
  const original = fs[method];
  fs[method] = function(path, ...args) {
    if (readOnly && process.getuid?.() === 0 && typeof path === 'string' && path.startsWith(directory + '/')
      && (method !== 'openSync' || args[0] !== 'r')) throw Error('EROFS');
    return original.call(fs, path, ...args);
  };
}
syncBuiltinESMExports();`;
  return '--import=data:text/javascript;base64,' + Buffer.from(source).toString('base64');
}

async function checkReadOnlyAfterCommit(t, state) {
  const { r, s, m } = await withBound(t, {
    NODE_OPTIONS: failCommittedWrite(state), LICHA_ORDER_MATCH_WINDOW_MS: '30000'
  });
  const writes = state === 'sent' ? 0 : 1;
  try {
    if (state === 'failed') m.override.set(PATHS.create, () => ({ status:false, code:30005 }));
    if (state === 'found') m.override.set(PATHS.create, () => ok({}));
    const draft = await prepare(s);
    if (state === 'success') {
      assert.equal((await place(s, draft)).orderNo, number(1));
    } else if (state === 'found') {
      await failure(s, 'place_order', argsFor(draft), /结果未知/);
      const orderAt = r.requests.find(req => req.path === PATHS.create).at;
      m.orders = [{ userId:memberA, orderNo:number(2), orderAt, storeId:shop, status:10 }];
      const result = await success(s, 'my_orders');
      assert.equal(result.unresolvedPendingWrites, 1);
      assert.equal(result.resolvedPendingWrites, undefined);
      assert.match(result.pendingWriteNote, /没能保存/);
    } else {
      await failure(s, 'place_order', argsFor(draft), state === 'sent' ? /没有发出/ : /这一单没有创建/);
    }
    assert.equal((await stat(r.dataDir)).mode & 0o777, 0o500);
    assert.equal(JSON.parse(await readFile(bookFile(r), 'utf8')).records[0].state, state);
    assert.equal(count(r, PATHS.create), writes);
    await failure(s, 'prepare_order', basket, /账本不可用/);
  } finally {
    await r.stop('SIGKILL');
    await chmod(r.dataDir, 0o700);
  }
  delete r.env.NODE_OPTIONS;
  await r.start();
  const resumed = await r.session(s.device);
  await bind(resumed);
  await failure(resumed, 'prepare_order', basket, /账本不可用/);
  assert.equal(count(r, PATHS.create), writes);
}

for (const [state, point] of [['sent', '发送前记录'], ['success', '成功终态'], ['failed', '明确失败终态'], ['found', '未决认领']]) {
  test('LED-03 ' + point + '实际提交后报错、目录持续只读，重启保持故障态', t => checkReadOnlyAfterCommit(t, state));
}

test('LED-03 确认成功后清除标记已生效才报错，回执、重启后的成功记录一致', async t => {
  const source = `import fs from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const remove = fs.unlinkSync, directory = process.env.LICHA_DATA_DIR;
fs.unlinkSync = path => {
  remove(path);
  if (path === join(directory, '.orders-need-review')
    && JSON.parse(fs.readFileSync(join(directory, 'orders.json'), 'utf8')).records[0]?.state === 'success') {
    throw Error('模拟标记已移除后清理报错');
  }
};
syncBuiltinESMExports();`;
  const { r, s } = await withBound(t, {
    NODE_OPTIONS: '--import=data:text/javascript;base64,' + Buffer.from(source).toString('base64'),
    LICHA_MAX_ORDERS_PER_CUSTOMER_PER_DAY: '1'
  });
  const receipt = await place(s, await prepare(s));
  assert.equal(receipt.orderNo, number(1));
  await failure(s, 'prepare_order', basket, /账本不可用/);
  delete r.env.NODE_OPTIONS;
  await r.restart();
  const resumed = await r.session(s.device);
  await bind(resumed);
  const draft = await prepare(resumed);
  assert.equal(draft.recentOrder.orderNo, receipt.orderNo);
  await failure(resumed, 'place_order', argsFor(draft), /每位会员每天最多 1 单/);
  assert.equal(count(r, PATHS.create), 1);
});

test('LED-02 R23 旧快照校验和正确、记录订单号无效时仍禁止再次下单', async t => {
  const { r, s } = await withBound(t);
  await place(s, await prepare(s));
  await r.stop();
  const path = bookFile(r);
  const snapshot = JSON.parse(await readFile(path, 'utf8'));
  const [{ completedAt, ...original }] = snapshot.records;
  for (const state of ['success', 'found', 'unknown']) {
    snapshot.records = [{ ...original, state, orderNo:'N/A',
      ...(state === 'success' && { completedAt }), ...(state === 'found' && { resolvedAt: completedAt }) }];
    snapshot.checksum = createHash('sha256').update(JSON.stringify(snapshot.records)).digest('hex');
    await writeFile(path, JSON.stringify(snapshot) + '\n');
    await r.start();
    const resumed = await r.session(s.device);
    await bind(resumed);
    await failure(resumed, 'prepare_order', basket, /账本不可用/);
    assert.equal(count(r, PATHS.create), 1);
    await r.stop();
  }
});
