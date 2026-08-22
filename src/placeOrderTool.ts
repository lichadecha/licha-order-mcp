// place_order 工具的处理逻辑，独立成模块（不放在 index.ts 里）的原因：
// index.ts 顶层有 `main().catch(...)`，import 它会触发真实的 stdio transport connect
// （见 index.ts 底部）。把这里的逻辑单独拆出来，测试才能安全地直接 import + 调用，
// 不必 spawn 子进程去验证"塞 userId 会被拒绝且 fetch 未被调用"这类需要 mock fetch 的场景。
//
// 🚨 M2 阶段仅链路骨架，完整逻辑见 M4。这里只做「拦 userId 黑盒后门 → 校验令牌 → 过护栏 →
// 调 callWrite」几步，不实现 6.2.9 完整参数组装（storeId/items/practiceList/attachList 的拼装
// 是 prepare_order 的活，M4 才交付）、不做 6.1.9 强制读回与差额比对（同为 M4）。
//
// M2 阶段没有任何工具能签发合法确认令牌——prepare_order 本身是 M4 交付物——所以此刻对本工具的
// 任何合法调用都必然在 callWrite 的令牌校验一步被拒绝（TokenNotFound）。它存在的唯一目的，是让
// 「写能力开关关闭时 tools/list 无写工具 / 开启时有」这条验收现象（T1/T2）可验。
//
// 🚨 红线提醒（写在这里，不能只写在文档里）：任何真实调用都会在企迈侧创建真实订单、
// 可能进入门店 POS 排单。开发/测试环境必须 mock 拦截 fetch，禁止用真实调用来验证本工具或护栏逻辑。
//
// M3 追加：接入会话态身份绑定。流程升级为「拦 userId 黑盒后门 → 要求会话已绑定会员 →
// 把绑定的 customerId 注入 finalParams.userId → 校验令牌 → 过护栏 → 调 callWrite」。
// 调用方仍然不能自己传 userId（黑名单挡在最前面），真正生效的 userId 只能来自
// bind_member 写入的会话态——这是"userId 只能由会话态注入"这条架构硬规矩的物理实现。

import { callRead, callWrite } from "./client.js";
import { WRITE_WHITELIST } from "./constants.js";
import { getWriteGuard, untrustedAuditValue } from "./writeGuard.js";
import { getAccessAuditLogger } from "./accessAudit.js";
import { DEFAULT_SESSION_KEY, getSessionStore, type SessionBinding } from "./session.js";
// M4 定稿新增（M2/M3 骨架不依赖这两个模块）：待确认单登记表 + 与 get_order_status 共用的所有权判据。
import { getPendingOrderStore } from "./pendingOrders.js";
import { assertOrderOwnership } from "./orderStatusTool.js";

export type TextResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export function ok(data: unknown): TextResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function fail(e: unknown): TextResult {
  const message = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * 递归检查 value 里任意嵌套层级是否出现名为 "userId" 的字段，命中则返回可读的路径（如
 * "items[0].userId"），否则返回 null。
 *
 * 背景（总工验收裁决 M2 追加修复）：M2 阶段 place_order 的 orderParams 是一个透传黑盒
 * （z.record(z.string(), z.unknown())），因为 M4 才会做 6.2.9 的正式参数组装。但"userId 不做
 * 工具参数、只能由会话态注入"是 M3 定死的架构硬规矩（施工令 § 3.3）——黑盒透传如果不加防御，
 * 精神上等于开了个后门：调用方可以把 userId 悄悄塞进 orderParams 的任意字段或任意嵌套层级里，
 * M2 阶段没有会话态可以拦这件事，所以在工具入口就用黑名单直接挡。
 */
export function findUserIdField(value: unknown, path = ""): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findUserIdField(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const currentPath = path ? `${path}.${k}` : k;
      if (k === "userId") return currentPath;
      const hit = findUserIdField(v, currentPath);
      if (hit) return hit;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 旧 place_order handler（M2/M3 骨架，入参 orderParams 完整透传）已于 2026-08-19 删除。
//
// 它在 M4 定稿后本就不再被注册（模型看不见、生产不可达），只为承载三条 M3 验收用例而留
// 在仓库里，登记为 §8-22 的 M6 收官清理项。M6 通过后按 17 号执行包 T5-1 执行清理：
// 那三条（B5a/B5b/B6）已按语义等价映射改写为调用定稿 handler，其余引用它的用例
// （placeOrderSession U1/U11、placeOrderUserIdGuard 三条集成、handlerInputSanitizer T1/T2）
// 同样迁移完毕，findUserIdField 的四条纯单测原样保留（定稿第 ① 步仍在用这个函数）。
//
// 迁移时踩到的一处连带、值得留给后来人：**定稿 handler 比旧 handler 多一条 callRead 路径**
// （第 ⑧ 步强制 6.1.9 读回）。旧 handler 不读回，所以那些测试原先无需注入只读审计路径；
// 一改成定稿 handler，那条路径就活了——两个文件因此往生产 logs/audit.log 追加了记录，
// 被 m4ConfirmOrder 的红线自证当场抓住。迁移从来不只是换个函数名，要跟着看新链路多做了什么。
// ---------------------------------------------------------------------------

// ============================================================================
// M4 定稿：两阶段确认下单 + 强制读回
// ============================================================================
//
// 与上面那个 M2/M3 骨架 handler 的关系（施工取舍，总工请裁决）：
// M4 任务书要求把 place_order 的入参收窄成「confirmToken + confirmAmountYuan」两个字段、
// 删除 orderParams 黑盒；但 test/m3AcceptanceGauntlet.test.ts（总工 M3 独立验收用例，一行
// 不许动）里的 B5a/B5b/B6 三条用例直接 import 并调用旧签名的 placeOrderHandler。两条硬约束
// 无法同时满足，处置是：**旧 handler 函数体一行不改地保留下来，只作为 M3 验收用例的运行载体；
// index.ts 注册的 place_order 换成下面这个定稿 handler**。
// 安全性评估：旧 handler 不再被注册，模型在 MCP 协议层根本看不到它，唯一能调用它的是本进程内
// 直接 import 它的测试代码；且它调用的 callWrite 护栏（令牌四校验/金额/频次/幂等）一条没绕过——
// M4 之后令牌由 prepare_order 签发并绑定一份登记在案的 finalParams，拿它去配任何自带的
// orderParams 都会指纹不符。也就是说这条历史路径在生产上既不可达、也不可能成功下单。
//
// 定稿流程（顺序固定）：
//   ① findUserIdField 扫描整个入参对象（入参已无对象字段，这是对将来误扩的防御，成本为零）
//   ② 要求会话已绑定
//   ③ 凭令牌从待确认单登记表取回 finalParams 与预估金额（取不到 = 令牌不存在/已过期）
//   ④ 复述金额比对（防"念给顾客的是 A 金额、实际下的是 B 金额"）
//   ⑤ 登记单的 userId 必须等于当前会话绑定值（跨会话串用防护）
//   ⑥ 未决写请求闸门——存在「结果未知」的旧请求时拒绝下单，先去读回核对（M5 前置修复第 1 项）
//   ⑦ callWrite——四项令牌校验、幂等、金额频次护栏原样生效，不绕过、不重复实现
//   ⑧ 成功后立刻强制 6.1.9 读回（施工令 § 8 第 16 条：查已取消订单返回空 data，
//      读回必须在订单活着时立刻做，事后补查拿不到）


/** 读回差额告警阈值（施工令 § 4.1）：|差额| > ¥1 或 > 5%，两者取严——任一触发即告警。 */
const READBACK_ABS_THRESHOLD_FEN = 100;
const READBACK_PCT_THRESHOLD = 0.05;

/** 复述金额允许的误差：1 分。存在容差是因为入参是浮点元，浮点转分可能差 1 分。 */
const CONFIRM_AMOUNT_TOLERANCE_FEN = 1;

function yuan(fen: number): string {
  return (fen / 100).toFixed(2);
}

export interface PlaceOrderConfirmedInput {
  confirmToken: string;
  confirmAmountYuan: number;
  /** index signature：入参 schema 只有上面两个字段，这里留口是为了 findUserIdField 能扫描
   * 整个入参对象——将来若有人给 schema 加了带嵌套的字段，userId 防御自动覆盖到它。 */
  [k: string]: unknown;
}

interface ReadbackResult {
  orderNo: string;
  readbackFailed?: true;
  readbackNote?: string;
  qmaiActualAmountYuan?: string;
  discountList?: unknown[];
  estimatedTotalYuan: string;
  diffYuan?: string;
  warning?: string;
}

/**
 * 6.1.9 强制读回：拿企迈自己算的实付金额与优惠明细回来，与本地预估比对。
 * 读回失败（网络异常/空 data/所有权不符）不算下单失败——orderNo 已经产生，订单是真实存在的，
 * 这里返回 readbackFailed 标记让上层如实告知顾客，绝不因为读回失败去重试下单。
 */
async function readbackOrder(
  orderNo: string,
  estimatedAmountFen: number,
  binding: SessionBinding,
): Promise<ReadbackResult> {
  const base: ReadbackResult = { orderNo, estimatedTotalYuan: yuan(estimatedAmountFen) };

  let resp;
  try {
    resp = await callRead<Record<string, unknown>>("v3/order/standard/cyOrderDetail", {
      orderNo,
      bizType: 5, // 固定 5=新饮食
      userId: binding.customerId,
    });
  } catch (e) {
    return { ...base, readbackFailed: true, readbackNote: `读回订单详情异常：${(e as Error).message}` };
  }

  if (!resp.ok || resp.data == null || typeof resp.data !== "object") {
    return {
      ...base,
      readbackFailed: true,
      readbackNote: `订单已创建成功，但读回企迈金额失败（${resp.error?.message ?? resp.message ?? "响应为空"}）。请用 get_order_status 或小程序核对金额后再引导付款。`,
    };
  }

  // 自己刚下的单读回来却不属于自己，属于异常——不吞掉、不静默通过，丢弃内容并如实标记。
  const ownership = assertOrderOwnership(resp.data, binding);
  if (!ownership.ok) {
    getAccessAuditLogger().record({
      event: "ownership_mismatch",
      result: "rejected",
      reason: `readback_${ownership.reason}`,
      // 来源判定（P-W2 第三轮微补丁）：这里的 orderNo **不是**调用方入参——它是我们自己
      // callWrite 下单成功后从企迈响应里取回的单号（服务端来源，调用方碰不到），
      // 不可能是伪装的识别值，所以留全值。而且这条审计的价值全在单号上：
      // "自己刚下的单读回来却不属于自己"是必须人工追到底的异常，遮成尾号就查不动了。
      // 与 get_order_status 那处（入参来源 → 遮尾号）刻意不同，差别就是来源，不是字段名。
      orderNo,
      customerIdLast4: `***${binding.customerId.slice(-4)}`,
      sessionKey: DEFAULT_SESSION_KEY,
      tool: "place_order",
    });
    return {
      ...base,
      readbackFailed: true,
      readbackNote: "订单已创建成功，但读回的订单详情归属校验不通过，内容已丢弃。请用小程序核对金额后再引导付款。",
    };
  }

  // ⚠️ 6.1.9 的 actualAmount 单位是「分」（施工令 § 8 第 15 条实测：同一笔单 6.1.9=2400 分、
  // 6.2.9 的 payAmount=24.0 元）。这里绝不能套用 6.2.9 响应的解析口径。
  const rawActual = (resp.data as Record<string, unknown>).actualAmount;
  // ⚠️ null 必须显式挡在 Number() 之前：Number(null) === 0 是 finite 的，会把"读不到金额"
  // 悄悄变成"企迈实付 ¥0.00"报给顾客。企迈确实会返回 null（§ 8 第 14 条：needPay 文档只
  // 定义 0/1，实测返回 null），所以这不是理论风险。undefined 走 Number() 得 NaN，本来就会被拦。
  const actualFen = typeof rawActual === "number" ? rawActual : rawActual == null ? NaN : Number(rawActual);
  if (!Number.isFinite(actualFen)) {
    return {
      ...base,
      readbackFailed: true,
      readbackNote: "订单已创建成功，但读回的详情里没有可用的实付金额字段。请用小程序核对金额后再引导付款。",
    };
  }

  const rawDiscounts = (resp.data as Record<string, unknown>).discountList;
  const diffFen = actualFen - estimatedAmountFen;
  const absDiff = Math.abs(diffFen);
  // 「取严」= 绝对值阈值与百分比阈值哪个更小就用哪个，任一被突破即告警。
  const threshold = Math.min(READBACK_ABS_THRESHOLD_FEN, Math.round(estimatedAmountFen * READBACK_PCT_THRESHOLD));

  return {
    ...base,
    qmaiActualAmountYuan: yuan(actualFen),
    discountList: Array.isArray(rawDiscounts) ? rawDiscounts : [],
    diffYuan: yuan(diffFen),
    ...(absDiff > threshold
      ? {
          warning: `金额与预估不一致：企迈实付 ¥${yuan(actualFen)}，本地预估 ¥${yuan(estimatedAmountFen)}，差额 ¥${yuan(diffFen)}。请先向顾客说清这个差额并核对，再引导付款。`,
        }
      : {}),
  };
}

export async function placeOrderConfirmedHandler(input: PlaceOrderConfirmedInput): Promise<TextResult> {
  const { confirmToken, confirmAmountYuan } = input;
  try {
    // ① userId 黑名单防御：扫整个入参对象。
    const userIdPath = findUserIdField(input);
    if (userIdPath) {
      getWriteGuard().recordAudit({
        path: WRITE_WHITELIST[0],
        result: "rejected",
        reason: `UserIdInInput:${userIdPath}`,
        // 来源判定（P-W2 第三轮微补丁）：这一步在 ③ 的 lookup 之前，令牌**还没经过任何
        // 本地验证**——它此刻纯粹是一串调用方入参，和 orderNo 一样长相说明不了性质
        // （19 位会员 ID 变形成 32 位 hex 就冒充得了令牌 ID），只留尾四位。
        // 工单只点了 ③ 那一处，这里是同一判据下的同类漏点：token 连 lookup 都没走过，
        // 来源比 lookup=absent 更不可信，没有理由反倒给它明文。
        tokenId: untrustedAuditValue(confirmToken),
        idempotencyKey: null,
        durationMs: 0,
      });
      return fail(
        new Error(
          `入参不能包含 userId 字段（命中路径：${userIdPath}）：userId 只能由会话态注入（M3 架构硬规矩），不接受调用方传入`,
        ),
      );
    }

    // ② 未绑定 → 拒，不发请求。
    const binding = getSessionStore().getBinding(DEFAULT_SESSION_KEY);
    if (!binding) {
      getAccessAuditLogger().record({
        event: "unbound_call_rejected",
        result: "rejected",
        reason: "SessionNotBound",
        sessionKey: DEFAULT_SESSION_KEY,
        tool: "place_order",
      });
      return fail(new Error("本会话尚未绑定会员身份，请先用 bind_member 绑定后再下单"));
    }

    // ③ 凭令牌取回待确认单。查无此单与已过期对顾客是同一句话（这张单不能下了，请重新组单），
    // 但写审计里分成两个理由记——两者性质不同：一个是"时间到了"，一个是"这个令牌根本不是我们发的"。
    // 请求在这一步之前不会发出。
    const lookup = getPendingOrderStore().lookup(confirmToken);
    if (lookup.status !== "ok") {
      getWriteGuard().recordAudit({
        path: WRITE_WHITELIST[0],
        result: "rejected",
        reason: lookup.status === "expired" ? "PendingOrderExpired" : "PendingOrderNotFound",
        // 来源判定（P-W2 第三轮微补丁）：lookup 的两种失败态来源完全不同，明文权跟着来源走——
        //   · expired：登记表**确实签发过**这张令牌（只是过了 5 分钟），值是本地 randomBytes
        //     生成的，不可能是伪装的识别值 → 留全值，排查"哪张令牌超时了"要用它；
        //   · absent：登记表从没见过它——要么根本不是我们签发的（编造/别的进程），要么已被
        //     prune 消亡。前一种情况下这串东西完全由调用方控制，格式校验挡不住合法形态伪装
        //     （32 位 hex 谁都拼得出来）→ 只留尾四位。
        // 代价：已 prune 的真令牌也会被当作 absent 遮成尾号。可接受——prune 只在 register 时
        // 触发且只清过期条目，被清掉的令牌本来就已经过期、已无排查价值，而"宁可多打星号"
        // 正是本轮翻转判据时定下的取舍方向。
        tokenId: lookup.status === "expired" ? confirmToken || null : untrustedAuditValue(confirmToken),
        idempotencyKey: null,
        durationMs: 0,
      });
      return fail(
        new Error(
          lookup.status === "expired"
            ? "确认令牌已过期（有效期 5 分钟）：请重新调用 prepare_order 组单，把新的待确认单念给顾客确认。"
            : "确认令牌无效（不存在或已被使用过）：请重新调用 prepare_order 组单，把新的待确认单念给顾客确认。",
        ),
      );
    }
    const pending = lookup.order;

    // ④ 复述金额比对：模型报给顾客的金额，必须与登记在案的预估金额一致。
    // 防的是"念给顾客听的是 A 金额、实际下的是 B 金额"——这是确认门要挡的核心场景之一，
    // 而令牌指纹只能保证参数没被改，保证不了模型有没有如实复述。
    const confirmFen = Math.round(confirmAmountYuan * 100);
    if (Math.abs(confirmFen - pending.estimatedAmountFen) > CONFIRM_AMOUNT_TOLERANCE_FEN) {
      getWriteGuard().recordAudit({
        path: WRITE_WHITELIST[0],
        result: "rejected",
        reason: `ConfirmAmountMismatch:${confirmFen}vs${pending.estimatedAmountFen}`,
        tokenId: confirmToken,
        idempotencyKey: null,
        durationMs: 0,
      });
      return fail(
        new Error(
          `复述金额与待确认单不一致：你报的是 ¥${yuan(confirmFen)}，待确认单是 ¥${yuan(pending.estimatedAmountFen)}。` +
            `请按待确认单的金额重新向顾客确认，不要凭记忆报数。`,
        ),
      );
    }

    // ⑤ 跨会话串用防护：登记单里的 userId 必须就是当前会话绑定的人。
    // 正常流程下这必然成立（prepare_order 注入的就是同一个会话的绑定值），不成立说明令牌来路有问题。
    if (String(pending.finalParams.userId ?? "") !== binding.customerId) {
      getWriteGuard().recordAudit({
        path: WRITE_WHITELIST[0],
        result: "rejected",
        reason: "PendingOrderOwnerMismatch",
        tokenId: confirmToken,
        idempotencyKey: null,
        durationMs: 0,
      });
      return fail(new Error("这张待确认单不属于当前绑定的会员，已拒绝。请重新用 prepare_order 组单。"));
    }

    // ⑥ 未决写请求闸门（施工令 § 3.1 第 5 条补充③）：上一次写请求到底成没成还没弄清楚
    // （网络异常 / 5xx / 进程被杀在半途），这时候放行新下单就是在赌——赌输的代价是顾客
    // 被扣两次钱，而企迈侧没有幂等字段可以兜底（§ 8 第 4 条）。
    // 解除方式不是「模型说核对完了」，而是真的去 my_orders / get_order_status 走一次读回：
    // 那两个工具拿到企迈真实数据之后会自动销账（见 WriteGuard.resolveUnresolvedWrites 注释）。
    const guard = getWriteGuard();
    if (guard.hasUnresolvedWrite()) {
      const pendingInfo = guard.describeUnresolvedWrites();
      guard.recordAudit({
        path: WRITE_WHITELIST[0],
        result: "rejected",
        reason: `UnresolvedWriteExists:unknown=${pendingInfo.unknown}:inflight=${pendingInfo.inflight}`,
        tokenId: confirmToken,
        idempotencyKey: null,
        durationMs: 0,
      });
      return fail(
        new Error(
          `上一次下单请求的结果还没有核对清楚（${pendingInfo.total} 笔状态未知` +
            `${pendingInfo.earliestTime ? `，最早一笔发生在 ${pendingInfo.earliestTime}` : ""}），暂不放行新的下单。\n` +
            `那次请求可能已经在企迈侧真的建了单——现在直接重下会变成两单、扣两次钱。\n` +
            `请先调用 my_orders（查最近订单）或 get_order_status（按订单号查）核对企迈侧到底有没有那一单：\n` +
            `　· 已经有那一单 → 不要再下，直接引导顾客去小程序付款；\n` +
            `　· 确实没有那一单 → 核对动作本身会解除这道闸门，再重新走一次 prepare_order 组单即可。`,
        ),
      );
    }

    // ⑦ 写出口。callWrite 内部的四项令牌校验 / 幂等 / 金额频次护栏原样生效。
    const result = await callWrite<Record<string, unknown>>(WRITE_WHITELIST[0], pending.finalParams, {
      amountFen: pending.estimatedAmountFen,
      confirmToken,
    });

    if (!result.ok) {
      return fail(new Error(`下单失败：${result.error?.message ?? result.message ?? "未知错误"}（${result.error?.hint ?? "请稍后再试"}）`));
    }

    const orderNo = typeof result.data?.orderNo === "string" ? result.data.orderNo : String(result.data?.orderNo ?? "");
    if (!orderNo) {
      // 企迈返回成功却没有订单号：不重试（重试可能造成重复下单，企迈侧无幂等字段兜底）。
      return ok({
        placed: true,
        readbackFailed: true,
        readbackNote: "下单接口返回成功但没有订单号，无法读回核对。请立刻用小程序「我的订单」确认，不要重复下单。",
        estimatedTotalYuan: yuan(pending.estimatedAmountFen),
      });
    }

    // ⑧ 强制读回（立刻，趁订单还活着）。读回失败不算下单失败。
    const readback = await readbackOrder(orderNo, pending.estimatedAmountFen, binding);

    // 6.2.9 响应的 payAmount 单位是「元」（实测 24.0），与 6.1.9 的 actualAmount（分）不同单位——
    // 原样带出、不做换算、不与分制字段混算，只作为第三方对照值给模型看。
    const payAmountYuanRaw = result.data?.payAmount;

    return ok({
      placed: true,
      ...readback,
      ...(payAmountYuanRaw != null ? { qmaiPayAmountYuanFromCreate: String(payAmountYuanRaw) } : {}),
      nextStep:
        "订单已创建但尚未支付。请把企迈实付金额与优惠明细念给顾客，" +
        (readback.warning ? "先说清金额差额并核对，再" : "") +
        "引导顾客去小程序「我的订单」完成付款——我们不代付、不碰任何支付凭据。",
    });
  } catch (e) {
    return fail(e);
  }
}
