#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StdioServerTransport, EventSourceParserStream } from './protocol-runtime.js';
import { deviceId } from './device.js';

const defaultUrl = 'https://licha-mcp.invalid/mcp';
const defaultAccess = 'PUBLIC_LICHA_ACCESS_PLACEHOLDER';
class StartupError extends Error {}
const diagnostic = (message) => process.stderr.write(message + '\n');

async function run() {
  const timeout = process.env.LICHA_SHELL_TIMEOUT_MS ?? '75000';
  const requestTimeoutMs = Number(timeout);
  if (!/^\d+$/.test(timeout) || requestTimeoutMs < 1 || requestTimeoutMs > 2147483647) {
    throw new StartupError('LICHA_SHELL_TIMEOUT_MS 须为 1 到 2147483647 之间的整数毫秒。');
  }
  let device;
  try { device = await deviceId(process.env.LICHA_HOME ?? join(homedir(), '.licha')); }
  catch {
    throw new StartupError('无法读写设备 ID。请在 AI 客户端的 MCP 环境变量中，将 LICHA_HOME 设为本人可写的本地目录，再重启客户端。使用新目录后需要重新绑定会员。');
  }
  const url = new URL(process.env.LICHA_MCP_URL ?? defaultUrl);
  const isLocal = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) {
    throw new Error('服务端地址无效。');
  }
  const access = process.env.LICHA_ACCESS_KEY ?? defaultAccess;
  const stdio = new StdioServerTransport();
  let current;
  let latestRemoteSession;
  let opening;
  let initialization;
  let barrier = Promise.resolve();
  let closing = false;

  function headers(session) {
    const result = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-licha-access': access,
      'x-licha-device': device,
    };
    if (session) {
      result['mcp-session-id'] = session.id;
      result['mcp-protocol-version'] = session.version;
    }
    return result;
  }

  async function post(message, session, emit = true) {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST', redirect: 'error', headers: headers(session),
        body: JSON.stringify(message), signal: controller.signal,
      });
      if (!response.ok) {
        const error = new Error('服务端未接受请求。');
        error.sessionMissing = response.status === 404
          && response.headers.get('x-licha-reason') === 'session-not-found';
        throw error;
      }
      let reply;
      const expectsReply = 'method' in message && 'id' in message;
      async function accept(event) {
        if (event?.jsonrpc !== '2.0') throw new Error('服务端应答无效。');
        if ('result' in event || 'error' in event) {
          if (!expectsReply || event.id !== message.id) throw new Error('服务端应答编号无效。');
          reply = event;
        } else if (emit) {
          await stdio.send(event);
        }
      }

      if (response.status !== 202 && response.status !== 204) {
        if (response.headers.get('content-type')?.startsWith('text/event-stream')) {
          const events = response.body.pipeThrough(new TextDecoderStream())
            .pipeThrough(new EventSourceParserStream());
          const reader = events.getReader();
          try {
            while (!reply) {
              const { done, value } = await reader.read();
              if (done) break;
              if ((!value.event || value.event === 'message') && value.data) {
                await accept(JSON.parse(value.data));
              }
            }
          } finally {
            reader.releaseLock();
          }
        } else {
          await accept(await response.json());
        }
      }
      if (expectsReply && !reply) throw new Error('服务端没有返回完整答复。');
      return { reply, id: response.headers.get('mcp-session-id') };
    } finally {
      clearTimeout(deadline);
      controller.abort();
    }
  }

  async function openRemote(message, silent) {
    const { reply, id } = await post(message, undefined, !silent);
    if (reply?.error) return { reply };
    if (!id || !reply?.result?.protocolVersion) throw new Error('握手失败。');
    const session = { id, version: reply.result.protocolVersion, recovery: {} };
    // 收到 ID 就能关闭这个会话，工具调用仍须等 initialized 通知完成。
    latestRemoteSession = session;
    return { reply, session };
  }

  async function initialize(message, silent) {
    const handshake = openRemote(message, silent);
    opening = handshake;
    try {
      const { session, reply } = await handshake;
      if (!silent && !closing) await stdio.send(reply);
      return session;
    } finally {
      if (opening === handshake) opening = undefined;
    }
  }

  async function rebuild(expired, recovery, original) {
    if (current !== expired) return current;
    if (!recovery.promise) {
      recovery.promise = (async () => {
        const session = await initialize(initialization, true);
        if (!session) throw new Error('重建会话失败。');
        if (!closing && original.method !== 'notifications/initialized') {
          await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, session, false);
        }
        current = session;
        return session;
      })().catch((error) => {
        // 已发出的请求共享此次失败；之后新到的请求可以重新尝试恢复。
        expired.recovery = {};
        throw error;
      });
    }
    return recovery.promise;
  }

  async function forward(message) {
    if (closing) return;
    const session = current;
    if (!session) throw new Error('尚未建立会话。');
    const recovery = session.recovery;
    let result;
    try {
      result = await post(message, session);
    } catch (error) {
      if (!error.sessionMissing || closing) throw error;
      const replacement = await rebuild(session, recovery, message);
      if (closing) return;
      result = await post(message, replacement);
    }
    if (result.reply) await stdio.send(result.reply);
  }

  function reportFailure(message) {
    const text = message.method === 'tools/call'
      ? '这次调用可能已经被处理；如果刚才是在下单，请先查我的订单核对，不要重新组单。'
      : '无法取得服务端答复，请稍后再试。';
    if ('method' in message && 'id' in message) {
      const failure = message.method === 'tools/call'
        ? { result: { isError: true, content: [{ type: 'text', text }] } }
        : { error: { code: -32603, message: text } };
      return stdio.send({ jsonrpc: '2.0', id: message.id, ...failure });
    }
    diagnostic(text);
  }

  stdio.onmessage = (message) => {
    if (closing) return;
    if (message.method === 'initialize') {
      initialization = message;
      barrier = initialize(message, false).then((session) => { current = session; })
        .catch(() => reportFailure(message));
    } else {
      const completed = barrier.then(() => forward(message)).catch(() => reportFailure(message));
      if (message.method === 'notifications/initialized') barrier = completed;
    }
  };
  stdio.onerror = () => diagnostic('无法读取标准输入中的 MCP 消息。');

  async function close() {
    if (closing) return;
    closing = true;
    // 包括等待正在进行的握手在内，关闭过程共用一个时限。
    const deadline = setTimeout(() => process.exit(0), 2800);
    try {
      await opening?.catch(() => {});
      if (latestRemoteSession) {
        await fetch(url, { method: 'DELETE', headers: headers(latestRemoteSession), redirect: 'error' });
      }
      await stdio.close();
    } catch {
      diagnostic('服务端会话已断开。');
    } finally {
      clearTimeout(deadline);
      process.exit(0);
    }
  }
  process.stdin.once('end', close);
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  await stdio.start();
}

run().catch((error) => {
  diagnostic(error instanceof StartupError ? error.message : '薄壳启动失败，请检查服务端地址配置。');
  process.exitCode = 1;
});
