import { Ajv } from './protocol-runtime.js';

const descriptions = {
  "find_store": "按店名、商场名或城市找李茶的茶门店，返回 storeId（看菜单/点单都要用）、营业状态；唯一命中时附营业时间。顾客问哪家店近、或准备下单时再用；只是看菜单可以先不找店。",
  "get_menu": "看某店菜单：不传 keyword 返回全部分类；传 keyword（商品名或分类名）返回商品列表（goodsId、价格、标签）。",
  "get_item_detail": "看商品点单详情：规格（SKU）、做法（温度/糖度等，标明哪些必选）、加料、是否估清，以及品牌填写的商品描述（配料、热量、杯量、能否去冰、是否含酒精等）。回答配料、热量、酒精这类问题只依据 description 与 labels，没写的就说品牌没提供，不要自己估。goodsId 从 get_menu 结果里取。",
  "preview_order": "组单算预估总价（本地累加；实际金额以下单后小程序里这一单显示的为准）。同组做法（如温度）只能选一个，估清商品会拦截。",
  "bind_member": "绑定当前设备到一位李茶的茶会员，之后才能下单、查自己的订单或查积分等级；只在顾客明确要下单、查自己的订单或查自己的积分等级时才绑定。默认用顾客注册会员的手机号（codeType=phone）。换人直接换绑：顾客报一个新号，照常再调一次本工具就行，不需要任何额外动作——换成了另一位会员时出参带 rebound=true（旧顾客还没确认的待确认单会被作废，见 discardedPendingOrders）；报的还是同一位会员则是幂等成功、不改任何状态，出参不带 rebound，别说成「换绑成功」。唯一拦换人的情况：上一次下单请求结果还没核对清楚时本工具会拒绝，先用 my_orders 把那一单核对掉再换人。**绑定要两步**：第一次只带手机号，系统会给这个号发一条短信验证码（这台设备本来绑的就是这个号时直接成功、不发码）；请顾客把短信里的数字告诉你，再调用一次，带上同一个手机号和 captcha，校验通过才绑定。同一台设备可以先后绑多个手机号（号码的主人要把验证码告诉你；不要问顾客这个号是谁的）：每个号在这台设备上验证过、且记录还有效（闲置不超过保留期、服务没重启）时，再报它就直接切过去、不用收码（出参同换绑）；两个号属于同一位会员时，仍按那位会员现在的绑定，不算换人；同一时刻只按当前这一个号组单、下单、查单。目前只支持手机号（codeType=phone）。",
  "prepare_order": "两阶段下单的第一步（这一步还不会下单，只生成待确认单）：本地算价、组装下单参数，返回一张「待确认单」和一个限时有效、只能用一次的确认令牌。需先用 bind_member 绑定会员身份。拿到待确认单后必须逐项念给顾客（下到哪位会员名下、门店、每杯商品与规格做法、每行数量），并让顾客**明确确认三样：数量（每行数量与总杯数 totalQuantity）、优惠（这单用哪张券、省多少，或不用券）、金额（合计与预计实付）**；三样没有得到顾客明确的「确认」，不得调用 place_order。总杯数 10 杯及以上、或合计 300 元及以上的大单，念完后再单独复述一次「一共 N 杯、实付约 X 元」，得到第二次确认才可下单。入参与 preview_order 相同，另有可选的 couponChoice：不传或传 \"default\" = 系统在能用的券里替顾客挑抵得最多的一张并指定（coupons.autoPicked 为 true 时，必须把 coupons.usable 里的券念给顾客，问用这张、换一张还是这单不用券）；顾客明确说这单不用券时传 \"none\"；顾客点名要用某一张时传 \"specific\"，并在 couponRef 里带上那张券的 ref（取自上一次待确认单 coupons.usable 里的 ref）。不接受 userId、金额与渠道参数。",
  "place_order": "两阶段下单的第二步（写）：凭 prepare_order 签发的确认令牌创建真实订单。**只有在顾客对念给他听的待确认单——数量、优惠、金额三样——明确说了确认之后才能调用**；confirmAmountYuan 必须是刚念给顾客、顾客确认过的那个合计金额。下单参数完全来自那张待确认单，本工具不接受任何订单内容参数——这保证「下的单 = 念给顾客听过的那张单」。下单成功后会强制读回企迈的实付金额与优惠明细，与本地预估比对；差额超阈值时返回体带 warning，必须先向顾客说清差额再引导付款。我们不代付、不碰支付凭据，只引导顾客去小程序「我的订单」自行付款。",
  "get_order_status": "查询一个订单的当前状态。只能查当前绑定会员自己的订单——查询别人的订单会被拒绝。",
  "my_orders": "列出当前绑定会员最近几天的订单（订单号、状态、实付金额、下单时间、商品）。只查当前绑定的会员本人——不接受指定他人身份，最多返回最近 10 条。",
  "my_member_info": "查当前绑定会员的积分和会员等级。只查当前绑定的会员本人；只查不改——本工具不能兑换积分、不能领券，顾客问积分怎么用，请引导他去李茶的茶小程序的积分商城。需先用 bind_member 绑定。"
};

const text = {type:'string'};
const nonempty = {type:'string', minLength:1};
const stringList = {type:'array',items:text};
export const maxStoreId = 2147483647;
const storeId = {anyOf:[{type:'integer',minimum:1,maximum:maxStoreId},
  {type:'string',pattern:'^0*[1-9][0-9]*$', description:'十进制门店编号，取值 1 到 2147483647。'}]};

function shape(properties, required = []) {
  return {type:'object', properties, required, additionalProperties:false};
}
const item = shape({goodsId:nonempty, skuId:text, practices:stringList, attaches:stringList,
  quantity:{type:'integer',minimum:1,maximum:99}}, ['goodsId','quantity']);
const order = shape({storeId,items:{type:'array',minItems:1,maxItems:20,items:item}}, ['storeId','items']);
const schemas = {
  find_store: shape({query:nonempty}, ['query']),
  get_menu: shape({storeId,keyword:text}, ['storeId']),
  get_item_detail: shape({storeId,goodsId:nonempty}, ['storeId','goodsId']),
  preview_order: order,
  bind_member: shape({code:{type:'string',minLength:4,maxLength:64},codeType:{enum:['phone','card','dynamic_code']},
    captcha:{type:'string',minLength:1,maxLength:16}},['code','codeType']),
  prepare_order: shape({...order.properties, couponChoice:{type:'string',enum:['default','none','specific']},
    couponRef:{...nonempty,maxLength:128}}, order.required),
  place_order: shape({confirmToken:nonempty,confirmAmountYuan:{type:'number',exclusiveMinimum:0,
    description:'刚念给顾客的合计金额（元），最多两位小数。'}},['confirmToken','confirmAmountYuan']),
  get_order_status: shape({orderNo:nonempty},['orderNo']),
  my_orders: shape({days:{type:'integer',minimum:1,maximum:90,default:7}}),
  my_member_info: shape({})
};
const ajv = new Ajv();
export const tools = Object.entries(schemas).map(([name,inputSchema]) => ({
  name,description:descriptions[name],inputSchema
}));
export const validators = new Map(tools.map(tool => [tool.name,ajv.compile(tool.inputSchema)]));
