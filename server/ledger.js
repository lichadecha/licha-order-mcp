import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  accessSync, closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync,
  realpathSync, renameSync, statSync, unlinkSync, writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { orderNumber } from './commerce-view.js';

const checksum = text => createHash('sha256').update(text).digest('hex');
const bookName = 'orders.json';
const memberHashVersion = 'sha256-canonical-decimal-v1';
const digestCutover = '安全账本的会员摘要口径未标明或不兼容。请按规格 §8 第 8 项停掉旧版写入，核清未决请求与当日额度后用空账本切换。';
// 保留已部署版本的文件名，库中保存快照撤销记录。
const journalName = '.ledger-lock.sqlite';
const reviewName = '.orders-need-review';
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
    && typeof record.storeId === 'string' && /^\d+$/.test(record.storeId)
    && (record.products === undefined || (Array.isArray(record.products) && record.products.length >= 1
      && record.products.length <= 20 && record.products.every(item => item && typeof item.goodsId === 'string'
        && /^[1-9]\d*$/.test(item.goodsId) && (item.nameHash === null || isDigest(item.nameHash))
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
    this.journalFile = join(this.directory, journalName);
    try {
      const files = readdirSync(this.directory);
      const fresh = files.length === 0;
      if (fresh && !initializeIfEmpty) return;
      if (!fresh && (!files.includes(journalName) || !files.includes(bookName))) {
        throw Error('账本组成不完整或需要人工核对');
      }
      if (fresh) closeSync(openSync(this.journalFile, 'wx', 0o600));
      else if (!statSync(this.journalFile).size) throw Error('撤销记录库为空');
      this.journal = new DatabaseSync(this.journalFile);
      this.journal.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE');
      if (this.journal.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw Error('账本数据库损坏');
      if (fresh) {
        this.journal.exec('CREATE TABLE initialized (version INTEGER)');
      }
      if (this.journal.prepare('SELECT 1 FROM initialized WHERE version=0').get()) throw Error('账本需要人工核对');
      // v1 的完整快照可升级到带撤销记录的格式。
      this.journal.exec(`CREATE TABLE IF NOT EXISTS pending_snapshot (
        id INTEGER PRIMARY KEY CHECK (id = 1), previous TEXT NOT NULL, candidate_hash TEXT NOT NULL
      )`);
      this.journalIdentity = statSync(this.journalFile);
      if (fresh) {
        this.#save(new Map(), {initial:true});
      } else {
        const current = readFileSync(this.file);
        const pending = this.journal.prepare('SELECT previous, candidate_hash FROM pending_snapshot WHERE id=1').get();
        const hasReview = files.includes(reviewName);
        const previous = pending ? Buffer.from(pending.previous, 'utf8') : current;
        if (hasReview && !readFileSync(join(this.directory, reviewName)).equals(previous)) {
          throw Error('人工核对标记无法与撤销记录核实');
        }
        // 两次提交之间退出时，只接受日志记载的旧、候选两种现场。
        if (pending && !current.equals(previous) && checksum(current) !== pending.candidate_hash) throw Error('快照与撤销记录不符');
        const bytes = new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(previous);
        const envelope = JSON.parse(bytes);
        if (envelope.version !== 1 || !Array.isArray(envelope.records)
          || envelope.checksum !== checksum(JSON.stringify(envelope.records))
          || !envelope.records.every(validateRecord)) throw Error('损坏');
        if (envelope.memberHashVersion !== memberHashVersion
          && (envelope.records.length || Object.hasOwn(envelope, 'memberHashVersion'))) {
          this.faultReason = digestCutover;
          throw Error(digestCutover);
        }
        const recovered = new Map(envelope.records.map(row => [row.key, row]));
        if (recovered.size !== envelope.records.length) throw Error('重复');
        if (pending) this.#replaceFile(bytes);
        if (hasReview) {
          unlinkSync(join(this.directory, reviewName));
          this.#syncDirectory();
        }
        if (pending) {
          this.journal.exec('DELETE FROM pending_snapshot WHERE id=1');
        }
        this.lastBytes = bytes;
        this.records = recovered;
        for (const record of this.records.values()) rememberAuditFields(record);
      }
    } catch {
      this.fault = true;
    }
  }

  #replaceFile(bytes) {
    const temporary = join(this.directory, '.orders-' + randomUUID() + '.tmp');
    try {
      const fd = openSync(temporary, 'wx', 0o600);
      try {
        writeFileSync(fd, bytes, 'utf8');
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, this.file);
      this.#syncDirectory();
    } finally {
      if (existsSync(temporary)) {
        try { unlinkSync(temporary); } catch { /* 保留现场供运维检查 */ }
      }
    }
  }

  #syncDirectory() {
    if (process.platform === 'win32') return;
    const directory = openSync(this.directory, 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }

  #save(records, {initial = false, beforeSend = false} = {}) {
    if (this.fault) throw Error('安全账本不可用，需要人工检查');
    try {
      const journalFile = statSync(this.journalFile);
      if (journalFile.dev !== this.journalIdentity.dev || journalFile.ino !== this.journalIdentity.ino) throw Error('账本数据库已替换');
      const rows = [...records.values()];
      const bytes = JSON.stringify({ version: 1, memberHashVersion, records: rows, checksum: checksum(JSON.stringify(rows)) }) + '\n';
      if (!initial) {
        const prior = openSync(this.file, 'r+');
        try {
          if (!readFileSync(prior).equals(Buffer.from(this.lastBytes))) throw Error('账本已更改');
        } finally { closeSync(prior); }
        // SQLite 单语句事务先确认撤销记录，替换、同步任一步失败都保留它。
        this.journal.prepare('INSERT INTO pending_snapshot VALUES (1, ?, ?)').run(this.lastBytes, checksum(bytes));
      }
      this.#replaceFile(bytes);
      if (!initial) this.#confirmSnapshot(bytes, beforeSend);
      this.records = records;
      this.lastBytes = bytes;
    } catch {
      this.fault = true;
      throw Error('安全账本写入失败');
    }
  }

  #confirmSnapshot(candidate, beforeSend) {
    // 独立标记保留写前快照，启动时可与 SQLite 撤销行交叉核验。
    const review = join(this.directory, reviewName);
    writeFileSync(review, this.lastBytes, {flag:'wx', mode:0o600, flush:true});
    this.#syncDirectory();
    if (beforeSend) {
      this.#confirmSending(candidate, review);
      return;
    }
    try {
      this.journal.exec('DELETE FROM pending_snapshot WHERE id=1');
    } catch (error) {
      try {
        this.#restoreOnUncertainCommit(candidate);
        unlinkSync(review);
        this.#syncDirectory();
      } catch { /* 撤销无法确认时保留预先落盘的标记。 */ }
      throw error;
    }
    // 此刻 SQLite 已明确确认，候选快照已落盘。清理失败只关闭后续写入；
    // 报告本笔已确认的结果，否则 unlink 已生效才报错时会给出相反的交易结论。
    try {
      unlinkSync(review);
      this.#syncDirectory();
    } catch { this.fault = true; }
  }

  #confirmSending(candidate, review) {
    // 清理期间 SQLite 删除仍在事务中。即使 unlink 已生效才报错，撤销行也能随回滚恢复。
    this.journal.exec('BEGIN IMMEDIATE');
    try {
      this.journal.exec('DELETE FROM pending_snapshot WHERE id=1');
      unlinkSync(review);
      this.#syncDirectory();
    } catch (error) {
      this.journal.exec('ROLLBACK');
      throw error;
    }
    try {
      this.journal.exec('COMMIT');
    } catch (error) {
      // COMMIT 可能已经生效才报错。优先恢复撤销行或原文件。
      try { this.journal.exec('ROLLBACK'); } catch { /* 事务可能已结束。 */ }
      try {
        this.#restoreOnUncertainCommit(candidate);
      } catch {
        try {
          writeFileSync(review, this.lastBytes, {flag:'wx', mode:0o600, flush:true});
          this.#syncDirectory();
        } catch {
          // 目录只读也能写已有快照；回写中断时，截断或校验不符将阻止加载。
          writeFileSync(this.file, this.lastBytes, {flag:'w', flush:true});
        }
      }
      throw error;
    }
  }

  #restoreOnUncertainCommit(candidate) {
    try {
      this.journal.prepare('INSERT OR REPLACE INTO pending_snapshot VALUES (1, ?, ?)').run(this.lastBytes, checksum(candidate));
      return;
    } catch { /* 数据库仍不可写时，走文件恢复。 */ }
    this.#replaceFile(this.lastBytes);
  }

  #persistRecord(record, options) {
    if (!validateRecord(record)) throw Error('账本记录无效');
    this.#save(new Map(this.records).set(record.key, record), options);
    rememberAuditFields(record);
  }

  update(record) {
    this.#persistRecord(record);
  }

  recordSending(record, attempt) {
    if (record.state !== 'sent' || this.records.has(record.key)) throw Error('发送前记录无效或重复');
    this.#persistRecord(record, {beforeSend:true});
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
      this.journal?.close();
      this.journal = undefined;
    } finally {
      if (this.directoryFd !== undefined) {
        closeSync(this.directoryFd);
        this.directoryFd = undefined;
      }
    }
  }
}
