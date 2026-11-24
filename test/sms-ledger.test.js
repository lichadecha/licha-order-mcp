import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {mkdtempSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {digest} from '../server/common.js';
import {readConfig} from '../server/config.js';
import {consumeSmsReceipt, Ledger} from '../server/ledger.js';

const phone = '13900000407';
const other = '13900010407';
const start = Date.parse('2031-02-07T08:00:00+08:00');
const config = readConfig({LICHA_ACCESS_KEYS:'test'});

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
    const key = inspect(dir, db => db.prepare('SELECT secret FROM sms_key').get().secret);
    const secret = Buffer.from(key, 'hex');
    assert.ok(secret.length >= 32);
    const expected = createHmac('sha256', secret).update(phone).digest('hex');
    assert.notEqual(expected, digest(phone));
    assert.deepEqual(rows.map(row => ({...row})), [{phone_hash:expected, sent_at:start}]);
    assert.deepEqual(readdirSync(dir), ['orders.sqlite']);
    assert.equal(JSON.stringify(receipt).includes(key), false);
    assert.equal(readFileSync(join(dir, 'orders.sqlite')).includes(phone), false);
    assert.throws(() => consumeSmsReceipt({}, attempt, phone), /落盘凭据/);
    assert.throws(() => consumeSmsReceipt(receipt, {}, phone), /落盘凭据/);
    assert.throws(() => consumeSmsReceipt(receipt, attempt, other), /落盘凭据/);
    consumeSmsReceipt(receipt, attempt, phone);
    assert.throws(() => consumeSmsReceipt(receipt, attempt, phone), /落盘凭据/);
  } finally { book.close(); }
});

test('BND-12 两本新账本对同一手机号各用独立密钥，重启沿用原摘要', t => {
  const dir = directory(t);
  const another = new Ledger(directory(t));
  let book = new Ledger(dir);
  try {
    const hash = book.phoneHash(phone);
    assert.match(hash, /^[a-f0-9]{64}$/);
    assert.notEqual(hash, another.phoneHash(phone));
    book.close();
    book = new Ledger(dir);
    assert.equal(book.phoneHash(phone), hash);
  } finally { book.close(); another.close(); }
});

const midnight = Date.parse('2031-02-08T00:00:00+08:00');
for (const [tier, issuedAt, cooldown, daily, global, message, tiers] of [
  ['cooldown', midnight - 50_000, 3601, 1, 1, /请 3601 秒后再试/, ['cooldown', 'hour', 'global_day', 'day']],
  ['hour', midnight - 50_000, 60, 1, 1, /请约 60 分钟后再试/, ['hour', 'cooldown', 'global_day', 'day']],
  ['day', start, 60, 1, 2, /请明天再试/, ['day', 'hour', 'cooldown']],
  ['global_day', start, 60, 2, 1, /今天的验证短信已经发完了/, ['global_day', 'hour', 'cooldown']],
  ['global_day', start, 60, 1, 1, /今天的验证短信已经发完了/, ['global_day', 'day', 'hour', 'cooldown']]
]) {
  test('BND-12 多档同中按最后解除时刻答复并向上取整：' + tiers.join(' > '), t => {
    const book = new Ledger(directory(t));
    const policy = {...config, LICHA_SMS_COOLDOWN_SEC:cooldown, LICHA_SMS_PER_PHONE_PER_HOUR:1,
      LICHA_SMS_PER_PHONE_PER_DAY:daily, LICHA_SMS_GLOBAL_PER_DAY:global};
    try {
      book.recordSmsSending(phone, {}, policy, issuedAt);
      assert.throws(() => book.checkSmsAllowed(phone, policy, issuedAt + 801),
        {kind:'sms_limit', tier, tiers, firstGlobalRejection:global === 1, message});
      assert.throws(() => book.recordSmsSending(phone, {}, policy, issuedAt + 801),
        {kind:'sms_limit', tier, tiers, firstGlobalRejection:false, message});
    } finally { book.close(); }
  });
}

test('BND-12/14 全服务日额按北京时间跨零点复位，首拒标记跨重启且每日只产生一次', t => {
  const dir = directory(t);
  let book = new Ledger(dir);
  const policy = {...config, LICHA_SMS_GLOBAL_PER_DAY:1};
  try {
    book.recordSmsSending(phone, {}, policy, midnight - 1);
    assert.throws(() => book.recordSmsSending(other, {}, policy, midnight - 1),
      {kind:'sms_limit', tier:'global_day', firstGlobalRejection:true});
    book.close();
    book = new Ledger(dir);
    assert.throws(() => book.checkSmsAllowed(other, policy, midnight - 1),
      {kind:'sms_limit', tier:'global_day', firstGlobalRejection:false});
    book.recordSmsSending(other, {}, policy, midnight);
    assert.throws(() => book.checkSmsAllowed(phone, policy, midnight),
      {kind:'sms_limit', tier:'global_day', firstGlobalRejection:true});
    assert.throws(() => book.recordSmsSending(phone, {}, policy, midnight),
      {kind:'sms_limit', tier:'global_day', firstGlobalRejection:false});
    assert.equal(inspect(dir, db => db.prepare('SELECT count(*) AS n FROM sms_sends').get().n), 2);
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

test('BND-12 刹车要求足量已过期样本，恰好一半未填放行，多一条未填即拒绝', t => {
  const book = new Ledger(directory(t));
  const policy = {...config, LICHA_SMS_CODE_TTL_SEC:30, LICHA_SMS_BRAKE_MIN_SAMPLE:4};
  try {
    for (let i = 0; i < 5; i++) {
      const number = '1390000000' + i;
      book.recordSmsSending(number, {}, policy, start + i);
      if (i === 2 || i === 3) book.markSmsFilled(number, start + i);
    }
    // 3 条过期、2 条未填；4 条过期、2 条未填；5 条过期、3 条未填。
    book.checkSmsAllowed(phone, policy, start + 30_002);
    book.checkSmsAllowed(phone, policy, start + 30_003);
    assert.throws(() => book.recordSmsSending(phone, {}, policy, start + 30_004),
      {kind:'sms_limit', tier:'brake', expiredCount:5, unfilledCount:3});
  } finally { book.close(); }
});

test('BND-12 刹车窗口两端含边界，尚未过期或已出窗口的记录均不计，自动恢复发码', t => {
  const dir = directory(t);
  const book = new Ledger(dir);
  const policy = {...config, LICHA_SMS_CODE_TTL_SEC:30, LICHA_SMS_BRAKE_WINDOW_SEC:61, LICHA_SMS_BRAKE_MIN_SAMPLE:1};
  try {
    book.recordSmsSending(phone, {}, policy, start);
    book.checkSmsAllowed(other, policy, start + 29_999);
    for (const offset of [30_000, 61_000]) {
      assert.throws(() => book.checkSmsAllowed(other, policy, start + offset),
        {tier:'brake', expiredCount:1, unfilledCount:1, message:/最长约 2 分钟/});
    }
    book.recordSmsSending(other, {}, policy, start + 61_001);
    assert.equal(inspect(dir, db => db.prepare('SELECT count(*) AS total FROM sms_sends').get().total), 2);
  } finally { book.close(); }
});

test('BND-12 自定义窗口超过一天时，落账保留刚好处于左端点的记录', t => {
  const dir = directory(t);
  const book = new Ledger(dir);
  const policy = {...config, LICHA_SMS_BRAKE_WINDOW_SEC:90_000};
  try {
    book.recordSmsSending(phone, {}, policy, start);
    book.recordSmsSending(other, {}, policy, start + 90_000_000);
    assert.equal(inspect(dir, db => db.prepare('SELECT count(*) AS n FROM sms_sends').get().n), 2);
    book.recordSmsSending('13900000001', {}, policy, start + 90_000_001);
    assert.equal(inspect(dir, db => db.prepare('SELECT min(sent_at) AS first FROM sms_sends').get().first), start + 90_000_000);
  } finally { book.close(); }
});

test('BND-12/SES-05 同号码多次发码仅回填匹配的一条；重启保留回填状态，重新判定刹车', t => {
  const dir = directory(t);
  let book = new Ledger(dir);
  const policy = {...config, LICHA_SMS_BRAKE_MIN_SAMPLE:2, LICHA_SMS_BRAKE_MAX_UNFILLED_PERCENT:49};
  try {
    book.recordSmsSending(phone, {}, policy, start);
    book.recordSmsSending(phone, {}, policy, start + 60_000);
    book.markSmsFilled(phone, start);
    const now = start + 360_000;
    assert.throws(() => book.checkSmsAllowed(other, policy, now),
      {tier:'brake', firstBrakeRejection:true, expiredCount:2, unfilledCount:1});
    book.close();
    book = new Ledger(dir);
    const states = inspect(dir, db => db.prepare('SELECT filled FROM sms_sends ORDER BY sent_at').all());
    assert.deepEqual(states.map(row => row.filled), [1, 0]);
    assert.throws(() => book.checkSmsAllowed(other, policy, now),
      {tier:'brake', firstBrakeRejection:true, expiredCount:2, unfilledCount:1});
  } finally { book.close(); }
});

test('BND-12 刹车覆盖小时与冷却；同中日额时继续按各档最晚解除时间答复', t => {
  const book = new Ledger(directory(t));
  const policy = {...config, LICHA_SMS_CODE_TTL_SEC:30, LICHA_SMS_BRAKE_MIN_SAMPLE:1, LICHA_SMS_PER_PHONE_PER_HOUR:1};
  try {
    book.recordSmsSending(phone, {}, policy, midnight - 60_000);
    const check = overrides => book.checkSmsAllowed(phone, {...policy, ...overrides}, midnight - 30_000);
    assert.throws(() => check({}), {tier:'brake', tiers:['brake', 'hour', 'cooldown'], message:/验证短信暂时停发了/});
    assert.throws(() => check({LICHA_SMS_PER_PHONE_PER_DAY:1}),
      {tier:'hour', tiers:['hour', 'day', 'cooldown', 'brake'], message:/请约 60 分钟后/});
    // 延长冷却，让它在日额命中时成为最晚档。
    assert.throws(() => check({LICHA_SMS_GLOBAL_PER_DAY:1, LICHA_SMS_COOLDOWN_SEC:3601}),
      {tier:'cooldown', message:/请 3571 秒后/});
    book.recordSmsSending(other, {}, {...policy, LICHA_SMS_BRAKE_MIN_SAMPLE:2}, midnight + 100);
    const later = midnight + 30_100;
    assert.throws(() => book.checkSmsAllowed(other, {...policy, LICHA_SMS_PER_PHONE_PER_DAY:1}, later),
      {tier:'day', message:/请明天再试/});
    assert.throws(() => book.checkSmsAllowed(other, {...policy, LICHA_SMS_PER_PHONE_PER_DAY:1, LICHA_SMS_GLOBAL_PER_DAY:1}, later),
      {tier:'global_day', message:/今天的验证短信已经发完了/});
  } finally { book.close(); }
});

function legacyBook(dir, version) {
  const unresolved = {key:digest('request'), memberHash:digest('member'), storeId:'12',
    time:start, day:'2031-02-07', totalFen:650, state:'sent'};
  const found = {...unresolved, key:digest('claimed'), state:'found', resolvedAt:start, orderNo:'OrderFound001'};
  inspect(dir, db => {
    db.exec('CREATE TABLE records (key TEXT PRIMARY KEY, record TEXT NOT NULL, checksum TEXT NOT NULL) STRICT');
    for (const record of [unresolved, found]) {
      const original = JSON.stringify(record);
      db.prepare('INSERT INTO records VALUES (?, ?, ?)').run(record.key, original, digest(original));
    }
    if (version >= 3) {
      db.exec(`CREATE TABLE sms_sends (phone_hash TEXT NOT NULL, sent_at INTEGER NOT NULL, checksum TEXT NOT NULL,
        PRIMARY KEY (phone_hash, sent_at)) STRICT; CREATE INDEX sms_sends_time ON sms_sends(sent_at)`);
      let oldHash = digest(phone);
      if (version === 4) {
        db.exec(`CREATE TABLE sms_key (id INTEGER PRIMARY KEY CHECK (id=1), secret TEXT NOT NULL, checksum TEXT NOT NULL) STRICT;
          CREATE TABLE sms_daily_alerts (day_start INTEGER PRIMARY KEY) STRICT`);
        const key = 'ab'.repeat(32);
        db.prepare('INSERT INTO sms_key VALUES (1, ?, ?)').run(key, digest(key));
        db.prepare('INSERT INTO sms_daily_alerts VALUES (?)').run(midnight - 86_400_000);
        oldHash = createHmac('sha256', Buffer.from(key, 'hex')).update(phone).digest('hex');
      }
      db.prepare('INSERT INTO sms_sends VALUES (?, ?, ?)').run(oldHash, start, digest(oldHash + ':' + start));
    }
    db.exec('PRAGMA user_version=' + version);
  }, false);
  return {unresolved, found};
}

test('LED-01 格式 4 升级保留原有 HMAC、发码记录与日额告警，旧记录计入刹车', t => {
  const dir = directory(t);
  const {unresolved, found} = legacyBook(dir, 4);
  const book = new Ledger(dir);
  try {
    assert.equal(book.fault, false);
    assert.deepEqual([...book.records.values()], [unresolved, found]);
    assert.equal(inspect(dir, db => db.prepare('SELECT phone_hash FROM sms_sends').get().phone_hash), book.phoneHash(phone));
    const policy = {...config, LICHA_SMS_BRAKE_MIN_SAMPLE:1, LICHA_SMS_GLOBAL_PER_DAY:1};
    assert.throws(() => book.checkSmsAllowed(other, policy, start + 300_000),
      {tiers:['global_day', 'brake'], firstGlobalRejection:false, firstBrakeRejection:true, expiredCount:1, unfilledCount:1});
  } finally { book.close(); }
});

for (const version of [2, 3]) {
  test('LED-01 格式 ' + version + ' 升级保留未决、已认领及额度记录，发码从空表开始', t => {
    const dir = directory(t);
    const {unresolved, found} = legacyBook(dir, version);
    let book = new Ledger(dir);
    try {
      assert.equal(book.fault, false);
      assert.equal(inspect(dir, db => db.prepare('SELECT count(*) AS n FROM sms_sends').get().n), 0);
      assert.equal(readFileSync(join(dir, 'orders.sqlite')).includes(digest(phone)), false);
      assert.deepEqual([...book.records.values()], [unresolved, found]);
      book.recordSmsSending(phone, {}, config, start);
      book.close();
      book = new Ledger(dir);
      assert.deepEqual(book.unresolved(unresolved.memberHash), [unresolved]);
      assert.deepEqual([...book.knownOrders()], [found.orderNo]);
      assert.throws(() => book.recordSmsSending(phone, {}, config, start + 1), {kind:'sms_limit'});
    } finally { book.close(); }
  });
}

test('LED-02 旧账本订单受损或短信组成缺失时，拒绝升级并保留原格式', t => {
  for (const [version, damage] of [[2, "UPDATE records SET checksum='x'"], [3, "UPDATE records SET checksum='x'"],
    [3, 'DROP TABLE sms_sends'], [4, 'DROP TABLE sms_key']]) {
    const dir = directory(t);
    legacyBook(dir, version);
    inspect(dir, db => db.exec(damage), false);
    const original = readFileSync(join(dir, 'orders.sqlite'));
    const book = new Ledger(dir);
    try {
      assert.equal(book.fault, true);
      assert.deepEqual(readFileSync(join(dir, 'orders.sqlite')), original);
    } finally { book.close(); }
  }
});

test('LED-03 格式 3 升级提交受阻，旧发码及订单整体保留，重启后再整体切换', t => {
  const dir = directory(t);
  const {unresolved, found} = legacyBook(dir, 3);
  inspect(dir, reader => {
    reader.exec('BEGIN');
    assert.equal(reader.prepare('SELECT count(*) AS n FROM sms_sends').get().n, 1);
    const failed = new Ledger(dir);
    try {
      assert.equal(failed.fault, true);
    } finally { failed.close(); }
    reader.exec('COMMIT');
    assert.equal(reader.prepare('PRAGMA user_version').get().user_version, 3);
    assert.equal(reader.prepare('SELECT phone_hash FROM sms_sends').get().phone_hash, digest(phone));
    assert.equal(reader.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='sms_key'").get().n, 0);
  });
  const upgraded = new Ledger(dir);
  try {
    assert.equal(upgraded.fault, false);
    assert.deepEqual([...upgraded.records.values()], [unresolved, found]);
    assert.equal(inspect(dir, db => db.prepare('SELECT count(*) AS n FROM sms_sends').get().n), 0);
  } finally { upgraded.close(); }
});

test('LED-02 新版发码记录、密钥或日额审计表缺失或损坏时进入故障态', t => {
  for (const damage of ['DROP TABLE sms_sends', 'UPDATE sms_sends SET sent_at=sent_at+1', 'UPDATE sms_sends SET filled=1', 'DROP TABLE sms_key',
    'DELETE FROM sms_key', "UPDATE sms_key SET secret='abc'", "UPDATE sms_key SET secret=lower(hex(randomblob(32)))",
    'DROP TABLE sms_daily_alerts']) {
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
