// 凭证读取 + 拆封 + 签名 + 官方测试向量自检
// 红线：openKey 不进日志、不进错误信息、不进 git、不进 MCP 工具输出。

import { createHmac } from "node:crypto";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Credentials {
  openKey: string;
  openId: string;
  grantCode: string;
  source: string;
}

// 拆封（v6 实锤）：keychain 存的是 `go-keyring-base64:<base64>` 封装串，
// 须去前缀并 base64 解码得到 50 字符真 key。拆不动时按裸串返回。
export function unwrapKey(raw: string): string {
  const text = raw.trim();
  if (text.includes(":")) {
    const payload = text.slice(text.indexOf(":") + 1);
    try {
      const decoded = Buffer.from(payload, "base64").toString("utf8");
      if (/^[\x20-\x7e]+$/.test(decoded) && decoded.length >= 40 && decoded.length <= 64) {
        return decoded;
      }
    } catch {
      // 落入裸串兜底
    }
  }
  return text;
}

function readKeychain(): string {
  const out = execSync("security find-generic-password -s qmai-cli -w", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return out.trim();
}

// ~/.config/qmai/config.yaml：active_profile 指向段下的 open_id / grant_code
function readConfigFile(): { openId?: string; grantCode?: string } {
  const txt = readFileSync(join(homedir(), ".config", "qmai", "config.yaml"), "utf8");
  const active = txt.match(/^active_profile:\s*([^\s#]+)/m)?.[1] ?? "default";
  const lines = txt.split("\n");
  let inProfiles = false;
  let inTarget = false;
  let profileIndent = -1;
  const found: { openId?: string; grantCode?: string } = {};
  for (const line of lines) {
    if (/^profiles:\s*$/.test(line)) {
      inProfiles = true;
      continue;
    }
    if (!inProfiles) continue;
    const m = line.match(/^(\s+)([\w-]+):\s*(.*)$/);
    if (!m) {
      if (line.trim() && !line.startsWith(" ")) break;
      continue;
    }
    const indent = m[1].length;
    const key = m[2];
    const val = m[3].trim().replace(/^["']|["']$/g, "");
    if (profileIndent === -1) profileIndent = indent;
    if (indent < profileIndent) break;
    if (indent === profileIndent) {
      inTarget = key === active;
      continue;
    }
    if (inTarget && indent > profileIndent) {
      if (key === "open_id") found.openId = val;
      if (key === "grant_code") found.grantCode = val;
    }
  }
  return found;
}

// 优先级：环境变量 > 本地配置（keychain + config.yaml）
export function loadCredentials(): Credentials {
  let openKey = process.env.QMAI_OPEN_KEY;
  let openId = process.env.QMAI_OPEN_ID;
  let grantCode = process.env.QMAI_GRANT_CODE;
  const sources: string[] = [];

  if (!openKey) {
    openKey = unwrapKey(readKeychain());
    sources.push("keychain(已拆封)");
  } else {
    sources.push("env");
  }
  if (!openId || !grantCode) {
    const cfg = readConfigFile();
    openId = openId ?? cfg.openId;
    grantCode = grantCode ?? cfg.grantCode;
    sources.push("config.yaml");
  } else {
    sources.push("env");
  }
  if (!openKey || !openId || !grantCode) {
    throw new Error("凭证不完整：缺少 openKey/openId/grantCode 中的一项或多项");
  }
  return { openKey, openId, grantCode, source: sources.join("+") };
}

// 签名（v6 实锤版）：4 字段按字典序拼接 → HmacSHA1 → Base64 → URL Encode。
// nonce / timestamp 在请求体中为数字类型；token 每请求现签，禁止缓存复用。
export function sign(
  openKey: string,
  grantCode: string,
  nonce: number,
  openId: string,
  timestamp: number,
): { sig: string; token: string } {
  const raw = `grantCode=${grantCode}&nonce=${nonce}&openId=${openId}&timestamp=${timestamp}`;
  const sig = createHmac("sha1", openKey).update(raw, "utf8").digest("base64");
  return { sig, token: encodeURIComponent(sig) };
}

// 内置自检（启动必跑，不过则拒绝启动）——官方测试向量
//
// ⚠️ 给密钥扫描器与代码审计者的说明（2026-08-18 双外部审计后补，总工裁决入档）：
// 下面 v 对象里的 openKey / grantCode / openId / nonce / timestamp / 期望签名，
// 是**企迈官方文档 doc264 公开印发的签名测试向量**——官方文档里逐字给出、全网开发者可见，
// 用途就是让接入方验证自己的 HmacSHA1 实现算得对不对。
//   · 归档对照物（可自行核验）：上级项目 `【归档】/outputs/T2_step0_doc264.json`，
//     七项值逐一在该文档快照中精确命中；
//   · 它**不是任何真实凭证**：既不是本项目的、也不是老板账户的，拿它调不通任何接口
//     （已实测：老板现役真实凭证与这里 0 交集）；
//   · 因此**第三方密钥扫描器命中这几行属于预期误报**——形态像凭证（50 位高熵串）是必然的，
//     测试向量本来就得长成凭证的样子，否则测不出签名实现的问题。
//
// 为什么留着不改（总工 2026-08-18 裁决）：一次外部审计按「40+ 位高熵串零容忍」的形态规则
// 判它是泄密、要求重写公开仓四分支三标签的历史；溯源核验后定性为官方公开示例值，不重写。
// 重写会让 v0.2.1 / v0.3.0 / v0.3.1 三个 tag 全部换 hash，砸掉 README 的装机锚点与一期
// 发布承诺——代价远大于一个并不存在的泄密。
// 口径教训一并记在这里：**形态扫描的命中要先溯源再定性，零容忍规则必须给「官方公开示例值」
// 留一条定性通道**，否则规则本身会制造出比它防的风险更大的动作。
export function selfTest(): void {
  const v = {
    openKey: "LyvrkvkxRkG2R6aM55bXpPwjYAbkEXTbVnKwfDYvVHjNwNFAmx",
    grantCode: "ba67d4fa46",
    nonce: 11886,
    openId: "d14c1559e87b747d577c834b275a4310",
    timestamp: 1465185768,
    expectSig: "cFw0t9IuvL9jVo9qAzk0qMcw5BM=",
    expectToken: "cFw0t9IuvL9jVo9qAzk0qMcw5BM%3D",
  };
  const { sig, token } = sign(v.openKey, v.grantCode, v.nonce, v.openId, v.timestamp);
  if (sig !== v.expectSig) throw new Error("签名自检失败：sig 与官方测试向量不符");
  if (token !== v.expectToken) throw new Error("签名自检失败：token 编码与官方测试向量不符");
  console.log("签名自检通过（官方测试向量）");
}
