import { Ajv } from './protocol-runtime.js';

const descriptions = {
  "find_store": "按店名、商场名或城市找李茶的茶门店，返回 storeId（看菜单/点单都要用）、营业状态；唯一命中时附营业时间。点单第一步先找店。",
  "get_menu": "看某店菜单：不传 keyword 返回全部分类；传 keyword（商品名或分类名）返回商品列表（goodsId、价格、标签）。",
  "get_item_detail": "看商品点单详情：规格（SKU）、做法（温度/糖度等，标明哪些必选）、加料、是否估清。goodsId 从 get_menu 结果里取。",
  "preview_order": "组单算预估总价（本地累加；实际金额以门店收银台/订单为准）。同组做法（如温度）只能选一个，估清商品会拦截。",
  "bind_member": "绑定当前设备到一位李茶的茶会员，之后才能下单或查自己的订单；只在顾客明确要下单时才绑定。默认用顾客注册会员的手机号（codeType=phone）。换人直接换绑：顾客报一个新号，照常再调一次本工具就行，不需要任何额外动作——换成了另一位会员时出参带 rebound=true（旧顾客还没确认的待确认单会被作废，见 discardedPendingOrders）；报的还是同一位会员则是幂等成功、不改任何状态，出参不带 rebound，别说成「换绑成功」。唯一拦换人的情况：上一次下单请求结果还没核对清楚时本工具会拒绝，先用 my_orders 把那一单核对掉再换人。三种标识形态：phone=11 位手机号（默认）；card=实体卡号或会员码；dynamic_code=小程序「会员码」页面显示的动态码（每 30 秒刷新一次，需要请顾客当场打开小程序读出）。",
  "prepare_order": "两阶段下单的第一步（只读，不会创建任何订单）：本地算价、组装下单参数，返回一张「待确认单」和一个限时有效、只能用一次的确认令牌。需先用 bind_member 绑定会员身份。拿到待确认单后必须逐项念给顾客确认（下到哪位会员名下、门店、每杯商品与规格做法、杯数、总金额），顾客确认后再调用 place_order。入参与 preview_order 同构；不接受 userId、金额与渠道参数。",
  "place_order": "两阶段下单的第二步（写）：凭 prepare_order 签发的确认令牌创建真实订单。下单参数完全来自那张待确认单，本工具不接受任何订单内容参数——这保证「下的单 = 念给顾客听过的那张单」。下单成功后会强制读回企迈的实付金额与优惠明细，与本地预估比对；差额超阈值时返回体带 warning，必须先向顾客说清差额再引导付款。我们不代付、不碰支付凭据，只引导顾客去小程序「我的订单」自行付款。",
  "get_order_status": "查询一个订单的当前状态。只能查当前绑定会员自己的订单——查询别人的订单会被拒绝。",
  "my_orders": "列出当前绑定会员最近几天的订单（订单号、状态、实付金额、下单时间、商品）。只查当前绑定的会员本人——不接受指定他人身份，最多返回最近 10 条。"
};

const text = {type:'string'};
const nonempty = {type:'string', minLength:1};
const stringList = {type:'array',items:text};
const storeId = {anyOf:[{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER},{type:'string',pattern:'^0*[1-9][0-9]*$'}]};

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
  bind_member: shape({code:{type:'string',minLength:4,maxLength:64},codeType:{enum:['phone','card','dynamic_code']}},['code','codeType']),
  prepare_order: order,
  place_order: shape({confirmToken:nonempty,confirmAmountYuan:{type:'number',exclusiveMinimum:0}},['confirmToken','confirmAmountYuan']),
  get_order_status: shape({orderNo:nonempty},['orderNo']),
  my_orders: shape({days:{type:'integer',minimum:1,maximum:90,default:7}})
};
const ajv = new Ajv();
export const tools = Object.entries(schemas).map(([name,inputSchema]) => ({
  name,description:descriptions[name],inputSchema
}));
export const validators = new Map(tools.map(tool => [tool.name,ajv.compile(tool.inputSchema)]));
