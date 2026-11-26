import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const shellEntry = join(root, 'bin', 'licha-order-mcp.js');
const access = 'FAKE_TEST_SHELL_ACCESS';
const initialize = { jsonrpc: '2.0', method: 'initialize', id: 0, params: {
  protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' },
} };
const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };
const list = (id) => ({ jsonrpc: '2.0', id, method: 'tools/list', params: {} });
const call = (id) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'place_order', arguments: {} } });
const result = (id, body) => ({ jsonrpc: '2.0', id, result: body });
const testTool = { name: 'opaque', inputSchema: { type: 'object' } };

function respond(res, msg, headers = {}) {
  res.writeHead(200, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(msg));
}

async function sandbox(t) {
  const dir = await mkdtemp(join(tmpdir(), 'licha-shell-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function remote(t, hook = () => false) {
  const requests = [];
  let sessions = 0;
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const message = text ? JSON.parse(text) : undefined;
    const packet = { req, res, message, session: req.headers['mcp-session-id'] };
    requests.push(packet);
    if (await hook(packet)) return;
    if (req.method === 'DELETE') { res.writeHead(200).end(); return; }
    if (message.method === 'initialize') {
      const newSession = 'session-' + (++sessions);
      respond(res, result(message.id, {
        protocolVersion: '2025-03-26', serverInfo: { name: 'mock', version: '1' }, capabilities: { tools: {} },
      }), { 'mcp-session-id': newSession });
    } else if (message.method === 'tools/list') {
      respond(res, result(message.id, { tools: [testTool] }));
    } else if (message.method === 'tools/call') {
      respond(res, result(message.id, { content: [{ type: 'text', text: '原样答复' }] }));
    } else {
      res.writeHead(202).end();
    }
  });
  const port = await listen(server);
  t.after(() => { server.closeAllConnections(); return new Promise((done) => server.close(done)); });
  return { url: 'http://127.0.0.1:' + port + '/mcp', requests };
}

function startShell(t, dir, url, options = {}) {
  const {entry = shellEntry, home = join(dir, 'device'), env = {}, nodeArgs = []} = options;
  const child = spawn(process.execPath, [...nodeArgs, entry], {
    cwd: dir, env: { ...process.env, LICHA_HOME: home, LICHA_MCP_URL: url, LICHA_ACCESS_KEY: access, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const messages = [];
  const waiting = new Map();
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  lines.on('line', (line) => {
    const msg = JSON.parse(line);
    assert.equal(msg.jsonrpc, '2.0');
    messages.push(msg);
    waiting.get(msg.id)?.(msg);
  });
  const closed = once(child, 'close').then(([code]) => code);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  });
  function send(...messages) {
    child.stdin.write(messages.map((msg) => JSON.stringify(msg)).join('\n') + '\n');
  }
  function read(id, ms = 10_000) {
    const found = messages.find((msg) => msg.id === id);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error('等待薄壳应答超时 ' + id + '。' + stderr));
      }, ms);
      waiting.set(id, (msg) => { clearTimeout(timer); waiting.delete(id); resolve(msg); });
    });
  }
  async function connect() {
    send(initialize, initialized);
    assert.ok((await read(0)).result.serverInfo);
  }
  return { child, send, read, connect, closed, messages, stderr: () => stderr };
}

async function newPort() {
  const socket = createSocketServer();
  const port = await listen(socket);
  await new Promise((done) => socket.close(done));
  return port;
}

test('顾客零配置时薄壳使用说明书所列的正式端点，自动附上公开准入串', async t => {
  const dir = await sandbox(t);
  const endpoint = 'https://lichadecha.com/mcp';
  const readme = await readFile(join(root, 'docs', 'SERVER.md'), 'utf8');
  assert.ok(readme.includes(endpoint));
  assert.doesNotMatch(readme, /待替换的占位地址|内置公开占位串/);
  const local = await remote(t);
  // 只检查薄壳原本要访问的端点，所有 HTTP 请求均送本机模拟服务。
  const redirect = join(dir, 'mock-fetch.mjs');
  await writeFile(redirect, `
    const fetchLocal = globalThis.fetch;
    globalThis.fetch = (url, options) => {
      if (String(url) !== ${JSON.stringify(endpoint)}) throw Error('默认端点不符');
      return fetchLocal(${JSON.stringify(local.url)}, options);
    };`);
  const shell = startShell(t, dir, undefined, {
    env: { LICHA_ACCESS_KEY: undefined }, nodeArgs: ['--import', redirect]
  });
  await shell.connect();
  const header = local.requests[0].req.headers['x-licha-access'];
  assert.ok(header && header !== access);
});

test('SHL-01 干净目录离线安装根包后免编译，经 stdio 连接真实服务端列出工具', async (t) => {
  const dir = await sandbox(t);
  const npm = process.env.npm_execpath;
  const run = promisify(execFile);
  // npm test 与直接 node --test 都可运行。Windows 使用 npm 自带的 CLI，避免 shell 转义。
  const npmBin = npm || (process.platform === 'win32'
    ? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js') : 'npm');
  function invoke(args) {
    const cmd = npmBin.endsWith('.js') ? process.execPath : npmBin;
    const argv = npmBin.endsWith('.js') ? [npmBin, ...args] : args;
    return run(cmd, argv, { cwd: dir, env: {
      ...process.env, npm_config_cache: join(dir, 'cache'),
      npm_config_userconfig: join(dir, 'userconfig'), npm_config_globalconfig: join(dir, 'globalconfig'),
    } });
  }
  const consumer = join(dir, 'clean customer');
  await mkdir(consumer);
  const { stdout } = await invoke(['pack', root, '--ignore-scripts', '--offline', '--json', '--loglevel=error']);
  const [{ filename, files }] = JSON.parse(stdout);
  assert.ok(!files.some(({ path }) => /^(?:server|spec|test)\//.test(path)));
  await invoke(['install', '--prefix', consumer, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', join(dir, filename)]);

  const installed = join(consumer, 'node_modules', 'licha-order-mcp');
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  const port = await newPort();
  const base = 'http://127.0.0.1:' + port;
  const server = spawn(process.execPath, [join(root, 'server', 'main.js')], {
    cwd: dir, stdio: ['ignore', 'ignore', 'pipe'], env: {
      ...process.env, HOST: '127.0.0.1', PORT: String(port), LICHA_ACCESS_KEYS: access,
      LICHA_ENABLE_ORDERING: '0', LICHA_LOG_DIR: join(dir, 'logs'), LICHA_DATA_DIR: join(dir, 'data'),
      QMAI_BASE_URL: 'http://127.0.0.1:1/', QMAI_OPEN_ID: 'FAKE_ID', QMAI_OPEN_KEY: 'FAKE_KEY', QMAI_GRANT_CODE: 'FAKE_GRANT',
    },
  });
  let stderr = '';
  server.stderr.on('data', (data) => { stderr += data; });
  const exit = once(server, 'close');
  t.after(async () => { if (server.exitCode === null) server.kill(); await exit; });
  const deadline = Date.now() + 12_000;
  while (true) {
    if (server.exitCode !== null || Date.now() > deadline) throw new Error('服务端启动失败。' + stderr);
    if (await fetch(base + '/healthz').then((r) => r.ok, () => false)) break;
    await sleep(30);
  }
  const shell = startShell(t, dir, base + '/mcp', {entry:resolve(installed, manifest.bin['licha-order-mcp'])});
  await shell.connect();
  shell.send(list(1));
  assert.deepEqual((await shell.read(1)).result.tools.map((tool) => tool.name).sort(),
    ['find_store', 'get_item_detail', 'get_menu', 'preview_order']);
  shell.child.stdin.end();
  assert.equal(await shell.closed, 0);
});

test('SHL-02 两个进程首次并发启动取得同一个私有 UUID，重启复用，保存失败退出', async (t) => {
  const dir = await sandbox(t);
  const { url, requests } = await remote(t);
  const clients = [startShell(t, dir, url), startShell(t, dir, url)];
  await Promise.all(clients.map((c) => c.connect()));
  const [file] = await readdir(join(dir, 'device'));
  const target = join(dir, 'device', file);
  const id = (await readFile(target, 'utf8')).trim();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  if (process.platform !== 'win32') assert.equal((await stat(target)).mode & 0o777, 0o600);
  const restarted = startShell(t, dir, url);
  await restarted.connect();
  for (const { req } of requests) assert.equal(req.headers['x-licha-device'], id);
  const invalid = join(dir, 'ordinary-file');
  await writeFile(invalid, '', 'utf8');
  const broken = startShell(t, dir, url, {home:invalid});
  assert.notEqual(await broken.closed, 0);
  assert.deepEqual(broken.messages, []);
  assert.match(broken.stderr(), /设备/);
});

test('SHL-03 SHL-04 SHL-05 握手屏障、请求编号、SSE 和透明答复，诊断脱敏', async (t) => {
  const dir = await sandbox(t);
  let accepted = false;
  const { url, requests } = await remote(t, async ({ message, res }) => {
    if (message?.method === 'initialize') {
      await sleep(180);
      accepted = true;
    } else if (message?.method === 'tools/list') {
      assert.ok(accepted);
      await sleep(message.id === 10 ? 100 : 1);
      const msg = result(message.id, { tools: [testTool], _meta: { keep: '原样' } });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('event: message\r\ndata: ' + JSON.stringify(msg) + '\r\n\r\n');
      return true;
    }
  });
  const shell = startShell(t, dir, url);
  shell.send(initialize, initialized, list(10), list(11), call('opaque-request'));
  const [a, b, c] = await Promise.all([shell.read(10), shell.read(11), shell.read('opaque-request')]);
  assert.deepEqual(a, result(10, { tools: [testTool], _meta: { keep: '原样' } }));
  assert.deepEqual(b, { ...a, id: 11 });
  assert.deepEqual(c.result, { content: [{ type: 'text', text: '原样答复' }] });
  assert.deepEqual(requests.slice(0, 2).map((p) => p.message), [initialize, initialized]);
  for (const expected of [list(10), list(11), call('opaque-request')]) {
    assert.deepEqual(requests.find((p) => p.message?.id === expected.id)?.message, expected);
  }
  const id = requests[0].req.headers['x-licha-device'];
  for (const { req, session, message } of requests) {
    assert.equal(req.headers['x-licha-access'], access);
    assert.equal(req.headers['x-licha-device'], id);
    if (message.method !== 'initialize') assert.equal(session, 'session-1');
  }
  shell.child.stdin.write('{bad input ' + access + ' ' + id + '\n');
  shell.child.stdin.end();
  await shell.closed;
  assert.match(shell.stderr(), /标准输入/);
  assert.ok(!shell.stderr().includes(access) && !shell.stderr().includes(id));
});

test('SHL-06 并发标记 404 只重建一次，每个原请求仅补发一次', async (t) => {
  const dir = await sandbox(t);
  const { url, requests } = await remote(t, async ({ message, session, res }) => {
    if (!message) return;
    if (message.method === 'tools/call' && (session === 'session-1' || message.id === 2)) {
      await sleep(message.id === 2 ? 50 : 20);
      res.writeHead(404, { 'x-licha-reason': 'session-not-found' }).end();
      return true;
    }
  });
  const shell = startShell(t, dir, url);
  await shell.connect();
  shell.send(call(1), call(2));
  assert.ok((await shell.read(1)).result.content);
  const failure = (await shell.read(2)).result;
  assert.equal(failure.isError, true);
  assert.match(failure.content[0].text, /不要重新组单/);
  for (const id of [1, 2]) {
    assert.deepEqual(requests.filter((p) => p.message?.id === id).map((p) => p.session),
      ['session-1', 'session-2']);
  }
  assert.equal(requests.filter((p) => p.message?.method === 'initialize').length, 2);
  assert.equal(requests.filter((p) => p.message?.method === 'notifications/initialized').length, 2);
  shell.send(list(3));
  assert.ok((await shell.read(3)).result.tools);
});

test('SHL-07 普通 404、断连、5xx、畸形应答和超时均不重发，薄壳继续服务', async (t) => {
  const dir = await sandbox(t);
  const { url, requests } = await remote(t, ({ message, res }) => {
    if (message?.method !== 'tools/call') return;
    switch (message.id) {
      case 1: res.writeHead(404).end(); break;
      case 2: res.destroy(); break;
      case 3: res.writeHead(503).end(); break;
      case 4: res.writeHead(200, { 'content-type': 'application/json' }).end('{'); break;
      case 5: break; // 保留打开的响应，等待薄壳自己的真实超时。
    }
    return true;
  });
  const shell = startShell(t, dir, url, { env: { LICHA_SHELL_TIMEOUT_MS: '2000' } });
  await shell.connect();
  const ids = [1, 2, 3, 4, 5];
  shell.send(...ids.map(call));
  const responses = await Promise.all(ids.map((id) => shell.read(id)));
  for (const { result } of responses) {
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /可能已经被处理.*先查我的订单核对.*不要重新组单/);
  }
  assert.equal(requests.filter((p) => p.message?.method === 'initialize').length, 1);
  assert.equal(requests.filter((p) => p.message?.method === 'tools/call').length, ids.length);
  shell.send(list(8));
  assert.ok((await shell.read(8)).result.tools);
});

test('SHL-08 输入关闭后 DELETE 会话，404 或挂起均有界退出且不重建', async (t) => {
  const dir = await sandbox(t);
  for (const failure of ['404', 'hang']) {
    const { url, requests } = await remote(t, ({ req, res }) => {
      if (req.method !== 'DELETE') return;
      if (failure === '404') res.writeHead(404, { 'x-licha-reason': 'session-not-found' }).end();
      return true;
    });
    const shell = startShell(t, dir, url);
    await shell.connect();
    shell.send(list(1));
    await shell.read(1);
    const started = performance.now();
    shell.child.stdin.end();
    assert.equal(await shell.closed, 0);
    assert.ok(performance.now() - started < 3000);
    assert.equal(requests.filter((p) => p.message?.method === 'initialize').length, 1);
    const finished = requests.filter((p) => p.req.method === 'DELETE');
    assert.equal(finished.length, 1);
    assert.equal(finished[0].req.headers['mcp-session-id'], 'session-1');
    assert.equal(finished[0].req.headers['x-licha-access'], access);
  }
});

test('SHL-08 重建中关闭输入，结束最新远端会话且不再补发工具请求', async (t) => {
  const dir = await sandbox(t);
  for (const closeDuring of ['initialize', 'notifications/initialized']) {
    let opens = 0;
    let client;
    const { url, requests } = await remote(t, async ({ message, session, res }) => {
      if (message?.method === 'initialize' && ++opens === 2 && closeDuring === 'initialize') {
        client.child.stdin.end();
        await sleep(100); // EOF 到达时，新会话 ID 仍在路上。
      }
      if (message?.method === 'notifications/initialized' && session === 'session-2'
          && closeDuring === 'notifications/initialized') {
        client.child.stdin.end();
        return true; // 新会话 ID 已知，通知的 HTTP 响应挂起。
      }
      if (message?.method === 'tools/list' && session === 'session-1') {
        res.writeHead(404, { 'x-licha-reason': 'session-not-found' }).end();
        return true;
      }
    });
    client = startShell(t, dir, url);
    await client.connect();
    client.send(list(7));
    assert.equal(await client.closed, 0);
    assert.equal(opens, 2);
    const terminated = requests.filter((p) => p.req.method === 'DELETE').map((p) => p.session);
    assert.deepEqual(terminated, ['session-2']);
    assert.equal(requests.filter((p) => p.message?.method === 'tools/list').length, 1);
  }
});

test('SHL-06 同批标记 404 共享重建失败结果，后续独立请求仍可恢复', async (t) => {
  const dir = await sandbox(t);
  let opens = 0;
  const firstBatch = new Map();
  const { url, requests } = await remote(t, ({ message, session, res }) => {
    if (message?.method === 'initialize' && ++opens === 2) {
      res.writeHead(503).end();
      return true;
    }
    if (session === 'session-1' && message?.method === 'tools/list') {
      if (message.id <= 2) {
        firstBatch.set(message.id, res);
        if (firstBatch.size === 2) firstBatch.get(1).writeHead(404, { 'x-licha-reason': 'session-not-found' }).end();
      } else {
        res.writeHead(404, { 'x-licha-reason': 'session-not-found' }).end();
      }
      return true;
    }
  });
  const client = startShell(t, dir, url);
  await client.connect();
  client.send(list(1), list(2));
  assert.ok((await client.read(1)).error);
  firstBatch.get(2).writeHead(404, { 'x-licha-reason': 'session-not-found' }).end();
  assert.ok((await client.read(2)).error);
  assert.equal(opens, 2); // 一次原始握手和一次失败的重建。
  client.send(list(3));
  assert.deepEqual((await client.read(3)).result.tools, [testTool]);
  assert.equal(opens, 3);
  assert.deepEqual(requests.filter((p) => p.message?.method === 'tools/list').map((p) => p.message.id).sort(),
    [1, 2, 3, 3]);
});

test('SHL-07 调用超时后服务端才返回成功，薄壳只报错一次且不重放', async (t) => {
  const dir = await sandbox(t);
  // 挂起工具调用，等薄壳报超时后再回送成功。握手和列工具照常应答。
  const { url, requests } = await remote(t, ({ message }) => message?.method === 'tools/call');
  const shell = startShell(t, dir, url, { env: { LICHA_SHELL_TIMEOUT_MS: '2000' } });
  await shell.connect();
  shell.send(call(1));
  const failure = (await shell.read(1)).result;
  assert.equal(failure.isError, true);
  assert.match(failure.content[0].text, /先查我的订单核对/);

  const order = requests.find(({ message }) => message?.method === 'tools/call');
  assert.deepEqual(order?.message, call(1));
  respond(order.res, result(1, { content: [{ type: 'text', text: '迟到的成功回包' }] }));
  shell.send(list(2));
  assert.deepEqual((await shell.read(2)).result.tools, [testTool]);
  shell.child.stdin.end();
  assert.equal(await shell.closed, 0);
  assert.equal(shell.messages.filter(({ id }) => id === 1).length, 1);
  assert.equal(requests.filter(({ message }) => message?.method === 'tools/call').length, 1);
});

test('SHL-02 禁用硬链接并延迟首次写入，两个薄壳仍共用私有设备文件',async t => {
  const dir = await sandbox(t);
  const hook = join(dir,'no-links.cjs');
  await writeFile(hook,`
const fs = require('node:fs/promises');
const {syncBuiltinESMExports} = require('node:module');
const {setTimeout:delay} = require('node:timers/promises');
const open = fs.open;
fs.link = async () => { throw Object.assign(Error('No hard links'), {code:'EOPNOTSUPP'}); };
fs.open = async (...args) => {
  const handle = await open(...args);
  if (args[1] === 'wx') await delay(400);
  return handle;
};
syncBuiltinESMExports();
`);
  const {url,requests} = await remote(t);
  const options = {nodeArgs:['--require',hook]};
  const clients = [startShell(t,dir,url,options),startShell(t,dir,url,options)];
  await Promise.all(clients.map(c=>c.connect()));
  const saved = (await readFile(join(dir,'device','device-id'),'utf8')).trim();
  const ids = requests.filter(r=>r.message?.method === 'initialize').map(r=>r.req.headers['x-licha-device']);
  assert.deepEqual(ids,[saved,saved]);
  assert.match(saved,/^[a-f0-9-]{36}$/);
  if (process.platform !== 'win32') assert.equal((await stat(join(dir,'device','device-id'))).mode & 0o777,0o600);
});
