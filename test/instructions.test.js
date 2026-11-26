import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { rig } from '../test-support/rig.js';

const shellEntry = fileURLToPath(new URL('../bin/licha-order-mcp.js', import.meta.url));

// 工具契约 §0.2：逐字照抄，行间 \n，末尾无换行。这里故意不复用 server/instructions.js，避免自己验自己。
const orderingText = `这是李茶的茶点单服务。顾客装它只为一件事：点一杯李茶的茶。
刚装好时只对顾客说一句：「好了，现在可以帮你点李茶的茶了。想喝点什么？」不要反问顾客要不要点单，也不要讲安装经过。
对顾客只说结果：不提 MCP、工具名、安装、配置、命令、报错细节和内部编号（订单号除外）。
下单前把会员尾号、门店、每杯的规格做法与杯数、优惠、金额念给顾客，等他明确说「确认」才提交。付款只在李茶小程序，由顾客本人完成。只做到店堂食或自取，不做外卖。
完整的点单说明在 GitHub 仓库 lichadecha/licha-order-mcp 的 SKILL.md。`;
const browseOnlyText = `这是李茶的茶点单服务，这一套只能看菜单和组单，不能下单。
刚装好时只对顾客说一句：「好了，现在可以帮你看李茶的茶的菜单、把单组好，下单要你自己在李茶小程序里点。想喝点什么？」不要讲安装经过。
对顾客只说结果：不提 MCP、工具名、安装、配置、命令、报错细节和内部编号。
只做到店堂食或自取，不做外卖。
完整的点单说明在 GitHub 仓库 lichadecha/licha-order-mcp 的 SKILL.md。`;

test('RCP-01 开通下单时，初始化答复的 instructions 逐字等于「开通下单」文案', async t => {
  const server = await rig(t);
  const session = await server.session();
  assert.equal(session.handshake.instructions, orderingText);
  assert.ok(!session.handshake.instructions.endsWith('\n'));
});

test('RCP-01 只开浏览时（未设置开关），初始化答复的 instructions 逐字等于「只开浏览」文案', async t => {
  const server = await rig(t, {env: {LICHA_ENABLE_ORDERING: undefined, LICHA_SMS_EVENT_NO: undefined}});
  const session = await server.session();
  assert.equal(session.handshake.instructions, browseOnlyText);
  assert.ok(!session.handshake.instructions.endsWith('\n'));
});

test('RCP-01 开关不精确等于 1（如 true）时按只开浏览给说明', async t => {
  const server = await rig(t, {env: {LICHA_ENABLE_ORDERING: 'true', LICHA_SMS_EVENT_NO: undefined}});
  assert.equal((await server.session()).handshake.instructions, browseOnlyText);
});

async function shellHandshake(t, server) {
  const home = await mkdtemp(join(tmpdir(), 'licha-rcp-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const child = spawn(process.execPath, [shellEntry], {
    env: {...process.env, LICHA_HOME: home, LICHA_MCP_URL: server.url + '/mcp', LICHA_ACCESS_KEY: server.env.LICHA_ACCESS_KEYS},
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const closed = once(child, 'close');
  t.after(async () => { child.kill('SIGKILL'); await closed; });
  const lines = createInterface({input: child.stdout, crlfDelay: Infinity});
  const reply = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待薄壳应答超时')), 10_000);
    lines.on('line', line => {
      const message = JSON.parse(line);
      if (message.id !== 0) return;
      clearTimeout(timer);
      resolve(message);
    });
  });
  child.stdin.write(JSON.stringify({jsonrpc: '2.0', id: 0, method: 'initialize', params: {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: {name: 'test', version: '0'}
  }}) + '\n');
  return reply;
}

test('RCP-01 SHL-03 经薄壳握手拿到的 instructions 与服务端一致，薄壳不另加不改写', async t => {
  const server = await rig(t);
  const viaShell = await shellHandshake(t, server);
  assert.equal(viaShell.result.instructions, orderingText);
});
