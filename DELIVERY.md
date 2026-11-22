# 李茶的茶点单 MCP v1.6 交付清单

根包提供顾客端 stdio 薄壳，独立的 `server/` 包提供 Streamable HTTP 服务端和本机账本运维命令。三个入口均可从任意工作目录按绝对路径启动。[运行说明](README.md)

## v1.6 未决核对与复述金额

基线为 `0f5ca6c`。据负责人反馈，上一轮 5 条修订均经独立复核通过，第七轮黑盒验收共 221 项，206 项通过，0 项失败。

- **UNR-04 · 查询时段。** `my_orders` 只用本次查询起止时间内的不同订单号核对 `total`。查最近一天、总数为 1 而第一页仅有两天前旧单时，列表为空，原请求保持未决，再次提交仍被拦截。总数为 0 且仅多返回一张越界旧单，或总数为 1 且唯一旧单落在查询时段内、匹配窗外，其余无单条件齐全时均可解除未决。[查询与重下回归](test/order-query.test.js)
- **WRT-05 · 复述金额。** `place_order` 按收到的数值检查小数位数。超过两位时返回工具契约 §7 的重新确认提示，创建请求发出 0 次。整数及最多两位小数的金额沿用原规则，与待确认单相差 1 分可提交，超过 1 分拒绝。[长小数与一分容差回归](test/commerce.test.js#L886)

**本轮验收。** Node 22.23.1，使用假凭证和本机回环模拟上游运行完整的 `npm test`。143 项全部通过，失败、跳过、取消均为 0。相对基线新增 4 项，UNR-04 和 WRT-05 各 2 项，另各修订 1 项已有用例。原始 JSON 数字 `19.984999999999999999`、`20.014999999999999999` 均返回 §7 指定文案，随后用同一令牌复述整数 `20` 成功创建一单。

## v1.5 编号、金额与未决核对（历史记录）

本轮基于 `2e52982`。负责人反馈，上一版独立复核的 84 组写入故障与强制结束实验均恢复到预期的已提交状态，第六轮黑盒验收共 214 项，199 项通过、0 项失败。

| 修订 | 行为与回归 |
| --- | --- |
| R25、BRW-08、PRE-03、R3 编号比较 | 菜单给出 `"00076543210"`、详情给出 `76543210.0` 时，可以直接用菜单的编号打开卡片。同一商品用不同写法分两行组单，只现读一次详情。门店 `"00301"` 能取到店名，并使用原门店编码筛券。同一商品内，SKU、做法分组、做法值或加料各自出现数值重复的编号，预估与组单均拒绝。会员尾号沿用 §4，纯数字字符串保留前导零。[编号回归](test/catalog-integers.test.js) · [会员尾号](test/member-identity.test.js) |
| §4 元换分 | 从企迈创建回执和筛券响应保留元金额的十进制原文，移位后按半分四舍五入。创建回执的 `90071992547409.85` 元与详情的 `9007199254740985` 分显示一致。筛券请求里的元单价也由整分直接拼成 JSON 数字。[金额回归](test/response-integers.test.js) |
| R25 金额上界 | `9007199254740991` 分有效，多一分按无效处理。超界售价不能组单，超界的创建金额不回显，列表实付标为未知，超界券抵扣按工具契约记零并排除在预测之外。[上界与进位](test/response-integers.test.js) |
| UNR-04 列表完整性 | 用本页不同的合法订单号数核对 `total`。总数为 2 而同一张旧单返回两行时，过了匹配窗也继续拦截重下。换成旧单、吻合的新单各一行后，只认领新单。[重复行与下单闸门](test/order-query.test.js) |
| UNR-03、工具契约 §9 有单说明 | 查到唯一吻合订单后，按契约告知「按这张处理，不要重下」，并按待支付、其他已知状态、状态未知的顺序附上适用尾句。企迈列表没有来源标记，顾客在同一时间窗自行下的相同订单也可能吻合。[核对文案与三个尾句](test/commerce.test.js) |

**本轮验收。** Node 22.23.1，本机回环模拟企迈，完整运行 `npm test`，139 项通过，失败、跳过、取消均为 0。比基线新增 11 项，其中编号匹配与冲突 6 项、金额换算 2 项、金额上界 1 项、重复订单号与核对文案各 1 项。

## v1.4 数据可靠性改进（历史记录）

本次基于 `f01df9c` 的服务实现，保留其后的两笔顾客说明书提交。负责人反馈，第五轮独立黑盒验收共 189 项，其中 182 项通过、0 项失败。以下验证针对 v1.4，均使用假凭证和本机模拟企迈。

**账本与切换。** `orders.sqlite` 保存请求记录、终态、未决核对结论与人工裁决说明。已占额度、待核对请求和已认领的单号从记录恢复。每笔事务以 `synchronous=FULL` 提交后才对当前进程生效，发送凭据只在发送前记录明确提交后签发一次。服务与 CLI 使用同一把目录排他锁，重启读取 SQLite 已提交状态。格式号为 2，存入 `PRAGMA user_version`。首次发布完整空库后才接受业务写入。日常恢复由 SQLite 自己的事务日志完成。

`a42cb6b`、`b16d3c3`、`f01df9c` 等旧版账本和未知格式会触发 LED-02，保留现场并停用下单。按 §8 第 8 项停旧版下单，使用原版本的工具核清未决和当日额度，保留旧目录，将新版切到新的空目录。若当天新旧额度合计可能超限，可在下一个北京时间自然日启用。运维仍使用 `list`、`resolve … found …`、`resolve … absent …`。[运行及切换说明](README.md#账本故障与人工核对)

另以本仓库中的三个历史提交各自写入一笔未决。三版原 CLI 均列出一笔，新版 CLI 对原目录均以退出码 1 拒绝接管，并给出 §8 第 8 项的切换提示。

**LED-03 允许的保守偏差。** 任意写入报错都会关闭本进程后续下单。即使提交已生效才报错，当场答复也遵守下表。

| 报错位置 | 当场答复与发送结果 | 重启读取到的状态 |
| --- | --- | --- |
| 发送前记录 | 创建请求发出 0 次，明确告知「本次下单请求没有发出」。 | 无此笔记录，或该会员多一笔占额的未决。匹配窗过去且订单列表足以证实无单时，`my_orders` 解除未决。 |
| 发出后写终态 | 如实返回已收到的企迈结果，成功时给出单号，回执不明时提示先别重下。 | 至少有发送前记录。可以是未决，或已提交的终态。 |
| 核对结论 | 可告知查到的订单，说明闸门仍关着、稍后再查。 | 仍为未决，或已有证据支持的结论已提交并解除。 |

进程强杀后按同样的提交边界恢复，其他会员可照常下单。已发出的创建始终有记录，同一确认单至多发出一次。仅凭超时、无效单号或不完整的订单列表不能判无单。

**整数、单号与显示。** R25 按原始十进制值解析整数，目录编号和整数分与交易回执使用同一判据。有效 `long` 编号的范围为 1 至 9223372036854775807。售价带不足一分的尾数时，详情显示「价格待询」，该规格不能下单。R23 在保留大整数原文前区分 JSON 类型，创建、详情、列表和状态均只接受合格的字符串单号。金额按整数分的十进制数字拼两位小数（含负差额）。会员 ID 的纯数字字符串按原样取尾，含小数点或指数的等值写法按规范整数取尾；长度不足八位只显示 `***`。

取值范围按编号的十进制数值判断，纯数字字符串的前导零不计入有效位数。目录中原本允许省略的做法和加料加价继续按 0 处理，明确给出的负数或不足一分的加价会阻止选购该项。非零加价沿用 R18 的单位约定，尚未经真实企迈确认。[目录数据回归](test/catalog-integers.test.js)

**本轮验收。** Linux、Node 22.23.1，最终代码在本机回环运行 `npm test`，128 项通过，失败、跳过、取消均为 0。v1.4 新写 30 项用例，其中账本 19 项、目录 6 项、会员范围与尾号 2 项、订单号 2 项、金额显示 1 项。账本的 19 项覆盖并替换旧存储专项 18 项；逐文件损坏测试从两个文件子项变为一个。全套比上轮 117 项净增 11 项。已验证两个进程并发启动时只有一个取得目录锁、上游收到创建后强杀和发送前提交后强杀两处恢复边界，以及实际写连接的同步级别。整机掉电未实测。[事务与强杀](test/ledger-recovery.test.js) · [格式与同步级别](test/ledger-evidence.test.js) · [并发启动与运维](test/commerce.test.js)

## v1.3 第五轮修复（历史记录）

基线为 `b16d3c3`。据负责人反馈，第四轮的 13 条原反例均经独立复验通过，黑盒验收 175 个场景、0 失败。以下为 v1.3 改动及本地回归结果。

| 问题 | 改动与回归 |
| --- | --- |
| 1 · 发送前清理失败 | 发送前记录的全部持久化步骤成功后才签发凭据。清理报错时顾客收到「本次下单请求没有发出」，模拟企迈的创建次数为 0。 |
| 2 · 强杀恢复 | 成功终态写入中被强杀时，按下文判据恢复到发送前记录。该会员保留未决和占额，其他会员可下单，本机 CLI 可列出该笔未决。 |
| 3 · 旧摘要 | 快照记录会员摘要口径版本。旧快照含会员记录且缺少口径时进入故障态，启动诊断和 CLI 给出 §8 第 8 项的切换提示。 |
| 4 · R25 | 交易响应按原始十进制值核对整数。时间戳用 `.0` 或指数写法时仍参与唯一性判断，金额、状态、总数和零会员编号也接受等值写法。残余非零小数及超出字段范围的值按不可用处理。 |
| 5 · 绑定尾号 | 会员 ID 尾号按原值长度截取。绑定、念单和查单共用所报标识的 `member`，幂等时保留首次标识，换绑时提供 `previousMember` 并用两次所报标识尾号生成提示。 |
| 6 · 列表出参 | 查询时段外的所有行先丢弃，丢弃数只写访问日志。测试用本人、他人的越界行与恰好落在起止时刻的本人订单核对整个出参。 |
| 7 · 无单证据 | 用上游实际返回的原始条数与 `total` 判断分页完整性。匹配窗已过、整页只有可按时间排除的行时可确认无单；同一页若仍缺记录，则保留未决。 |
| 8 · 状态回执 | 回执含 `orderNo` 时须为合格单号且与请求相同。带尾空格、数组、空串或空值均返回查询失败；省略字段时沿用归属校验。 |

**强杀后怎样确认写入前状态。** 服务和 CLI 先取得目录锁并检查 SQLite 完整性。有撤销行时，当前快照须与其中的旧快照逐字节一致，或其 SHA-256 等于所记的候选摘要；若还有人工核对标记，标记必须与撤销行的旧快照逐字节一致。仅余标记时，当前快照必须已经等于标记。旧快照还须通过格式、记录校验和、记录内容、键唯一性和摘要口径校验。通过后恢复旧快照，清理残留并同步目录，再开放写入。恢复中再次退出，仍以同一份旧状态续做。证据矛盾时保留原文件并停单。[恢复反例](test/ledger-evidence.test.js)

**会员摘要与切换。** 新快照写入 `memberHashVersion: "sha256-canonical-decimal-v1"`，摘要输入是会员编号的规范化正十进制字符串。无版本且没有记录的旧快照可继续使用，下一次写入即带版本。含会员记录却无版本、或版本无法识别时停单，保留旧数据。已用 `a42cb6b` 的实际账本代码写出一笔带前导零会员号的未决记录，旧版 CLI 列出 1 笔，新版 CLI 对同一目录退出 1 并提示按 §8 第 8 项切换。[运行说明](README.md#账本故障与人工核对)

**发送前的提交边界。** 撤销行的删除、人工标记的清理和目录同步均在 SQLite 事务提交前完成。即使标记已实际删除才报 `EIO`，事务回滚后仍有撤销行。最终 `COMMIT` 自身回报错误时，依次尝试恢复撤销行、原子恢复旧快照、写人工核对标记，目录无法增删文件时再尝试原地恢复旧快照。以上错误都先关闭本进程写入并返回「本次下单请求没有发出」。

**仍有一个存储故障边界。** 如果最终 `COMMIT` 实际生效才报错，且介质从这一刻起拒绝所有补救写入，包括改写既有快照，磁盘可能只留下候选 `sent`。此次 HTTP 创建数仍为 0，但再次启动可能把它读为未决。目录权限降为只读的回归覆盖了可改写既有文件的情形。整个介质同时拒写、物理断电均未实机验证。

**本轮验收。** Linux、Node 22.23.1，在本机回环服务完整运行 `npm test`，117 项通过，失败、跳过、取消均为 0。比基线新增 11 项测试，其中账本 5 项、R25 数值 2 项、绑定 1 项、查单 3 项。四个浏览工具沿用原行为，真实企迈交易未调用。

## v1.2 第四轮修复（历史记录）

基线为 `a42cb6b`。负责人反馈，首次审查的 A2、A4、A8、A9、B1–B4 已通过独立复核，四个浏览工具已通过真实企迈只读冒烟，覆盖门店、分类、商品列表、搜索、详情和算价。本轮交易测试使用本机回环 HTTP 模拟企迈。

| 审查项 | 修复与验收 |
| --- | --- |
| 1 · LED-03 | SQLite 最终确认前，先把旧快照写入独立标记并同步文件和目录。确认报错时，能补救就恢复旧状态；补救也失败，重启即进入故障态。发送前、成功终态、明确失败终态、未决认领四处各用新进程恢复同一目录，核对顾客回执和创建次数。 |
| 2 · BND-05、LED-05 | 正十进制会员编号去掉前导零后再绑定、取摘要和校验归属。两台设备得到 `123` 与 `"00123"` 时共享个人额度和未决，重启后仍生效。 |
| 3 · QRY-02/04、WRT-18 | 校验会员编号时保留原始 JSON 数字词法。带小数或指数的编号即使舍入后等于本人，也不能用于绑定、列表、状态、详情或认领。 |
| 4 · UNR-04、WRT-18/19、QRY-03 | 订单总数、金额（分）和状态码只接受可精确表示的十进制非负整数。测试以字符串和裸数字分别验证下溢、舍入后的值都不能证明无单、实付零元或待支付。 |
| 5 · UNR-03/06 | 展示最多十行，判断候选唯一性使用本页实际收到的全部合格行。第 1、11 行同时匹配时，保持未决。 |
| 6 · QRY-04、UNR-02/03 | 按本次请求实际使用的毫秒起止时间筛选。归属和单号校验通过但时间越界的行计入 `discardedOutOfRange`，从展示和候选中剔除，含越界行的响应也不能证明无单。 |
| 7 · LED-01/02、R23 | 旧快照中 `success` 或 `found` 的订单号须为 12–40 位 ASCII 英数，其余状态不得携带订单号。有一条不合格，整本进入故障态，保留原快照人工核对。测试写入校验和正确的 `N/A` 快照，再启动新进程验证不能重下。 |
| 8 · WRT-17、OUT-02 | 比对使用完整预测券名和实际优惠的原始名称、摘要，出参才脱敏截断。明确的其他券与同名未知类型并存时，保留已用券事实，省略 `matchesPrediction`。 |
| 9 · QRY-04 | 上游成功回执必须在 `data.data` 提供订单数组。约定位置为空数组可显示零条；结构无法识别则返回查询失败。 |
| 10 · UNR-07 | 核对说明分别统计明确待支付、其他已知状态和未知状态。唯一候选状态为空时，可以确认建单，只引导顾客核对状态。 |
| 11 · QRY-02/03 | 状态回执带合格订单号时与查询单号交叉校验。不同号走查询失败；省略单号时仍按原归属校验处理。 |
| 12 · PRE-07、R13 | 门店缓存保留原始编码供筛券，门店浏览仍使用原有文本投影。测试对照同一笔查询的 17 位上游编码与顾客看到的脱敏尾号。 |
| 13 · PRE-03/06、WRT-10/11 | 商品详情与筛券继续发送原始字符串，创建请求按 R3 发无损 JSON 数字，发送证据和查询证据统一为正十进制编号。测试覆盖 `"00012345"` 的提交及后续未知请求的认领。 |

**账本确认边界。** SQLite 明确确认后，候选快照已经持久化。如果仅在清理独立标记时出错，当前操作按已确认结果返回，进程停止后续写入。重启时若仍有标记，就停在故障态。标记已清除时沿用已确认的快照。另有一例专门注入删除标记实际生效后报错，核对回执、近期提醒、额度和创建次数。

**旧会员摘要。** 旧版按带前导零字符串生成的会员摘要不可逆，快照缺少重算所需的原始编号。此类旧数据的升级需先核清未决和当日个人额度，无法还原对应关系时的切换时机见运行说明。[账本故障与人工核对](README.md#账本故障与人工核对)

本轮新增回归按账本、会员、组单与查单拆分，均从实际 MCP 工具入口访问本机服务。[账本恢复](test/ledger-recovery.test.js) · [会员编号](test/member-identity.test.js) · [组单与用券](test/order-preparation.test.js) · [查单与未决](test/order-query.test.js)

**本轮验收。** 新增 18 个测试，分别为账本 6 个、会员 3 个、组单与用券 3 个、查单与未决 6 个。13 条问题在 `a42cb6b` 的回环服务上均可复现。Linux、Node 22.23.1 下完整执行 `npm test`，106 项通过，失败、跳过、取消均为 0。

## 先前验证记录

- 上一版在 Linux、Node 22.23.1 下执行根目录 `npm test`。88 项通过（83 个顶层用例，另含 3 个空白歧义子用例和 2 个账本文件子用例），失败、跳过和取消均为 0。测试使用真实服务端和薄壳子进程、临时账本与回环 HTTP 模拟企迈。
- 从仓库根打出 npm 包，在干净的临时目录离线安装，禁用安装脚本，再从另一目录启动已安装的薄壳，完成 MCP 握手并列出四个浏览工具。另在模拟服务中验证了超时、恢复及一次请求实际发送的次数。
- 账本故障测试观察到候选内容已经替换成功，再让持久化确认出错并强杀服务。重启后重新绑定，核对未决、占额及上游收到的请求数。跨北京时间午夜的测试改变子进程的日历时钟，排队、网络和落盘照常执行。
- 第二轮独立验收结果由负责人反馈，148 个场景中 144 个通过、2 个失败、2 个未覆盖。后两项已由独立审查通过故障注入验证。两项失败分别涉及账本损坏时的启动行为、加料名称的空白歧义。

## v1.2 修改与核查

| 条目 | 本轮结果 |
| --- | --- |
| LED-02、LED-06 | 服务端和运维命令以 `flock` 独占账本目录的文件描述符，进程退出由内核释放。取得目录锁后才打开 SQLite 撤销记录和 JSON 快照，任一账本组件损坏都保持独占并进入故障态。 |
| LED-02、LED-06 验证 | 真实下单后停服，枚举并复制数据目录，分别覆写 `.ledger-lock.sqlite` 和 `orders.json`。每份坏账本先测单实例，再同时启动两个独立进程。唯一就绪的实例可预览、列出先前的订单，拒绝组单，模拟上游的创建请求总数仍为一。另测 SQLite 文件截空和目录只读。 |
| LED-01、LED-06 验证 | 健康目录两实例竞争，胜者下单后被强杀，先前失败的实例随后接管。重组单仍带原订单提醒，每日一单的名额仍已占用。 |
| BRW-08 空白歧义 | 单空格、双空格、首尾空白各有一个回归子用例。每例分别提交加料名、做法值和带分组名的做法值，核对预览报歧义、组单没有确认令牌、模拟上游收到零次创建请求。随后提交可区分的原名，验证预估金额和实际发送的选项 ID。 |

## v1.1 审查项与回归

| 审查项 | 实现及验收观察 |
| --- | --- |
| 1 · LED-03 | 账本在替换文件前持久化上一份已确认快照。发送前、成功、明确失败、未决认领四处末次同步失败各有单独回归。发送前失败恢复空额，终态失败恢复发送前记录，认领失败保留未决。另覆盖 SQLite 删除撤销记录后回报错误时的三条恢复路径。 |
| 2 · BRW-08、PRE-06 | 原名逐字匹配，同时查找投影重名和分组歧义。回归检查拒绝时零创建，并核对可区分选项的实际价格及创建请求中的 ID。 |
| 3 · UNR-03 | 新请求保存商品编号、原名摘要及数量。核对商品不同、编号冲突、杯数不符及单元素数组时间均保留未决。实际订单有合格明细时验证商品和总杯数。 |
| 4 · PRE-11 | 自动认领、停服命令裁决为有单之后，均验证再次组单的 `recentOrder` 使用原请求时间与预估金额。 |
| 5 · WRT-14、QRY-04、LED-08、R23 | 创建回执、列表与命令行共用订单号校验。回归含 `N/A`、长度边界、错类型以及 12 位和 40 位有效值。 |
| 6 · QRY-04 | 行内归属字段确实缺失时才标记 `unverified`。已存在的空值、数组、对象、布尔值、错误编号和他人订单被丢弃并计数。 |
| 7 · WRT-17/18/19 | 同名券缺金额仍显示已使用，金额记作未知；缺少或不认识类型时省略 `isCoupon`。实付零元时核对差额和订单状态。读回失败时移除所有金额字段。 |
| 8 · SHL-07 | 薄壳读取 `LICHA_SHELL_TIMEOUT_MS`。模拟服务延迟 250 毫秒，限时 75 毫秒时返回可读错误，随后请求仍可成功。 |
| 9 · LED-06 | v1.1 使用 SQLite 排他锁。该项在第二轮验收后按 v1.2 修订，现行行为与回归见上表。 |
| 10 · ORD-02、WRT-11、LOG-03 | 读路径显式列举，新增路径默认禁读。写出口验证账本持久化后签发且只限本次发送的一次性凭据。日志统一校验来源，伪造令牌、同形回执与账本对象不能写入全值。 |
| 11 · R24 | 实测营业时间内层复数、菜单布尔标志、订单行主备商品名、标量会员编号。成功响应的数据形态无法识别时保留原绑定并提示查询失败。 |
| 12 · SHL-02 | 独占创建设备文件，其余进程等到完整 UUID。测试禁用硬链接并延迟写入，两个并发薄壳从同一份私有文件握手。 |
| 13 · WRT-09、LOG-03、§5.9 | 写审计增加 `quotaDate`。跨午夜发送和终态可以通过同一令牌和请求键关联，记录日与占额日各自核对。占位前拒绝的记录不带占额日。 |
| 14 · LED-08 | 停服从其他工作目录运行 `list` 与两种 `resolve`。回归解析标准输出 JSON，检查字段、标准错误、退出码、失败前后的账本与裁决后的重启结果。 |
| SES-08、§8 第 8 条 | 新增一个真实悬挂的绑定，验证同设备的限流拒绝可立即答复。旧版切换前的停单、逐笔核清与当日额度处理已写入运行说明。 |

各项的实现文件与测试名见后面的逐项对照表。环境变量另有两项启动验证。[§3.2 启动配置只在未设置时采用默认值，拒绝无效项且不回显](test/session.test.js#L196)、[§3.2 凭证缺项仍可握手，非法环境变量阻止启动且不回显](test/session.test.js#L248)

## 未验证

| 对应范围 | 尚缺的证据 |
| --- | --- |
| SHL-01、SHL-02、SHL-07 | Windows、macOS 真机和两种实际 AI 客户端未验证，Windows 跳过 POSIX 权限位断言。此前版本在 Linux Node 18.0.0 离线安装后完成过握手、列工具和查询；本轮薄壳在 Node 18 上未复测。生产地址与公开标签安装待定（P5）。 |
| LED-03、LED-06 | 已用进程强杀、同步错误注入与磁盘文件损坏验证恢复。物理断电、损坏的存储硬件以及网络文件系统锁语义未验证。部署目标为本机持久化文件系统。 |
| BND-10、PRE-06、PRE-07、WRT-17/19 | 未连接真实企迈、未创建或付款。真实身份持有证明、非零加价的价格单位、默认或指定用券及全额抵扣后状态仍待真实环境核实（P1、P2）。 |
| SES-04、WRT-09、§8 | 实际开放时的绑定时长和额度仍待确认（P3、P4）。生产部署、旧版停单及人工清算未执行。 |
| 独立验收 | 第五轮黑盒结果由负责人提供。v1.4 尚未经新一轮独立黑盒复验。本地只使用假钥匙与回环 HTTP。 |
| 品牌 Skill 话术 | 根目录 `SKILL.md` 已使用 `member.last4`。本轮验证到 MCP 工具出参，未验证实际 AI 客户端的口播。 |

## 规格缺口与实现取舍

| 对应范围 | 取舍与依据 |
| --- | --- |
| BRW-08、OUT-02 | 做法值与加料都按上游原名逐字选中。另一个原名若仅在首尾空白或连续空白的数量、形式上有差别，就报歧义。空白归一化只用于发现冲突。 |
| UNR-03、UNR-04 | 新版保存商品编号、名称摘要与数量，同一商品分多行时合计比较。缺少证据不靠实付金额或订单状态补猜。判无单要求完整覆盖的窗口内没有任何订单。 |
| PRE-11、R23 | 已核实有单的提醒按原发送时刻计时。启动读取成功或已认领记录时，订单号不合格会导致账本故障，保留数据库供人工核对。 |
| WRT-17、WRT-19 | 工具契约给“用了与预测不同的券”的固定末句仍含付款提示。实付为零时只保留更正说明，下一步按 WRT-19 核对订单状态；非零时沿用契约文案。已知非券类型采用企迈契约中列举的编码。 |
| PRE-06、PRE-10、UPS-01 | 按 R18 以分计算加价，创建请求保留企迈的价格原值。同名同一项加料的多份合并为数量。就餐方式按样本和固定取餐文案使用堂食。 |
| BRW-04、BRW-06 | 分类商品使用分类缓存时长，搜索截断按上游原始条数判断。图片标签枚举不全，按样本过滤图片类型并保留文字。 |
| BND-05、QRY-05 | 查单的会员尾号及方式取首次绑定标识，绑定回执的 `customerIdLast4` 取会员 ID 尾号。 |
| LED-02/03/06/08、§8 | 停服后整目录备份与恢复。首次部署用空目录；旧版遗留未决由旧版运维核清。当天已占额的处理采用 README 中的切换方法。运维 `requestedAt` 使用记录中的北京时间。 |
| SES-06、SES-07、SHL-07 | 未完成握手占名额，正在处理的 POST 完成后开始闲置计时。薄壳答复超时默认 75000 毫秒，接受 Node 定时器可表达的正整毫秒，关闭时限独立。 |
| §3.2、SHL-01 | 下单服务使用 Node 22.13 或更高的 22.x 内置 SQLite，并调用 Linux util-linux 的 `flock`。已验证本机文件系统，其他部署环境未验证。两个包分别随附 MCP SDK 1.32.2 的运行代码和授权文件，安装与运行无需编译。 |

## 逐项实现与测试

下表列出规格 §5 的全部 105 个 ID。链接指向实现模块与测试定义，同一端到端用例可验证多条规则。测试中使用的故障、时钟偏移和假钥匙均不属于生产配置。

### 会话和设备

| ID | 实现位置 | 对应测试名 |
| --- | --- | --- |
| SES-01 | [server/session.js](server/session.js) · makeEndpoint | [SES-01 SES-07 ORD-01 准入、设备归属、并发末席、失败和关闭归还名额](test/session.test.js#L27) |
| SES-02 | [server/commerce.js](server/commerce.js) · createCommerce、sweep、call | [设备隔离、跨设备替代、过期清理 SES-02/03 PRE-08/09 WRT-03](test/commerce.test.js#L77)<br>[SES-02 SES-03 SES-04 SES-06 绑定跨会话保留、跨设备隔离，浏览与拒绝不续期](test/session.test.js#L64)<br>[SES-02 SES-04 SES-06 关会话保留待确认单，绑定过期后同会员重绑也不能提交旧单](test/session.test.js#L269) |
| SES-03 | [server/commerce.js](server/commerce.js) · createCommerce、sweep、call | [设备隔离、跨设备替代、过期清理 SES-02/03 PRE-08/09 WRT-03](test/commerce.test.js#L77)<br>[SES-02 SES-03 SES-04 SES-06 绑定跨会话保留、跨设备隔离，浏览与拒绝不续期](test/session.test.js#L64) |
| SES-04 | [server/commerce.js](server/commerce.js) · createCommerce、sweep、call | [SES-02 SES-03 SES-04 SES-06 绑定跨会话保留、跨设备隔离，浏览与拒绝不续期](test/session.test.js#L64)<br>[SES-02 SES-04 SES-06 关会话保留待确认单，绑定过期后同会员重绑也不能提交旧单](test/session.test.js#L269) |
| SES-05 | [server/commerce.js](server/commerce.js) · createCommerce、sweep、call | [同会员在途、最后总额度与会员配额原子竞争 WRT-07/09 LED-01/05/07 SES-05](test/commerce.test.js#L161)<br>[SES-05 SES-09 跨会话共用滑动窗口；重启清除限流与绑定](test/session.test.js#L86) |
| SES-06 | [server/session.js](server/session.js) · makeEndpoint | [SES-02 SES-03 SES-04 SES-06 绑定跨会话保留、跨设备隔离，浏览与拒绝不续期](test/session.test.js#L64)<br>[SES-06 已进入会话的 POST 在接收消息期间保持活动](test/session.test.js#L224)<br>[SES-02 SES-04 SES-06 关会话保留待确认单，绑定过期后同会员重绑也不能提交旧单](test/session.test.js#L269) |
| SES-07 | [server/session.js](server/session.js) · makeEndpoint | [SES-01 SES-07 ORD-01 准入、设备归属、并发末席、失败和关闭归还名额](test/session.test.js#L27)<br>[SES-07 正在接收握手的连接占名额，中止后只归还一次](test/session.test.js#L207) |
| SES-08 | [server/session.js](server/session.js) · dispatch | [SES-08 同设备跨会话按到达次序执行，其他设备可以继续查询](test/session.test.js#L104)<br>[SES-08 SES-09 上一个绑定仍在等待时，同设备超额请求立即返回](test/session.test.js#L124) |
| SES-09 | [server/session.js](server/session.js) · makeEndpoint | [SES-05 SES-09 跨会话共用滑动窗口；重启清除限流与绑定](test/session.test.js#L86)<br>[SES-08 SES-09 上一个绑定仍在等待时，同设备超额请求立即返回](test/session.test.js#L124)<br>[SES-09 任意连续六十秒内跨会话计数，拒绝不延长窗口，另一台设备独立](test/window.test.js#L55) |

### 工具开关和出口

| ID | 实现位置 | 对应测试名 |
| --- | --- | --- |
| ORD-01 | [server/session.js](server/session.js) · makeEndpoint | [SES-01 SES-07 ORD-01 准入、设备归属、并发末席、失败和关闭归还名额](test/session.test.js#L27) |
| ORD-02 | [server/qmai.js](server/qmai.js) · readPaths、Qmai.write · [账本发送凭据](server/ledger.js) | [ORD-02 ORD-03 出口白名单与未知路径发前拒绝](test/browse.test.js#L292)<br>[ORD-02 WRT-11 写出口拒绝缺失、伪造、跨次复用的落盘凭据](test/write-gate.test.js#L12)<br>[ORD-02 增加路径常量不会自动获得读权限](test/write-gate.test.js#L37) |
| ORD-03 | [server/qmai.js](server/qmai.js) · Qmai.read、Qmai.write | [ORD-02 ORD-03 出口白名单与未知路径发前拒绝](test/browse.test.js#L292) |

### 浏览与算价

| ID | 实现位置 | 对应测试名 |
| --- | --- | --- |
| BRW-01 | [server/browse.js](server/browse.js) · #directory、#find | [BRW-01 BRW-02 BRW-03 门店匹配、采样和两路刷新](test/browse.test.js#L26) |
| BRW-02 | [server/browse.js](server/browse.js) · #directory、#find | [BRW-01 BRW-02 BRW-03 门店匹配、采样和两路刷新](test/browse.test.js#L26) |
| BRW-03 | [server/browse.js](server/browse.js) · #liveStatus | [BRW-01 BRW-02 BRW-03 门店匹配、采样和两路刷新](test/browse.test.js#L26)<br>[BRW-03 BRW-04 R24 营业时间内层复数和菜单布尔标记](test/browse.test.js#L464) |
| BRW-04 | [server/browse.js](server/browse.js) · #menu | [BRW-04 BRW-05 BRW-06 菜单分支、过滤和估清，UPS-01 无损分类 ID](test/browse.test.js#L66)<br>[BRW-04 BRW-08 错形分类不缓存；算价失败只给一次商品原因](test/browse.test.js#L363)<br>[BRW-03 BRW-04 R24 营业时间内层复数和菜单布尔标记](test/browse.test.js#L464) |
| BRW-05 | [server/catalog.js](server/catalog.js) · menuItem，get_menu 的提示见 browse.js | [BRW-04 BRW-05 BRW-06 菜单分支、过滤和估清，UPS-01 无损分类 ID](test/browse.test.js#L66) |
| BRW-06 | [server/catalog.js](server/catalog.js) · menuItem，get_menu 的提示见 browse.js | [BRW-04 BRW-05 BRW-06 菜单分支、过滤和估清，UPS-01 无损分类 ID](test/browse.test.js#L66) |
| BRW-07 | [server/catalog.js](server/catalog.js) · itemCard，商品 ID 核对见 Browse.#item | [BRW-07 OUT-01 卡片投影、空值、估清优先级和商品一致性](test/browse.test.js#L105)<br>[OUT-01 BRW-07 畸形公开 ID 字段不能携出无关的识别值](test/browse.test.js#L345) |
| BRW-08 | [server/price.js](server/price.js) · selectSku、selectPractices、checkOptionSpacing、priceLine | [BRW-08 逐行算价、同名做法及缺价规格](test/browse.test.js#L139)<br>[BRW-04 BRW-08 错形分类不缓存；算价失败只给一次商品原因](test/browse.test.js#L363)<br>[BRW-08 PRE-06 加料原文、展示同名和做法双重解释都核对至创建请求](test/browse.test.js#L386) |
| BRW-09 | [server/browse.js](server/browse.js) · #cached、#item、quote | [BRW-09 PRE-03 PRE-04 PRE-05 PRE-06 现价、必选、内部 ID 与签发快照](test/browse.test.js#L164)<br>[BRW-09 PRE-03 同毫秒开始的旧浏览响应晚到，保留组单现读缓存](test/browse.test.js#L318) |
| BRW-10 | [server/qmai.js](server/qmai.js) · Qmai.#read、post | [BRW-10 UPS-01 UPS-03 OUT-02 OUT-03 重试重签、读超时和异常响应](test/browse.test.js#L223) |

### 绑定

| ID | 实现位置 | 对应测试名 |
| --- | --- | --- |
| BND-01 | [server/commerce.js](server/commerce.js) · bind | [绑定预检、幂等、换绑与识别值最小化 BND-01/02/03/04/05/06/08/10 PRE-01/08/10 WRT-02/04 QRY-01](test/commerce.test.js#L19) |
| BND-02 | [server/commerce.js](server/commerce.js) · bind | [绑定预检、幂等、换绑与识别值最小化 BND-01/02/03/04/05/06/08/10 PRE-01/08/10 WRT-02/04 QRY-01](test/commerce.test.js#L19)<br>[BND-02 R24 会员查询支持标量编号，未知形态报告查询失败并保留原绑定](test/commerce.test.js#L749) |
| BND-03 | [server/commerce.js](server/commerce.js) · bind | [绑定预检、幂等、换绑与识别值最小化 BND-01/02/03/04/05/06/08/10 PRE-01/08/10 WRT-02/04 QRY-01](test/commerce.test.js#L19) |
| BND-04 | [server/commerce.js](server/commerce.js) · bind | [绑定预检、幂等、换绑与识别值最小化 BND-01/02/03/04/05/06/08/10 PRE-01/08/10 WRT-02/04 QRY-01](test/commerce.test.js#L19) |
| BND-05 | [server/commerce.js](server/commerce.js) · bind | [绑定预检、幂等、换绑与识别值最小化 BND-01/02/03/04/05/06/08/10 PRE-01/08/10 WRT-02/04 QRY-01](test/commerce.test.js#L19) |
| BND-06 | [server/commerce.js](server/commerce.js) · bind | [绑定预检、幂等、换绑与识别值最小化 BND-01/02/03/04/05/06/08/10 PRE-01/08/10 WRT-02/04 QRY-01](test/commerce.test.js#L19) |
| BND-07 | [server/commerce.js](server/commerce.js) · bind | [未决隔离、静默期、分页及唯一正证据 BND-07 WRT-07 UNR-01/02/03/04/05/06/07/08](test/commerce.test.js#L304) |
| BND-08 | [server/commerce.js](server/commerce.js) · bind | [绑定预检、幂等、换绑与识别值最小化 BND-01/02/03/04/05/06/08/10 PRE-01/08/10 WRT-02/04 QRY-01](test/commerce.test.js#L19) |
| BND-09 | [server/commerce.js](server/commerce.js) · bind | [绑定查询限流不计预检与限流拒绝 BND-09](test/commerce.test.js#L66)<br>[BND-09 格式预检、设备一小时与全局一分钟滑窗分别计数，在边界释放](test/window.test.js#L70) |
| BND-10 | [server/commerce.js](server/commerce.js) · bind | [绑定预检、幂等、换绑与识别值最小化 BND-01/02/03/04/05/06/08/10 PRE-01/08/10 WRT-02/04 QRY-01](test/commerce.test.js#L19) |

### 组单

| ID | 实现位置 | 对应测试名 |
| --- | --- | --- |
| PRE-01 | [server/commerce.js](server/commerce.js) · requireBinding、prepare | [绑定预检、幂等、换绑与识别值最小化 BND-01/02/03/04/05/06/08/10 PRE-01/08/10 WRT-02/04 QRY-01](test/commerce.test.js#L19) |
| PRE-02 | [server/commerce.js](server/commerce.js) · requireBinding、prepare | [发送前账本故障时停止创建、重启后仍可浏览查单 PRE-02 WRT-06/11 LED-02/03](test/commerce.test.js#L377) |
| PRE-03 | [server/browse.js](server/browse.js) · quote、#item | [BRW-09 PRE-03 PRE-04 PRE-05 PRE-06 现价、必选、内部 ID 与签发快照](test/browse.test.js#L164)<br>[BRW-09 PRE-03 同毫秒开始的旧浏览响应晚到，保留组单现读缓存](test/browse.test.js#L318) |
| PRE-04 | [server/commerce.js](server/commerce.js) · requireBinding、prepare | [BRW-09 PRE-03 PRE-04 PRE-05 PRE-06 现价、必选、内部 ID 与签发快照](test/browse.test.js#L164) |
| PRE-05 | [server/price.js](server/price.js) · priceLine | [BRW-09 PRE-03 PRE-04 PRE-05 PRE-06 现价、必选、内部 ID 与签发快照](test/browse.test.js#L164) |
| PRE-06 | [server/commerce.js](server/commerce.js) · prepare、checkOrderFields，分行内部 ID 核对见 price.js | [BRW-09 PRE-03 PRE-04 PRE-05 PRE-06 现价、必选、内部 ID 与签发快照](test/browse.test.js#L164)<br>[BRW-08 PRE-06 加料原文、展示同名和做法双重解释都核对至创建请求](test/browse.test.js#L386)<br>[递归拒绝七个预约字段 PRE-06](test/commerce.test.js#L129) |
| PRE-07 | [server/commerce-view.js](server/commerce-view.js) · couponView，单次筛券见 commerce.js 的 prepare | [券预测优先级、投影、一次查询和缺门店编码 PRE-07 OUT-01/02](test/commerce.test.js#L99) |
| PRE-08 | [server/commerce.js](server/commerce.js) · requireBinding、prepare | [绑定预检、幂等、换绑与识别值最小化 BND-01/02/03/04/05/06/08/10 PRE-01/08/10 WRT-02/04 QRY-01](test/commerce.test.js#L19)<br>[设备隔离、跨设备替代、过期清理 SES-02/03 PRE-08/09 WRT-03](test/commerce.test.js#L77) |
| PRE-09 | [server/commerce.js](server/commerce.js) · requireBinding、prepare | [设备隔离、跨设备替代、过期清理 SES-02/03 PRE-08/09 WRT-03](test/commerce.test.js#L77) |
| PRE-10 | [server/commerce.js](server/commerce.js) · requireBinding、prepare | [绑定预检、幂等、换绑与识别值最小化 BND-01/02/03/04/05/06/08/10 PRE-01/08/10 WRT-02/04 QRY-01](test/commerce.test.js#L19) |
| PRE-11 | [server/commerce.js](server/commerce.js) · prepare | [并发提交、复述金额与成功回读 WRT-01/05/10/12/13/15/16/17/19 PRE-11](test/commerce.test.js#L135)<br>[PRE-11 自动认领与停服人工裁决均按发出时刻提醒再下单](test/commerce.test.js#L651) |

### 下单

| ID | 实现位置 | 对应测试名 |
| --- | --- | --- |
| WRT-01 | [server/session.js](server/session.js) · extraPlaceField、dispatch | [并发提交、复述金额与成功回读 WRT-01/05/10/12/13/15/16/17/19 PRE-11](test/commerce.test.js#L135) |
| WRT-02 | [server/commerce.js](server/commerce.js) · place | [绑定预检、幂等、换绑与识别值最小化 BND-01/02/03/04/05/06/08/10 PRE-01/08/10 WRT-02/04 QRY-01](test/commerce.test.js#L19) |
| WRT-03 | [server/commerce.js](server/commerce.js) · place | [设备隔离、跨设备替代、过期清理 SES-02/03 PRE-08/09 WRT-03](test/commerce.test.js#L77) |
| WRT-04 | [server/commerce.js](server/commerce.js) · place | [绑定预检、幂等、换绑与识别值最小化 BND-01/02/03/04/05/06/08/10 PRE-01/08/10 WRT-02/04 QRY-01](test/commerce.test.js#L19) |
| WRT-05 | [server/commerce.js](server/commerce.js) · place | [并发提交、复述金额与成功回读](test/commerce.test.js#L135) · [两位小数与一分容差](test/commerce.test.js#L886) |
| WRT-06 | [server/commerce.js](server/commerce.js) · place | [发送前账本故障时停止创建、重启后仍可浏览查单 PRE-02 WRT-06/11 LED-02/03](test/commerce.test.js#L377) |
| WRT-07 | [server/commerce.js](server/commerce.js) · place | [同会员在途、最后总额度与会员配额原子竞争 WRT-07/09 LED-01/05/07 SES-05](test/commerce.test.js#L161)<br>[未决隔离、静默期、分页及唯一正证据 BND-07 WRT-07 UNR-01/02/03/04/05/06/07/08](test/commerce.test.js#L304) |
| WRT-08 | [server/commerce.js](server/commerce.js) · place | [零元预估不占位 WRT-08](test/commerce.test.js#L360) |
| WRT-09 | [server/commerce.js](server/commerce.js) · place | [同会员在途、最后总额度与会员配额原子竞争 WRT-07/09 LED-01/05/07 SES-05](test/commerce.test.js#L161)<br>[WRT-09 LED-07 LOG-03 并发占最后一额跨北京午夜，账本与写审计记录占额日](test/quota-time.test.js#L39) |
| WRT-10 | [server/commerce.js](server/commerce.js) · place | [并发提交、复述金额与成功回读 WRT-01/05/10/12/13/15/16/17/19 PRE-11](test/commerce.test.js#L135)<br>[资金出口拒绝明确失败；不确定回执从不重试 WRT-10/12/14 LED-07 OUT-03](test/commerce.test.js#L201)<br>[WRT-10 持久防重记录命中时归还占位，不再请求创建](test/commerce.test.js#L583) |
| WRT-11 | [server/commerce.js](server/commerce.js) · place · [recordSending](server/ledger.js) · [Qmai.write](server/qmai.js) | [发送前账本故障时停止创建、重启后仍可浏览查单 PRE-02 WRT-06/11 LED-02/03](test/commerce.test.js#L377)<br>[WRT-11 等待实际发送名额超时，账本空且个人、全局占位都释放](test/quota-time.test.js#L99)<br>[ORD-02 WRT-11 写出口拒绝缺失、伪造、跨次复用的落盘凭据](test/write-gate.test.js#L12) |
| WRT-12 | [server/commerce.js](server/commerce.js) · place | [并发提交、复述金额与成功回读 WRT-01/05/10/12/13/15/16/17/19 PRE-11](test/commerce.test.js#L135)<br>[资金出口拒绝明确失败；不确定回执从不重试 WRT-10/12/14 LED-07 OUT-03](test/commerce.test.js#L201) |
| WRT-13 | [server/commerce.js](server/commerce.js) · place | [并发提交、复述金额与成功回读 WRT-01/05/10/12/13/15/16/17/19 PRE-11](test/commerce.test.js#L135) |
| WRT-14 | [server/commerce.js](server/commerce.js) · place · [orderNumber](server/commerce-view.js) | [资金出口拒绝明确失败；不确定回执从不重试 WRT-10/12/14 LED-07 OUT-03](test/commerce.test.js#L201)<br>[WRT-14 QRY-04 R23 占位文字不算订单号；列表逐行校验 12 至 40 位英数](test/commerce.test.js#L680) |
| WRT-15 | [server/commerce.js](server/commerce.js) · place | [并发提交、复述金额与成功回读 WRT-01/05/10/12/13/15/16/17/19 PRE-11](test/commerce.test.js#L135)<br>[安全读回和优惠证据 WRT-15/16/17/18/19](test/commerce.test.js#L229) |
| WRT-16 | [server/commerce-view.js](server/commerce-view.js) · placedView、discountView | [并发提交、复述金额与成功回读 WRT-01/05/10/12/13/15/16/17/19 PRE-11](test/commerce.test.js#L135)<br>[安全读回和优惠证据 WRT-15/16/17/18/19](test/commerce.test.js#L229) |
| WRT-17 | [server/commerce-view.js](server/commerce-view.js) · placedView、discountView | [并发提交、复述金额与成功回读 WRT-01/05/10/12/13/15/16/17/19 PRE-11](test/commerce.test.js#L135)<br>[安全读回和优惠证据 WRT-15/16/17/18/19](test/commerce.test.js#L229)<br>[WRT-17 WRT-19 金额未知的券保留、类型未知保留不确定、零元告警只核对差额](test/commerce.test.js#L718) |
| WRT-18 | [server/commerce-view.js](server/commerce-view.js) · placedView、discountView | [安全读回和优惠证据 WRT-15/16/17/18/19](test/commerce.test.js#L229) |
| WRT-19 | [server/commerce-view.js](server/commerce-view.js) · placedView、discountView | [并发提交、复述金额与成功回读 WRT-01/05/10/12/13/15/16/17/19 PRE-11](test/commerce.test.js#L135)<br>[安全读回和优惠证据 WRT-15/16/17/18/19](test/commerce.test.js#L229)<br>[WRT-17 WRT-19 金额未知的券保留、类型未知保留不确定、零元告警只核对差额](test/commerce.test.js#L718) |

### 账本

| ID | 实现位置 | 对应测试名 |
| --- | --- | --- |
| LED-01 | [server/ledger.js](server/ledger.js) · Ledger，占位与状态转换见 commerce.js 的 place | [同会员在途、最后总额度与会员配额原子竞争 WRT-07/09 LED-01/05/07 SES-05](test/commerce.test.js#L161)<br>[已发出与核对结果持久化失败仍保留未决 LED-01/03/07 UNR-04/05/07](test/commerce.test.js#L409)<br>[强杀真实进程、跨重启人工核对及唯一认领 LED-01/04/05/06/07/08 UNR-05/06](test/commerce.test.js#L448) |
| LED-02 | [server/ledger.js](server/ledger.js) · Ledger 校验库格式、记录摘要与内容 | [发送前账本故障时停止创建、重启后仍可浏览查单 PRE-02 WRT-06/11 LED-02/03](test/commerce.test.js#L377)<br>[LED-02 LED-06 逐个破坏已下单账本文件，单实例故障态与双实例唯一胜者仍可浏览查单](test/commerce.test.js#L767)<br>[LED-02 LED-06 既有账本截为零字节仍能独占并保持故障态](test/commerce.test.js#L828) |
| LED-03 | [SQLite 事务与发送凭据](server/ledger.js) · [下单和核对答复](server/commerce.js) | [实际 COMMIT 被拒、已提交却报错、两处强杀](test/ledger-recovery.test.js) · [初建强杀、版本与记录校验](test/ledger-evidence.test.js) |
| LED-04 | [server/ledger.js](server/ledger.js) · Ledger，占位与状态转换见 commerce.js 的 place | [强杀真实进程、跨重启人工核对及唯一认领 LED-01/04/05/06/07/08 UNR-05/06](test/commerce.test.js#L448) |
| LED-05 | [server/ledger.js](server/ledger.js) · Ledger，占位与状态转换见 commerce.js 的 place | [同会员在途、最后总额度与会员配额原子竞争 WRT-07/09 LED-01/05/07 SES-05](test/commerce.test.js#L161)<br>[强杀真实进程、跨重启人工核对及唯一认领 LED-01/04/05/06/07/08 UNR-05/06](test/commerce.test.js#L448) |
| LED-06 | [server/ledger.js](server/ledger.js) · Ledger 取得与释放目录锁 | [强杀真实进程、跨重启人工核对及唯一认领 LED-01/04/05/06/07/08 UNR-05/06](test/commerce.test.js#L448)<br>[全新目录双实例并发抢锁、别名与死亡接管 LED-06](test/commerce.test.js#L518)<br>[LED-02 LED-06 逐个破坏已下单账本文件，单实例故障态与双实例唯一胜者仍可浏览查单](test/commerce.test.js#L767)<br>[LED-02 LED-06 既有账本截为零字节仍能独占并保持故障态](test/commerce.test.js#L828)<br>[LED-06 账本目录不可写时启动失败，恢复写权限后可接管](test/commerce.test.js#L842) |
| LED-07 | [server/ledger.js](server/ledger.js) · Ledger，占位与状态转换见 commerce.js 的 place | [同会员在途、最后总额度与会员配额原子竞争 WRT-07/09 LED-01/05/07 SES-05](test/commerce.test.js#L161)<br>[资金出口拒绝明确失败；不确定回执从不重试 WRT-10/12/14 LED-07 OUT-03](test/commerce.test.js#L201)<br>[已发出与核对结果持久化失败仍保留未决 LED-01/03/07 UNR-04/05/07](test/commerce.test.js#L409)<br>[强杀真实进程、跨重启人工核对及唯一认领 LED-01/04/05/06/07/08 UNR-05/06](test/commerce.test.js#L448)<br>[WRT-09 LED-07 LOG-03 并发占最后一额跨北京午夜，账本与写审计记录占额日](test/quota-time.test.js#L39) |
| LED-08 | [server/ledger-cli.js](server/ledger-cli.js) · run | [强杀真实进程、跨重启人工核对及唯一认领 LED-01/04/05/06/07/08 UNR-05/06](test/commerce.test.js#L448)<br>[LED-08 运维按固定字段列未决，R23 不合格单号及未知请求退出非零且账本不变](test/commerce.test.js#L801) |

### 未决核对

| ID | 实现位置 | 对应测试名 |
| --- | --- | --- |
| UNR-01 | [server/commerce.js](server/commerce.js) · unresolved、orders | [未决隔离、静默期、分页及唯一正证据 BND-07 WRT-07 UNR-01/02/03/04/05/06/07/08](test/commerce.test.js#L304) |
| UNR-02 | [server/commerce.js](server/commerce.js) · unresolved、orders | [查单严格核对归属、时间和状态 QRY-02/03/04/05 UNR-02/08](test/commerce.test.js#L268)<br>[未决隔离、静默期、分页及唯一正证据 BND-07 WRT-07 UNR-01/02/03/04/05/06/07/08](test/commerce.test.js#L304) |
| UNR-03 | [server/commerce.js](server/commerce.js) · orders · [rowTime、listedProducts、sameProducts](server/commerce-view.js) | [未决隔离、静默期、分页及唯一正证据 BND-07 WRT-07 UNR-01/02/03/04/05/06/07/08](test/commerce.test.js#L304)<br>[恢复多笔未决后按请求时间认领并引导人工复核 UNR-03/05/06/07](test/commerce.test.js#L536)<br>[UNR-03 商品名称、编号和杯数随发送记录恢复，畸形时间不能用于正负核对](test/commerce.test.js#L608) |
| UNR-04 | [server/commerce.js](server/commerce.js) · unresolved、orders | [未决隔离、静默期、分页及唯一正证据](test/commerce.test.js#L304) · [核对结论持久化失败](test/commerce.test.js#L409) · [总数为零与越界旧单](test/order-query.test.js#L98) · [错页拦截与匹配窗外旧单](test/order-query.test.js#L184) |
| UNR-05 | [server/commerce.js](server/commerce.js) · unresolved、orders | [未决隔离、静默期、分页及唯一正证据 BND-07 WRT-07 UNR-01/02/03/04/05/06/07/08](test/commerce.test.js#L304)<br>[已发出与核对结果持久化失败仍保留未决 LED-01/03/07 UNR-04/05/07](test/commerce.test.js#L409)<br>[强杀真实进程、跨重启人工核对及唯一认领 LED-01/04/05/06/07/08 UNR-05/06](test/commerce.test.js#L448)<br>[恢复多笔未决后按请求时间认领并引导人工复核 UNR-03/05/06/07](test/commerce.test.js#L536)<br>[迟到的订单列表只核对查询开始时的未决 UNR-05](test/commerce.test.js#L564) |
| UNR-06 | [server/commerce.js](server/commerce.js) · unresolved、orders | [未决隔离、静默期、分页及唯一正证据 BND-07 WRT-07 UNR-01/02/03/04/05/06/07/08](test/commerce.test.js#L304)<br>[强杀真实进程、跨重启人工核对及唯一认领 LED-01/04/05/06/07/08 UNR-05/06](test/commerce.test.js#L448)<br>[恢复多笔未决后按请求时间认领并引导人工复核 UNR-03/05/06/07](test/commerce.test.js#L536) |
| UNR-07 | [server/commerce.js](server/commerce.js) · unresolved、orders | [未决隔离、静默期、分页及唯一正证据 BND-07 WRT-07 UNR-01/02/03/04/05/06/07/08](test/commerce.test.js#L304)<br>[已发出与核对结果持久化失败仍保留未决 LED-01/03/07 UNR-04/05/07](test/commerce.test.js#L409)<br>[恢复多笔未决后按请求时间认领并引导人工复核 UNR-03/05/06/07](test/commerce.test.js#L536) |
| UNR-08 | [server/commerce.js](server/commerce.js) · unresolved、orders | [查单严格核对归属、时间和状态 QRY-02/03/04/05 UNR-02/08](test/commerce.test.js#L268)<br>[未决隔离、静默期、分页及唯一正证据 BND-07 WRT-07 UNR-01/02/03/04/05/06/07/08](test/commerce.test.js#L304) |

### 查单

| ID | 实现位置 | 对应测试名 |
| --- | --- | --- |
| QRY-01 | [server/commerce.js](server/commerce.js) · requireBinding、status、orders | [绑定预检、幂等、换绑与识别值最小化 BND-01/02/03/04/05/06/08/10 PRE-01/08/10 WRT-02/04 QRY-01](test/commerce.test.js#L19) |
| QRY-02 | [server/commerce.js](server/commerce.js) · requireBinding、status、orders | [查单严格核对归属、时间和状态 QRY-02/03/04/05 UNR-02/08](test/commerce.test.js#L268) |
| QRY-03 | [server/commerce-view.js](server/commerce-view.js) · statusView | [查单严格核对归属、时间和状态 QRY-02/03/04/05 UNR-02/08](test/commerce.test.js#L268) |
| QRY-04 | [server/commerce.js](server/commerce.js) · orders · [orderNumber、orderView](server/commerce-view.js) · [decimalId](server/common.js) | [查单严格核对归属、时间和状态 QRY-02/03/04/05 UNR-02/08](test/commerce.test.js#L268)<br>[WRT-14 QRY-04 R23 占位文字不算订单号；列表逐行校验 12 至 40 位英数](test/commerce.test.js#L680)<br>[QRY-04 R24 归属缺失与形态异常分别处理、商品名称按主备字段投影](test/commerce.test.js#L700) |
| QRY-05 | [server/commerce.js](server/commerce.js) · requireBinding、status、orders | [查单严格核对归属、时间和状态 QRY-02/03/04/05 UNR-02/08](test/commerce.test.js#L268) |

### 审计

| ID | 实现位置 | 对应测试名 |
| --- | --- | --- |
| LOG-01 | [server/logs.js](server/logs.js) · createLogs，调用点见 session.js、qmai.js、commerce.js | [LOG-01 LOG-02 LOG-03 LOG-04 LOG-06 LOG-07 出口审计、来源白名单、整条日志脱敏](test/session.test.js#L142) |
| LOG-02 | [server/logs.js](server/logs.js) · createLogs，调用点见 session.js、qmai.js、commerce.js | [LOG-01 LOG-02 LOG-03 LOG-04 LOG-06 LOG-07 出口审计、来源白名单、整条日志脱敏](test/session.test.js#L142) |
| LOG-03 | [server/logs.js](server/logs.js) · createLogs、issueConfirmation、currentQuotaDay · [企迈回执](server/qmai.js) · [已提交账本记录](server/ledger.js) | [WRT-09 LED-07 LOG-03 并发占最后一额跨北京午夜，账本与写审计记录占额日](test/quota-time.test.js#L39)<br>[LOG-01 LOG-02 LOG-03 LOG-04 LOG-06 LOG-07 出口审计、来源白名单、整条日志脱敏](test/session.test.js#L142)<br>[LOG-03 写审计默认掩码，伪造的令牌、订单回执和账本对象不能取得全值](test/session.test.js#L297) |
| LOG-04 | [server/logs.js](server/logs.js) · createLogs，调用点见 session.js、qmai.js、commerce.js | [LOG-01 LOG-02 LOG-03 LOG-04 LOG-06 LOG-07 出口审计、来源白名单、整条日志脱敏](test/session.test.js#L142) |
| LOG-05 | [server/logs.js](server/logs.js) · createLogs，调用点见 session.js、qmai.js、commerce.js | [LOG-05 三本日志介质故障不改变业务结果](test/session.test.js#L180) |
| LOG-06 | [server/logs.js](server/logs.js) · createLogs，调用点见 session.js、qmai.js、commerce.js | [LOG-01 LOG-02 LOG-03 LOG-04 LOG-06 LOG-07 出口审计、来源白名单、整条日志脱敏](test/session.test.js#L142) |
| LOG-07 | [test-support/rig.js](test-support/rig.js) · rig，安装测试另建独立临时目录 | [LOG-01 LOG-02 LOG-03 LOG-04 LOG-06 LOG-07 出口审计、来源白名单、整条日志脱敏](test/session.test.js#L142) |

### 出参

| ID | 实现位置 | 对应测试名 |
| --- | --- | --- |
| OUT-01 | [server/catalog.js](server/catalog.js) · itemCard、menuItem，交易投影见 commerce-view.js | [BRW-07 OUT-01 卡片投影、空值、估清优先级和商品一致性](test/browse.test.js#L105)<br>[OUT-01 BRW-07 畸形公开 ID 字段不能携出无关的识别值](test/browse.test.js#L345)<br>[券预测优先级、投影、一次查询和缺门店编码 PRE-07 OUT-01/02](test/commerce.test.js#L99) |
| OUT-02 | [server/common.js](server/common.js) · projectText | [BRW-10 UPS-01 UPS-03 OUT-02 OUT-03 重试重签、读超时和异常响应](test/browse.test.js#L223)<br>[券预测优先级、投影、一次查询和缺门店编码 PRE-07 OUT-01/02](test/commerce.test.js#L99)<br>[OUT-02 错误文本投影按码点截断并移除网址、凭证、电话与长数字](test/session.test.js#L190) |
| OUT-03 | [server/qmai.js](server/qmai.js) · readHint，写结果未知文案见 commerce.js 的 unknownMessage | [BRW-10 UPS-01 UPS-03 OUT-02 OUT-03 重试重签、读超时和异常响应](test/browse.test.js#L223)<br>[资金出口拒绝明确失败；不确定回执从不重试 WRT-10/12/14 LED-07 OUT-03](test/commerce.test.js#L201) |

### 薄壳

| ID | 实现位置 | 对应测试名 |
| --- | --- | --- |
| SHL-01 | [package.json](package.json) · bin、files，协议运行库生成方式见 scripts/build-runtimes.js | [SHL-01 干净目录离线安装根包后免编译，经 stdio 连接真实服务端列出工具](test/shell.test.js#L123) |
| SHL-02 | [bin/device.js](bin/device.js) · deviceId | [SHL-02 两个进程首次并发启动取得同一个私有 UUID，重启复用，保存失败退出](test/shell.test.js#L175)<br>[SHL-02 禁用硬链接并延迟首次写入，两个薄壳仍共用私有设备文件](test/shell.test.js#L396) |
| SHL-03 | [bin/licha-order-mcp.js](bin/licha-order-mcp.js) · post、forward、initialize、rebuild、close | [SHL-03 SHL-04 SHL-05 握手屏障、请求编号、SSE 和透明答复，诊断脱敏](test/shell.test.js#L196) |
| SHL-04 | [bin/licha-order-mcp.js](bin/licha-order-mcp.js) · post、forward、initialize、rebuild、close | [SHL-03 SHL-04 SHL-05 握手屏障、请求编号、SSE 和透明答复，诊断脱敏](test/shell.test.js#L196) |
| SHL-05 | [bin/licha-order-mcp.js](bin/licha-order-mcp.js) · post、forward、initialize、rebuild、close | [SHL-03 SHL-04 SHL-05 握手屏障、请求编号、SSE 和透明答复，诊断脱敏](test/shell.test.js#L196) |
| SHL-06 | [bin/licha-order-mcp.js](bin/licha-order-mcp.js) · post、forward、initialize、rebuild、close | [SHL-06 并发标记 404 只重建一次，每个原请求仅补发一次](test/shell.test.js#L235)<br>[SHL-06 同批标记 404 共享重建失败结果，后续独立请求仍可恢复](test/shell.test.js#L345) |
| SHL-07 | [bin/licha-order-mcp.js](bin/licha-order-mcp.js) · post、forward、initialize、rebuild、close | [SHL-07 普通 404、断连、5xx、畸形应答和超时均不重发，薄壳继续服务](test/shell.test.js#L262)<br>[SHL-07 配置 75 毫秒，服务端 250 毫秒后成功也不重放](test/shell.test.js#L378) |
| SHL-08 | [bin/licha-order-mcp.js](bin/licha-order-mcp.js) · post、forward、initialize、rebuild、close | [SHL-08 输入关闭后 DELETE 会话，404 或挂起均有界退出且不重建](test/shell.test.js#L290)<br>[SHL-08 重建中关闭输入，结束最新远端会话且不再补发工具请求](test/shell.test.js#L314) |

### 上游访问

| ID | 实现位置 | 对应测试名 |
| --- | --- | --- |
| UPS-01 | [server/qmai.js](server/qmai.js) · Qmai、post、sign、checkSignature | [BRW-04 BRW-05 BRW-06 菜单分支、过滤和估清，UPS-01 无损分类 ID](test/browse.test.js#L66)<br>[BRW-10 UPS-01 UPS-03 OUT-02 OUT-03 重试重签、读超时和异常响应](test/browse.test.js#L223)<br>[UPS-01 R4 响应数组、嵌套字段与字符串中的数字保持无损](test/browse.test.js#L305)<br>[UPS-01 R21 损坏的密钥封装不作为普通字符串签名](test/browse.test.js#L381) |
| UPS-02 | [server/qmai.js](server/qmai.js) · Qmai、post、sign、checkSignature | [UPS-02 全局队列按实际发送时刻限速、慢响应可并行](test/browse.test.js#L268) |
| UPS-03 | [server/qmai.js](server/qmai.js) · Qmai、post、sign、checkSignature | [BRW-10 UPS-01 UPS-03 OUT-02 OUT-03 重试重签、读超时和异常响应](test/browse.test.js#L223)<br>[UPS-03 读超时覆盖收到响应头后的半截响应体](test/quota-time.test.js#L120) |
| UPS-04 | [server/qmai.js](server/qmai.js) · Qmai、post、sign、checkSignature | [UPS-04 签名实现损坏时真实启动拒绝就绪](test/browse.test.js#L311) |
