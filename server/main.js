import http from 'node:http';
import { readFileSync } from 'node:fs';
import { readConfig } from './config.js';
import { createLogs } from './logs.js';
import { Qmai } from './qmai.js';
import { Browse } from './browse.js';
import { createCommerce } from './commerce.js';
import { makeEndpoint } from './session.js';

async function start() {
  const config = readConfig();
  const {version} = JSON.parse(readFileSync(new URL('./package.json',import.meta.url)));
  const logs = createLogs(config);
  const qmai = new Qmai(config,logs.upstream);
  const browse = new Browse(config,qmai);
  const commerce = config.LICHA_ENABLE_ORDERING ? await createCommerce(config,qmai,browse,logs) : null;
  const endpoint = makeEndpoint({version,config,logs,qmai,browse,commerce});
  const server = http.createServer((req,res) => {
    endpoint.handle(req,res).catch(() => {
      if (!res.headersSent) res.writeHead(500,{'content-type':'text/plain; charset=utf-8'});
      res.end('服务暂时不可用。');
    });
  });
  try {
    await new Promise((resolve,reject) => {
      server.once('error',reject);
      server.listen(config.PORT,config.HOST,resolve);
    });
  } catch {
    await commerce?.close();
    throw new Error('无法监听，请检查 HOST 与 PORT。');
  }
  logs.access({event:'startup',version,pid:process.pid,ordering:!!commerce,dataDir:config.LICHA_DATA_DIR});
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    server.close();
    await endpoint.close();
    // 在途写入可能尚未取得终态。退出时由账本的发送前记录接管。
    process.exit(0);
  }
  process.on('SIGTERM',stop);
  process.on('SIGINT',stop);
}
start().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
