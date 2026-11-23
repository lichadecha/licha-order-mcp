import { spawnSync } from 'node:child_process';
import {
  accessSync, closeSync, constants, fsyncSync, mkdirSync, openSync, readdirSync,
  realpathSync, renameSync, statSync, unlinkSync
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { decimalId, digest } from './common.js';
import { orderNumber } from './commerce-view.js';

const bookName = 'orders.sqlite';
const initialName = '.orders-init.sqlite';
const formatVersion = 3;
const hourMs = 3600_000;
const dayMs = 24 * hourMs;
const smsSchema = `CREATE TABLE sms_sends (
  phone_hash TEXT NOT NULL, sent_at INTEGER NOT NULL, checksum TEXT NOT NULL,
  PRIMARY KEY (phone_hash, sent_at)
) STRICT;
CREATE INDEX sms_sends_time ON sms_sends(sent_at)`;
const smsUnavailable = '安全账本不可用，暂时不能发验证码。看菜单不受影响，也可以直接在小程序里下单。';
const cutover = '安全账本不可用，格式不兼容或组成不完整。请按规格 §8 第 8 项停掉旧版写入，核清未决请求与当日额度后用空账本切换。';
// 凭据只在记录持久化之后由账本签发，并绑定到这一次实际发送。
const sendReceipts = new WeakMap();
export function consumeSendReceipt(receipt, attempt) {
  if (!sendReceipts.has(receipt) || sendReceipts.get(receipt) !== attempt) {
    throw Error('写出口缺少本次发送的落盘凭据');
  }
  sendReceipts.delete(receipt);
}

const smsReceipts = new WeakMap();
export function consumeSmsReceipt(receipt, attempt, phone) {
  const evidence = smsReceipts.get(receipt);
  if (!evidence || evidence.attempt !== attempt || evidence.phoneHash !== digest(phone)) {
    throw Error('短信出口缺少本次发码的落盘凭据');
  }
  smsReceipts.delete(receipt);
}

function smsChecksum(phoneHash, time) {
  return digest(phoneHash + ':' + time);
}

function smsLimit(times, config, now) {
  if (!times.length) return;
  const remainingMs = times.at(-1) + config.LICHA_SMS_COOLDOWN_SEC * 1000 - now;
  if (remainingMs > 0) return `验证码发得太频繁了，请 ${Math.ceil(remainingMs / 1000)} 秒后再试。`;
  const hourly = times.filter(time => time > now - hourMs);
  if (hourly.length >= config.LICHA_SMS_PER_PHONE_PER_HOUR) {
    const availableAt = hourly[hourly.length - config.LICHA_SMS_PER_PHONE_PER_HOUR] + hourMs;
    return `这个手机号收验证码的次数已到上限，请约 ${Math.ceil((availableAt - now) / 60_000)} 分钟后再试，或直接在小程序里下单。`;
  }
  const midnight = Math.floor((now + 8 * hourMs) / dayMs) * dayMs - 8 * hourMs;
  if (times.filter(time => time >= midnight).length >= config.LICHA_SMS_PER_PHONE_PER_DAY) {
    return '这个手机号收验证码的次数已到上限，请明天再试，或直接在小程序里下单。';
  }
}

const states = new Set(['sent', 'unknown', 'success', 'failed', 'found', 'absent']);
const isDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function validateRecord(record) {
  return record && isDigest(record.key) && isDigest(record.memberHash)
    && typeof record.storeId === 'string' && decimalId(record.storeId) !== null
    && (record.couponChoice === undefined || ['default', 'none', 'specific'].includes(record.couponChoice))
    && (record.products === undefined || (Array.isArray(record.products) && record.products.length >= 1
      && record.products.length <= 20 && record.products.every(item => item && typeof item.goodsId === 'string'
        && decimalId(item.goodsId) === item.goodsId && (item.nameHash === null || isDigest(item.nameHash))
        && Number.isInteger(item.quantity) && item.quantity >= 1 && item.quantity <= 99)))
    && Number.isSafeInteger(record.time) && record.time > 0
    && Number.isSafeInteger(record.totalFen) && record.totalFen > 0
    && /^\d{4}-\d{2}-\d{2}$/.test(record.day)
    && states.has(record.state)
    && (['success', 'found'].includes(record.state) ? Boolean(orderNumber(record)) : !Object.hasOwn(record, 'orderNo'))
    && (record.state !== 'success' || Number.isSafeInteger(record.completedAt))
    && (!['found', 'absent'].includes(record.state) || Number.isSafeInteger(record.resolvedAt));
}

const persistedFields = new WeakMap();
function rememberAuditFields(record) {
  // v1.8 的旧记录只可能是默认用券。
  persistedFields.set(record, Object.freeze({
    requestKey:record.key, quotaDate:record.day, couponChoice:record.couponChoice ?? 'default'
  }));
}
export function persistedAuditFields(record) {
  return persistedFields.get(record);
}

export class Ledger {
  constructor(directory, {initializeIfEmpty = true} = {}) {
    this.records = new Map();
    this.fault = false;
    try {
      mkdirSync(directory, {recursive:true, mode:0o700});
      this.directory = realpathSync(directory);
      accessSync(this.directory, constants.W_OK | constants.X_OK);
      this.directoryFd = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY);
      // flock 在继承的 fd 3 上加锁。它退出后，父进程仍持有同一打开文件描述，
      // 直到关闭 fd 或进程退出。竞争者始终锁目录本身，不必读取账本。
      const lock = spawnSync('flock', ['-x', '-n', '-E', '73', '3'], {
        stdio:['ignore', 'ignore', 'ignore', this.directoryFd]
      });
      if (lock.status === 73) throw Error('账本目录已由其他实例使用，请先停止该实例。');
      if (lock.error || lock.status !== 0) throw Error('无法建立账本目录独占锁，请检查 flock 和文件系统支持。');
    } catch (error) {
      this.close();
      if (error.code) throw Error('无法建立账本目录独占锁，请检查目录路径和写权限。');
      throw error;
    }
    this.file = join(this.directory, bookName);
    try {
      const files = readdirSync(this.directory);
      if (!files.includes(bookName)) {
        // 初建暂名下从未接受过业务记录。正式库一经发布，只有 SQLite 写它。
        if (files.some(name => name !== initialName && name !== initialName + '-journal')) {
          this.faultReason = cutover;
          throw Error(cutover);
        }
        if (!initializeIfEmpty) return;
        for (const name of files) unlinkSync(join(this.directory, name));
        this.#initialize();
      }
      this.identity = statSync(this.file);
      if (!this.identity.isFile() || !this.identity.size) throw Error('账本损坏');
      this.db = new DatabaseSync(this.file);
      this.db.exec('PRAGMA synchronous=FULL');
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version !== 2 && version !== formatVersion) {
        this.faultReason = cutover;
        throw Error(cutover);
      }
      if (this.db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw Error('账本损坏');
      const recovered = new Map();
      for (const row of this.db.prepare('SELECT key, record, checksum FROM records').all()) {
        const record = JSON.parse(row.record);
        if (row.key !== record?.key || recovered.has(row.key)
          || digest(row.record) !== row.checksum || !validateRecord(record)) {
          throw Error('账本记录损坏');
        }
        recovered.set(record.key, record);
      }
      if (version === 2) {
        // v2 还没有短信表。在确认旧订单完整后一次性升级，避免把损坏的新版误作空表。
        this.db.exec('BEGIN IMMEDIATE');
        this.db.exec(smsSchema);
        this.db.exec(`PRAGMA user_version=${formatVersion}`);
        this.db.exec('COMMIT');
      }
      for (const row of this.db.prepare('SELECT phone_hash, sent_at, checksum FROM sms_sends').iterate()) {
        if (!isDigest(row.phone_hash) || !Number.isSafeInteger(row.sent_at) || row.sent_at <= 0
          || row.checksum !== smsChecksum(row.phone_hash, row.sent_at)) throw Error('发码记录损坏');
      }
      this.records = recovered;
      for (const record of recovered.values()) rememberAuditFields(record);
    } catch {
      this.fault = true;
    }
  }

  #initialize() {
    const temporary = join(this.directory, initialName);
    closeSync(openSync(temporary, 'wx', 0o600));
    const db = new DatabaseSync(temporary);
    try {
      db.exec('PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE');
      db.exec('BEGIN IMMEDIATE');
      db.exec('CREATE TABLE records (key TEXT PRIMARY KEY, record TEXT NOT NULL, checksum TEXT NOT NULL) STRICT');
      db.exec(smsSchema);
      db.exec(`PRAGMA user_version=${formatVersion}`);
      db.exec('COMMIT');
    } finally {
      db.close();
    }
    renameSync(temporary, this.file);
    fsyncSync(this.directoryFd);
  }

  #withWritableBook(operation) {
    if (this.fault) throw Error('安全账本不可用，需要人工检查');
    try {
      const current = statSync(this.file);
      if (current.ino !== this.identity.ino || current.dev !== this.identity.dev) throw Error('账本已替换');
      return operation();
    } catch {
      this.fault = true;
      // 关闭连接会回滚尚未提交的事务。若 COMMIT 已生效，保留该提交供重启读取。
      try {
        this.db?.close();
        this.db = undefined;
      } catch { /* 服务仍持有目录锁并拒绝后续写入。 */ }
      throw Error('安全账本写入失败');
    }
  }

  #persistRecord(record, insertOnly) {
    this.#withWritableBook(() => {
      if (!validateRecord(record)) throw Error('账本记录无效');
      const json = JSON.stringify(record);
      // 发送前只许插入新请求。终态、防重和认领信息都在同一行随事务提交。
      const sql = 'INSERT INTO records (key, record, checksum) VALUES (?, ?, ?)'
        + (insertOnly ? '' : ' ON CONFLICT(key) DO UPDATE SET record=excluded.record, checksum=excluded.checksum');
      this.db.exec('BEGIN IMMEDIATE');
      this.db.prepare(sql).run(record.key, json, digest(json));
      this.db.exec('COMMIT');
    });
    this.records.set(record.key, record);
    rememberAuditFields(record);
  }

  update(record) {
    this.#persistRecord(record);
  }

  recordSending(record, attempt) {
    if (record.state !== 'sent' || this.records.has(record.key)) throw Error('发送前记录无效或重复');
    this.#persistRecord(record, true);
    const receipt = Object.freeze({});
    sendReceipts.set(receipt, attempt);
    return receipt;
  }

  #withSmsAllowance(phoneHash, config, now, onAllowed) {
    let limit;
    try {
      limit = this.#withWritableBook(() => {
        // 服务独占目录，检查到提交之间全程同步。自定义冷却超过一天时仍保留其记录。
        const cutoff = now - Math.max(dayMs, config.LICHA_SMS_COOLDOWN_SEC * 1000);
        const history = this.db.prepare('SELECT sent_at FROM sms_sends WHERE phone_hash=? AND sent_at>? ORDER BY sent_at')
          .all(phoneHash, cutoff);
        const reason = smsLimit(history.map(row => row.sent_at), config, now);
        if (reason) return reason;
        onAllowed?.(cutoff);
      });
    } catch {
      throw Object.assign(Error(smsUnavailable), {kind:'sms_ledger'});
    }
    if (limit) throw Object.assign(Error(limit), {kind:'sms_limit'});
  }

  checkSmsAllowed(phone, config, now = Date.now()) {
    this.#withSmsAllowance(digest(phone), config, now);
  }

  recordSmsSending(phone, attempt, config, now = Date.now()) {
    const phoneHash = digest(phone);
    // 查询会员期间，其他设备可能已给同一号码发码，落盘前须重新检查。
    this.#withSmsAllowance(phoneHash, config, now, cutoff => {
      this.db.exec('BEGIN IMMEDIATE');
      this.db.prepare('DELETE FROM sms_sends WHERE sent_at<=?').run(cutoff);
      this.db.prepare('INSERT INTO sms_sends (phone_hash, sent_at, checksum) VALUES (?, ?, ?)')
        .run(phoneHash, now, smsChecksum(phoneHash, now));
      this.db.exec('COMMIT');
    });
    const receipt = Object.freeze({});
    smsReceipts.set(receipt, {attempt, phoneHash});
    return receipt;
  }

  unresolved(memberHash) {
    return [...this.records.values()].filter(row => ['sent', 'unknown'].includes(row.state) && row.memberHash === memberHash)
      .sort((left, right) => left.time - right.time);
  }

  knownOrders() {
    return new Set([...this.records.values()].map(row => row.orderNo).filter(Boolean));
  }

  close() {
    try {
      this.db?.close();
      this.db = undefined;
    } finally {
      if (this.directoryFd !== undefined) {
        closeSync(this.directoryFd);
        this.directoryFd = undefined;
      }
    }
  }
}
