import { randomUUID } from 'node:crypto';
import {
  Server, StreamableHTTPServerTransport, CallToolRequestSchema, InitializeRequestSchema, ListToolsRequestSchema
} from './protocol-runtime.js';
import { decimalId, uuidPattern } from './common.js';
import { tools, validators } from './tools.js';

function json(res,status,body,headers = {}) {
  res.writeHead(status,{'content-type':'application/json; charset=utf-8',...headers});
  res.end(JSON.stringify(body));
}
function reject(res,status,message,headers) {
  json(res,status,{jsonrpc:'2.0',id:null,error:{code:-32000,message}},headers);
}
function toolError(text) {
  return {isError:true,content:[{type:'text',text}]};
}

// SDK 仍会校验 tools/call 的协议形状。让 arguments 对象原样到达 WRT-01，
// 避免 SDK 的 record 解码在检查前丢弃 __proto__ 等自有字段。
const rawToolCall = CallToolRequestSchema.extend({
  params:CallToolRequestSchema.shape.params.omit({arguments:true}).loose()
});

function extraPlaceField(args, isCouponRef) {
  const field = key => {
    if (isCouponRef(key)) return '（券编号）';
    return /^[A-Za-z_-]{1,32}$/.test(key) ? key : '（略）';
  };
  for (const [key,value] of Object.entries(args)) {
    if (!['confirmToken','confirmAmountYuan'].includes(key)) return field(key);
    let path = key;
    let child = value;
    while (Array.isArray(child) && child.length) {
      // 如果数组中带有对象字段，指出它实际所在的位置。
      const found = child.findIndex(item => item && typeof item === 'object' && Object.keys(item).length);
      const index = Math.max(0, found);
      path += '[' + (index <= 999 ? index : '（略）') + ']';
      child = child[index];
    }
    if (child && typeof child === 'object') {
      const first = Object.keys(child)[0];
      if (first !== undefined) return path + '.' + field(first);
    }
    if (path !== key) return path;
  }
}

export function makeEndpoint({version,config,logs,browse,commerce}) {
  const sessions = new Map();
  const devices = new Map();
  let opening = 0;
  const browsing = new Set(tools.slice(0,4).map(tool => tool.name));
  const available = commerce ? tools : tools.slice(0,4);
  const names = new Set(available.map(tool => tool.name));
  const ttl = config.LICHA_SESSION_IDLE_TTL_MS;

  function evictIdle() {
    const now = Date.now();
    for (const [id,s] of sessions) {
      if (!s.working && now - s.last >= ttl) {
        sessions.delete(id);
        void s.server.close().catch(() => {});
      }
    }
    for (const [device,state] of devices) {
      if (!state.queued && state.times.at(-1) <= now - 60000) devices.delete(device);
    }
  }
  const sweep = setInterval(evictIdle,Math.min(ttl,60000)).unref();

  async function dispatch(s,name,args) {
    const source = {device:s.device};
    const state = devices.get(s.device) ?? {times:[],chain:Promise.resolve(),queued:0};
    devices.set(s.device,state);
    const now = Date.now();
    state.times = state.times.filter(t => t > now - 60000);
    if (state.times.length >= config.LICHA_RATE_CALLS_PER_DEVICE_PER_MIN) {
      logs.access({event:'rate_limited',reason:'device_calls'},source);
      if (commerce && name === 'place_order') commerce.logPlaceRejection('device_rate',args.confirmToken,s.device);
      return toolError('操作太频繁，请稍等一下再试。');
    }
    state.times.push(now);
    state.queued++;
    s.working++;
    const releaseVerification = name === 'bind_member' && args.captcha !== undefined
      ? commerce?.holdVerification(s.device) : undefined;
    const run = state.chain.then(async () => {
      if (!names.has(name)) return toolError('未开放该工具。');
      if (name === 'place_order') {
        const path = extraPlaceField(args, key => commerce.isDeviceCouponRef(s.device, key));
        if (path !== undefined) {
          commerce.logPlaceRejection('WRT-01',args.confirmToken,s.device);
          return toolError('place_order 只接受 confirmToken 与 confirmAmountYuan 两个参数（收到多余的：' + path + '）。会员身份只能由服务端按设备绑定注入，不接受调用方传入。');
        }
      }
      if (!validators.get(name)(args) || (Object.hasOwn(args,'storeId') && !decimalId(args.storeId))) {
        if (name === 'place_order') commerce.logPlaceRejection('invalid_arguments',args.confirmToken,s.device);
        if (name === 'bind_member') logs.access({event:'bind_rejected',reason:'invalid_arguments'},source);
        return toolError('工具参数的类型、取值或必填字段不符合要求。');
      }
      try {
        // 与上游发送的十进制编号一致，供门店名录、缓存和未决核对共用。
        const input = Object.hasOwn(args,'storeId')
          ? {...args,storeId:decimalId(args.storeId)} : args;
        const result = browsing.has(name)
          ? await browse.call(name,input) : await commerce.call(name,input,s.device,now);
        return {content:[{type:'text',text:JSON.stringify(result,null,2)}]};
      } catch (error) {
        return toolError(error.message);
      }
    });
    state.chain = run.catch(() => {});
    try { return await run; }
    finally { releaseVerification?.(); state.queued--; s.working--; s.last = Date.now(); }
  }

  async function handle(req,res) {
    if (req.url === '/healthz' && req.method === 'GET') {
      return json(res,200,{ok:true,version,ordering:!!commerce});
    }
    if (req.url !== '/mcp') return reject(res,404,'路径不存在。');
    const access = req.headers['x-licha-access'];
    const device = (req.headers['x-licha-device'] ?? '').toLowerCase();
    if (!config.LICHA_ACCESS_KEYS.includes(access)) {
      logs.access({event:'access_denied',reason:'access_key'});
      return reject(res,401,'准入密钥无效。');
    }
    if (!uuidPattern.test(device)) {
      logs.access({event:'access_denied',reason:'device_format'});
      return reject(res,400,'设备标识缺失或格式不正确。');
    }
    if (config.LICHA_BLOCKED_DEVICES.includes(device)) {
      logs.access({event:'device_blocked'},{device});
      return reject(res,403,'该设备已停用。');
    }
    evictIdle();
    const id = req.headers['mcp-session-id'];
    if (id !== undefined) {
      const s = sessions.get(id);
      if (!s) return reject(res,404,'会话不存在。',{'X-Licha-Reason':'session-not-found'});
      if (s.device !== device) {
        logs.access({event:'access_denied',reason:'session_device'},{device});
        return reject(res,403,'会话与设备不匹配。');
      }
      s.last = Date.now();
      if (req.method !== 'POST') return s.transport.handleRequest(req,res);
      s.working++;
      try { await s.transport.handleRequest(req,res); }
      finally { s.working--; s.last = Date.now(); }
      return;
    }
    if (req.method !== 'POST') return reject(res,400,'缺少会话 ID。');
    if (sessions.size + opening >= config.LICHA_MAX_SESSIONS) return reject(res,503,'会话名额已满，请稍后再试。');
    opening++;
    let reserved = true;
    const release = () => { if (reserved) { reserved = false; opening--; } };
    let body;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) {
          release();
          return reject(res,413,'初始化消息太大。');
        }
        chunks.push(chunk);
      }
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      release();
      if (!res.destroyed) reject(res,400,'消息格式无效。');
      return;
    }
    if (!InitializeRequestSchema.safeParse(body).success || body.id == null || body.jsonrpc !== '2.0') {
      release();
      return reject(res,400,'请先初始化会话。');
    }
    const server = new Server({name:'licha-order-mcp',version},{capabilities:{tools:{}}});
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator:randomUUID,enableJsonResponse:true,
      onsessioninitialized(id) { release(); sessions.set(id,s); },
      onsessionclosed(id) { sessions.delete(id); }
    });
    const s = {server,transport,device,working:0,last:Date.now()};
    server.setRequestHandler(ListToolsRequestSchema,async () => ({tools:available}));
    server.setRequestHandler(rawToolCall,({params}) => dispatch(s,params.name,params.arguments ?? {}));
    try {
      await server.connect(transport);
      await transport.handleRequest(req,res,body);
    } finally {
      release();
      if (!transport.sessionId || res.statusCode >= 400) {
        sessions.delete(transport.sessionId);
        await server.close();
      }
    }
  }
  return {
    handle,
    async close() {
      clearInterval(sweep);
      await Promise.allSettled(Array.from(sessions.values(),s => s.server.close()));
      sessions.clear();
    }
  };
}
