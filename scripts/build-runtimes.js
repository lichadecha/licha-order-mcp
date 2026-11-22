// 把两个独立包实际使用的第三方协议代码和授权文本随源码交付。
// 这是维护者更新依赖时才运行的命令，没有顾客安装或启动钩子。
import { build } from 'esbuild';
import { isBuiltin } from 'node:module';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..',import.meta.url));
const runtimes = [
  {
    directory:root, output:'bin/protocol-runtime.js', target:'node18',
    exports:[
      "export {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';",
      "export {EventSourceParserStream} from 'eventsource-parser/stream';"
    ]
  },
  {
    directory:join(root,'server'), output:'protocol-runtime.js', target:'node22',
    exports:[
      "export {Server} from '@modelcontextprotocol/sdk/server/index.js';",
      "export {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';",
      "export {CallToolRequestSchema, InitializeRequestSchema, ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';",
      "export {default as Ajv} from 'ajv';"
    ]
  }
];

async function writeLicenses(directory, output, inputs) {
  const packages = new Set();
  for (const input of inputs) {
    const match = input.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
    if (match) packages.add(resolve(directory,match[1]));
  }
  const notices = [];
  for (const location of packages) {
    const manifest = JSON.parse(await readFile(join(location,'package.json'),'utf8'));
    const files = (await readdir(location)).filter(name => /^(license|licence|copying|notice)(\..*)?$/i.test(name)).sort();
    if (!files.length) throw Error('缺少依赖授权文本：'+manifest.name);
    const bodies = await Promise.all(files.map(name => readFile(join(location,name),'utf8')));
    notices.push(manifest.name+' '+manifest.version+'\n\n'+bodies.map(body=>body.trim()).join('\n\n'));
  }
  await writeFile(join(dirname(output),'THIRD-PARTY-LICENSES.txt'),notices.sort().join('\n\n--------------------\n\n')+'\n');
}

for (const runtime of runtimes) {
  const {directory, output, target} = runtime;
  const destination = join(directory,output);
  const result = await build({
    absWorkingDir:directory, stdin:{contents:runtime.exports.join('\n'),resolveDir:directory},
    outfile:destination, platform:'node',target,format:'esm',bundle:true,minify:true,
    metafile:true,legalComments:'inline',charset:'utf8',
    banner:{js:"// 第三方协议运行库。授权见同目录 THIRD-PARTY-LICENSES.txt；更新命令见 README.md。\nimport {createRequire as createRuntimeRequire} from 'node:module';const require=createRuntimeRequire(import.meta.url);"}
  });
  for (const artifact of Object.values(result.metafile.outputs)) {
    for (const reference of artifact.imports) {
      if (reference.external && !isBuiltin(reference.path)) throw Error('运行库仍引用外部包：'+reference.path);
    }
  }
  await writeLicenses(directory,destination,Object.keys(result.metafile.inputs));
}
