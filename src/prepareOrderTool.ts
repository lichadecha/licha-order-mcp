// M4 prepare_order：两阶段提交的第一阶段（只读）。
//
// 做三件事，缺一不可：
//   ① 算价与校验——完全复用一期 previewOrder（本地分制累加、估清拦截、同组做法互斥、规格校验）。
//      本文件一分钱都不自己算：算价逻辑只允许有一份，这是一期「价格一致性」证据链的前提。
//   ② 组装 6.2.9 的最终下单参数 finalParams——全项目唯一一份组装逻辑，place_order 不再重复组装。
//   ③ 签发一次性确认令牌 + 把 finalParams 登记进待确认单表，返回给模型一张「待确认单」。
//
// 为什么组装逻辑必须放在这一步（施工令 § 3.2）：模型手里从此只有一个不透明的令牌 ID，
// 没有任何途径修改下单参数——「下的单 = 给顾客看过的那张单」由此从"事后校验"变成"没有入口"。
//
// 🚨 红线（本文件只读，但它决定了写请求长什么样）：
//   - userId 不接受入参、只从会话态取（施工令 § 3.3 架构硬规矩第 1 条）。
//   - orderType / source 用施工令 § 4.1 定死的常量，不接受入参（模型不该有渠道选择权）。
//   - 绝不携带 isPre / preTime / isWaiterCheck / orderSubType——这类字段会把订单变成
//     needPay=0 的无需支付预约单，直接进门店 POS 让门店白做一杯（M1 观察点 ⑥）。
//     组装完成后有一道静态自检兜底（assertNoPreOrderFields），不只靠"我没写这些字段"。
//
// 🚨 金额单位纪律（施工令 § 8 第 15 条实测坑）：本地算价与护栏全程用「分」（整数）；
//    展示给顾客的金额用「元」（两位小数）。6.2.9 响应的 payAmount 是元、6.1.9 的 actualAmount
//    是分——三处单位不同是实测坐实的，禁止复用同名字段的解析逻辑。

import { callRead } from "./client.js";
import { CHANNEL, ORDER_GUARD, STORES } from "./constants.js";
import { previewOrder, type OrderItemInput, type PreviewResult } from "./tools/previewOrder.js";
import { getWriteGuard } from "./writeGuard.js";
import { getAccessAuditLogger } from "./accessAudit.js";
import { getPendingOrderStore } from "./pendingOrders.js";
import { DEFAULT_SESSION_KEY, getSessionStore, type SessionBinding } from "./session.js";

export type TextResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export function ok(data: unknown): TextResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function fail(e: unknown): TextResult {
  const message = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text", text: message }], isError: true };
}

// ---------- 施工令 § 4.1 定死的渠道常量（不接受入参） ----------
/** 就餐模式：1 堂食。深圳湾实测只开堂食（用 2 报 71011 门店未开启该就餐模式）。 */
export const ORDER_TYPE_DINE_IN = 1;
/** 订单来源渠道码：18 其他三方渠道。选 18 而非 100，是为了后台能把 AI 单与小程序单分开统计。 */
export const ORDER_SOURCE_THIRD_PARTY = 18;
/**
 * Agent 单归因标识：2026-08-18 M6 渠道探针真发实测（二期侦察/m6_channel_probe.py，
 * 老板登商户后台肉眼核对）——6.2.9 请求体多传 channelCode/scene="AI_AGENT" 后，
 * 订单详情页「渠道参数」栏原样显示 AI_AGENT，「订单来源」仍正确显示三方渠道文案，
 * 两者互不冲突。Agent 单从此在后台可被单独归因，不再和小程序原生单混在一起。
 * channelCode 与 scene 同值双保险：doc168 定义两者都是自由文本选填字段，探针两个字段
 * 同值传入，无法从后台单一展示结果反推到底是哪个字段映射了「渠道参数」栏——多传一个
 * 自由文本字段不产生副作用，故两个都传，代价为零。与 userId 一样属常量注入，不接受入参。
 */
export const ORDER_CHANNEL_CODE = "AI_AGENT";
/**
 * 会员标记（doc168 `member`，boolean 选填）：本工具链下单必然挂着会话绑定的 userId——
 * 也就是说这单**本来就是会员单**，`member: true` 只是把这个事实如实告诉企迈，不是我们额外主张什么。
 *
 * 为什么敢常量注入（先验后用）：M6 第二枪探针（2026-08-18）已带此字段真发过一单，
 * 老板 2026-08-19 后台核对——支付总额 24 / 应付总额 24 / 优惠总额 0，与不带该字段的第一枪
 * 一模一样，**没有触发任何会员价或优惠逻辑**。它影响的是企迈内部怎么归类这单，不影响算钱。
 * 会员权益是否因此正常累积（积分等）仍是零付款口径下的盲区，挂在 §8-34 待机会性验证。
 */
export const ORDER_MEMBER_FLAG = true;

/** 预约单/无需支付类字段黑名单：出现任意一个都要中止（M1 观察点 ⑥ 的第一层护栏）。 */
const PREORDER_FORBIDDEN_KEYS = ["isPre", "preTime", "isWaiterCheck", "orderSubType"] as const;

// ---------- 6.2.9 items 子结构（doc id=168 权威定义） ----------
// practiceList → ConfirmItemPracticeDto: code / id / name / price / value / valueId
// attachList   → ConfirmItemAttachDto:   code / id / name / num / price
//
// 字段名依据（2026-08-17 双证据，此前按 3.1.12 响应结构推断的名字被 code=30005「做法不存在」打回）：
//   ① doc id=168 全文的 DTO 定义；
//   ② 30005 响应回显的 unavailableItemList[0].practiceList 元素恰为 {id, valueId, name, value} 且全 null
//      —— 说明企迈就是按这些名字读我们传的对象，读不到才报「做法不存在」。
// code 是「三方编码」，我方没有三方编码体系，不传（M1 真发成功的请求体也没有这个字段）。
export interface PracticeEntry {
  id?: string;
  name: string;
  value: string;
  valueId?: string;
  price: number;
}

export interface AttachEntry {
  id?: string;
  name: string;
  num: number;
  price: number;
}

export interface OrderItemParams {
  goodsId: string;
  skuId: string;
  num: number;
  practiceList: PracticeEntry[];
  attachList: AttachEntry[];
}

// ---------- 商品详情原始响应（只取组装 ID 需要的字段） ----------
// 为什么不用 tools/getItemDetail.ts 的 ItemDetail：那份投影是给顾客看的（名字 + 价格），
// 刻意丢掉了 practiceId / practiceValueId / attachGoodsId 这些企迈内部 ID——一期不需要它们，
// 二期下单却必须传。一期四个工具文件是不许改的不变量，所以这里独立取一次原始响应做 ID 映射。
// 注意：这里只做「名字 → ID」的查表，绝不重算价格——价格以 previewOrder 的结果为准。
interface RawSku {
  skuId?: string | number;
  salePrice?: number;
  clearStatus?: number;
  specName?: string;
  skuName?: string;
}

interface RawPracticeGroup {
  practiceId?: string | number;
  practiceName?: string;
  practiceValueList?: Array<{ practiceValueId?: string | number; practiceValue?: string; price?: number }>;
}

interface RawDetail {
  goodsId?: string | number;
  name?: string;
  goodsSkuList?: RawSku[];
  sortedPracticeList?: RawPracticeGroup[];
  attachGoodsList?: Array<{ attachGoodsId?: string | number; attachGoodsName?: string; attachGoodsPrice?: number }>;
}

function idOrUndefined(v: string | number | undefined): string | undefined {
  if (v == null) return undefined;
  const s = String(v);
  return s.length > 0 ? s : undefined;
}

async function fetchRawDetail(storeId: number, goodsId: string): Promise<RawDetail> {
  const r = await callRead<RawDetail[]>("v3/goods/item/getShopGoodsDetail", {
    storeId,
    goodsIds: [goodsId],
    ...CHANNEL,
    includeProperties: ["SKU", "PRACTICE", "ATTACH", "LABEL", "CATEGORY"],
  });
  if (!r.ok || !Array.isArray(r.data) || r.data.length === 0) {
    throw new Error(`组单失败：商品 ${goodsId} 的下单信息取不到（${r.error?.message ?? r.message ?? "商品不存在或已下架"}）`);
  }
  return r.data[0];
}

/**
 * 按规格名找 skuId：previewOrder 已经选定了具体规格（返回 specName），这里只做反查。
 *
 * ⚠️ 取名口径必须与一期 getItemDetail 的投影逐字一致（`s.specName ?? s.skuName ?? "标准杯"`）——
 * 我们要匹配的 specName 就是那份投影产生的。曾经按 M1 侦察脚本的写法把 skuItemList[0].specValue
 * 排在最前面，一旦某个 SKU 同时有 skuItemList 与 specName 且两者不同，多规格商品就会反查不到
 * skuId。两处口径不一致的后果不是报错，而是"组单时好时坏"，所以在这里钉死并写明原因。
 */
function resolveSkuId(detail: RawDetail, specName: string, explicitSkuId?: string): string {
  const skus = detail.goodsSkuList ?? [];
  if (explicitSkuId) {
    const hit = skus.find((s) => String(s.skuId ?? "") === explicitSkuId);
    if (hit) return String(hit.skuId);
  }
  const byName = skus.find((s) => (s.specName ?? s.skuName ?? "标准杯") === specName);
  const chosen = byName ?? (skus.length === 1 ? skus[0] : undefined);
  const skuId = idOrUndefined(chosen?.skuId);
  if (!skuId) {
    throw new Error(`组单失败：商品「${detail.name ?? ""}」的规格「${specName}」找不到对应 skuId，请重新组单`);
  }
  return skuId;
}

/** 按做法值名找它所在的组与两个 ID。previewOrder 已校验过这些值名合法、同组不重复。 */
function resolvePractices(detail: RawDetail, valueNames: string[]): PracticeEntry[] {
  const out: PracticeEntry[] = [];
  for (const wanted of valueNames) {
    let hit: PracticeEntry | undefined;
    for (const group of detail.sortedPracticeList ?? []) {
      const value = (group.practiceValueList ?? []).find((v) => v.practiceValue === wanted);
      if (!value) continue;
      hit = {
        ...(idOrUndefined(group.practiceId) ? { id: idOrUndefined(group.practiceId) } : {}),
        name: group.practiceName ?? "做法",
        value: wanted,
        ...(idOrUndefined(value.practiceValueId) ? { valueId: idOrUndefined(value.practiceValueId) } : {}),
        // price 取详情里的原值（当前全品牌实测为 0）。这里不做任何单位换算：
        // doc168 没写 price 是元还是分，当前全 0 传 0 不受影响；品牌一旦启用非零加价，
        // 必须先确认单位再改这一行（施工令 § 8 第 12 条，100 倍差错风险）。
        price: typeof value.price === "number" ? value.price : 0,
      };
      break;
    }
    if (!hit) {
      throw new Error(`组单失败：商品「${detail.name ?? ""}」的做法「${wanted}」在下单信息里找不到，请重新组单`);
    }
    out.push(hit);
  }
  return out;
}

/** 按加料名找 ID；同名重复出现按份数聚合成 num（previewOrder 的算价也是按出现次数累加，口径一致）。 */
function resolveAttaches(detail: RawDetail, names: string[]): AttachEntry[] {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);

  const out: AttachEntry[] = [];
  for (const [name, num] of counts) {
    const hit = (detail.attachGoodsList ?? []).find((a) => a.attachGoodsName === name);
    if (!hit) {
      throw new Error(`组单失败：商品「${detail.name ?? ""}」的加料「${name}」在下单信息里找不到，请重新组单`);
    }
    out.push({
      ...(idOrUndefined(hit.attachGoodsId) ? { id: idOrUndefined(hit.attachGoodsId) } : {}),
      name,
      num,
      price: typeof hit.attachGoodsPrice === "number" ? hit.attachGoodsPrice : 0, // 单位同 practice.price，见上
    });
  }
  return out;
}

/**
 * 预约单防护 · 静态自检（M1 观察点 ⑥ 的第一层护栏，纯本地检查，不发任何请求）：
 * 递归确认最终参数里不出现 isPre / preTime / isWaiterCheck / orderSubType。
 * 这些字段会让订单变成 needPay=0 的无需支付预约单，直接进门店 POS 让门店白做一杯。
 * 命中即抛错终止——组装代码没写这些字段是一回事，"每次都验一遍"是另一回事。
 */
export function assertNoPreOrderFields(value: unknown, path = ""): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoPreOrderFields(v, `${path}[${i}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const currentPath = path ? `${path}.${k}` : k;
      if ((PREORDER_FORBIDDEN_KEYS as readonly string[]).includes(k)) {
        throw new Error(`组单自检失败：下单参数不得包含预约单字段 ${k}（命中路径：${currentPath}）`);
      }
      assertNoPreOrderFields(v, currentPath);
    }
  }
}

/** 元展示（两位小数）。内部一律用分，只有出参才转元。 */
function yuan(fen: number): string {
  return (fen / 100).toFixed(2);
}

/** previewOrder 的 totalYuan 是元字符串，转回分（与 previewOrder 内部累加口径一致：四舍五入到分）。 */
export function yuanStringToFen(yuanStr: string): number {
  return Math.round(parseFloat(yuanStr) * 100);
}

function storeName(storeId: number): string | undefined {
  return STORES.find((s) => s.storeId === storeId)?.name;
}

export interface PrepareOrderInput {
  storeId: number;
  items: OrderItemInput[];
}

export async function prepareOrderHandler({ storeId, items }: PrepareOrderInput): Promise<TextResult> {
  const audit = getAccessAuditLogger();

  try {
    // ① 未绑定会员 → 直接拒绝，不发任何请求。下单链路的第一道门就在这里，
    // 不能等到 place_order 才拦——否则模型会先拿到一张待确认单、念给顾客听，最后才发现下不了单。
    let binding: SessionBinding;
    try {
      binding = getSessionStore().requireBinding(DEFAULT_SESSION_KEY);
    } catch (e) {
      audit.record({
        event: "unbound_call_rejected",
        result: "rejected",
        reason: "SessionNotBound",
        sessionKey: DEFAULT_SESSION_KEY,
        tool: "prepare_order",
      });
      return fail(e);
    }

    // ② 算价与商品校验：一期 previewOrder 是唯一算价来源（估清、规格、做法互斥的拦截都在里面）。
    const preview: PreviewResult = await previewOrder(storeId, items);
    if (!preview.ok || !preview.lines || !preview.totalYuan) {
      return fail(new Error(`${preview.error?.message ?? "组单失败"}（${preview.error?.hint ?? "换一款试试"}）`));
    }
    const estimatedAmountFen = yuanStringToFen(preview.totalYuan);

    // ③ 金额护栏前置：超上限在 prepare 阶段就拒，不签发令牌。
    // 为什么不等 place_order（callWrite 里本来就有同一道护栏）：早失败早改单——
    // 让顾客听完一张念得很完整的待确认单、说"就这个"，才被告知超限，是最差的交互。
    if (estimatedAmountFen > ORDER_GUARD.maxAmountFen) {
      return fail(
        new Error(
          `单笔金额超上限：本单预估 ¥${yuan(estimatedAmountFen)}，上限 ¥${yuan(ORDER_GUARD.maxAmountFen)}。请减少商品后重新组单。`,
        ),
      );
    }

    // ④ 组装 6.2.9 最终参数（全项目唯一一份）。ID 映射按行取原始详情——
    // previewOrder 已经确认了每一行的规格名/做法名/加料名都合法，这里只做"名字 → 企迈 ID"的反查。
    const orderItems: OrderItemParams[] = [];
    for (let i = 0; i < items.length; i++) {
      const line = preview.lines[i];
      const input = items[i];
      const detail = await fetchRawDetail(storeId, input.goodsId);
      orderItems.push({
        goodsId: input.goodsId,
        skuId: resolveSkuId(detail, line.specName, input.skuId),
        num: line.quantity,
        practiceList: resolvePractices(detail, line.practices),
        attachList: resolveAttaches(detail, line.attaches),
      });
    }

    const finalParams: Record<string, unknown> = {
      storeId,
      items: orderItems,
      orderType: ORDER_TYPE_DINE_IN,
      source: ORDER_SOURCE_THIRD_PARTY,
      // userId 只能来自会话态（架构硬规矩）。指纹对「含 userId 的 finalParams」计算——
      // placeOrderTool.ts 里 M3 留下的提醒：签发侧与校验侧必须对同一个对象算指纹，
      // 否则 callWrite 的 TokenFingerprintMismatch 会误伤合法下单。
      userId: binding.customerId,
      // Agent 单归因标识（2026-08-18 探针实测坐实，见 ORDER_CHANNEL_CODE 注释）。
      // 与 userId 一样属常量注入、不接受入参。
      channelCode: ORDER_CHANNEL_CODE,
      scene: ORDER_CHANNEL_CODE,
      // 会员标记：本单必挂 userId，如实填 true（先验后用，见 ORDER_MEMBER_FLAG 注释）。
      member: ORDER_MEMBER_FLAG,
      // 顾客手机号回填（2026-08-19 老板后台四看实测坐实，见 session.ts 的 SessionBinding.phone 注释）：
      // 不传这两个字段，商户后台订单详情页的「下单人」「预留电话」两栏就是空的——门店拿到 Agent 单
      // 联系不上顾客。mobile 与 reservePhone 传同一个号，各自映射后台两个不同栏位（两栏实测都有值）。
      //
      // 只有手机号绑定的会话有这个值；会员码/动态码绑定拿不到手机号，那就**不带这两个键**
      // （而不是带空串——空串是「显式告诉企迈这人没电话」，与「我们不知道」是两回事，
      // 而且空串会污染指纹口径）。与 userId/channelCode 一样属服务端注入，不接受入参。
      ...(binding.phone ? { mobile: binding.phone, reservePhone: binding.phone } : {}),
    };

    // ⑤ 预约单字段静态自检（组装完成后必跑一次）。
    assertNoPreOrderFields(finalParams);

    // ⑥ 签发一次性确认令牌 + 登记待确认单。
    const { tokenId } = getWriteGuard().issueConfirmToken(finalParams);
    getPendingOrderStore().register(tokenId, { finalParams, estimatedAmountFen });

    audit.record({
      event: "token_issued",
      result: "allowed",
      customerIdLast4: `***${binding.customerId.slice(-4)}`,
      sessionKey: DEFAULT_SESSION_KEY,
      tool: "prepare_order",
      tokenId,
      estimatedAmountFen,
      itemCount: orderItems.length,
    });

    // ⑦ 返回待确认单。金额一律以元展示（两位小数），内部计算全程用分。
    // 出参不含 userId（连后四位都不给——待确认单是念给顾客听的，顾客不需要知道自己的会员内部 ID）。
    return ok({
      confirmToken: tokenId,
      store: { storeId: String(storeId), ...(storeName(storeId) ? { name: storeName(storeId) } : {}) },
      lines: preview.lines.map((l) => ({
        name: l.name,
        specName: l.specName,
        practices: l.practices,
        attaches: l.attaches,
        quantity: l.quantity,
        unitPriceYuan: l.unitPriceYuan,
        lineTotalYuan: l.lineTotalYuan,
      })),
      estimatedTotalYuan: yuan(estimatedAmountFen),
      // 取餐话术只承诺确定存在的机制（老板 2026-08-22 拍板，§8-40 销项）：接口单有没有
      // 「取餐号」从未实测过，说了顾客到店可能报不出来；小程序订单页是付款后必经的既有链路，
      // 按它的提示走永远不会错。「报取餐号」的旧文案曾让模型照着念、被 §8-40 当成模型发挥登记。
      pickup: "堂食（本店当前只开堂食）：付款后按小程序订单页的提示取餐",
      expiresInMinutes: ORDER_GUARD.confirmTokenTtlMs / 60000,
      note:
        "请把以上内容逐项念给顾客确认（门店、每杯商品与规格做法、杯数、总金额）。" +
        "顾客确认后调用 place_order，传入 confirmToken 与你刚念出的总金额（元）。" +
        `令牌 ${ORDER_GUARD.confirmTokenTtlMs / 60000} 分钟内有效、只能用一次，过期请重新组单。`,
    });
  } catch (e) {
    return fail(e);
  }
}
