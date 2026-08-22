// bind_member 工具的处理逻辑，独立成模块（不放在 index.ts 里）——理由同 placeOrderTool.ts
// 头部注释：index.ts 顶层有 main().catch(...)，import 它会触发真实的 stdio transport connect，
// 单元测试不能安全地直接 import 这个文件；处理逻辑拆到独立模块后，测试才能直接 import + mock fetch。
//
// 流程（顺序固定，不许变，理由见各步注释）：
//   1. 入参格式预检 → 不合格不发请求，错误信息绝不回显 code 原值（M1 真发第二轮的教训）。
//   2. callRead 4.2.2 查会员 ID。
//   3. 响应解析：customerId 为 0/空 = 这个号没注册过会员（2026-08-19 实测，见 isAbsentCustomerId）。
//   4. 按「当前会话有没有人、是不是同一个人」分三条路：
//        · 没人        → 正常绑定；
//        · 同一个人    → 幂等成功，一个字节的状态都不改（顾客可能正在确认一张待确认单，别毁掉它）；
//        · 换成另一个人 → 未决写请求闸门 → 作废旧顾客的待确认单 → 覆盖绑定 → 记 rebind 审计。
//   5. 出参只含 customerId 后四位。
//
// 2026-08-19 行为变更（老板拍板「换人就解绑，别让用户这么麻烦」）：
// 原先第 1 步是「已有绑定 → 直接拒绝，不发任何请求」（一会话一次绑定，连是不是同一人都不判，省一次调用）。
// 那条规矩配的是「要换人得重开会话」这句话术——而这句话在真实宿主里做不到（MCP server 进程常驻、
// 跨对话复用，开新对话不换会话键，§8-41）。结果它既挡不住真正的风险（手机号绑定本就无验证，
// 第一次就能绑任何人的号，风险已于 2026-08-18 盘清并接受：最多查他人订单状态、往他人账上塞
// 待付款单，无资金风险），又把正常换人的顾客卡死。
// 代价是每次重复绑定都要多花一次 4.2.2 只读调用——因为不调接口就不知道新号是不是同一个人。
// 基础类接口在免费额度内，这笔成本换掉一个卡死用户的规矩，值。

import { callRead } from "./client.js";
import { getAccessAuditLogger } from "./accessAudit.js";
import { beijingTimeString } from "./writeGuard.js";
import { DEFAULT_SESSION_KEY, getSessionStore, type BoundVia } from "./session.js";
import { getPendingOrderStore } from "./pendingOrders.js";
import { getWriteGuard } from "./writeGuard.js";

export type TextResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export function ok(data: unknown): TextResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function fail(e: unknown): TextResult {
  const message = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text", text: message }], isError: true };
}

// codeType → 企迈 4.2.2 customerCode.type 映射。
const CODE_TYPE_MAP: Record<BoundVia, number> = { phone: 1, card: 2, dynamic_code: 0 };

type ValidateResult = { ok: true; trimmed: string } | { ok: false; message: string };

/**
 * 入参格式预检：只检查形状（长度/是否全数字），绝不在错误信息里回显 code 原值。
 * "去空白" 指去除全部空白字符（含首尾与中间），不只是 trim——顾客口述或从小程序截屏的码
 * 常见夹带空格。
 */
function validateCodeFormat(code: string, codeType: BoundVia): ValidateResult {
  const trimmed = code.replace(/\s+/g, "");
  if (codeType === "phone") {
    const isAllDigits = /^\d+$/.test(trimmed);
    if (trimmed.length !== 11 || !isAllDigits) {
      return {
        ok: false,
        message: `code 格式不正确：codeType=phone 要求去除空白后为 11 位纯数字（收到长度：${trimmed.length}，是否全为数字：${isAllDigits ? "是" : "否"}）`,
      };
    }
    return { ok: true, trimmed };
  }
  // card / dynamic_code：长度 4-64 且非空
  if (trimmed.length < 4 || trimmed.length > 64) {
    return {
      ok: false,
      message: `code 格式不正确：codeType=${codeType} 要求去除空白后长度在 4-64 之间（收到长度：${trimmed.length}）`,
    };
  }
  return { ok: true, trimmed };
}

/**
 * 「这个值等于查无此人」的判据（2026-08-19 实测得出，别按直觉简化）。
 *
 * 企迈对**没注册过的手机号**不报错——它返回一个彻头彻尾的成功响应：
 *   `{"code":0,"status":true,"message":"请求成功","data":{"customerId":0,"blttUserId":null}}`
 * 三个不同的未注册号实测返回同一个 `customerId: 0`，同号重复查也稳定为 0。
 *
 * 这个 `0` 是个陷阱：`String(0)` 是 `"0"`，**非空字符串在 JS 里是真值**，
 * 于是「!customerId 就拒绝」那种写法会把它当成绑定成功——顾客会听到「已绑定尾号 ***0」，
 * 然后单子挂到一个不存在的会员上，他在自己小程序里**永远看不到这张单**。
 * （唯一的万幸是先付后做：未付款的单不进 POS，门店不会白做一杯。）
 *
 * 判据覆盖三种形态，因为大数 ID 在链路上可能以数字或字符串出现：数字 0、字符串 "0"、空串。
 */
function isAbsentCustomerId(v: unknown): boolean {
  if (v == null) return true;
  const s = String(v).trim();
  return s === "" || s === "0";
}

/**
 * 从 4.2.2 响应体里取出 customerId：正常形态是 data 为对象、取 data.customerId；
 * 兜底 data 本身直接是 string/number 的情形。protectIds 已把响应文本里的大数 ID 字符串化，
 * 这里仍统一 String() 化，不假设它一定已经是字符串。
 *
 * 返回 undefined 表示「这个标识查不到会员」——`customerId: 0` 归入此类（见 isAbsentCustomerId）。
 */
function extractCustomerId(data: unknown): string | undefined {
  if (data == null) return undefined;
  if (typeof data === "string" || typeof data === "number") {
    return isAbsentCustomerId(data) ? undefined : String(data);
  }
  if (typeof data === "object") {
    const v = (data as Record<string, unknown>).customerId;
    if (isAbsentCustomerId(v)) return undefined;
    if (typeof v === "string" || typeof v === "number") return String(v);
  }
  return undefined;
}

export interface BindMemberInput {
  code: string;
  codeType: BoundVia;
}

export async function bindMemberHandler({ code, codeType }: BindMemberInput): Promise<TextResult> {
  const sessionStore = getSessionStore();
  const audit = getAccessAuditLogger();

  try {
    // ① 入参格式预检 → 不合格不发请求。
    const validated = validateCodeFormat(code, codeType);
    if (!validated.ok) {
      audit.record({
        event: "bind_rejected",
        result: "rejected",
        reason: "InvalidCodeFormat",
        sessionKey: DEFAULT_SESSION_KEY,
        tool: "bind_member",
      });
      return fail(new Error(validated.message));
    }
    const trimmedCode = validated.trimmed;
    const codeLast4 = `***${trimmedCode.slice(-4)}`;

    // ② callRead 4.2.2 会员标识查会员ID。
    const resp = await callRead<unknown>("v3/crm/customer/getCustomerIdByCode", {
      customerCode: { code: trimmedCode, type: CODE_TYPE_MAP[codeType] },
    });

    // ③ 响应解析：拿不到 customerId 或 ok=false → 兜底分支，稳定不崩溃。
    const customerId = resp.ok ? extractCustomerId(resp.data) : undefined;
    if (!resp.ok || !customerId) {
      audit.record({
        event: "bind_rejected",
        result: "rejected",
        // 不再把企迈的 message 原文拼进审计（§ 8 第 25 条）：那段文本是**外部输入**，
        // 内容不受我们控制——4.2.2 的异常示例在文档里是空的，实测已知它会把手机号嵌在句子里
        // （M3 的 B7 缺陷），完全可能哪天也把会员 ID、动态码原样带出来。出口脱敏虽然能兜住
        // 已知形态，但「不把不受控的外部文本落盘」比「落盘后再洗」少一整类风险。
        // 排查所需的信息量并没有损失：错误枚举 + 原文长度 + 企迈 code 足以区分是哪一类失败。
        // reason 分两类：NotAMember（接口成功但 customerId=0，人没注册）与 LookupFailed（接口本身失败）。
        // 事后翻日志时这两类的处置完全不同——前者是产品问题（注册引导做得好不好），后者是故障。
        reason: `${resp.ok ? "NotAMember" : "LookupFailed"}:len=${resp.message?.length ?? 0}:code=${resp.code ?? "none"}`,
        codeLast4,
        sessionKey: DEFAULT_SESSION_KEY,
        tool: "bind_member",
      });
      // 话术分两种，因为顾客要做的事完全不同（2026-08-19 实测后拆开）：
      //   · 接口成功但查不到（customerId=0）= **这个号还不是李茶会员** → 让他去注册，别让他重试
      //     （原来那句「请确认后重试」会让顾客以为自己号报错了，反复重报同一个号，反复失败）；
      //   · 接口本身失败 = 我们这边的问题 → 让他稍后再试，不要暗示他没注册。
      const notAMember = resp.ok;
      return fail(
        new Error(
          notAMember
            ? "这个号还不是李茶的茶会员，所以没法帮你下单。" +
              "去微信搜「李茶的茶」小程序注册一下（用同一个手机号，很快），注册好回来跟我说一声，我再帮你绑。"
            : "绑定暂时没成功（查询会员信息时出了点问题，不是你的号有问题）。稍等一下再试一次。",
        ),
      );
    }

    // ④ 三条路：没人 / 同一个人 / 换成另一个人。
    const customerIdLast4 = `***${customerId.slice(-4)}`;
    const existing = sessionStore.getBinding(DEFAULT_SESSION_KEY);

    // ④-a 同一个人又报了一次（顾客重复报号、模型多调一次）→ 幂等成功，**状态一个字节都不改**。
    // 为什么不走换绑分支：换绑要作废待确认单，而这里根本没换人——顾客可能正对着一张
    // 待确认单说「就是我，138…」，把他的单作废掉才是真的添麻烦。
    if (existing && existing.customerId === customerId) {
      audit.record({
        event: "bind_success",
        result: "allowed",
        reason: "AlreadyBoundSamePerson",
        codeLast4,
        customerIdLast4,
        sessionKey: DEFAULT_SESSION_KEY,
        tool: "bind_member",
      });
      return ok({
        bound: true,
        customerIdLast4,
        boundVia: existing.boundVia,
        boundAt: beijingTimeString(existing.boundAt),
        note: "本会话原本绑的就是这一位会员，无需重新绑定。",
      });
    }

    // ④-b 换成另一个人之前，先过未决写请求闸门。
    // 为什么必须拦：如果上一单「发出去了但结果未知」（网络异常/5xx/进程被杀在半途），
    // 解开它的唯一办法是用**当时那个人的身份**去 my_orders / get_order_status 读回销账。
    // 一换绑，那条核对通路就断了——未决状态会一直悬着，而 place_order 的第 ⑥ 步闸门是全局的，
    // 新顾客同样下不了单。也就是说放行换绑并不能让新顾客用上，只是把问题埋起来。
    if (existing) {
      const guard = getWriteGuard();
      if (guard.hasUnresolvedWrite()) {
        const info = guard.describeUnresolvedWrites();
        audit.record({
          event: "bind_rejected",
          result: "rejected",
          reason: `RebindBlockedByUnresolvedWrite:unknown=${info.unknown}:inflight=${info.inflight}`,
          codeLast4,
          customerIdLast4: `***${existing.customerId.slice(-4)}`,
          sessionKey: DEFAULT_SESSION_KEY,
          tool: "bind_member",
        });
        return fail(
          new Error(
            `暂时不能换人：上一次下单请求的结果还没核对清楚（${info.total} 笔状态未知` +
              `${info.earliestTime ? `，最早一笔发生在 ${info.earliestTime}` : ""}）。\n` +
              `先用「我那单怎么样了」或「看看我最近的订单」把那一单核对掉，再换人——` +
              `否则那笔单到底成没成就没人能确认了。`,
          ),
        );
      }
    }

    // ④-c 落绑定。手机号只在 codeType==="phone" 时才有（另两种形态拿到的是卡号/动态码，不是电话）。
    // 用条件展开而不是 `phone: codeType === "phone" ? trimmedCode : undefined`——后者会在对象里
    // 留下一个值为 undefined 的 phone 键，JSON.stringify 虽然会丢掉它，但 `"phone" in binding`
    // 之类的判断会被它骗过去。没有就是没有这个键。
    const boundAt = Date.now();
    const nextBinding = {
      customerId,
      boundAt,
      boundVia: codeType,
      ...(codeType === "phone" ? { phone: trimmedCode } : {}),
    };

    if (!existing) {
      sessionStore.bind(DEFAULT_SESSION_KEY, nextBinding);
      audit.record({
        event: "bind_success",
        result: "allowed",
        codeLast4,
        customerIdLast4,
        sessionKey: DEFAULT_SESSION_KEY,
        tool: "bind_member",
      });
      return ok({ bound: true, customerIdLast4, boundVia: codeType, boundAt: beijingTimeString(boundAt) });
    }

    // 换人：先作废旧顾客的待确认单（见 PendingOrderStore.discardByUserId 注释），再覆盖绑定。
    // 顺序很重要——先覆盖再作废的话，就得记着旧 userId 是谁，多一个出错的机会。
    const discarded = getPendingOrderStore().discardByUserId(existing.customerId);
    const previousLast4 = `***${existing.customerId.slice(-4)}`;
    sessionStore.rebind(DEFAULT_SESSION_KEY, nextBinding);
    audit.record({
      event: "rebind_success",
      result: "allowed",
      reason: `PreviousCustomer:${previousLast4}:DiscardedPendingOrders:${discarded}`,
      codeLast4,
      customerIdLast4,
      sessionKey: DEFAULT_SESSION_KEY,
      tool: "bind_member",
    });
    return ok({
      bound: true,
      customerIdLast4,
      boundVia: codeType,
      boundAt: beijingTimeString(boundAt),
      rebound: true,
      previousCustomerIdLast4: previousLast4,
      discardedPendingOrders: discarded,
      note:
        `已从${previousLast4}换成${customerIdLast4}。` +
        (discarded > 0 ? `原来那位顾客还没确认的 ${discarded} 张单已作废，需要重新组单。` : ""),
    });
  } catch (e) {
    return fail(e);
  }
}
