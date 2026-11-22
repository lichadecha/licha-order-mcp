import { createHash } from 'node:crypto';

export const uuidPattern = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
export function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function decimalId(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  if (typeof value !== 'string' || !/^0*[1-9]\d*$/.test(value)) return null;
  return value.replace(/^0+/, '');
}

// R25：只在十进制原文上移动小数点；任何会落在整数位右边的非零数字都不能舍入。
export function integerDigits(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  if (typeof value !== 'string') return null;
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match) return null;
  const [, sign, whole, fraction = '', exponent = '0'] = match;
  const digits = (whole + fraction).replace(/^0+/, '');
  if (!digits) return '0';
  // 浮点范围只用于排除溢出，也避免对极端指数分配巨大的字符串。
  if (sign || !Number.isFinite(Number(value))) return null;
  const point = digits.length - fraction.length + Number(exponent);
  if (point <= 0 || /[1-9]/.test(digits.slice(point))) return null;
  return digits.slice(0, point).padEnd(point, '0');
}

export function responseId(value) {
  const digits = integerDigits(value);
  return digits === '0' ? null : digits;
}

export function beijingTime(ms = Date.now()) {
  return new Date(ms + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ') + ' +08:00';
}

export function tail(value) {
  const chars = Array.from(String(value ?? ''));
  return '***' + (chars.length >= 8 ? chars.slice(-4).join('') : '');
}

export function yuan(fen) {
  return (fen / 100).toFixed(2);
}

export function maskNumbers(value) {
  return value.replace(/\d{15,}|(?:0086|\+?86)?1[3-9]\d{9}/g, tail);
}

export function projectText(value) {
  if (typeof value !== 'string') return '';
  const cleaned = value
    .replace(/(?:https?:\/\/|www\.)[^\s，。；、）)]+/gi, ' ')
    .replace(/[a-z\d_.-]*(?:key|secret|token)[a-z\d_.-]*\s*[=：:]\s*[^\s，。；、]+/gi, ' ')
    .replace(/\d{15,}|(?:0086|\+?86)?1[3-9]\d{9}/g, tail)
    .replace(/\s+/g, ' ').trim();
  const chars = Array.from(cleaned);
  return chars.length > 80 ? chars.slice(0, 80).join('') + '…' : cleaned;
}
