import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {digest} from '../server/common.js';
import {consumeSmsReceipt, Ledger} from '../server/ledger.js';

const phone = '13900000407';
const other = '13900010407';
const start = Date.parse('2031-02-07T08:00:00+08:00');
const config = {LICHA_SMS_COOLDOWN_SEC:60, LICHA_SMS_PER_PHONE_PER_HOUR:5, LICHA_SMS_PER_PHONE_PER_DAY:10};

function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), 'licha-sms-ledger-'));
  t.after(() => rmSync(dir, {recursive:true, force:true}));
  return dir;
}

function inspect(dir, callback, readOnly = true) {
  const db = new DatabaseSync(join(dir, 'orders.sqlite'), {readOnly});
  try { return callback(db); } finally { db.close(); }
}

test('BND-12 发码先落盘；凭据一次有效，跨手机号或跨次均拒绝', t => {
  const dir = directory(t);
  const book = new Ledger(dir);
  try {
    const attempt = {};
    const receipt = book.recordSmsSending(phone, attempt, config, start);
    const rows = inspect(dir, db => db.prepare('SELECT phone_hash, sent_at FROM sms_sends').all());
    assert.deepEqual(rows.map(row => ({...row})), [{phone_hash:digest(phone), sent_at:start}]);
    assert.equal(readFileSync(join(dir, 'orders.sqlite')).includes(phone), false);
    assert.throws(() => consumeSmsReceipt({}, attempt, phone), /落盘凭据/);
    assert.throws(() => consumeSmsReceipt(receipt, {}, phone), /落盘凭据/);
    assert.throws(() => consumeSmsReceipt(receipt, attempt, other), /落盘凭据/);
    consumeSmsReceipt(receipt, attempt, phone);
    assert.throws(() => consumeSmsReceipt(receipt, attempt, phone), /落盘凭据/);
  } finally { book.close(); }
});

test('BND-12 LED-01 重启保留冷却与滚动一小时上限，尾号相同的另一个号码独立计数', t => {
  const dir = directory(t);
  let book = new Ledger(dir);
  const policy = {...config, LICHA_SMS_PER_PHONE_PER_HOUR:2};
  const issue = (number, at) => book.recordSmsSending(number, {}, policy, at);
  try {
    issue(phone, start);
    issue(other, start);
    book.close();
    book = new Ledger(dir);
    assert.throws(() => issue(phone, start + 59_999), {kind:'sms_limit', message:/请 1 秒后/});
    issue(phone, start + 60_000);
    assert.throws(() => issue(phone, start + 2 * 60_000), {kind:'sms_limit', message:/约 58 分钟后/});
    assert.throws(() => issue(phone, start + 3600_000 - 1), {kind:'sms_limit', message:/约 1 分钟后/});
    issue(phone, start + 3600_000);
    assert.equal(inspect(dir, db => db.prepare('SELECT count(*) AS n FROM sms_sends').get().n), 4);
  } finally { book.close(); }
});

test('BND-12 北京自然日跨零点恢复配额，清理 24 小时前发码', t => {
  const dir = directory(t);
  const book = new Ledger(dir);
  const midnight = Date.parse('2031-02-08T00:00:00+08:00');
  const policy = {...config, LICHA_SMS_COOLDOWN_SEC:1, LICHA_SMS_PER_PHONE_PER_DAY:1};
  const issue = at => book.recordSmsSending(phone, {}, policy, at);
  try {
    issue(midnight - 1001);
    assert.throws(() => issue(midnight - 1), {kind:'sms_limit', message:/请明天再试/});
    issue(midnight);
    issue(midnight + 24 * 3600_000);
    assert.equal(inspect(dir, db => db.prepare('SELECT count(*) AS n FROM sms_sends').get().n), 1);
  } finally { book.close(); }
});

test('LED-01 升级真实 v2 账本保留已有未决记录，并可持久记录首条发码', t => {
  const dir = directory(t);
  const record = {key:digest('request'), memberHash:digest('member'), storeId:'12',
    time:start, day:'2031-02-07', totalFen:650, state:'sent'};
  const original = JSON.stringify(record);
  inspect(dir, db => {
    db.exec('CREATE TABLE records (key TEXT PRIMARY KEY, record TEXT NOT NULL, checksum TEXT NOT NULL) STRICT');
    db.prepare('INSERT INTO records VALUES (?, ?, ?)').run(record.key, original, digest(original));
    db.exec('PRAGMA user_version=2');
  }, false);
  let book = new Ledger(dir);
  try {
    assert.deepEqual(book.unresolved(record.memberHash), [record]);
    book.recordSmsSending(phone, {}, config, start);
    book.close();
    book = new Ledger(dir);
    assert.deepEqual(book.unresolved(record.memberHash), [record]);
    assert.throws(() => book.recordSmsSending(phone, {}, config, start + 1), {kind:'sms_limit'});
  } finally { book.close(); }
});

test('LED-02 新版发码表缺失或发码记录损坏时进入故障态', t => {
  for (const damage of ['DROP TABLE sms_sends', 'UPDATE sms_sends SET sent_at=sent_at+1']) {
    const dir = directory(t);
    let book = new Ledger(dir);
    try {
      book.recordSmsSending(phone, {}, config, start);
      book.close();
      inspect(dir, db => db.exec(damage), false);
      book = new Ledger(dir);
      assert.equal(book.fault, true);
      assert.throws(() => book.recordSmsSending(other, {}, config, start), {kind:'sms_ledger', message:/安全账本不可用/});
    } finally { book.close(); }
  }
});

test('LED-02/BND-12 发码落盘失败不签发凭据，同一进程后续拒绝写入', t => {
  const dir = directory(t);
  const book = new Ledger(dir);
  try {
    inspect(dir, db => db.exec(`CREATE TRIGGER deny_sms BEFORE INSERT ON sms_sends
      BEGIN SELECT RAISE(ABORT, 'write failed'); END`), false);
    assert.throws(() => book.recordSmsSending(phone, {}, config, start), {kind:'sms_ledger'});
    assert.equal(book.fault, true);
    inspect(dir, db => db.exec('DROP TRIGGER deny_sms'), false);
    assert.throws(() => book.recordSmsSending(phone, {}, config, start), {kind:'sms_ledger'});
    assert.equal(inspect(dir, db => db.prepare('SELECT count(*) AS n FROM sms_sends').get().n), 0);
  } finally { book.close(); }
});
