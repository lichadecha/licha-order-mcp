import { randomBytes, randomUUID } from 'node:crypto';
import { beijingTime, decimalId, digest, integerDigits, tail } from './common.js';
import { pendingCount } from './commerce-view.js';
import { PATHS, MISSING_CREDENTIALS } from './qmai.js';

const bindFailed = '绑定暂时没成功（查询会员信息时出了点问题，不是你的号有问题）。稍等一下再试一次。';
const notMember = '这个号还不是李茶的茶会员，所以没法帮你下单。去微信搜「李茶的茶」小程序注册一下（用同一个手机号，很快），注册好回来跟我说一声，我再帮你绑。';

export const memberView = b => ({ last4: b.identifierTail, via: b.via });
const bindingView = b => ({ bound: true, customerIdLast4: b.customerIdTail, member: memberView(b),
  boundVia: b.via, boundAt: beijingTime(b.created) });

// 映射随这一次会员绑定释放。同设备的新会话和同会员的幂等绑定共用它。
function createCouponRefs() {
  const refById = new Map();
  const couponByRef = new Map();
  return {
    issue(id, title) {
      if (refById.has(id)) return refById.get(id);
      const ref = randomBytes(24).toString('base64url');
      refById.set(id, ref);
      couponByRef.set(ref, { id, title });
      return ref;
    },
    get(ref) { return couponByRef.get(ref); }
  };
}

const sameMember = binding => ({ ...bindingView(binding), note: '本设备原本绑的就是这一位会员，无需重新绑定。' });
const noChallenge = '还没给这个手机号发过验证码，或者之前那条已经作废。请先只带手机号调用一次 bind_member，让系统发验证码。';

export function createBindingFlow({config, qmai, book, logs, unresolved, discardDrafts, expireDrafts}) {
  const devices = new Map();
  const challenges = new Map();
  const queuedChecks = new Map();
  const bindTimes = new Map();
  let globalBindTimes = [];
  const ttlSeconds = config.LICHA_SMS_CODE_TTL_SEC;
  const minutes = ttlSeconds / 60;

  // 只要设备还有已到达的校验，清理器就保留其待验证内容，供设备队列按序处理。
  function holdVerification(device) {
    queuedChecks.set(device, (queuedChecks.get(device) ?? 0) + 1);
    return () => {
      const remaining = queuedChecks.get(device) - 1;
      if (remaining) queuedChecks.set(device, remaining);
      else queuedChecks.delete(device);
    };
  }

  function removeVerified(device, state, binding) {
    state.verified.delete(binding.phone);
    if (state.current === binding) {
      state.current = undefined;
      expireDrafts(device, binding.hash);
    }
    if (!state.verified.size) devices.delete(device);
  }

  function expired(binding, now) {
    return now - binding.created >= config.LICHA_BINDING_MAX_AGE_MS ||
      (!binding.busy && now - binding.touched > config.LICHA_BINDING_IDLE_TTL_MS);
  }

  function current(device) {
    const state = devices.get(device);
    const binding = state?.current;
    if (!binding || !expired(binding, Date.now())) return binding;
    removeVerified(device, state, binding);
  }

  function sweep(now) {
    for (const [device, state] of devices) {
      for (const binding of state.verified.values()) {
        if (expired(binding, now)) removeVerified(device, state, binding);
      }
    }
    for (const [device, times] of bindTimes) if (times.at(-1) <= now - 3600000) bindTimes.delete(device);
    for (const [device, challenge] of challenges) {
      if (now < challenge.expires || queuedChecks.has(device)) continue;
      // 留下摘要供同设备再次报码时解释过期原因。闲置会话回收周期后释放。
      if (now - challenge.expires >= config.LICHA_SESSION_IDLE_TTL_MS) challenges.delete(device);
      else if (challenge.phone) challenges.set(device, {expires:challenge.expires, phoneHash:challenge.phoneHash});
    }
  }

  function reject(source, reason, message) {
    logs.access({event:'bind_rejected', reason}, source);
    throw Error(message);
  }

  function guardRebind(source, previous) {
    const pending = previous ? unresolved(previous.hash) : [];
    if (pending.length) reject(source, 'unresolved', `暂时不能换人：上一次下单请求的结果还没核对清楚（${pendingCount(pending)}）。\n先用「看看我最近的订单」把那一单核对掉，再换人——否则那笔单到底成没成就没人能确认了。`);
  }

  function rejectSmsAttempt(source, error) {
    logs.access({event:'sms_send', outcome:error.kind === 'sms_limit' ? 'rate_limited' : 'ledger_fault',
      tier:error.tier, tiers:error.tiers}, source);
    if (error.firstGlobalRejection) logs.access({event:'sms_global_day_exhausted'}, source);
    if (error.firstBrakeRejection) {
      logs.access({event:'sms_brake_engaged', expiredCount:error.expiredCount, unfilledCount:error.unfilledCount}, source);
    }
    reject(source, error.kind, error.message);
  }

  async function findMember(source) {
    if (!config.QMAI_OPEN_ID || !config.QMAI_OPEN_KEY || !config.QMAI_GRANT_CODE) {
      reject(source, 'credentials', MISSING_CREDENTIALS);
    }
    const now = Date.now();
    const local = (bindTimes.get(source.device) || []).filter(time => time > now - 3600000);
    globalBindTimes = globalBindTimes.filter(time => time > now - 60000);
    if (local.length >= config.LICHA_RATE_BINDS_PER_DEVICE_PER_HOUR || globalBindTimes.length >= config.LICHA_RATE_BINDS_GLOBAL_PER_MIN) {
      reject(source, 'rate_limit', '绑定尝试太频繁，请稍后再试。');
    }
    try {
      book.checkSmsAllowed(source.phone, config, now);
    } catch (error) {
      rejectSmsAttempt(source, error);
    }
    local.push(now);
    bindTimes.set(source.device, local);
    globalBindTimes.push(now);
    let member;
    try {
      member = await readMember(source.phone);
    } catch (error) {
      reject(source, error.kind, error.kind === 'credentials' ? error.message : bindFailed);
    }
    if (!member) reject(source, 'not_member', notMember);
    return member;
  }

  async function readMember(phone, options) {
    const data = await qmai.read(PATHS.member, { customerCode:{code:phone, type:1} }, options);
    const wrapped = data !== null && typeof data === 'object' && Object.hasOwn(data, 'customerId');
    const value = wrapped ? data.customerId : data;
    const digits = integerDigits(value);
    if ((wrapped && value === null) || digits === '0' || (typeof value === 'string' && /^0*$/.test(value.trim()))) {
      return null;
    }
    const id = decimalId(digits);
    if (!id) throw Object.assign(Error(bindFailed), {kind:'invalid_response'});
    const displayId = typeof value === 'string' && /^\d+$/.test(value) ? value : id;
    return {id, customerIdTail:tail(displayId)};
  }

  async function recheckMember(device, binding, couponIds) {
    const source = {device, memberId:binding.id};
    let member;
    try {
      member = await readMember(binding.phone, {retry:false, couponIds});
    } catch {
      logs.access({event:'order_member_recheck', outcome:'failed'}, source);
      return 'failed';
    }
    const outcome = member?.id === binding.id ? 'matched' : 'changed';
    if (outcome === 'changed') {
      for (const [otherDevice, state] of devices) {
        const verified = state.verified.get(binding.phone);
        if (verified) removeVerified(otherDevice, state, verified);
      }
    }
    logs.access({event:'order_member_recheck', outcome}, source);
    return outcome;
  }

  function rejectExpired(source) {
    challenges.delete(source.device);
    logs.access({event:'sms_check', outcome:'invalidated', reason:'expired'}, source);
    reject(source, 'expired', `验证码已过期（有效期 ${minutes} 分钟）。请先只带手机号调用一次 bind_member，重新发一条。`);
  }

  async function send(source, previous) {
    const {phone, device} = source;
    const verified = devices.get(device)?.verified.get(phone);
    if (verified) return activate(source, previous, verified, true);
    guardRebind(source, previous);
    const member = await findMember(source);
    const bizId = randomUUID();
    let sentAt;
    let verificationSent = true;
    try {
      await qmai.sms(PATHS.smsSend, {phone, bizId}, {beforeSend(attempt) {
        const now = Date.now();
        const receipt = book.recordSmsSending(phone, attempt, config, now);
        sentAt = now;
        return receipt;
      }});
    } catch (error) {
      if (error.kind === 'sms_limit' || error.kind === 'sms_ledger') {
        rejectSmsAttempt(source, error);
      }
      if (sentAt === undefined || error.kind === 'business') {
        logs.access({event:'sms_send', outcome:error.kind === 'business' ? 'rejected' : 'not_sent'}, source);
        const reason = error.kind === 'business' ? error.message : '短信服务暂时不可用';
        reject(source, 'sms_not_sent', `验证码没发出去（${reason}）。请稍后再试，或直接在小程序里下单。`);
      }
      verificationSent = 'unknown';
    }
    const old = challenges.get(device);
    if (old?.phone && old.expires > Date.now()) {
      logs.access({event:'sms_check', outcome:'invalidated', reason:'replaced'}, {device, phoneHash:old.phoneHash});
    }
    logs.access({event:'sms_send', outcome:verificationSent === true ? 'sent' : 'unknown'}, source);
    const expires = sentAt + ttlSeconds * 1000;
    if (Date.now() >= expires) rejectExpired(source);
    challenges.set(device, {...member, phone, phoneHash:source.phoneHash, bizId, sentAt, expires, wrong:0});
    const last4 = phone.slice(-4);
    const cooldown = config.LICHA_SMS_COOLDOWN_SEC;
    const wait = cooldown % 60 === 0 ? `${cooldown / 60} 分钟` : `${cooldown} 秒`;
    const note = verificationSent === true
      ? `验证码已发到尾号 ${last4} 的手机，${minutes} 分钟内有效。请顾客把短信里的数字告诉你，再调用一次 bind_member，带上同一个手机号和 captcha。`
      : `验证码可能已经发出（短信服务没有回话）。请顾客看一下尾号 ${last4} 的手机：收到了就照常报验证码；过 ${wait} 还没收到，再只带手机号调用一次重新发。`;
    return {bound:false, verificationSent, phoneLast4:tail(phone), expiresInMinutes:minutes, note};
  }

  function activate(source, previous, binding, exempt) {
    const {device} = source;
    const same = previous?.id === binding.id;
    if (!same) guardRebind(source, previous);
    if (same) {
      if (exempt) logs.access({event:'bind', reason:'sms_exempt'}, source);
      else logs.access({event:'bind', reason:'same_member'}, {device, memberId:binding.id});
      return sameMember(previous);
    }
    const discarded = previous ? discardDrafts(device, previous.hash) : 0;
    if (previous) delete previous.couponRefs;
    binding.couponRefs = createCouponRefs();
    devices.get(device).current = binding;
    const event = previous ? 'rebind' : 'bind';
    if (exempt) logs.access({event, discarded, reason:'verified_switch'}, source);
    else logs.access({event, discarded}, {device, memberId:binding.id, previousMemberId:previous?.id});
    if (!previous) return bindingView(binding);
    return { ...bindingView(binding), rebound:true, previousCustomerIdLast4:previous.customerIdTail,
      previousMember:memberView(previous), discardedPendingOrders:discarded,
      note:`已从${previous.identifierTail}换成${binding.identifierTail}` +
        (exempt ? '（这台设备之前验证过这个号，这次不用收验证码）。' : '。') +
        (discarded ? `原来那位顾客还没确认的 ${discarded} 张单已作废，需要重新组单。` : '') };
  }

  function finish(source, {id, customerIdTail}, verifiedAt) {
    const {device, phone} = source;
    const previous = current(device);
    const binding = {id, hash:digest(id), customerIdTail, identifierTail:tail(phone),
      phone, via:'phone', touched:verifiedAt, created:verifiedAt};
    const state = devices.get(device) ?? {verified:new Map(), current:undefined};
    devices.set(device, state);
    // 短信通过即记住号码；能否换人还要按原会员此刻的未决状态判断。
    state.verified.set(phone, binding);
    return activate(source, previous, binding, false);
  }

  async function verify(source, rawCaptcha, arrivedAt) {
    const {device, phone} = source;
    const challenge = challenges.get(device);
    if (!challenge || challenge.phoneHash !== source.phoneHash) {
      reject(source, 'no_challenge', noChallenge);
    }
    if (!challenge.phone || arrivedAt >= challenge.expires) rejectExpired(source);
    const captcha = rawCaptcha.replace(/\s+/gu, '');
    if (!/^\d{4,8}$/.test(captcha)) {
      reject(source, 'captcha_format', '验证码格式不对：请照短信里的数字原样报（4 到 8 位数字）。');
    }
    let result;
    try {
      result = await qmai.sms(PATHS.smsCheck, {phone, bizId:challenge.bizId, captcha});
    } catch {
      logs.access({event:'sms_check', outcome:'request_failed'}, source);
      reject(source, 'check_failed', '验证码暂时没校验成功（是我们这边的问题），这条验证码仍然有效，请稍等几秒再试一次。');
    }
    if (result === true) {
      const verifiedAt = Date.now();
      challenges.delete(device);
      logs.access({event:'sms_check', outcome:'passed'}, source);
      try {
        book.markSmsFilled(phone, challenge.sentAt);
      } catch {
        reject(source, 'ledger_fault', '验证码已校验通过，但安全账本写入失败，本次未完成绑定。请直接在小程序里下单。');
      }
      return finish(source, challenge, verifiedAt);
    }
    const remaining = config.LICHA_SMS_MAX_WRONG - ++challenge.wrong;
    const outcome = result === false ? 'wrong' : 'unrecognized';
    logs.access({event:'sms_check', outcome}, source);
    if (remaining > 0) {
      const message = outcome === 'wrong' ? `验证码不对，还可以再试 ${remaining} 次。请顾客核对短信里的数字再报一次。`
        : `这次没能确认验证码（门店系统的回复认不出来），按报错算了一次，还可以再试 ${remaining} 次。`;
      reject(source, outcome, message);
    }
    challenges.delete(device);
    logs.access({event:'sms_check', outcome:'invalidated', reason:'max_wrong'}, source);
    reject(source, 'max_wrong', '验证码报错次数太多，这条已作废。请先只带手机号调用一次 bind_member，重新发一条。');
  }

  function bind({code, codeType, captcha}, device, arrivedAt = Date.now()) {
    if (codeType !== 'phone') reject({device}, 'unsupported_type', '目前只支持用注册会员的手机号绑定（会给这个号发一条短信验证码）。请顾客报手机号。');
    const phone = code.replace(/\s+/gu, '');
    if (!/^\d{11}$/.test(phone)) {
      reject({device}, 'format', `code 格式不正确：codeType=phone 要求去除空白后为 11 位纯数字（收到长度：${[...phone].length}，是否全为数字：${/^\d+$/.test(phone) ? '是' : '否'}）`);
    }
    const source = {device, phone, phoneHash:book.phoneHash(phone)};
    return captcha === undefined ? send(source, current(device)) : verify(source, captcha, arrivedAt);
  }
  return {bind, current, sweep, holdVerification, recheckMember};
}
