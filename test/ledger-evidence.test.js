import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { digest } from '../server/common.js';
import { basket, bind, phone, bookFile, bookRecords, count, failure, place, prepare, success, withBound } from '../test-support/commerce.js';
import { PATHS } from '../server/qmai.js';

const cli = fileURLToPath(new URL('../server/ledger-cli.js', import.meta.url));
const list = r => spawnSync(process.execPath, [cli, 'list'], {cwd:r.cwd, env:r.env, encoding:'utf8'});

async function verifyFault(r, previousCreates) {
  await r.start();
  const resumed = await r.session();
  await failure(resumed, 'bind_member', { code: phone, codeType: 'phone' }, /安全账本不可用/);
  assert.equal((await success(resumed, 'preview_order', basket)).ok, true);
  await failure(resumed, 'my_orders', {}, /尚未绑定/);
  assert.equal(count(r, PATHS.create), previousCreates);
  await r.stop();
}

const cutover = /§8 第 8 项.*核清.*空账本/;
test('LED-02/08 旧快照的两种格式均保持原样，CLI 和服务提示核清后切换', async t => {
  const {r, s} = await withBound(t);
  await place(s, await prepare(s));
  const records = bookRecords(r);
  await r.stop();
  // a42cb6b 与 b16d3c3 使用相同的 version=1 格式；f01df9c 增加会员摘要版本。
  for (const revision of ['a42cb6b-b16d3c3', 'f01df9c']) {
    const dir = join(r.cwd, revision);
    await mkdir(dir);
    const envelope = {version:1, ...(revision === 'f01df9c' && {memberHashVersion:'sha256-canonical-decimal-v1'}),
      records, checksum:digest(JSON.stringify(records))};
    const snapshot = JSON.stringify(envelope) + '\n';
    const snapshotFile = join(dir, 'orders.json');
    const journalFile = join(dir, '.ledger-lock.sqlite');
    await writeFile(snapshotFile, snapshot);
    const old = new DatabaseSync(journalFile);
    try {
      old.exec('CREATE TABLE initialized (version INTEGER); CREATE TABLE pending_snapshot (id INTEGER PRIMARY KEY CHECK (id=1), previous TEXT NOT NULL, candidate_hash TEXT NOT NULL)');
    } finally { old.close(); }
    const journal = await readFile(journalFile);
    r.env.LICHA_DATA_DIR = dir;
    const listed = list(r);
    assert.notEqual(listed.status, 0);
    assert.match(listed.stderr, cutover);
    await verifyFault(r, 1);
    assert.match(r.stderr, cutover);
    assert.deepEqual((await readdir(dir)).sort(), ['.ledger-lock.sqlite', 'orders.json']);
    assert.equal(await readFile(snapshotFile, 'utf8'), snapshot);
    assert.deepEqual(await readFile(journalFile), journal);
  }
});

test('LED-02/08 SQLite 未知版本拒绝打开业务，不自动重写版本或记录', async t => {
  const {r, s} = await withBound(t);
  await place(s, await prepare(s));
  await r.stop();
  const file = bookFile(r);
  assert.deepEqual(await readdir(r.dataDir), [basename(file)]);
  const db = new DatabaseSync(file);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 6);
    db.exec('PRAGMA user_version=99');
  } finally { db.close(); }
  const bytes = await readFile(file);
  const listed = list(r);
  assert.notEqual(listed.status, 0);
  assert.match(listed.stderr, cutover);
  await verifyFault(r, 1);
  assert.match(r.stderr, cutover);
  assert.deepEqual(await readFile(file), bytes);
});

test('LED-02 R23 记录校验和正确，订单号形态或 JSON 类型错误仍停单', async t => {
  const {r, s} = await withBound(t);
  await place(s, await prepare(s));
  await r.stop();
  const [original] = bookRecords(r);
  for (const [state, orderNo] of [['success', 'N/A'], ['success', 123456789012],
    ['found', 'N/A'], ['unknown', original.orderNo]]) {
    const record = JSON.stringify({...original, state, orderNo, ...(state === 'found' && {resolvedAt:original.completedAt})});
    const db = new DatabaseSync(bookFile(r));
    try {
      db.prepare('UPDATE records SET record=?, checksum=? WHERE key=?').run(record, digest(record), original.key);
    } finally { db.close(); }
    await verifyFault(r, 1);
    assert.notEqual(list(r).status, 0);
  }
});

test('LED-03 初次建库过程中强杀，重启后仍能接受首单', async t => {
  const {r} = await withBound(t);
  await r.stop();
  r.env.LICHA_DATA_DIR = join(r.cwd, 'fresh');
  const preload = `import { DatabaseSync } from 'node:sqlite';
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) {
  if (sql === 'COMMIT') process.kill(process.pid, 'SIGKILL');
  return exec.call(this, sql);
};`;
  r.env.NODE_OPTIONS = '--import=data:text/javascript;base64,' + Buffer.from(preload).toString('base64');
  await assert.rejects(() => r.start(), /服务启动失败/);
  assert.equal(r.child.signalCode, 'SIGKILL');
  await r.stop();
  delete r.env.NODE_OPTIONS;
  await r.start();
  const first = await r.session();
  await bind(first);
  assert.equal((await place(first, await prepare(first))).placed, true);
  assert.equal(count(r, PATHS.create), 1);
});

test('LED-03 建库、发码、发单记录与成功终态均由 synchronous=FULL 或更强的连接提交', async t => {
  const preload = `import {DatabaseSync} from 'node:sqlite';
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) {
  if (sql === 'COMMIT') {
    const row = this.prepare('SELECT record FROM records LIMIT 1').get();
    const hasSms = this.prepare('SELECT 1 FROM sms_sends LIMIT 1').get();
    const state = row ? JSON.parse(row.record).state : hasSms ? 'sms' : 'initial';
    const {synchronous} = this.prepare('PRAGMA synchronous').get();
    process.stderr.write('test-ledger-commit ' + state + ' ' + synchronous + '\\n');
  }
  return exec.call(this, sql);
};`;
  const {r, s} = await withBound(t, {NODE_OPTIONS:'--import=data:text/javascript;base64,' + Buffer.from(preload).toString('base64')});
  await place(s, await prepare(s));
  await r.stop();
  const commits = [...r.stderr.matchAll(/^test-ledger-commit (\w+) (\d+)$/gm)];
  assert.deepEqual(commits.map(([,state]) => state), ['initial','sms','sent','success']);
  assert.ok(commits.every(([, , level]) => Number(level) >= 2), r.stderr);
});
