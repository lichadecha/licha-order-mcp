// 审计日志目录的解析（M5 前置修复第 2 项，施工令 § 8 第 24 条）。
//
// 修的是什么：三个审计日志的路径原本都写成「从本模块的编译产物位置往上数两级」
// （dist/src/x.js → ../.. → mcp-server/）。这个写法把日志位置绑在了**编译产物的目录层级**上，
// 而那个层级是 tsconfig 的 rootDir/outDir 决定的、改一次就漂一次——实际后果已经发生：
// 同一本 audit.log 分裂成了两份（项目根 logs/ 20 条 + mcp-server/logs/ 227 条）。
//
// 为什么这不只是"日志乱了"：写审计日志同时是频次护栏的持久化载体（重启后按它重建当日计数）。
// 路径一漂，重建就读到一本空的或旧的日志，「单日 ≤5 单」被**静默**清零——护栏看起来还在，
// 其实已经不设防。日志路径在这个系统里是护栏的一部分，不是运维细节。
//
// 改成什么：
//   ① 环境变量 LICHA_LOG_DIR 优先——部署时想把日志放哪就放哪，显式压过一切推算；
//   ② 缺省锚定到**package.json 所在目录**下的 logs/——向上查找而不是数层级，
//      无论从 src/ 直接跑还是从 dist/src/ 跑、无论 outDir 怎么改，都落到同一个 mcp-server/logs/。
//
// 红线：本文件不发起任何网络请求，只做路径计算。

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 向上查找的层数上限：正常至多 2-3 级就命中，给到 10 级纯粹是防死循环的兜底。 */
const MAX_LOOKUP_DEPTH = 10;

/**
 * 从本模块所在目录逐级向上找 package.json，返回它所在的目录（= 工程根 mcp-server/）。
 * 找不到时回退到「往上两级」这个改造前的老行为——宁可退回旧路径，也不要在一个
 * 谁都想不到的地方（比如文件系统根目录）建 logs/。
 */
function findPackageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < MAX_LOOKUP_DEPTH; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break; // 已经到文件系统根
    dir = parent;
  }
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * 审计日志目录。LICHA_LOG_DIR 优先（相对路径按进程 cwd 解析），否则 <package.json 所在目录>/logs。
 * 每次调用都重新读环境变量——测试要切换目录时不必绕过模块级缓存。
 */
export function resolveLogDir(): string {
  const fromEnv = process.env.LICHA_LOG_DIR;
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());
  return join(findPackageRoot(), "logs");
}

/** 审计日志文件的完整路径，如 logFilePath("audit.log")。 */
export function logFilePath(fileName: string): string {
  return join(resolveLogDir(), fileName);
}
