// 25 号任务书 C4（盲审 B05）：MCP 外部出口投影。
//
// 问题面：企迈上游的 message 文本在六处出口被原样拼进返回给客户端的 MCP JSON。日志层脱敏（P-W2）
// 已完备，但返回给 Agent 的这一侧没有——盲审合成的假手机号、`openKey=` 片段都能从这里出去。
// 这里只做**字符串投影**，不做错误码映射表、不改日志层、不新建框架。

/** 上游 message 最多保留的字符数（按 Unicode 码点计，不按 UTF-16 单元）。 */
const MAX_UPSTREAM_CHARS = 80;

// 15 位以上数字串：企迈 19 位大数 ID（customerId / orderNo / cardId）一类。先于手机号规则匹配，
// 两条规则用 (?<!\d)/(?!\d) 边界互斥，谁先谁后都不会把 19 位切成 11 位 + 8 位。
const LONG_DIGITS_RE = /(?<!\d)\d{15,}(?!\d)/g;
// 11 位手机号：1 开头、第二位 3-9。
const PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
// URL：整段抹掉——上游错误里若带回调地址、文档链接，Agent 不需要、顾客更不需要。
const URL_RE = /https?:\/\/[^\s'"<>）)】\]]+/gi;
// `key=` / `token=` / `secret=` 形态：键名含这些词（裸词 `token:` 也算）、后面跟 = 或 : 再跟一段非分隔符。整段抹掉，键名也不留
//（留键名等于告诉读者"这里原来有一把钥匙"）。
const CREDENTIAL_PAIR_RE = /\b[A-Za-z0-9_]*(?:key|token|secret)[A-Za-z0-9_]*\s*[=:：]\s*[^\s,;，；、)）\]】]+/gi;

function tail4(digits: string): string {
  return `***${digits.slice(-4)}`;
}

/**
 * 把上游（企迈）返回的 message 投影成可以放进 MCP 出参的文本。
 *
 * 规则（按序）：URL 与 key=/token=/secret= 片段整段抹掉 → 15 位以上数字串与 11 位手机号遮成尾号 →
 * 空白压成单空格 → 截到 80 字。非字符串输入返回空串，调用方用 `|| "未知错误"` 一类兜底。
 *
 * 只投影上游文本；我们自己拼的 hint 由调用方在投影之后再接上，不经过这里。
 */
export function projectUpstreamMessage(message: unknown): string {
  if (typeof message !== "string") return "";
  const scrubbed = message
    .replace(URL_RE, "")
    .replace(CREDENTIAL_PAIR_RE, "")
    .replace(LONG_DIGITS_RE, tail4)
    .replace(PHONE_RE, tail4)
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(scrubbed);
  if (chars.length <= MAX_UPSTREAM_CHARS) return scrubbed;
  return `${chars.slice(0, MAX_UPSTREAM_CHARS).join("")}…`;
}
