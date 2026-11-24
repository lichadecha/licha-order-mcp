import { resolve } from 'node:path';
import { uuidPattern } from './common.js';

const defaults = {
  MAX_ORDER_AMOUNT_FEN: 0,
  MAX_ORDERS_PER_CUSTOMER_PER_DAY: 0,
  MAX_ORDERS_PER_DAY: 0,
  CONFIRM_TOKEN_TTL_MS: 300000,
  BINDING_IDLE_TTL_MS: 2592000000,
  BINDING_MAX_AGE_MS: 2592000000,
  SMS_CODE_TTL_SEC: 300,
  SMS_COOLDOWN_SEC: 60,
  SMS_PER_PHONE_PER_HOUR: 5,
  SMS_PER_PHONE_PER_DAY: 10,
  SMS_GLOBAL_PER_DAY: 2000,
  SMS_BRAKE_WINDOW_SEC: 3600,
  SMS_BRAKE_MIN_SAMPLE: 20,
  SMS_BRAKE_MAX_UNFILLED_PERCENT: 50,
  SMS_MAX_WRONG: 5,
  SESSION_IDLE_TTL_MS: 1800000,
  ORDER_MATCH_WINDOW_MS: 600000,
  RECENT_ORDER_HINT_MS: 600000,
  UPSTREAM_MIN_INTERVAL_MS: 210,
  READ_TIMEOUT_MS: 8000,
  WRITE_TIMEOUT_MS: 15000,
  CACHE_STORES_MS: 86400000,
  CACHE_STORE_STATUS_MS: 600000,
  CACHE_CATEGORIES_MS: 300000,
  CACHE_SEARCH_MS: 120000,
  CACHE_ITEM_MS: 300000,
  RATE_CALLS_PER_DEVICE_PER_MIN: 60,
  RATE_BINDS_PER_DEVICE_PER_HOUR: 10,
  RATE_BINDS_GLOBAL_PER_MIN: 30,
  MAX_SESSIONS: 200
};

export function readConfig(env = process.env) {
  function invalid(name) { throw new Error('配置无效：' + name); }
  function integer(value, name, minimum = 1) {
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum) invalid(name);
    return Number(value);
  }
  function nonempty(name, fallback) {
    const value = env[name] ?? fallback;
    if (!value?.trim()) invalid(name);
    return value;
  }
  const config = {};
  for (const [key, initial] of Object.entries(defaults)) {
    const name = 'LICHA_' + key;
    config[name] = integer(env[name] ?? initial, name, initial === 0 ? 0 : 1);
  }
  if (config.LICHA_SMS_CODE_TTL_SEC < 30 || config.LICHA_SMS_CODE_TTL_SEC > 300) invalid('LICHA_SMS_CODE_TTL_SEC');
  if (config.LICHA_SMS_BRAKE_WINDOW_SEC <= config.LICHA_SMS_CODE_TTL_SEC) invalid('LICHA_SMS_BRAKE_WINDOW_SEC');
  if (config.LICHA_SMS_BRAKE_MAX_UNFILLED_PERCENT > 100) invalid('LICHA_SMS_BRAKE_MAX_UNFILLED_PERCENT');
  config.PORT = integer(env.PORT ?? 3000, 'PORT');
  if (config.PORT > 65535) invalid('PORT');
  config.HOST = nonempty('HOST', '127.0.0.1');
  config.QMAI_BASE_URL = nonempty('QMAI_BASE_URL', 'https://openapi.qmai.cn/');
  try {
    const url = new URL(config.QMAI_BASE_URL);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) invalid('QMAI_BASE_URL');
  } catch { invalid('QMAI_BASE_URL'); }
  for (const name of ['QMAI_OPEN_KEY', 'QMAI_OPEN_ID', 'QMAI_GRANT_CODE']) config[name] = env[name]?.trim() || '';
  config.LICHA_ENABLE_ORDERING = env.LICHA_ENABLE_ORDERING === '1';
  config.LICHA_ACCESS_KEYS = nonempty('LICHA_ACCESS_KEYS').split(',').map(s => s.trim()).filter(Boolean);
  if (!config.LICHA_ACCESS_KEYS.length) invalid('LICHA_ACCESS_KEYS');
  config.LICHA_BLOCKED_DEVICES = (env.LICHA_BLOCKED_DEVICES ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (env.LICHA_BLOCKED_DEVICES !== undefined && !config.LICHA_BLOCKED_DEVICES.length) invalid('LICHA_BLOCKED_DEVICES');
  if (config.LICHA_BLOCKED_DEVICES.some(id => !uuidPattern.test(id))) invalid('LICHA_BLOCKED_DEVICES');
  config.LICHA_DATA_DIR = (env.LICHA_DATA_DIR !== undefined || config.LICHA_ENABLE_ORDERING)
    ? resolve(nonempty('LICHA_DATA_DIR')) : null;
  if (env.LICHA_SMS_EVENT_NO !== undefined || config.LICHA_ENABLE_ORDERING) {
    config.LICHA_SMS_EVENT_NO = integer(env.LICHA_SMS_EVENT_NO, 'LICHA_SMS_EVENT_NO');
  }
  config.LICHA_LOG_DIR = resolve(nonempty('LICHA_LOG_DIR', './logs'));
  const delays = (env.LICHA_READ_BACKOFF_MS ?? '1000,2000').split(',');
  if (delays.length !== 2) invalid('LICHA_READ_BACKOFF_MS');
  config.LICHA_READ_BACKOFF_MS = delays.map(s => integer(s.trim(), 'LICHA_READ_BACKOFF_MS'));
  return config;
}
