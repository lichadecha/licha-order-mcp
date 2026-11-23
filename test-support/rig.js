import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

export const mockCaptcha = '048257';

export function mockSmsUpstream() {
  const challenges = new Map();
  return (path, params) => {
    if (path === 'v3/message/commonSendSmsCaptcha') {
      challenges.set(params.bizId, params.customerPhone);
      return {status:true};
    }
    if (path === 'v3/message/commonCheckSmsCaptcha') {
      const passed = challenges.has(params.bizId) && challenges.get(params.bizId) === params.phone &&
        params.captcha === mockCaptcha;
      if (passed) challenges.delete(params.bizId);
      return {status:passed};
    }
  };
}

export const serverPath = fileURLToPath(new URL('../server/main.js',import.meta.url));
const loopback = '127.0.0.1';
async function listen(server) {
  server.listen(0,loopback);
  await once(server,'listening');
  return server.address().port;
}
export async function freePort() {
  const socket = http.createServer();
  const port = await listen(socket);
  await new Promise(resolve => socket.close(resolve));
  return port;
}

export async function rig(t,options = {}) {
  const cwd = await mkdtemp(join(tmpdir(),'licha-test-'));
  const requests = [];
  const sms = options.mockSms ? mockSmsUpstream() : undefined;
  const upstream = http.createServer(async(req,res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString();
      const body = JSON.parse(raw, (key,value,ctx) =>
        typeof value === 'number' && /^-?\d{15,}$/.test(ctx.source) ? ctx.source : value);
      const path = req.url.replace(/^\//,'');
      requests.push({path,params:body.params,body,raw,at:Date.now()});
      const reply = sms?.(path,body.params) ?? (options.upstream
        ? await options.upstream(path,body.params,{req,res,body,raw})
        : {status:true,code:0,data:[]});
      if (reply !== undefined && !res.writableEnded) {
        res.setHeader('content-type','application/json');
        res.end(JSON.stringify(reply));
      }
    } catch {
      if (!res.destroyed) { res.statusCode = 500; res.end(); }
    }
  });
  const upstreamPort = await listen(upstream);
  const env = {...process.env};
  for (const name of Object.keys(env)) {
    if (/^(?:LICHA_|QMAI_)|^(?:HOST|PORT|NODE_OPTIONS)$/.test(name)) delete env[name];
  }
  Object.assign(env,{
    HOST:loopback, PORT:String(await freePort()), QMAI_BASE_URL:'http://' + loopback + ':' + upstreamPort + '/',
    QMAI_OPEN_KEY:'FAKE_SIGNING_KEY',QMAI_OPEN_ID:'FAKE_OPEN_ID',QMAI_GRANT_CODE:'FAKE_GRANT_CODE',
    LICHA_ACCESS_KEYS:'FAKE_ACCESS_KEY',LICHA_DATA_DIR:join(cwd,'data'),LICHA_LOG_DIR:join(cwd,'logs'),
    LICHA_ENABLE_ORDERING:'1',LICHA_SMS_EVENT_NO:'42',LICHA_UPSTREAM_MIN_INTERVAL_MS:'2',LICHA_READ_BACKOFF_MS:'3,5',
    LICHA_READ_TIMEOUT_MS:'1000',LICHA_WRITE_TIMEOUT_MS:'1000',...options.env
  });
  for (const [key,value] of Object.entries(env)) if (value === undefined) delete env[key];
  const url = 'http://' + loopback + ':' + env.PORT;
  let child;
  let stderr;
  let exited;
  let cleaned = false;
  async function stop(signal = 'SIGTERM') {
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
      const kill = setTimeout(() => child?.kill('SIGKILL'),3000).unref();
      try { await exited; } finally { clearTimeout(kill); }
    }
    child = undefined;
  }
  async function start() {
    child = spawn(process.execPath,[...(options.nodeArgs ?? []),serverPath],{cwd,env,stdio:['ignore','ignore','pipe']});
    stderr = '';
    child.stderr.setEncoding('utf8').on('data',s => { stderr += s; });
    exited = once(child,'exit');
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode) throw new Error('服务启动失败：' + stderr);
      try { if ((await fetch(url + '/healthz')).ok) return; } catch {}
      await delay(20);
    }
    throw new Error('等待服务就绪超时：' + stderr);
  }
  async function close() {
    if (cleaned) return;
    cleaned = true;
    await stop();
    const finished = new Promise(resolve => upstream.close(resolve));
    upstream.closeAllConnections();
    await finished;
    await rm(cwd,{recursive:true,force:true,maxRetries:3});
  }
  t.after(close);
  let rpcId = 0;
  const headers = device => ({
    'content-type':'application/json',accept:'application/json, text/event-stream',
    'x-licha-access':env.LICHA_ACCESS_KEYS.split(',')[0].trim(),'x-licha-device':device
  });
  async function session(device = randomUUID()) {
    const base = headers(device);
    const init = {jsonrpc:'2.0',id:++rpcId,method:'initialize',params:{
      protocolVersion:'2025-06-18',clientInfo:{name:'local-test',version:'1'},capabilities:{}
    }};
    const opened = await fetch(url + '/mcp',{method:'POST',headers:base,body:JSON.stringify(init)});
    if (!opened.ok) throw new Error('握手失败 ' + opened.status + ' ' + await opened.text());
    const handshake = (await opened.json()).result;
    const id = opened.headers.get('mcp-session-id');
    Object.assign(base,{'mcp-session-id':id,'mcp-protocol-version':handshake.protocolVersion});
    const send = (body,extra = {}) => fetch(url + '/mcp',{
      method:'POST',headers:{...base,...extra},body:JSON.stringify(body)
    });
    const ack = await send({jsonrpc:'2.0',method:'notifications/initialized'});
    if (!ack.ok) throw new Error('初始化通知失败 ' + ack.status);
    async function rpc(method,params = {}) {
      const res = await send({jsonrpc:'2.0',id:++rpcId,method,params});
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(JSON.stringify(data.error));
      return data.result;
    }
    return {id,device,headers:base,handshake,send,rpc,call:(name,args = {}) => rpc('tools/call',{name,arguments:args}),
      close:() => fetch(url + '/mcp',{method:'DELETE',headers:base})};
  }
  await start();
  return {
    requests,url,env,cwd,logDir:env.LICHA_LOG_DIR,dataDir:env.LICHA_DATA_DIR,session,headers,start,stop,close,
    get child() { return child; }, get stderr() { return stderr; },
    async restart() { await stop(); await start(); }
  };
}
