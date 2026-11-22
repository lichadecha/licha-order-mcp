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
const formatVersion = 2;
const cutover = '安全账本不可用，格式不兼容或组成不完整。请按规格 §8 第 8 项停掉旧版写入，核清未决请求与当日额度后用空账本切换。';
// 凭据只在记录持久化之后由账本签发，并绑定到这一次实际发送。
const sendReceipts = new WeakMap();
export function consumeSendReceipt(receipt, attempt) {
  if (!sendReceipts.has(receipt) || sendReceipts.get(receipt) !== attempt) {
    throw Error('写出口缺少本次发送的落盘凭据');
  }
  sendReceipts.delete(receipt);
}

const states = new Set(['sent', 'unknown', 'success', 'failed', 'found', 'absent']);
const isDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function validateRecord(record) {
  return record && isDigest(record.key) && isDigest(record.memberHash)
    && typeof record.storeId === 'string' && decimalId(record.storeId) !== null
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
  persistedFields.set(record, Object.freeze({requestKey:record.key, quotaDate:record.day}));
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
      if (this.db.prepare('PRAGMA user_version').get().user_version !== formatVersion) {
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
      db.exec(`PRAGMA user_version=${formatVersion}`);
      db.exec('COMMIT');
    } finally {
      db.close();
    }
    renameSync(temporary, this.file);
    fsyncSync(this.directoryFd);
  }

  #persistRecord(record, insertOnly) {
    if (this.fault) throw Error('安全账本不可用，需要人工检查');
    try {
      if (!validateRecord(record)) throw Error('账本记录无效');
      const current = statSync(this.file);
      if (current.ino !== this.identity.ino || current.dev !== this.identity.dev) throw Error('账本已替换');
      const json = JSON.stringify(record);
      // 发送前只许插入新请求。终态、防重和认领信息都在同一行随事务提交。
      const sql = 'INSERT INTO records (key, record, checksum) VALUES (?, ?, ?)'
        + (insertOnly ? '' : ' ON CONFLICT(key) DO UPDATE SET record=excluded.record, checksum=excluded.checksum');
      this.db.exec('BEGIN IMMEDIATE');
      this.db.prepare(sql).run(record.key, json, digest(json));
      this.db.exec('COMMIT');
    } catch {
      this.fault = true;
      // 关闭连接会回滚尚未提交的事务。若 COMMIT 已生效，保留该提交供重启读取。
      try {
        this.db?.close();
        this.db = undefined;
      } catch { /* 服务仍持有目录锁并拒绝后续写入。 */ }
      throw Error('安全账本写入失败');
    }
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
