# 李茶的茶点单 MCP 运行说明

服务端启动命令（Node 22.13 或更高的 22.x，先设置下表中的环境变量）

```text
node "/绝对路径/licha-order-mcp/server/main.js"
```

顾客端薄壳启动命令（Node 18 及以上，标准输入输出连接 MCP 客户端）

```text
node "/绝对路径/licha-order-mcp/bin/licha-order-mcp.js"
```

把 `/绝对路径/licha-order-mcp` 换成仓库实际所在位置，两条命令均可从其他工作目录运行。Windows 客户端可将 `command` 配为 `node`，`args` 填一个元素，例如 `C:\licha\bin\licha-order-mcp.js`。本轮内置服务地址是待替换的占位地址，本机使用时指定 `LICHA_MCP_URL` 和与服务端匹配的 `LICHA_ACCESS_KEY`。

## 安装与自测

仓库随附两个包各自使用的协议运行库。下单服务、账本运维命令和全量测试在 Linux 上使用 Node 22.13 或更高的 22.x，并要求 PATH 中有 util-linux 的 `flock` 命令。顾客端薄壳无需安装此命令。运行整套测试请在仓库根执行：

```text
npm test
```

测试自行启动回环模拟上游、服务端与薄壳，在系统临时目录创建数据、日志、设备文件和离线安装样本。包括等待真实网络超时的用例。无需提供企迈凭证。开发时请总是将 `QMAI_BASE_URL` 指向自己的模拟 HTTP 服务。

维护者更新 SDK 或校验库时，在仓库根依次执行以下命令，更新两个独立包的运行库和第三方授权文本，再运行测试。日常启动和测试均可在没有 `node_modules` 的干净工作区执行。

```text
npm ci
npm ci --prefix server
npm run rebuild:runtimes
npm test
```

仓库根是顾客端包，随包分发约 114 KiB 的薄壳协议运行库。发布时客户端的命令形式为 `npx -y github:lichadecha/licha-order-mcp#<标签>`。正式地址和公开准入串集中在 `bin/licha-order-mcp.js`；发布前替换占位常量。仓库未发布。

## 服务端环境

仅设置 `LICHA_ACCESS_KEYS` 即可启动浏览模式。凭证缺项时仍可握手并查看工具清单。调用需要上游数据的工具会说明凭证不完整。举例，本机客户端与服务端可约定使用 `FAKE_LOCAL_ACCESS`。下单模式须额外设置 `LICHA_ENABLE_ORDERING=1`、`LICHA_DATA_DIR` 和企迈商家后台的短信事件编号 `LICHA_SMS_EVENT_NO`。事件编号缺失或无效时，服务拒绝启动。下列目录的相对路径均按服务进程的启动工作目录解析。服务管理器宜传入绝对路径，重启时复用同一账本。

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | HTTP 监听地址。对外服务时由品牌方 HTTPS 入口转发 |
| `PORT` | 3000 | HTTP 端口 |
| `LICHA_ACCESS_KEYS` | 必填 | 准入串，逗号分隔，容许新旧两串同时生效以便轮换 |
| `LICHA_BLOCKED_DEVICES` | 无停用设备 | 需停用的 UUID v4 列表，逗号分隔 |
| `QMAI_BASE_URL` | `https://openapi.qmai.cn/` | 企迈基址。开发与验收使用回环模拟地址 |
| `QMAI_OPEN_KEY` | 空 | 签名钥匙，兼容 `go-keyring-base64:` 前缀 |
| `QMAI_OPEN_ID` | 空 | 应用标识 |
| `QMAI_GRANT_CODE` | 空 | 商家授权码 |
| `LICHA_ENABLE_ORDERING` | 关闭 | 精确等于 `1` 时从四个浏览工具扩为九个工具 |
| `LICHA_DATA_DIR` | 下单时必填 | 单实例独占的持久账本目录 |
| `LICHA_LOG_DIR` | `./logs` | 三本 JSON Lines 日志的输出目录 |
| `LICHA_MAX_ORDER_AMOUNT_FEN` | 10000 | 单笔预估金额上限，分 |
| `LICHA_MAX_ORDERS_PER_CUSTOMER_PER_DAY` | 5 | 每会员每日占额上限 |
| `LICHA_MAX_ORDERS_PER_DAY` | 10 | 全体会员每日占额上限 |
| `LICHA_CONFIRM_TOKEN_TTL_MS` | 300000 | 待确认单与一次性令牌有效期 |
| `LICHA_BINDING_IDLE_TTL_MS` | 2592000000 | 设备会员绑定的闲置有效期，默认 30 天 |
| `LICHA_SMS_EVENT_NO` | 下单时必填 | 企迈短信验证码事件编号，正整数 |
| `LICHA_SMS_CODE_TTL_SEC` | 300 | 验证码有效秒数，取 30 至 300 的整数 |
| `LICHA_SMS_COOLDOWN_SEC` | 60 | 同一手机号两次发码的最小间隔，秒 |
| `LICHA_SMS_PER_PHONE_PER_HOUR` | 5 | 每个手机号在任意连续一小时内的发码上限 |
| `LICHA_SMS_PER_PHONE_PER_DAY` | 10 | 每个手机号在北京时间自然日内的发码上限 |
| `LICHA_SMS_GLOBAL_PER_DAY` | 100 | 全服务在每个北京时间自然日的发码总上限。须为正整数，配置无效时拒绝启动 |
| `LICHA_SMS_MAX_WRONG` | 5 | 每条验证码允许报错的次数，达到上限即作废 |
| `LICHA_SESSION_IDLE_TTL_MS` | 1800000 | HTTP 会话闲置有效期 |
| `LICHA_ORDER_MATCH_WINDOW_MS` | 600000 | 未决核对的前后匹配窗口，也是判无单前的静默期 |
| `LICHA_RECENT_ORDER_HINT_MS` | 600000 | 再次组单时提示近期已下单的回看时长 |
| `LICHA_UPSTREAM_MIN_INTERVAL_MS` | 210 | 全进程两次上游发送的最小时间间隔 |
| `LICHA_READ_TIMEOUT_MS` | 8000 | 每次读请求的超时 |
| `LICHA_WRITE_TIMEOUT_MS` | 15000 | 创建订单及短信请求的排队上限与发出后的单次超时 |
| `LICHA_READ_BACKOFF_MS` | `1000,2000` | 第二、三次读请求前分别等待的毫秒数 |
| `LICHA_CACHE_STORES_MS` | 86400000 | 门店名录缓存 |
| `LICHA_CACHE_STORE_STATUS_MS` | 600000 | 单店实时状态缓存 |
| `LICHA_CACHE_CATEGORIES_MS` | 300000 | 分类及分类商品缓存 |
| `LICHA_CACHE_SEARCH_MS` | 120000 | 商品搜索缓存 |
| `LICHA_CACHE_ITEM_MS` | 300000 | 商品详情缓存；组单每次现读 |
| `LICHA_RATE_CALLS_PER_DEVICE_PER_MIN` | 60 | 单设备连续 60 秒内的工具调用数 |
| `LICHA_RATE_BINDS_PER_DEVICE_PER_HOUR` | 10 | 单设备连续一小时内的会员查询数 |
| `LICHA_RATE_BINDS_GLOBAL_PER_MIN` | 30 | 全服务连续 60 秒内的会员查询数 |
| `LICHA_MAX_SESSIONS` | 200 | 包含正在初始化的会话名额 |

`_MS` 的单位是毫秒。数值上限与时长采用正整数。自然日及可读时间统一为北京时间。修改配置后重启服务。

## 客户端环境与 HTTP 接口

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `LICHA_MCP_URL` | `https://licha-mcp.invalid/mcp` | 品牌服务端的完整 MCP 端点。本机可用 `http://127.0.0.1:3000/mcp` |
| `LICHA_ACCESS_KEY` | 内置公开占位串 | 须匹配服务端允许列表中的一项 |
| `LICHA_HOME` | 当前系统用户主目录下的 `.licha` | 首次生成设备凭据文件 `device-id`，后续复用 |
| `LICHA_SHELL_TIMEOUT_MS` | 75000 | 单次转发等待服务端答复的最长毫秒数，取 1 至 2147483647 的整数 |

多个薄壳首次启动时会独占创建同一个设备文件，其余进程等到完整 UUID 可读后再握手。若启动提示无法读写设备 ID，先关闭使用该目录的薄壳，恢复原设备文件，或将 `LICHA_HOME` 指向可写的新目录后重新绑定。

`GET /healthz` 无需请求头，返回 `ok`、包版本、交易工具开关。它表示 HTTP 服务就绪。账本故障时可继续浏览，已绑定设备可查自己的订单，故障会在服务启动诊断或交易工具结果中体现。

`/mcp` 使用有状态 Streamable HTTP，支持 POST、GET、DELETE。薄壳为每次请求附加准入串与设备 ID，握手后附加会话 ID。仅当带指定原因头的 404 证明工具尚未处理请求时，薄壳才重建会话并重发一次。网络中断、等待超时或下单结果未知时，应先查 `my_orders`。顾客在小程序「我的订单」自行核对并付款。

`bind_member` 只接受注册会员的手机号。首次调用传 `codeType: "phone"` 和手机号 `code`。收到 `bound: false` 时请顾客查看短信，再带同一个手机号和字符串 `captcha` 调用一次。只有 `bound: true` 才表示已绑定。同设备重复报已绑定的手机号会直接成功。发码结果为 `verificationSent: "unknown"` 时，收到的验证码仍可使用。

服务端在查会员前检查可用额度，发码落账时再核对一次。多个限制同时命中时，提示解除最晚的一档，秒数和分钟数均向上取整。全服务日额在北京时间零点恢复。发码与校验各只请求一次。短信出口的上游文字中，连续 4 位及以上数字显示为 `***`，1 至 3 位数字保留。

验证码在第二步到达服务端时仍有效即可送验。企迈返回布尔值 `status: true` 且 `data` 缺失、为 `null`、`{}` 或 `true` 才算通过。明确不通过和认不出的回执各耗一次机会，提示语会区分两者。HTTP 4xx、无效 JSON 和缺少布尔 `status` 都计入报错。超时、连接失败和 HTTP 5xx 保留剩余次数。

`prepare_order` 可省略 `couponChoice` 或传 `"default"`，由门店系统按默认规则用券。顾客明确说不用券时传 `"none"`。顾客点名某张券时，传 `"specific"`，并把上次待确认单中那张券的 `coupons.usable[].ref` 填入 `couponRef`。`couponRef` 是最长 128 个字符的非空字符串，只有指定用券时才带。换绑、绑定过期或服务重启后，先按默认方式重新组单，取得新的券编号。

指定用券时服务端会重查这张券在当前购物车能抵多少。念单时说明券前合计、券名和预计实付，顾客确认后用新令牌和券前合计调用 `place_order`。下单后按 `couponApplied.note` 与 `nextStep` 告知顾客实际用券和付款安排。

## 账本故障与人工核对

账本使用可写本机目录中的 `orders.sqlite`，格式号为 4（`PRAGMA user_version`）。格式 2、3 均沿用原目录自动升级，订单记录、未决、已占额度及认领信息保留。升级会丢弃格式 3 的旧发码记录，其无密钥摘要无法换算。新建或升级账本时，在同一 SQLite 事务里生成并存入 32 字节随机密钥。发码记录与访问审计都用这把密钥计算 11 位手机号的 HMAC-SHA256。服务和运维命令先用 `flock` 独占目录。正常退出和强杀都会由内核释放锁。备份或恢复前请停服，保留整个目录，包括 SQLite 自己的事务日志。

每次变更在一个 SQLite 事务中以 `synchronous=FULL` 提交。任何一次写入报错，本进程立即停用后续下单和短信发送。发码在请求发出前记账，企迈拒绝和结果不明也占用按号与全服务额度。重启保留已用额度、未决、防重和发码记录，清除设备绑定、待验证、待确认单、确认令牌及内存中的调用与绑定查询限流。未决只挡相应会员，后来核实为无单的记录仍保留原占额。

目录不可写、另一实例持锁或系统无法建立独占时，服务启动失败。取得锁后若发现库损坏、记录校验失败或版本不符，服务保留锁和故障现场，可继续浏览，组单、创建订单及发码停用。启动时已损坏，设备因无法绑定须到小程序查单。运行中进入故障态，仍有有效绑定的设备可照常查自己的订单。请检查目录挂载、空间、权限与备份，结合上游订单人工核对。删除账本会丢失额度、未决、防重与发码限频记录。

**从旧版切换至 v1.4。** 按规格 §8 第 8 项，先停旧版下单，用对应旧版工具逐笔核清未决并核对当日已占额度，保留旧目录备查，再将新版的 `LICHA_DATA_DIR` 指向新的空目录。当天合计可能超过限额时，可等下一个北京时间自然日再开放。即使旧版账本的记录数为零，也需要按此切换。新版日常重启继续使用同一目录。

## 从任意目录运行运维命令

在服务所在机器停服，将 `LICHA_DATA_DIR` 设为该实例账本目录的**绝对路径**。以下命令使用本仓库的实际位置。替换尖括号内的参数，说明用双引号括起，避免填入联系方式或凭证。

```text
node "/绝对路径/licha-order-mcp/server/ledger-cli.js" list
node "/绝对路径/licha-order-mcp/server/ledger-cli.js" resolve <请求键> found <订单号> "门店已核实该单"
node "/绝对路径/licha-order-mcp/server/ledger-cli.js" resolve <请求键> absent "门店已核实没有对应订单"
```

`list` 将 JSON 数组写到标准输出，无未决时输出 `[]`。每项含 `key`（请求键）、`member`（会员摘要）、`storeId`、`requestedAt`（北京时间）和 `estimatedFen`（预估金额，分）。用其中的 `key` 裁决一笔未决。登记有单时，订单号须为 12 至 40 位 ASCII 英文字母或数字，且尚未被认领。命令成功返回 0。请求键不存在、订单号不合格或已被认领、服务占着账本等错误会保留账本结论，向标准错误写明原因并返回非零。裁决完成后按原配置启动服务。

`access.jsonl` 记录启动、准入、绑定及拒绝事件。短信事件按设备摘要和手机号 HMAC 关联。发码被限频时，`tiers` 列出命中档位，`tier` 标明用于提示顾客的档位。当天首次因全服务日额拒绝发码时另记 `sms_global_day_exhausted`，可供运维告警。校验分别记录通过、明确不通过、回执认不出、作废和请求失败。`upstream.jsonl` 记录每次企迈尝试的路径、分类与耗时。`write.jsonl` 可按令牌、请求键或订单号核查发送及终态。查到本设备的确认令牌时，写审计以 `couponChoice` 记录该单的用券选择。其中 `date` 是记录时刻的北京时间日期，`quotaDate` 是取得占位时所记的北京自然日，跨午夜时两者可以不同。取得占位前拒绝的调用没有 `quotaDate`。日志写入失败不阻断业务，安全账本写入失败会阻断后续下单和发码。
