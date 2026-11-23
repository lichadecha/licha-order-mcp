import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { beijingTime, digest, maskNumbers, tail } from './common.js';
import { orderNumber } from './commerce-view.js';
import { persistedAuditFields } from './ledger.js';
import { PATHS, receivedOrderNumber } from './qmai.js';

// 凭证与对外令牌同时生成。外部提交的 UUID 即使完全相同，也不是签发时的这个对象。
const confirmations = new WeakSet();
export function issueConfirmation() {
  const confirmation = Object.freeze({token:randomUUID()});
  confirmations.add(confirmation);
  return confirmation;
}

const quotaDays = new WeakSet();
export function currentQuotaDay() {
  const reservation = Object.freeze({day:beijingTime().slice(0,10)});
  quotaDays.add(reservation);
  return reservation;
}

const knownPaths = new Set(Object.values(PATHS));
const generatedFields = new Set(['time', 'date', 'quotaDate', 'path']);
const protectedFields = new Set([
  'orderNo', 'tokenId', 'requestKey', 'dedupKey', 'memberHash', 'previousMemberHash', 'deviceHash', 'phoneHash'
]);

export function createLogs(config) {
  const directory = config.LICHA_LOG_DIR;
  const secrets = [...config.LICHA_ACCESS_KEYS, config.QMAI_OPEN_ID, config.QMAI_GRANT_CODE, config.QMAI_OPEN_KEY].filter(Boolean);
  function clean(key, value) {
    if (generatedFields.has(key)) return undefined;
    if (protectedFields.has(key)) return typeof value === 'string' ? tail(value) : '***';
    if (/key|token|secret|password|passphrase|authorization|captcha|grantcode|openid|signature|credential|licha.?access|^nonce$/i.test(key)) return undefined;
    if (Array.isArray(value)) return value.map(item => clean('', item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,clean(k,v)]));
    }
    if (typeof value !== 'string' && typeof value !== 'number') return value;
    let str = String(value);
    for (const secret of secrets) str = str.replaceAll(secret, '***');
    str = str.replace(/[a-z\d]{40,}|[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}/gi, tail);
    str = maskNumbers(str);
    return str === String(value) ? value : str;
  }
  function writer(file, dated) {
    return (record, {device, phone, memberId, previousMemberId, confirmation, order, ledgerRecord, reservation} = {}) => {
      try {
        const row = clean('',record);
        row.time = beijingTime();
        if (dated) row.date = row.time.slice(0,10);
        if (file === 'upstream.jsonl' && knownPaths.has(record.path)) row.path = record.path;
        if (dated && quotaDays.has(reservation)) row.quotaDate = reservation.day;
        if (device) row.deviceHash = digest(device);
        if (phone) row.phoneHash = digest(phone);
        if (memberId) row.memberHash = digest(memberId);
        if (previousMemberId) row.previousMemberHash = digest(previousMemberId);
        if (confirmations.has(confirmation)) {
          row.tokenId = confirmation.token;
          if (dated) row.requestKey = row.dedupKey = digest(confirmation.token);
        }
        const orderNo = orderNumber({orderNo:receivedOrderNumber(order)});
        if (orderNo) row.orderNo = orderNo;
        const persisted = persistedAuditFields(ledgerRecord);
        if (dated && persisted) Object.assign(row,persisted);
        mkdirSync(directory, {recursive:true,mode:0o700});
        appendFileSync(join(directory,file), JSON.stringify(row) + '\n', {mode:0o600});
      } catch { /* 审计介质故障不改变工具结果。 */ }
    };
  }
  return {access: writer('access.jsonl'), upstream: writer('upstream.jsonl'), write: writer('write.jsonl',true)};
}
