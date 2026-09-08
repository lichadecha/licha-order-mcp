// 24 号 A5：组单时查券、事前告知（B1 券确认页的第一步）。
//
// 背景（施工令 §8-47 终版定案，2026-08-25）：企迈后端对「没带券指令的单」默认适用一张券；小程序确认页
// 默认勾选那张、顾客可取消；Agent 接口单没有确认页，默认行为直接生效，顾客事前不知道自己的券要被用掉。
// 2026-09-08 侦察单再次实证：预估 ¥26.00、实付 ¥0.00，Agent 只能在下单后报「金额对不上」。
//
// 这一步做的是「AI 对话充当确认页」的前半：prepare 阶段用 5.1.7 问企迈「这一单能用哪些券、各抵多少」，
// 把可用券与预测会被用的那张一起塞进待确认单，让 Agent 念单时先说「系统默认会用你的 X 券，省 X 元」。
// 后半「顾客说不用券」需要接口侧表达（首要候选 lastSelect），要 Mac 真发实测，不在本文件范围。
//
// 边界：只读、只告知、不指定券、不核销；查不到就如实说查不到，绝不阻塞组单；出参不带 cardId /
// customerId（盲审 B05：上游原始字段不进 MCP 返回）。

import { callRead } from "./client.js";

const PATH_CHOOSE_COUPON = "v3/bsns/customer/chooseCouponAsOne"; // 5.1.7

export interface CouponPreviewLine {
  goodsId: string;
  quantity: number;
  unitPriceFen: number;
}

export interface UsableCoupon {
  title: string;
  /** 本单可抵金额（元，两位小数字串）。 */
  canDisYuan: string;
  /** 券类型（施工令 §8-47：2 = 「自动生效」类，实测被企迈自动核销的都是这一类）。缺省表示上游没给。 */
  couponCenterType?: number;
}

export interface PredictedCoupon {
  title: string;
  canDisYuan: string;
  /** 用了这张券之后的预计实付（元）。 */
  payAfterYuan: string;
  /** 预测依据：auto_type = 自动生效类里抵扣最大；max_discount = 没有自动生效类，取全部可用券里抵扣最大。 */
  basis: "auto_type" | "max_discount";
}

export interface CouponPreview {
  /** 这次有没有拿到企迈的判定结果。false 时 usable / unusable 都是空，note 说明原因。 */
  available: boolean;
  usable: UsableCoupon[];
  unusable: Array<{ title: string; reason: string }>;
  predicted?: PredictedCoupon;
  note: string;
}

/** 施工令 §8-47 实测：被自动核销的都是 couponCenterType=2 的「自动生效」类券，且选的是该类里抵扣最大的一张。 */
const AUTO_APPLY_TYPE = 2;

function yuan(fen: number): string {
  return (fen / 100).toFixed(2);
}

function toFen(yuanValue: unknown): number | null {
  if (typeof yuanValue !== "number" || !Number.isFinite(yuanValue)) return null;
  return Math.round(yuanValue * 100);
}

/**
 * 预测规则（施工判断点，24 号 §9 A5）：先在「自动生效」类可用券里挑抵扣最大的（8-25 两枪实测口径）；
 * 没有这类券再看全部可用券里抵扣最大的，并把依据标出来。规则以下单后 6.1.9 读回为准——
 * place_order 会拿实际用的券与这里的预测比对，不一致会如实报出来，那也是修正本规则的证据。
 */
export function predictCoupon(usable: UsableCoupon[], estimatedAmountFen: number): PredictedCoupon | undefined {
  if (usable.length === 0) return undefined;
  const withFen = usable.map((c) => ({ c, fen: Math.round(Number(c.canDisYuan) * 100) })).filter((x) => Number.isFinite(x.fen) && x.fen > 0);
  if (withFen.length === 0) return undefined;
  const autoOnes = withFen.filter((x) => x.c.couponCenterType === AUTO_APPLY_TYPE);
  const pool = autoOnes.length > 0 ? autoOnes : withFen;
  const best = pool.reduce((a, b) => (b.fen > a.fen ? b : a));
  return {
    title: best.c.title,
    canDisYuan: best.c.canDisYuan,
    payAfterYuan: yuan(Math.max(0, estimatedAmountFen - best.fen)),
    basis: autoOnes.length > 0 ? "auto_type" : "max_discount",
  };
}

const UNAVAILABLE_NOTE = "券信息暂时没查到；下单后以门店系统读回的实付为准，如有优惠会在读回里体现。";

export async function previewCoupons(args: {
  customerId: string;
  shopCode: string;
  lines: CouponPreviewLine[];
  estimatedAmountFen: number;
}): Promise<CouponPreview> {
  const empty = (note: string): CouponPreview => ({ available: false, usable: [], unusable: [], note });
  let rows: unknown;
  try {
    const r = await callRead<unknown>(
      PATH_CHOOSE_COUPON,
      {
        customerId: args.customerId, // 19 位，client 发送前按大数规则还原为 JSON 数字
        discountPrice: 0.0,
        multiMark: args.shopCode, // 5.1.7 门店定位用 shopCode（手册 §2.2 两套门店标识）
        typeCate: 1, // 1 堂食（本店只开堂食 / 自取）
        tradeMarks: args.lines.map((l) => ({ tradeMark: l.goodsId, num: l.quantity, price: Number(yuan(l.unitPriceFen)) })),
      },
      { attempts: 1 },
    );
    if (!r.ok) return empty(UNAVAILABLE_NOTE);
    const data = r.data as { list?: unknown } | unknown[] | null | undefined;
    rows = Array.isArray(data) ? data : data && typeof data === "object" && Array.isArray((data as { list?: unknown }).list) ? (data as { list: unknown[] }).list : null;
  } catch {
    return empty(UNAVAILABLE_NOTE);
  }
  if (!Array.isArray(rows)) return empty(UNAVAILABLE_NOTE);

  const usable: UsableCoupon[] = [];
  const unusable: Array<{ title: string; reason: string }> = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as { title?: unknown; unUseStatus?: unknown; unUseDesc?: unknown; userCouponCanDisAmount?: unknown; couponCenterType?: unknown };
    const title = typeof c.title === "string" && c.title.trim() ? c.title.trim() : "（未命名的券）";
    if (c.unUseStatus === 1) {
      const fen = toFen(c.userCouponCanDisAmount);
      usable.push({
        title,
        canDisYuan: yuan(fen ?? 0),
        ...(typeof c.couponCenterType === "number" ? { couponCenterType: c.couponCenterType } : {}),
      });
    } else {
      unusable.push({ title, reason: typeof c.unUseDesc === "string" && c.unUseDesc.trim() ? c.unUseDesc.trim() : "本单不可用" });
    }
  }
  const predicted = predictCoupon(usable, args.estimatedAmountFen);
  const note = predicted
    ? `顾客有 ${usable.length} 张券可用于本单。念单时要加一句：「系统默认会用你的『${predicted.title}』，省 ${predicted.canDisYuan} 元，实付大约 ¥${predicted.payAfterYuan}」。这是按企迈默认用券规则的预测，下单后以读回为准。`
    : usable.length === 0
      ? `顾客没有可用于本单的券${unusable.length > 0 ? `（${unusable.length} 张不可用）` : ""}，念单时不用提券。`
      : "查到可用券但抵扣金额都为 0，念单时不用提券。";
  return { available: true, usable, unusable, ...(predicted ? { predicted } : {}), note };
}
