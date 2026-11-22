import { createHash } from 'node:crypto';

export const uuidPattern = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
export function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex');
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
