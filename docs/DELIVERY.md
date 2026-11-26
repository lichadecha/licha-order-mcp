# 李茶的茶点单 MCP v1.17 交付清单

根包提供顾客端 stdio 薄壳，独立的 `server/` 包提供 Streamable HTTP 服务端和本机账本运维命令。三个入口均可从任意工作目录按绝对路径启动。[运行说明](SERVER.md)

## v1.17 初始化说明

- 服务端在初始化答复里带 `instructions`（RCP-01）：`LICHA_ENABLE_ORDERING` 精确等于 `1` 时给「开通下单」文案，否则给「只开浏览」文案，逐字照工具契约 §0.2，文案常量在 `server/instructions.js`。薄壳不改动，原样转发。[初始化说明测试](../test/instructions.test.js)
- 测试覆盖两种形态逐字相等、开关为 `true` 时按只开浏览、以及经薄壳握手拿到同一段文案。

## v1.16 会员复查与订单回执（历史记录）

- 已验证号码从短信验证通过起另计绝对期限。创建订单前按号码核对一次会员，改挂时清除所有设备上的同号记录，查询失败时保留原待确认单。[会员复查测试](../test/order-member-recheck.test.js) · [到期边界测试](../test/window.test.js)
- 查单按回执核对订单号，判无单时核对整页归属。优惠和等级等上游文字按当前会员与本次券实例遮盖，错误码遵循相同限制。[查单测试](../test/order-query.test.js) · [遮盖测试](../test/coupon-redaction.test.js)
- 开通下单时，健康检查报告账本状态。旧账本没有回填信息的发码记录仍计入按号限频与日额，刹车比例只统计回填情况已知的记录。[迁移测试](../test/sms-ledger.test.js) · [运行说明](SERVER.md)

## v1.15 验证短信按比例刹车（历史记录）

- 窗口内已过有效期的码达到最少样本数，且未回填比例超过设定值时，全服务暂停发新码。每次请求重新判断。北京时间自然日总额默认 2000 条。[运行说明](SERVER.md) · [停发与恢复测试](../test/sms-brake.test.js)
- 校验通过后更新对应的 SQLite 发码记录，重启后仍可统计回填情况。服务重启会清空待验证和设备绑定。[账本与迁移测试](../test/sms-ledger.test.js)

## v1.14 默认用券与实付核对（历史记录）

- 默认组单时，服务端只从本单可指定、抵扣为正且抵后仍需付款的券中挑选。选中后将抵扣最多的一张登记到待确认单，下单时按 R26 指定该券；金额并列取上游先返回的一张。挑不到时按原因提示顾客，创建请求各层均省略用券字段。[选券与请求体测试](../test/coupon-preparation.test.js)
- 下单后，用登记的券实例与券后实付核对读回。告警比较读回实付和念单时的预计实付，`diffYuan` 仍比较读回实付和券前预估。两项预测字段均已移除。[读回与告警测试](../test/coupon-readback.test.js)
- 规格 §8 第 1 条的真实订单验证留待上线后进行，需核对默认单实际使用的券与实付金额。开放前核验（品牌方内部规格）

## v1.13 查询当前会员的积分和等级（历史记录）

- **工具与绑定（ORD-01、SES-04）。** 服务端仅在 `LICHA_ENABLE_ORDERING=1` 时注册第十个工具 `my_member_info`。入参为空对象。未绑定时直接返回绑定提示。查询成功（含只查到一项）刷新本设备当前绑定的闲置计时。工具契约 §10（品牌方内部规格）
- **企迈读出口（ORD-02、ORD-03、BRW-10）。** 每次按当前会员编号分别查 4.1.6 积分和 4.1.15 等级，直接读取最新回执。临时故障仅重试受影响的请求，每次重新签名，最多尝试三次。两条路径加入读出口白名单，服务器专用应用所需权限共 16 项。[读出口](../server/qmai.js) · 企迈契约（品牌方内部规格）
- **结果（QRY-07、QRY-08）。** 积分去掉小数末尾多余的零，近期过期数量大于零才展示数量及可解析的过期时间。等级回执带会员编号时须核对归属。只查到一项时附 `unavailable` 和对应提示，两项都没查到才返回查询失败。出参只给绑定尾号及绑定方式、查到的积分与等级、必要的缺项标记和兑换指引。兑换请到李茶小程序的积分商城。积分实测样本（品牌方内部规格） · 等级实测样本（品牌方内部规格）

Node 22.23.1 下连续运行三次完整 `npm test`，每轮 270 项全部通过，失败、跳过、取消均为 0。测试使用本机模拟企迈。另以两份规格原始样本验证解析结果，有效积分为 `"30"`、会员等级为 `"VIP1"`，近期将过期积分为零时省略过期字段。

## v1.12.3 点单卡片的品牌描述与多号绑定（历史记录）

- **商品描述（BRW-11）。** 卡片将企迈 `goodsExtra.goodsDesc` 的 `desc` 和 `detail` 分别投影为 `description.summary` 和 `description.detail`。去掉 HTML 标签、还原常见实体，段落用「；」连接，连续空白压为一个空格。按 OUT-02 去网址与疑似凭证，手机号和长数字串只留尾号。两项分别按 60 和 400 个 Unicode 码点截断，超长加省略号，空项省略，两项都空时省略整个对象。菜单列表不带描述。工具契约 §3（品牌方内部规格）
- **组单刷新（PRE-03、BRW-09）。** 浏览卡片和组单现读共用商品详情请求。两处均保留 `includeProperties` 并带上 `includeExtras: ["GOODS_DESC"]`，组单刷新缓存后，后续卡片也能显示最新的品牌描述。[详情请求与缓存](../server/browse.js)
- **已验证号码（BND-15）。** 现有实现符合本次澄清。每台设备按号码保存验证记录，个数不限。所有号码共用 `LICHA_BINDING_IDLE_TTL_MS`，分别计算闲置时间，只刷新当前绑定。绑定流程无需区分号码与顾客的关系。[绑定与失效](../server/binding.js) · [各号独立计时、重启与设备隔离](../test/window.test.js)

Node 22.23.1 连续三次运行完整 `npm test`，每轮均通过 264 项，失败、跳过和取消均为 0。商品描述通过本地 MCP 调用回放 11 月 24 日合成样本中的字段，并与规格样本（品牌方内部规格）核对。

## v1.12.1 单笔金额与顾客确认（历史记录）

- **单笔金额。** `LICHA_MAX_ORDER_AMOUNT_FEN` 接受非负整数，默认从 10000 分调整为 0。取 0 时，组单跳过上限检查（PRE-04），下单仍要求预估总额为正数（WRT-08）。设为正数时，合计等于上限可通过，超过上限沿用原拒绝文案。
- **待确认单。** `totalQuantity` 位于 `lines` 和 `estimatedTotalYuan` 之间，等于各行 `quantity` 之和。Agent 须让顾客明确确认每行数量与总杯数、优惠、合计与预计实付。总杯数达到 10 杯或合计达到 300 元时，再单独复述总杯数与预计实付，取得第二次确认后下单。`place_order` 使用待确认单的令牌，`confirmAmountYuan` 取顾客确认过的券前合计。
- **多号码绑定。** 已核对 BND-06。换绑时 `previousMember` 仅以尾号标识原号码。服务端按设备将完整号码保存在内存的已验证号码表中，切回仍有效的号码可免收验证码。[绑定实现](../server/binding.js)
- **回归测试。** Node.js v22.23.1 下连续运行三次完整 `npm test`，每次均通过 260 项，失败和跳过均为 0。用例覆盖默认配置下 15 杯、合计 300 元的组单与提交，以及金额为零、复述金额不符、超过已配置上限时拒绝提交。

## v1.12 每日下单上限与多号码绑定（历史记录）

- **每日单量。** `LICHA_MAX_ORDERS_PER_CUSTOMER_PER_DAY`（每位会员）和 `LICHA_MAX_ORDERS_PER_DAY`（全体会员）都只接受非负整数，默认均为 0。0 表示该项不限，不占名额，也不会出现该项的额度拒绝提示。两项可分别设为正数，按取得占位时的北京时间自然日计数。单笔金额上限和同一会员同时只能有一笔在途的限制继续生效。
- **已有账本。** 沿用 SQLite 格式 4。旧版订单按原规则计入两项额度。新版订单只占用当时已启用的额度。当天调高或收紧上限时，已占用的名额继续计数。
- **设备绑定。** 同一设备可以记住任意多个短信验证过的号码，同一时刻只按当前绑定组单、下单和查单。报当前号码按幂等处理。报本设备另一位会员的号码时，只要该号已验证且未失效，即可直接切换。两种操作都不访问上游，也不占会员查询次数。原会员有未决下单请求时拒绝换人。成功切换返回换绑标记、作废张数和免验说明，切回原会员需要重新组单。
- **闲置与重启。** `LICHA_BINDING_IDLE_TTL_MS` 默认 2592000000 毫秒（30 天），每个号码独立计时，只有当前绑定随符合条件的工具调用续期。闲置失效后须重新验证。已验证号码仅存于服务端内存，重启清空，每台设备分别验证。
- **回归结果。** 使用本地模拟企迈上游，连续三次运行完整 `npm test`，每次 258 项全部通过，0 跳过。[配额与旧账本](../test/order-limits.test.js) · [切换与未决请求](../test/sms-binding.test.js) · [闲置、重启与设备隔离](../test/window.test.js)

## v1.11.2 短信额度、校验与账本升级（历史记录）

- **发码。** 查会员前在本地检查账本、同号冷却、滚动小时、按号自然日和全服务自然日额度。发码落账时再复核全部档位。`LICHA_SMS_GLOBAL_PER_DAY` 默认 100，须为正整数。限频回复选解除最晚的一档，全服务与按号日额并列时选全服务。访问审计记录命中档位，当天首次因全服务日额拒绝另记 `sms_global_day_exhausted`。[账本边界](../test/sms-ledger.test.js) · [并发、跨午夜与首拒审计](../test/sms-binding-recovery.test.js)
- **账本。** SQLite 格式 4 用同库生成的 32 字节随机密钥计算手机号 HMAC-SHA256，访问审计与发码记录使用同一摘要。格式 2、3 自动迁移，保留订单、已占额度、未决、防重与认领记录，丢弃格式 3 的旧短信记录。重启沿用已提交的密钥、发码记录和日额首拒标记。运行中账本故障后，有效绑定仍可查单。启动即故障时，绑定已清空，顾客须到小程序查单。[迁移与损坏](../test/sms-ledger.test.js) · [查单与恢复](../test/commerce.test.js)
- **校验。** 以第二步到达时刻判断有效期。R27 的四种肯定形态算通过，明确不通过与认不出的回执有不同提示，均计一次报错。只有超时、连接失败和 HTTP 5xx 保留次数。短信出口的上游文案遮盖连续 4 位及以上数字，保留 1 至 3 位。[短信出口](../test/sms-gateway.test.js) · [逐次报错与过期边界](../test/sms-binding.test.js)
- **工具回执。** 提交多余字段时按段遮盖字段路径。按分类查商品遇传输失败时带工具前缀和对应提示语。默认用券与预测不一致且读回实付为零时，回执以「请如实更正。」结束。

**全量回归。** Node 22.23.1、本机回环模拟企迈，连续三次运行完整 `npm test`。第一次 250 通过、0 失败，第二次 250 通过、0 失败，第三次 250 通过、0 失败。三次跳过、取消均为 0。真实短信回执与商家短信单价仍待实测。

**规格文字冲突。** BND-12 与工具契约 §5 表格写有全服务日额命中即用专属文案，§5 末段要求四档按解除最晚者选文案。按本轮任务第 2 项采用末段规则。接近午夜时，冷却或滚动小时可能比日额更晚解除。只要命中全服务日额，当天首拒仍单独记审计。

## v1.11.1 查会员前检查发码条件（历史记录）

第一步绑定先检查手机号冷却、滚动一小时上限、北京时间当天上限及账本状态。四种拒绝情形各有一项回归测试，均断言上游请求为零。确认是会员后，发码前再次核对限频并落盘。[绑定回归测试](../test/sms-binding-recovery.test.js)

Node 22.23.1 运行 `npm test`，234 项全部通过。

## v1.11 手机号绑定与短信验证（历史记录）

- **会员绑定。** 同设备首次绑定手机号需通过企迈验证码校验。换绑前及校验通过后均核对原会员未决订单。发码到校验期间保留原绑定和待确认单，卡号和动态码在本地拒绝。短信校验从严接受 R27 的四种肯定回执，校验请求失败保留剩余次数。[绑定与审计回归](../test/sms-binding.test.js)
- **短信出口。** 开通下单须设置有效的 `LICHA_SMS_EVENT_NO`。独立出口只放行发码和校验，发码消耗与本次请求、手机号匹配的一次性落盘凭据，两项均只尝试一次。[配置与出口测试](../test/sms-gateway.test.js)
- **恢复与隐私。** 发码按手机号摘要落盘，冷却、滚动小时和北京时间自然日上限跨设备、跨重启生效。短信服务明确拒绝或回执不明也占用次数。格式 2 账本自动升至格式 3，保留订单。重启清除内存中的待验证，账本故障停止发码。绑定闲置期默认 30 天。[账本升级与限频](../test/sms-ledger.test.js) · [跨设备及重启验收](../test/sms-binding-recovery.test.js)

**全量回归。** 基线 `fa7f891`。新增 25 项测试，其中绑定流程、过期与隐私 8 项，配置、出口与回执 6 项，账本 6 项，跨设备与重启 5 项。Node 22.23.1 完整运行 `npm test`，230 项全部通过，失败、跳过、取消均为 0。

**实测边界。** 本轮使用假凭证和本机模拟企迈。商家后台的事件编号、短信单价，以及正确码、错误码、过期码的真实回执仍待品牌方核实。

## v1.10.1 券归属、实例冲突与实付核对（历史记录）

- **组单。** 逐行核对 `customerId` 和 `user_id`。明示他人、归属无效或矛盾时排除整张券。同一实例的可用性、可抵金额或原始券名有冲突时也排除整张，一致重复只计一次。缺实例 ID 或两个归属都缺时继续列出并参与默认预测，省略该张的 `ref`。指定时现查，旧编号不能绕过本次判定。正反行序、甲指定乙的可用券被拒且创建请求为零、三张券中只删除一行 ID，均有回归。[组单与 R26 完整请求体](../test/coupon-preparation.test.js)
- **文字与日志。** 从整次筛券响应取实例 ID，组单、创建错误、读回错误及优惠明细共用本单的遮盖规则。7 位 ID 显示为 `***`，19 位只露尾四位。WRT-01 的多余字段路径按段核对设备券编号，命中的段显示为 `（券编号）`。回环测试同时检查访问、写入、上游三本日志。[遮盖与日志回归](../test/coupon-redaction.test.js)
- **读回。** 确认只用了指定券后，按分比较实付与待确认单登记的券后实付。念单预计付 17.00 元，读回实付 19.50 元或 20.00 元，两例均为 `matchesChoice:true`、`amountAsPromised:false`，说明差额并请顾客决定付款或取消。有明确异券时优先判用券不符。默认、不用券、指定三种选择遇到非数组明细都按未取得优惠信息处理。[读回、金额与付款指引](../test/coupon-readback.test.js)

**全量回归。** 基线 `bc767b1`。新增 14 项测试，其中归属与冲突 4 项、文字及字段路径遮盖 6 项、读回与金额核对 4 项。原有缺 ID 用例按新版逐行判定更新。Node 22.23.1 使用假凭证与本机回环模拟企迈，完整运行 `npm test`，205 项全部通过，失败、跳过、取消均为 0。默认与不用券的整份创建请求均通过既有 R26 样本比对。

## v1.10 顾客指定用哪张券（历史记录）

- **券编号与组单。** 可用券带有绑定范围内稳定的随机 `ref`。顾客点名后，用 `couponChoice: "specific"` 和 `couponRef` 重新组单。服务端先核验编号，再查询一次本单可用券。查券失败、门店没有编码、券已不可用或抵扣为零时均不签令牌。通过时给出券名、当前可抵金额和券后预计实付。上游把缺少有效实例 ID 的行列为可用时，按查券失败处理，默认选择仍可组单。[编号生命周期](../test/coupon-refs.test.js) · [组单回归](../test/coupon-preparation.test.js)
- **提交与恢复。** 下单请求按 R26 在顶层写入三项，两处券实例 ID 均为同一个十进制字符串。签发与提交各自核对请求。写审计和账本只记 `specific`。模拟重启后可继续核对未决单。既有整份创建请求断言继续覆盖默认和不用券。[提交与审计回归](../test/coupon-audit.test.js)
- **读回与付款。** 读回按券实例 ID 的精确整数值核对。同名券缺少 ID 时请顾客在小程序确认。确定用券不符且实付大于零时，顾客可接受金额后付款，或取消该单。实付为零时引导核对订单状态。[读回回归](../test/coupon-readback.test.js)

**全量回归。** 基线 `02e5f5d`，新增 17 项测试（券编号生命周期 4 项、组单与请求体 6 项、读回 4 项、提交与审计 2 项、券编号精度 1 项）。Node 22.23.1 使用假凭证和本机回环模拟企迈运行完整的 `npm test`，191 项全部通过，失败、跳过、取消均为 0。

## v1.9.1 优惠读回与提前拒绝的写审计（历史记录）

- **WRT-17 / WRT-20**　默认和不用券共用同一套读回判定。认不出的明细逐条显示为「优惠（金额未知）」，省略 `isCoupon`。没有明确券时，若有未知类型，或各条金额都已知但相加与优惠合计不符，向顾客说明无法确定是否用券，省略 `matchesPrediction` 和 `matchesChoice`。有明确券时仍按已用券处理。[读回回归](../test/coupon-readback.test.js)
- **§5.9 / LOG-03**　`place_order` 因多余字段、参数形状错误或设备限流提前拒绝时，从本设备仍登记的令牌取得完整令牌 ID 和防重键。他机令牌、未登记令牌及非字符串输入均省略这两项和用券选择。[写审计回归](../test/coupon-audit.test.js)

**全量回归。** 基线 `a06df9e`，新增 6 项测试（优惠读回 3 项、提前拒绝审计 3 项）。在 Node 22.23.1 下使用假凭证和本机回环模拟企迈运行完整的 `npm test`，174 项全部通过，失败、跳过、取消均为 0。

## v1.9 这单不用券（历史记录）

**已验证（本地模拟企迈）**

- `prepare_order` 的 `couponChoice` 只接受 `default` 和 `none`。缺省和显式默认都按原规则筛券、预测。同一份完整请求样本在 v1.8 基线 `a7aaf35` 和本版均通过，覆盖字段、取值和长编号的 JSON 数字类型。不用券时筛券请求为 0 次，创建请求只在顶层增加 R26 三项，字段错层、缺项或值不符会在签发令牌前被拒绝。[组单与创建请求](../test/coupon-preparation.test.js)
- 用券选择和完整请求一起登记。即使同一会员换设备重新组单，旧令牌也会作废。提交时重新核对登记的选择，企迈明确拒绝不用券时只发一次创建请求。[换选择与提交](../test/order-preparation.test.js)
- 不用券的读回覆盖五种证据情形。确定用了券且实付大于零时，先请顾客决定是否接受该金额。实付为零时引导核对订单状态。读回失败会提醒核对金额和用券。默认用券沿用预测比对。[读回与付款指引](../test/coupon-readback.test.js)
- 写审计从本设备签发的令牌取用券选择，未命中时省略该字段。未决请求在重启后核对仍保留原选择，v1.8 账本按默认用券处理。[写审计与恢复](../test/coupon-audit.test.js)

**全量回归。** Linux、Node 22.23.1，使用假凭证和本机回环模拟企迈运行 `npm test`。原有 153 项与新增 15 项共 168 项全部通过，失败、跳过和取消均为 0。

## v1.8 订单列表的下单时间（历史记录）

6.1.6 列表行优先读取 `createdAt`，按北京时间解析到该秒的起点。缺失或为 null 时沿用 `orderAt`、`createTime` 的 13 位毫秒。已提供的时间格式错误或日期不存在时，本人订单仍可展示，省略下单时间，该行也不能用于认领或证明无单。订单展示、查询起止边界、UNR-03 匹配窗和 UNR-04 完整性判断共用这一取法。[实现](../server/commerce-view.js) · [格式和兼容测试](../test/order-query.test.js)

端到端样本按契约 §3.13 构造，页级 `blttUserId` 为 null，行内 `userId`、`storeId` 和商品 `goodsId` 为裸数字。模拟的两杯「测试茶」按 `itemName` 和 `num` 展示。编号或杯数不符时保持未决，修正后能认领十分钟边界的本人订单。完整页只有匹配窗外的本人旧单，或返回完整空页时，静默期满可判无单。查询起点和终点均包含整秒边界，起点向后移一毫秒即排除该秒的订单。[端到端测试](../test/order-created-at.test.js)

**本轮验收。** 基线 `8d94160`，新增 7 项测试，其中 2 项直接验证解析规则，5 项通过本机 MCP 服务和模拟企迈验证。Node 22.23.1 完整运行 `npm test`，153 项全部通过，失败、跳过、取消均为 0。全程使用假凭证和本机回环地址。

## v1.7 订单列表的会员归属（历史记录）

本轮基于 `4276276`，包含 `ee08503` 的实现及后续顾客说明书修订。据负责人反馈，上一轮两条修复均经独立复核确认。第八轮黑盒验收共 232 项，217 项通过，0 项失败。

- **UNR-04**　`my_orders` 用查询时段内已核实属于本人的不同订单号核对总数。整页只要出现缺少会员号的行，即使该行时间在匹配窗或查询时段之外，也不能判无单。模拟上游已为 A 登记一单、错页只回 B 一小时前的旧单并省略会员号时，账本保持未决，A 再次确认新增创建请求 0 次。随后同页返回唯一吻合的本人订单时可正常认领。[未决与重下回归](../test/order-query.test.js)
- **QRY-04 / R11**　归属缺失的订单明细从 `orders` 中移除，`count` 只数实际展示的本人订单。查询时段内有归属缺失的合格单号时，返回 `unverifiedNotShown` 并在 `note` 末尾追加 §9 的小程序提示。已标明他人归属及归属值无效的行继续计入 `discardedNotOwned`。双会员测试对比整份回包，核实混入 B 的行后，A 只能看到隐藏数量和提示。[列表出参回归](../test/commerce.test.js)

**本轮验收。** Node 22.23.1，假凭证、本机回环模拟上游，完整运行 `npm test`。146 项全部通过，失败、跳过、取消均为 0。新增 3 项（UNR-04 两项，QRY-04 一项），修订已有列表用例 2 项。三组无单对照均通过：总数为 0 且仅多回本人越界旧单，总数为 1 且只回时段内、匹配窗外的一张本人旧单，以及总数为 0 的完整空页。按单号查询的既有归属校验用例通过。

## v1.6 未决核对与复述金额（历史记录）

基线为 `0f5ca6c`。据负责人反馈，上一轮 5 条修订均经独立复核通过，第七轮黑盒验收共 221 项，206 项通过，0 项失败。

- **UNR-04 · 查询时段。** `my_orders` 只用本次查询起止时间内的不同订单号核对 `total`。查最近一天、总数为 1 而第一页仅有两天前旧单时，列表为空，原请求保持未决，再次提交仍被拦截。总数为 0 且仅多返回一张越界旧单，或总数为 1 且唯一旧单落在查询时段内、匹配窗外，其余无单条件齐全时均可解除未决。[查询与重下回归](../test/order-query.test.js)
- **WRT-05 · 复述金额。** `place_order` 按收到的数值检查小数位数。超过两位时返回工具契约 §7 的重新确认提示，创建请求发出 0 次。整数及最多两位小数的金额沿用原规则，与待确认单相差 1 分可提交，超过 1 分拒绝。[长小数与一分容差回归](../test/commerce.test.js#L886)

**本轮验收。** Node 22.23.1，使用假凭证和本机回环模拟上游运行完整的 `npm test`。143 项全部通过，失败、跳过、取消均为 0。相对基线新增 4 项，UNR-04 和 WRT-05 各 2 项，另各修订 1 项已有用例。原始 JSON 数字 `19.984999999999999999`、`20.014999999999999999` 均返回 §7 指定文案，随后用同一令牌复述整数 `20` 成功创建一单。

## v1.5 编号、金额与未决核对（历史记录）

本轮基于 `2e52982`。负责人反馈，上一版独立复核的 84 组写入故障与强制结束实验均恢复到预期的已提交状态，第六轮黑盒验收共 214 项，199 项通过、0 项失败。

| 修订 | 行为与回归 |
| --- | --- |
| R25、BRW-08、PRE-03、R3 编号比较 | 菜单给出 `"00076543210"`、详情给出 `76543210.0` 时，可以直接用菜单的编号打开卡片。同一商品用不同写法分两行组单，只现读一次详情。门店 `"00301"` 能取到店名，并使用原门店编码筛券。同一商品内，SKU、做法分组、做法值或加料各自出现数值重复的编号，预估与组单均拒绝。会员尾号沿用 §4，纯数字字符串保留前导零。[编号回归](../test/catalog-integers.test.js) · [会员尾号](../test/member-identity.test.js) |
| §4 元换分 | 从企迈创建回执和筛券响应保留元金额的十进制原文，移位后按半分四舍五入。创建回执的 `90071992547409.85` 元与详情的 `9007199254740985` 分显示一致。筛券请求里的元单价也由整分直接拼成 JSON 数字。[金额回归](../test/response-integers.test.js) |
| R25 金额上界 | `9007199254740991` 分有效，多一分按无效处理。超界售价不能组单，超界的创建金额不回显，列表实付标为未知，超界券抵扣按工具契约记零并排除在预测之外。[上界与进位](../test/response-integers.test.js) |
| UNR-04 列表完整性 | 用本页不同的合法订单号数核对 `total`。总数为 2 而同一张旧单返回两行时，过了匹配窗也继续拦截重下。换成旧单、吻合的新单各一行后，只认领新单。[重复行与下单闸门](../test/order-query.test.js) |
| UNR-03、工具契约 §9 有单说明 | 查到唯一吻合订单后，按契约告知「按这张处理，不要重下」，并按待支付、其他已知状态、状态未知的顺序附上适用尾句。企迈列表没有来源标记，顾客在同一时间窗自行下的相同订单也可能吻合。[核对文案与三个尾句](../test/commerce.test.js) |

**本轮验收。** Node 22.23.1，本机回环模拟企迈，完整运行 `npm test`，139 项通过，失败、跳过、取消均为 0。比基线新增 11 项，其中编号匹配与冲突 6 项、金额换算 2 项、金额上界 1 项、重复订单号与核对文案各 1 项。

## v1.4 数据可靠性改进（历史记录）

本次基于 `f01df9c` 的服务实现，保留其后的两笔顾客说明书提交。负责人反馈，第五轮独立黑盒验收共 189 项，其中 182 项通过、0 项失败。以下验证针对 v1.4，均使用假凭证和本机模拟企迈。

**账本与切换。** `orders.sqlite` 保存请求记录、终态、未决核对结论与人工裁决说明。已占额度、待核对请求和已认领的单号从记录恢复。每笔事务以 `synchronous=FULL` 提交后才对当前进程生效，发送凭据只在发送前记录明确提交后签发一次。服务与 CLI 使用同一把目录排他锁，重启读取 SQLite 已提交状态。格式号为 2，存入 `PRAGMA user_version`。首次发布完整空库后才接受业务写入。日常恢复由 SQLite 自己的事务日志完成。

`a42cb6b`、`b16d3c3`、`f01df9c` 等旧版账本和未知格式会触发 LED-02，保留现场并停用下单。按 §8 第 8 项停旧版下单，使用原版本的工具核清未决和当日额度，保留旧目录，将新版切到新的空目录。若当天新旧额度合计可能超限，可在下一个北京时间自然日启用。运维仍使用 `list`、`resolve … found …`、`resolve … absent …`。[运行及切换说明](SERVER.md#账本故障与人工核对)

另以本仓库中的三个历史提交各自写入一笔未决。三版原 CLI 均列出一笔，新版 CLI 对原目录均以退出码 1 拒绝接管，并给出 §8 第 8 项的切换提示。

**LED-03 允许的保守偏差。** 任意写入报错都会关闭本进程后续下单。即使提交已生效才报错，当场答复也遵守下表。

| 报错位置 | 当场答复与发送结果 | 重启读取到的状态 |
| --- | --- | --- |
| 发送前记录 | 创建请求发出 0 次，明确告知「本次下单请求没有发出」。 | 无此笔记录，或该会员多一笔占额的未决。匹配窗过去且订单列表足以证实无单时，`my_orders` 解除未决。 |
| 发出后写终态 | 如实返回已收到的企迈结果，成功时给出单号，回执不明时提示先别重下。 | 至少有发送前记录。可以是未决，或已提交的终态。 |
| 核对结论 | 可告知查到的订单，说明闸门仍关着、稍后再查。 | 仍为未决，或已有证据支持的结论已提交并解除。 |

进程强杀后按同样的提交边界恢复，其他会员可照常下单。已发出的创建始终有记录，同一确认单至多发出一次。仅凭超时、无效单号或不完整的订单列表不能判无单。

**整数、单号与显示。** R25 按原始十进制值解析整数，目录编号和整数分与交易回执使用同一判据。有效 `long` 编号的范围为 1 至 9223372036854775807。售价带不足一分的尾数时，详情显示「价格待询」，该规格不能下单。R23 在保留大整数原文前区分 JSON 类型，创建、详情、列表和状态均只接受合格的字符串单号。金额按整数分的十进制数字拼两位小数（含负差额）。会员 ID 的纯数字字符串按原样取尾，含小数点或指数的等值写法按规范整数取尾；长度不足八位只显示 `***`。

取值范围按编号的十进制数值判断，纯数字字符串的前导零不计入有效位数。目录中原本允许省略的做法和加料加价继续按 0 处理，明确给出的负数或不足一分的加价会阻止选购该项。非零加价沿用 R18 的单位约定，尚未经真实企迈确认。[目录数据回归](../test/catalog-integers.test.js)

**本轮验收。** Linux、Node 22.23.1，最终代码在本机回环运行 `npm test`，128 项通过，失败、跳过、取消均为 0。v1.4 新写 30 项用例，其中账本 19 项、目录 6 项、会员范围与尾号 2 项、订单号 2 项、金额显示 1 项。账本的 19 项覆盖并替换旧存储专项 18 项；逐文件损坏测试从两个文件子项变为一个。全套比上轮 117 项净增 11 项。已验证两个进程并发启动时只有一个取得目录锁、上游收到创建后强杀和发送前提交后强杀两处恢复边界，以及实际写连接的同步级别。整机掉电未实测。[事务与强杀](../test/ledger-recovery.test.js) · [格式与同步级别](../test/ledger-evidence.test.js) · [并发启动与运维](../test/commerce.test.js)

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

**强杀后怎样确认写入前状态。** 服务和 CLI 先取得目录锁并检查 SQLite 完整性。有撤销行时，当前快照须与其中的旧快照逐字节一致，或其 SHA-256 等于所记的候选摘要；若还有人工核对标记，标记必须与撤销行的旧快照逐字节一致。仅余标记时，当前快照必须已经等于标记。旧快照还须通过格式、记录校验和、记录内容、键唯一性和摘要口径校验。通过后恢复旧快照，清理残留并同步目录，再开放写入。恢复中再次退出，仍以同一份旧状态续做。证据矛盾时保留原文件并停单。[恢复反例](../test/ledger-evidence.test.js)

**会员摘要与切换。** 新快照写入 `memberHashVersion: "sha256-canonical-decimal-v1"`，摘要输入是会员编号的规范化正十进制字符串。无版本且没有记录的旧快照可继续使用，下一次写入即带版本。含会员记录却无版本、或版本无法识别时停单，保留旧数据。已用 `a42cb6b` 的实际账本代码写出一笔带前导零会员号的未决记录，旧版 CLI 列出 1 笔，新版 CLI 对同一目录退出 1 并提示按 §8 第 8 项切换。[运行说明](SERVER.md#账本故障与人工核对)

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

**旧会员摘要。** 旧版按带前导零字符串生成的会员摘要不可逆，快照缺少重算所需的原始编号。此类旧数据的升级需先核清未决和当日个人额度，无法还原对应关系时的切换时机见运行说明。[账本故障与人工核对](SERVER.md#账本故障与人工核对)

本轮新增回归按账本、会员、组单与查单拆分，均从实际 MCP 工具入口访问本机服务。[账本恢复](../test/ledger-recovery.test.js) · [会员编号](../test/member-identity.test.js) · [组单与用券](../test/order-preparation.test.js) · [查单与未决](../test/order-query.test.js)

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

各项的实现文件与测试名见后面的逐项对照表。环境变量另有两项启动验证。[§3.2 启动配置只在未设置时采用默认值，拒绝无效项且不回显](../test/session.test.js#L196)、[§3.2 凭证缺项仍可握手，非法环境变量阻止启动且不回显](../test/session.test.js#L248)

## 未验证

| 对应范围 | 尚缺的证据 |
| --- | --- |
| SHL-01、SHL-02、SHL-07 | Windows、macOS 真机和两种实际 AI 客户端未验证，Windows 跳过 POSIX 权限位断言。此前版本在 Linux Node 18.0.0 离线安装后完成过握手、列工具和查询；本轮薄壳在 Node 18 上未复测。生产地址与公开标签安装待定（P5）。 |
| LED-03、LED-06 | 已用进程强杀、同步错误注入与磁盘文件损坏验证恢复。物理断电、损坏的存储硬件以及网络文件系统锁语义未验证。部署目标为本机持久化文件系统。 |
| PRE-12、WRT-20、P1 | 本服务在真实企迈下单后的用券和实付仍待联调。契约 §3.10.4 记录的 11-23 两笔探针测试覆盖一张普通券，自动生效类券和非券活动的表现仍待验证。指定用哪张券排在第二版。 |
| BND-10、PRE-06、WRT-19 | 真实身份持有证明、非零加价的价格单位及全额抵扣后的订单状态仍待真实环境核实。 |
| SES-04、WRT-09、§8 | 绑定闲置期已按 P3 定为默认 30 天，实际开放时的订单额度待确认（P4）。生产部署、旧版停单及人工清算未执行。 |
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
| LED-02/03/06/08、§8 | 停服后整目录备份与恢复。首次部署用空目录；旧版遗留未决由旧版运维核清。当天已占额的处理采用 SERVER.md 中的切换方法。运维 `requestedAt` 使用记录中的北京时间。 |
| SES-06、SES-07、SHL-07 | 未完成握手占名额，正在处理的 POST 完成后开始闲置计时。薄壳答复超时默认 75000 毫秒，接受 Node 定时器可表达的正整毫秒，关闭时限独立。 |
| §3.2、SHL-01 | 下单服务使用 Node 22.13 或更高的 22.x 内置 SQLite，并调用 Linux util-linux 的 `flock`。已验证本机文件系统，其他部署环境未验证。两个包分别随附 MCP SDK 1.32.2 的运行代码和授权文件，安装与运行无需编译。 |

## 逐项实现与测试

下表按规格 §5 的 ID 链接实现模块与测试定义，同一端到端用例可验证多条规则。测试中使用的故障、时钟偏移和假钥匙均不属于生产配置。

### 会话和设备

| ID | 实现位置 | 对应测试名 |
| --- | --- | --- |
| SES-01 | [server/session.js](../server/session.js) · makeEndpoint | [SES-01 SES-07 ORD-01 准入、设备归属、并发末席、失败和关闭归还名额](../test/session.test.js#L27) |
| SES-02 | [server/commerce.js](../server/commerce.js) · createCommerce、sweep、call | [设备隔离、跨设备替代、过期清理 SES-02/03 PRE-08/09 WRT-03](../test/commerce.test.js#L77)<br>[SES-02 SES-03 SES-04 SES-06 绑定跨会话保留、跨设备隔离，浏览与拒绝不续期](../test/session.test.js#L64)<br>[SES-02 SES-04 SES-06 关会话保留待确认单，绑定过期后同会员重绑也不能提交旧单](../test/session.test.js#L269) |
| SES-03 | [server/commerce.js](../server/commerce.js) · createCommerce、sweep、call | [设备隔离、跨设备替代、过期清理 SES-02/03 PRE-08/09 WRT-03](../test/commerce.test.js#L77)<br>[SES-02 SES-03 SES-04 SES-06 绑定跨会话保留、跨设备隔离，浏览与拒绝不续期](../test/session.test.js#L64) |
| SES-04 | [server/commerce.js](../server/commerce.js) · createCommerce、sweep、call | [SES-02 SES-03 SES-04 SES-06 绑定跨会话保留、跨设备隔离，浏览与拒绝不续期](../test/session.test.js#L67)<br>[SES-02 SES-04 SES-06 关会话保留待确认单，绑定过期后同会员重绑也不能提交旧单](../test/session.test.js#L274) · [会员查询部分成功也续期](../test/window.test.js#L135) |
| SES-05 | [server/commerce.js](../server/commerce.js) · createCommerce、sweep、call | [同会员在途、最后总额度与会员配额原子竞争 WRT-07/09 LED-01/05/07 SES-05](../test/commerce.test.js#L161)<br>[SES-05 SES-09 跨会话共用滑动窗口；重启清除限流与绑定](../test/session.test.js#L86) · [重启清除设备状态及查询限流，保留发码记录](../test/sms-binding-recovery.test.js#L94) |
| SES-06 | [server/session.js](../server/session.js) · makeEndpoint | [SES-02 SES-03 SES-04 SES-06 绑定跨会话保留、跨设备隔离，浏览与拒绝不续期](../test/session.test.js#L64)<br>[SES-06 已进入会话的 POST 在接收消息期间保持活动](../test/session.test.js#L224)<br>[SES-02 SES-04 SES-06 关会话保留待确认单，绑定过期后同会员重绑也不能提交旧单](../test/session.test.js#L269) |
| SES-07 | [server/session.js](../server/session.js) · makeEndpoint | [SES-01 SES-07 ORD-01 准入、设备归属、并发末席、失败和关闭归还名额](../test/session.test.js#L27)<br>[SES-07 正在接收握手的连接占名额，中止后只归还一次](../test/session.test.js#L207) |
| SES-08 | [server/session.js](../server/session.js) · dispatch | [SES-08 同设备跨会话按到达次序执行，其他设备可以继续查询](../test/session.test.js#L104)<br>[SES-08 SES-09 上一个绑定仍在等待时，同设备超额请求立即返回](../test/session.test.js#L124) |
| SES-09 | [server/session.js](../server/session.js) · makeEndpoint | [SES-05 SES-09 跨会话共用滑动窗口；重启清除限流与绑定](../test/session.test.js#L86)<br>[SES-08 SES-09 上一个绑定仍在等待时，同设备超额请求立即返回](../test/session.test.js#L124)<br>[SES-09 任意连续六十秒内跨会话计数，拒绝不延长窗口，另一台设备独立](../test/window.test.js#L55) |

### 工具开关和出口

| ID | 实现位置 | 对应测试名 |
| --- | --- | --- |
| ORD-01 | [server/session.js](../server/session.js) · makeEndpoint | [SES-01 SES-07 ORD-01 准入、设备归属、并发末席、失败和关闭归还名额](../test/session.test.js#L28) · [下单开关与工具数量](../test/session.test.js) · [会员工具契约](../test/member-info.test.js) |
| ORD-02 | [server/qmai.js](../server/qmai.js) · readPaths、Qmai.write、Qmai.sms · [账本发送凭据](../server/ledger.js) | [ORD-02 ORD-03 出口白名单与未知路径发前拒绝](../test/browse.test.js#L378)<br>[ORD-02 WRT-11 写出口拒绝缺失、伪造、跨次复用的落盘凭据](../test/write-gate.test.js#L12)<br>[ORD-02 增加路径常量不会自动获得读权限](../test/write-gate.test.js#L37) · [短信出口、关停与落盘凭据](../test/sms-gateway.test.js#L81) |
| ORD-03 | [server/qmai.js](../server/qmai.js) · Qmai.read、Qmai.write、Qmai.sms | [ORD-02 ORD-03 出口白名单与未知路径发前拒绝](../test/browse.test.js#L378) |

### 浏览与算价

| ID | 实现位置 | 对应测试名 |
| --- | --- | --- |
| BRW-01 | [server/browse.js](../server/browse.js) · #directory、#find | [BRW-01 BRW-02 BRW-03 门店匹配、采样和两路刷新](../test/browse.test.js#L30) |
| BRW-02 | [server/browse.js](../server/browse.js) · #directory、#find | [BRW-01 BRW-02 BRW-03 门店匹配、采样和两路刷新](../test/browse.test.js#L30) |
| BRW-03 | [server/browse.js](../server/browse.js) · #liveStatus | [BRW-01 BRW-02 BRW-03 门店匹配、采样和两路刷新](../test/browse.test.js#L30)<br>[BRW-03 BRW-04 R24 营业时间内层复数和菜单布尔标记](../test/browse.test.js#L582) |
| BRW-04 | [server/browse.js](../server/browse.js) · #menu | [BRW-04 BRW-05 BRW-06 菜单分支、过滤和估清，UPS-01 无损分类 ID](../test/browse.test.js#L70)<br>[BRW-04 BRW-08 错形分类不缓存；算价失败只给一次商品原因](../test/browse.test.js#L449)<br>[BRW-03 BRW-04 R24 营业时间内层复数和菜单布尔标记](../test/browse.test.js#L582) |
| BRW-05 | [server/catalog.js](../server/catalog.js) · menuItem，get_menu 的提示见 browse.js | [BRW-04 BRW-05 BRW-06 菜单分支、过滤和估清，UPS-01 无损分类 ID](../test/browse.test.js#L70) |
| BRW-06 | [server/catalog.js](../server/catalog.js) · menuItem，get_menu 的提示见 browse.js | [BRW-04 BRW-05 BRW-06 菜单分支、过滤和估清，UPS-01 无损分类 ID](../test/browse.test.js#L70) |
| BRW-07 | [server/catalog.js](../server/catalog.js) · itemCard，商品 ID 核对见 Browse.#item | [BRW-07 OUT-01 卡片投影、空值、估清优先级和商品一致性](../test/browse.test.js#L112)<br>[OUT-01 BRW-07 畸形公开 ID 字段不能携出无关的识别值](../test/browse.test.js#L431) |
| BRW-08 | [server/price.js](../server/price.js) · selectSku、selectPractices、checkOptionSpacing、priceLine | [BRW-08 逐行算价、同名做法及缺价规格](../test/browse.test.js#L194)<br>[BRW-04 BRW-08 错形分类不缓存；算价失败只给一次商品原因](../test/browse.test.js#L449)<br>[BRW-08 PRE-06 加料原文、展示同名和做法双重解释都核对至创建请求](../test/browse.test.js#L504) |
| BRW-09 | [server/browse.js](../server/browse.js) · #cached、#item、quote | [BRW-09 PRE-03 PRE-04 PRE-05 PRE-06 现价、必选、内部 ID 与签发快照](../test/browse.test.js#L219)<br>[BRW-09 PRE-03 同毫秒开始的旧浏览响应晚到，保留组单现读缓存](../test/browse.test.js#L404) |
| BRW-10 | [server/qmai.js](../server/qmai.js) · Qmai.#read、post | [BRW-10 UPS-01 UPS-03 OUT-02 OUT-03 重试重签、读超时和异常响应](../test/browse.test.js#L285) |
| BRW-11 | [详情请求](../server/browse.js) · [卡片投影](../server/catalog.js) | [描述样本、清洗脱敏、长度边界与空项](../test/browse.test.js#L146) |

### 绑定

| ID | 实现位置 | 对应测试名 |
| --- | --- | --- |
| BND-01 | [server/binding.js](../server/binding.js) | [绑定预检、幂等、换绑与识别值最小化 BND-01/02/03/04/05/06/08/10 PRE-01/08/10 WRT-02/04 QRY-01](../test/commerce.test.js#L19) |
| BND-02 | [server/binding.js](../server/binding.js) | [绑定预检、幂等、换绑与识别值最小化 BND-01/02/03/04/05/06/08/10 PRE-01/08/10 WRT-02/04 QRY-01](../test/commerce.test.js#L19)<br>[BND-02 R24 会员查询支持标量编号，未知形态报告查询失败并保留原绑定](../test/commerce.test.js#L749) |
| BND-03 | [server/binding.js](../server/binding.js) | [绑定预检、幂等、换绑与识别值最小化 BND-01/02/03/04/05/06/08/10 PRE-01/08/10 WRT-02/04 QRY-01](../test/commerce.test.js#L19) |
| BND-04 | [server/binding.js](../server/binding.js) | [绑定预检、幂等、换绑与识别值最小化 BND-01/02/03/04/05/06/08/10 PRE-01/08/10 WRT-02/04 QRY-01](../test/commerce.test.js#L19) |
| BND-05 | [server/binding.js](../server/binding.js) | [绑定预检、幂等、换绑与识别值最小化 BND-01/02/03/04/05/06/08/10 PRE-01/08/10 WRT-02/04 QRY-01](../test/commerce.test.js#L19) |
| BND-06 | [server/binding.js](../server/binding.js) | [绑定预检、幂等、换绑与识别值最小化 BND-01/02/03/04/05/06/08/10 PRE-01/08/10 WRT-02/04 QRY-01](../test/commerce.test.js#L19) |
| BND-07 | [server/binding.js](../server/binding.js) | [未决隔离、静默期、分页及唯一正证据 BND-07 WRT-07 UNR-01/02/03/04/05/06/07/08](../test/commerce.test.js#L304) |
| BND-08 | [server/binding.js](../server/binding.js) | [绑定预检、幂等、换绑与识别值最小化 BND-01/02/03/04/05/06/08/10 PRE-01/08/10 WRT-02/04 QRY-01](../test/commerce.test.js#L19) |
| BND-09 | [server/binding.js](../server/binding.js) | [绑定查询限流不计预检与限流拒绝 BND-09](../test/commerce.test.js#L66)<br>[BND-09 格式预检、设备一小时与全局一分钟滑窗分别计数，在边界释放](../test/window.test.js#L70) |
| BND-10 | [server/binding.js](../server/binding.js) | [绑定预检、幂等、换绑与识别值最小化 BND-01/02/03/04/05/06/08/10 PRE-01/08/10 WRT-02/04 QRY-01](../test/commerce.test.js#L19) |
| BND-11 | [两步绑定](../server/binding.js) | [待验证、换绑、失败与作废](../test/sms-binding.test.js) · [第二步到达时刻与跨期排队](../test/window.test.js#L57) |
| BND-12 | [发码计数与落盘凭据](../server/ledger.js) | [四档限频与 HMAC](../test/sms-ledger.test.js) · [并发、重启与故障](../test/sms-binding-recovery.test.js) |
| BND-13 | [设备待验证](../server/binding.js) | [重启失效](../test/sms-binding-recovery.test.js) · [出参与日志隐私](../test/sms-binding.test.js) |
| BND-14 | [访问审计](../server/logs.js) | [发码和校验分类、手机号与设备摘要](../test/sms-binding.test.js) |
| BND-15 | [设备内验证记录与统一闲置期限](../server/binding.js) | [切回已验证号码](../test/member-identity.test.js) · [各号独立计时、重启与设备隔离](../test/window.test.js) |

### 组单

| ID | 实现位置 | 对应测试名 |
| --- | --- | --- |
| PRE-01 | [server/commerce.js](../server/commerce.js) · requireBinding、prepare | [绑定预检、幂等、换绑与识别值最小化 BND-01/02/03/04/05/06/08/10 PRE-01/08/10 WRT-02/04 QRY-01](../test/commerce.test.js#L19) |
| PRE-02 | [server/commerce.js](../server/commerce.js) · requireBinding、prepare | [运行时故障仍可查单，重启发现损坏后可浏览、无法绑定](../test/commerce.test.js#L387) |
| PRE-03 | [server/browse.js](../server/browse.js) · quote、#item | [BRW-09 PRE-03 PRE-04 PRE-05 PRE-06 现价、必选、内部 ID 与签发快照](../test/browse.test.js#L219)<br>[BRW-09 PRE-03 同毫秒开始的旧浏览响应晚到，保留组单现读缓存](../test/browse.test.js#L404) |
| PRE-04 | [server/commerce.js](../server/commerce.js) · requireBinding、prepare | [BRW-09 PRE-03 PRE-04 PRE-05 PRE-06 现价、必选、内部 ID 与签发快照](../test/browse.test.js#L219) |
| PRE-05 | [server/price.js](../server/price.js) · priceLine | [BRW-09 PRE-03 PRE-04 PRE-05 PRE-06 现价、必选、内部 ID 与签发快照](../test/browse.test.js#L219) |
| PRE-06 | [server/commerce.js](../server/commerce.js) · prepare、checkOrderFields，分行内部 ID 核对见 price.js | [BRW-09 PRE-03 PRE-04 PRE-05 PRE-06 现价、必选、内部 ID 与签发快照](../test/browse.test.js#L219)<br>[BRW-08 PRE-06 加料原文、展示同名和做法双重解释都核对至创建请求](../test/browse.test.js#L504)<br>[递归拒绝七个预约字段 PRE-06](../test/commerce.test.js#L129) |
| PRE-07 | [server/commerce-view.js](../server/commerce-view.js) · couponView，单次筛券见 commerce.js 的 prepare | [默认挑券、投影、一次查询和缺门店编码 PRE-07 OUT-01/02](../test/commerce.test.js#L114) |
| PRE-08 | [server/commerce.js](../server/commerce.js) · requireBinding、prepare | [绑定预检、幂等、换绑与识别值最小化 BND-01/02/03/04/05/06/08/10 PRE-01/08/10 WRT-02/04 QRY-01](../test/commerce.test.js#L19)<br>[设备隔离、跨设备替代、过期清理 SES-02/03 PRE-08/09 WRT-03](../test/commerce.test.js#L77) |
| PRE-09 | [server/commerce.js](../server/commerce.js) · requireBinding、prepare | [设备隔离、跨设备替代、过期清理 SES-02/03 PRE-08/09 WRT-03](../test/commerce.test.js#L77) |
| PRE-10 | [server/commerce.js](../server/commerce.js) · requireBinding、prepare | [绑定预检、幂等、换绑与识别值最小化 BND-01/02/03/04/05/06/08/10 PRE-01/08/10 WRT-02/04 QRY-01](../test/commerce.test.js#L19) |
| PRE-11 | [server/commerce.js](../server/commerce.js) · prepare | [并发提交、复述金额与成功回读 WRT-01/05/10/12/13/15/16/17/19 PRE-11](../test/commerce.test.js#L135)<br>[PRE-11 自动认领与停服人工裁决均按发出时刻提醒再下单](../test/commerce.test.js#L651) |
| PRE-12 | [server/tools.js](../server/tools.js) · [prepare](../server/commerce.js) | [可选入参、两种创建请求和查券次数](../test/coupon-preparation.test.js) · [跨设备换选择](../test/order-preparation.test.js) |
| PRE-13 | [筛券归属与实例合并](../server/commerce-view.js) · [券编号与待确认单](../server/commerce.js) | [逐行筛券与指定](../test/coupon-preparation.test.js) · [编号生命周期](../test/coupon-refs.test.js) |

### 下单

| ID | 实现位置 | 对应测试名 |
| --- | --- | --- |
| WRT-01 | [server/session.js](../server/session.js) · extraPlaceField、dispatch | [并发提交、复述金额与成功回读 WRT-01/05/10/12/13/15/16/17/19 PRE-11](../test/commerce.test.js#L135) |
| WRT-02 | [server/commerce.js](../server/commerce.js) · place | [绑定预检、幂等、换绑与识别值最小化 BND-01/02/03/04/05/06/08/10 PRE-01/08/10 WRT-02/04 QRY-01](../test/commerce.test.js#L19) |
| WRT-03 | [server/commerce.js](../server/commerce.js) · place | [设备隔离、跨设备替代、过期清理 SES-02/03 PRE-08/09 WRT-03](../test/commerce.test.js#L77) |
| WRT-04 | [server/commerce.js](../server/commerce.js) · place | [绑定预检、幂等、换绑与识别值最小化 BND-01/02/03/04/05/06/08/10 PRE-01/08/10 WRT-02/04 QRY-01](../test/commerce.test.js#L19) |
| WRT-05 | [server/commerce.js](../server/commerce.js) · place | [并发提交、复述金额与成功回读](../test/commerce.test.js#L135) · [两位小数与一分容差](../test/commerce.test.js#L886) |
| WRT-06 | [server/commerce.js](../server/commerce.js) · place | [运行时故障仍可查单，重启发现损坏后可浏览、无法绑定](../test/commerce.test.js#L387) |
| WRT-07 | [server/commerce.js](../server/commerce.js) · place | [同会员在途、最后总额度与会员配额原子竞争 WRT-07/09 LED-01/05/07 SES-05](../test/commerce.test.js#L161)<br>[未决隔离、静默期、分页及唯一正证据 BND-07 WRT-07 UNR-01/02/03/04/05/06/07/08](../test/commerce.test.js#L304) |
| WRT-08 | [server/commerce.js](../server/commerce.js) · place | [零元预估不占位 WRT-08](../test/commerce.test.js#L360) |
| WRT-09 | [server/commerce.js](../server/commerce.js) · place | [同会员在途、最后总额度与会员配额原子竞争 WRT-07/09 LED-01/05/07 SES-05](../test/commerce.test.js#L161)<br>[WRT-09 LED-07 LOG-03 并发占最后一额跨北京午夜，账本与写审计记录占额日](../test/quota-time.test.js#L39) |
| WRT-10 | [server/commerce.js](../server/commerce.js) · place | [并发提交、复述金额与成功回读 WRT-01/05/10/12/13/15/16/17/19 PRE-11](../test/commerce.test.js#L135)<br>[资金出口拒绝明确失败；不确定回执从不重试 WRT-10/12/14 LED-07 OUT-03](../test/commerce.test.js#L201)<br>[WRT-10 持久防重记录命中时归还占位，不再请求创建](../test/commerce.test.js#L583) |
| WRT-11 | [server/commerce.js](../server/commerce.js) · place · [recordSending](../server/ledger.js) · [Qmai.write](../server/qmai.js) | [运行时故障仍可查单，重启发现损坏后可浏览、无法绑定](../test/commerce.test.js#L387)<br>[WRT-11 等待实际发送名额超时，账本空且个人、全局占位都释放](../test/quota-time.test.js#L99)<br>[ORD-02 WRT-11 写出口拒绝缺失、伪造、跨次复用的落盘凭据](../test/write-gate.test.js#L12) |
| WRT-12 | [server/commerce.js](../server/commerce.js) · place | [并发提交、复述金额与成功回读 WRT-01/05/10/12/13/15/16/17/19 PRE-11](../test/commerce.test.js#L135)<br>[资金出口拒绝明确失败；不确定回执从不重试 WRT-10/12/14 LED-07 OUT-03](../test/commerce.test.js#L201) |
| WRT-13 | [server/commerce.js](../server/commerce.js) · place | [并发提交、复述金额与成功回读 WRT-01/05/10/12/13/15/16/17/19 PRE-11](../test/commerce.test.js#L135) |
| WRT-14 | [server/commerce.js](../server/commerce.js) · place · [orderNumber](../server/commerce-view.js) | [资金出口拒绝明确失败；不确定回执从不重试 WRT-10/12/14 LED-07 OUT-03](../test/commerce.test.js#L201)<br>[WRT-14 QRY-04 R23 占位文字不算订单号；列表逐行校验 12 至 40 位英数](../test/commerce.test.js#L680) |
| WRT-15 | [server/commerce.js](../server/commerce.js) · place | [并发提交、复述金额与成功回读 WRT-01/05/10/12/13/15/16/17/19 PRE-11](../test/commerce.test.js#L135)<br>[安全读回和优惠证据 WRT-15/16/17/18/19](../test/commerce.test.js#L229) |
| WRT-16 | [server/commerce-view.js](../server/commerce-view.js) · placedView、discountView | [并发提交、复述金额与成功回读 WRT-01/05/10/12/13/15/16/17/19 PRE-11](../test/commerce.test.js#L135)<br>[安全读回和优惠证据 WRT-15/16/17/18/19](../test/commerce.test.js#L229) |
| WRT-17 | [server/commerce-view.js](../server/commerce-view.js) · placedView、discountView | [并发提交、复述金额与成功回读 WRT-01/05/10/12/13/15/16/17/19 PRE-11](../test/commerce.test.js#L135)<br>[安全读回和优惠证据 WRT-15/16/17/18/19](../test/commerce.test.js#L229)<br>[WRT-17 WRT-19 金额未知的券保留、类型未知保留不确定、零元告警只核对差额](../test/commerce.test.js#L718) |
| WRT-18 | [server/commerce-view.js](../server/commerce-view.js) · placedView、discountView | [安全读回和优惠证据 WRT-15/16/17/18/19](../test/commerce.test.js#L229) |
| WRT-19 | [server/commerce-view.js](../server/commerce-view.js) · placedView、discountView | [并发提交、复述金额与成功回读 WRT-01/05/10/12/13/15/16/17/19 PRE-11](../test/commerce.test.js#L135)<br>[安全读回和优惠证据 WRT-15/16/17/18/19](../test/commerce.test.js#L229)<br>[WRT-17 WRT-19 金额未知的券保留、类型未知保留不确定、零元告警只核对差额](../test/commerce.test.js#L718) |
| WRT-20 | [server/commerce-view.js](../server/commerce-view.js) · placedView、discountView | [五种证据、实付分支和读回失败](../test/coupon-readback.test.js) |
| WRT-21 | [指定券核对、差额及付款指引](../server/commerce-view.js) | [不同券优先、金额兑现与非数组明细](../test/coupon-readback.test.js) |

### 账本

| ID | 实现位置 | 对应测试名 |
| --- | --- | --- |
| LED-01 | [server/ledger.js](../server/ledger.js) · Ledger，占位与状态转换见 commerce.js 的 place | [同会员在途、最后总额度与会员配额原子竞争 WRT-07/09 LED-01/05/07 SES-05](../test/commerce.test.js#L161)<br>[已发出与核对结果持久化失败仍保留未决 LED-01/03/07 UNR-04/05/07](../test/commerce.test.js#L409)<br>[强杀真实进程、跨重启人工核对及唯一认领 LED-01/04/05/06/07/08 UNR-05/06](../test/commerce.test.js#L448) |
| LED-02 | [server/ledger.js](../server/ledger.js) · Ledger 校验库格式、记录摘要与内容 | [运行时故障仍可查单，重启发现损坏后可浏览、无法绑定](../test/commerce.test.js#L387)<br>[损坏账本仍可独占和浏览，拒绝新绑定](../test/commerce.test.js#L835)<br>[LED-02 LED-06 既有账本截为零字节仍能独占并保持故障态](../test/commerce.test.js#L895) |
| LED-03 | [SQLite 事务与发送凭据](../server/ledger.js) · [下单和核对答复](../server/commerce.js) | [实际 COMMIT 被拒、已提交却报错、两处强杀](../test/ledger-recovery.test.js) · [初建强杀、版本与记录校验](../test/ledger-evidence.test.js) |
| LED-04 | [server/ledger.js](../server/ledger.js) · Ledger，占位与状态转换见 commerce.js 的 place | [强杀真实进程、跨重启人工核对及唯一认领 LED-01/04/05/06/07/08 UNR-05/06](../test/commerce.test.js#L448) |
| LED-05 | [server/ledger.js](../server/ledger.js) · Ledger，占位与状态转换见 commerce.js 的 place | [同会员在途、最后总额度与会员配额原子竞争 WRT-07/09 LED-01/05/07 SES-05](../test/commerce.test.js#L161)<br>[强杀真实进程、跨重启人工核对及唯一认领 LED-01/04/05/06/07/08 UNR-05/06](../test/commerce.test.js#L448) |
| LED-06 | [server/ledger.js](../server/ledger.js) · Ledger 取得与释放目录锁 | [强杀真实进程、跨重启人工核对及唯一认领 LED-01/04/05/06/07/08 UNR-05/06](../test/commerce.test.js#L448)<br>[全新目录双实例并发抢锁、别名与死亡接管 LED-06](../test/commerce.test.js#L518)<br>[损坏账本仍可独占和浏览，拒绝新绑定](../test/commerce.test.js#L835)<br>[LED-02 LED-06 既有账本截为零字节仍能独占并保持故障态](../test/commerce.test.js#L895)<br>[LED-06 账本目录不可写时启动失败，恢复写权限后可接管](../test/commerce.test.js#L842) |
| LED-07 | [server/ledger.js](../server/ledger.js) · Ledger，占位与状态转换见 commerce.js 的 place | [同会员在途、最后总额度与会员配额原子竞争 WRT-07/09 LED-01/05/07 SES-05](../test/commerce.test.js#L161)<br>[资金出口拒绝明确失败；不确定回执从不重试 WRT-10/12/14 LED-07 OUT-03](../test/commerce.test.js#L201)<br>[已发出与核对结果持久化失败仍保留未决 LED-01/03/07 UNR-04/05/07](../test/commerce.test.js#L409)<br>[强杀真实进程、跨重启人工核对及唯一认领 LED-01/04/05/06/07/08 UNR-05/06](../test/commerce.test.js#L448)<br>[WRT-09 LED-07 LOG-03 并发占最后一额跨北京午夜，账本与写审计记录占额日](../test/quota-time.test.js#L39) |
| LED-08 | [server/ledger-cli.js](../server/ledger-cli.js) · run | [强杀真实进程、跨重启人工核对及唯一认领 LED-01/04/05/06/07/08 UNR-05/06](../test/commerce.test.js#L448)<br>[LED-08 运维按固定字段列未决，R23 不合格单号及未知请求退出非零且账本不变](../test/commerce.test.js#L801) |

### 未决核对

| ID | 实现位置 | 对应测试名 |
| --- | --- | --- |
| UNR-01 | [server/commerce.js](../server/commerce.js) · unresolved、orders | [未决隔离、静默期、分页及唯一正证据 BND-07 WRT-07 UNR-01/02/03/04/05/06/07/08](../test/commerce.test.js#L304) |
| UNR-02 | [server/commerce.js](../server/commerce.js) · unresolved、orders | [查单严格核对归属、时间和状态 QRY-02/03/04/05 UNR-02/08](../test/commerce.test.js#L268)<br>[未决隔离、静默期、分页及唯一正证据 BND-07 WRT-07 UNR-01/02/03/04/05/06/07/08](../test/commerce.test.js#L304) |
| UNR-03 | [server/commerce.js](../server/commerce.js) · orders · [rowTime、listedProducts、sameProducts](../server/commerce-view.js) | [未决隔离、静默期、分页及唯一正证据 BND-07 WRT-07 UNR-01/02/03/04/05/06/07/08](../test/commerce.test.js#L304)<br>[恢复多笔未决后按请求时间认领并引导人工复核 UNR-03/05/06/07](../test/commerce.test.js#L536)<br>[UNR-03 商品名称、编号和杯数随发送记录恢复，畸形时间不能用于正负核对](../test/commerce.test.js#L608) |
| UNR-04 | [server/commerce.js](../server/commerce.js) · unresolved、orders | [未决隔离、静默期、分页及唯一正证据](../test/commerce.test.js#L304) · [核对结论持久化失败](../test/commerce.test.js#L409) · [总数为零与越界旧单](../test/order-query.test.js#L98) · [错页拦截与匹配窗外旧单](../test/order-query.test.js#L184) |
| UNR-05 | [server/commerce.js](../server/commerce.js) · unresolved、orders | [未决隔离、静默期、分页及唯一正证据 BND-07 WRT-07 UNR-01/02/03/04/05/06/07/08](../test/commerce.test.js#L304)<br>[已发出与核对结果持久化失败仍保留未决 LED-01/03/07 UNR-04/05/07](../test/commerce.test.js#L409)<br>[强杀真实进程、跨重启人工核对及唯一认领 LED-01/04/05/06/07/08 UNR-05/06](../test/commerce.test.js#L448)<br>[恢复多笔未决后按请求时间认领并引导人工复核 UNR-03/05/06/07](../test/commerce.test.js#L536)<br>[迟到的订单列表只核对查询开始时的未决 UNR-05](../test/commerce.test.js#L564) |
| UNR-06 | [server/commerce.js](../server/commerce.js) · unresolved、orders | [未决隔离、静默期、分页及唯一正证据 BND-07 WRT-07 UNR-01/02/03/04/05/06/07/08](../test/commerce.test.js#L304)<br>[强杀真实进程、跨重启人工核对及唯一认领 LED-01/04/05/06/07/08 UNR-05/06](../test/commerce.test.js#L448)<br>[恢复多笔未决后按请求时间认领并引导人工复核 UNR-03/05/06/07](../test/commerce.test.js#L536) |
| UNR-07 | [server/commerce.js](../server/commerce.js) · unresolved、orders | [未决隔离、静默期、分页及唯一正证据 BND-07 WRT-07 UNR-01/02/03/04/05/06/07/08](../test/commerce.test.js#L304)<br>[已发出与核对结果持久化失败仍保留未决 LED-01/03/07 UNR-04/05/07](../test/commerce.test.js#L409)<br>[恢复多笔未决后按请求时间认领并引导人工复核 UNR-03/05/06/07](../test/commerce.test.js#L536) |
| UNR-08 | [server/commerce.js](../server/commerce.js) · unresolved、orders | [查单严格核对归属、时间和状态 QRY-02/03/04/05 UNR-02/08](../test/commerce.test.js#L268)<br>[未决隔离、静默期、分页及唯一正证据 BND-07 WRT-07 UNR-01/02/03/04/05/06/07/08](../test/commerce.test.js#L304) |

### 查单与会员信息

| ID | 实现位置 | 对应测试名 |
| --- | --- | --- |
| QRY-01 | [server/commerce.js](../server/commerce.js) · requireBinding、status、orders | [绑定预检、幂等、换绑与识别值最小化 BND-01/02/03/04/05/06/08/10 PRE-01/08/10 WRT-02/04 QRY-01](../test/commerce.test.js#L19) |
| QRY-02 | [server/commerce.js](../server/commerce.js) · requireBinding、status、orders | [查单严格核对归属、时间和状态 QRY-02/03/04/05 UNR-02/08](../test/commerce.test.js#L268) |
| QRY-03 | [server/commerce-view.js](../server/commerce-view.js) · statusView | [查单严格核对归属、时间和状态 QRY-02/03/04/05 UNR-02/08](../test/commerce.test.js#L268) |
| QRY-04 | [server/commerce.js](../server/commerce.js) · orders · [orderNumber、orderView](../server/commerce-view.js) · [decimalId](../server/common.js) | [查单严格核对归属、时间和状态 QRY-02/03/04/05 UNR-02/08](../test/commerce.test.js#L268)<br>[WRT-14 QRY-04 R23 占位文字不算订单号；列表逐行校验 12 至 40 位英数](../test/commerce.test.js#L680)<br>[QRY-04 R24 归属缺失与形态异常分别处理、商品名称按主备字段投影](../test/commerce.test.js#L700) |
| QRY-05 | [server/commerce.js](../server/commerce.js) · requireBinding、status、orders | [查单严格核对归属、时间和状态 QRY-02/03/04/05 UNR-02/08](../test/commerce.test.js#L268) |
| QRY-07 | [会员工具](../server/commerce.js) · [企迈读出口](../server/qmai.js) | [积分格式、过期时间、等级归属、部分与全部失败](../test/member-info.test.js) |
| QRY-08 | [工具描述与空对象入参](../server/tools.js) · [会员工具](../server/commerce.js) | [会员信息出参与积分商城提示](../test/member-info.test.js) |

### 审计

| ID | 实现位置 | 对应测试名 |
| --- | --- | --- |
| LOG-01 | [server/logs.js](../server/logs.js) · createLogs，调用点见 session.js、qmai.js、commerce.js | [LOG-01 LOG-02 LOG-03 LOG-04 LOG-06 LOG-07 出口审计、来源白名单、整条日志脱敏](../test/session.test.js#L142) |
| LOG-02 | [server/logs.js](../server/logs.js) · createLogs，调用点见 session.js、qmai.js、commerce.js | [LOG-01 LOG-02 LOG-03 LOG-04 LOG-06 LOG-07 出口审计、来源白名单、整条日志脱敏](../test/session.test.js#L142) |
| LOG-03 | [server/logs.js](../server/logs.js) · createLogs、issueConfirmation、currentQuotaDay · [企迈回执](../server/qmai.js) · [已提交账本记录](../server/ledger.js) | [WRT-09 LED-07 LOG-03 并发占最后一额跨北京午夜，账本与写审计记录占额日](../test/quota-time.test.js#L39)<br>[LOG-01 LOG-02 LOG-03 LOG-04 LOG-06 LOG-07 出口审计、来源白名单、整条日志脱敏](../test/session.test.js#L142)<br>[LOG-03 写审计默认掩码，伪造的令牌、订单回执和账本对象不能取得全值](../test/session.test.js#L297) · [访问审计与账本 HMAC 一致](../test/sms-binding.test.js#L177) |
| LOG-04 | [server/logs.js](../server/logs.js) · createLogs，调用点见 session.js、qmai.js、commerce.js | [LOG-01 LOG-02 LOG-03 LOG-04 LOG-06 LOG-07 出口审计、来源白名单、整条日志脱敏](../test/session.test.js#L142) |
| LOG-05 | [server/logs.js](../server/logs.js) · createLogs，调用点见 session.js、qmai.js、commerce.js | [LOG-05 三本日志介质故障不改变业务结果](../test/session.test.js#L180) |
| LOG-06 | [server/logs.js](../server/logs.js) · createLogs，调用点见 session.js、qmai.js、commerce.js | [LOG-01 LOG-02 LOG-03 LOG-04 LOG-06 LOG-07 出口审计、来源白名单、整条日志脱敏](../test/session.test.js#L142) |
| LOG-07 | [test-support/rig.js](../test-support/rig.js) · rig，安装测试另建独立临时目录 | [LOG-01 LOG-02 LOG-03 LOG-04 LOG-06 LOG-07 出口审计、来源白名单、整条日志脱敏](../test/session.test.js#L142) |

### 出参

| ID | 实现位置 | 对应测试名 |
| --- | --- | --- |
| OUT-01 | [server/catalog.js](../server/catalog.js) · itemCard、menuItem，交易投影见 commerce-view.js | [BRW-07 OUT-01 卡片投影、空值、估清优先级和商品一致性](../test/browse.test.js#L112)<br>[OUT-01 BRW-07 畸形公开 ID 字段不能携出无关的识别值](../test/browse.test.js#L431)<br>[默认挑券、投影、一次查询和缺门店编码 PRE-07 OUT-01/02](../test/commerce.test.js#L114) |
| OUT-02 | [server/common.js](../server/common.js) · projectText | [BRW-10 UPS-01 UPS-03 OUT-02 OUT-03 重试重签、读超时和异常响应](../test/browse.test.js#L285)<br>[默认挑券、投影、一次查询和缺门店编码 PRE-07 OUT-01/02](../test/commerce.test.js#L114)<br>[OUT-02 错误文本投影按码点截断并移除网址、凭证、电话与长数字](../test/session.test.js#L190) |
| OUT-03 | [server/qmai.js](../server/qmai.js) · readHint，写结果未知文案见 commerce.js 的 unknownMessage | [BRW-10 UPS-01 UPS-03 OUT-02 OUT-03 重试重签、读超时和异常响应](../test/browse.test.js#L285)<br>[资金出口拒绝明确失败；不确定回执从不重试 WRT-10/12/14 LED-07 OUT-03](../test/commerce.test.js#L201) |

### 薄壳

| ID | 实现位置 | 对应测试名 |
| --- | --- | --- |
| SHL-01 | [package.json](../package.json) · bin、files，协议运行库生成方式见 scripts/build-runtimes.js | [SHL-01 干净目录离线安装根包后免编译，经 stdio 连接真实服务端列出工具](../test/shell.test.js#L123) |
| SHL-02 | [bin/device.js](../bin/device.js) · deviceId | [SHL-02 两个进程首次并发启动取得同一个私有 UUID，重启复用，保存失败退出](../test/shell.test.js#L175)<br>[SHL-02 禁用硬链接并延迟首次写入，两个薄壳仍共用私有设备文件](../test/shell.test.js#L396) |
| SHL-03 | [bin/licha-order-mcp.js](../bin/licha-order-mcp.js) · post、forward、initialize、rebuild、close | [SHL-03 SHL-04 SHL-05 握手屏障、请求编号、SSE 和透明答复，诊断脱敏](../test/shell.test.js#L196) |
| SHL-04 | [bin/licha-order-mcp.js](../bin/licha-order-mcp.js) · post、forward、initialize、rebuild、close | [SHL-03 SHL-04 SHL-05 握手屏障、请求编号、SSE 和透明答复，诊断脱敏](../test/shell.test.js#L196) |
| SHL-05 | [bin/licha-order-mcp.js](../bin/licha-order-mcp.js) · post、forward、initialize、rebuild、close | [SHL-03 SHL-04 SHL-05 握手屏障、请求编号、SSE 和透明答复，诊断脱敏](../test/shell.test.js#L196) |
| SHL-06 | [bin/licha-order-mcp.js](../bin/licha-order-mcp.js) · post、forward、initialize、rebuild、close | [SHL-06 并发标记 404 只重建一次，每个原请求仅补发一次](../test/shell.test.js#L235)<br>[SHL-06 同批标记 404 共享重建失败结果，后续独立请求仍可恢复](../test/shell.test.js#L345) |
| SHL-07 | [bin/licha-order-mcp.js](../bin/licha-order-mcp.js) · post、forward、initialize、rebuild、close | [SHL-07 普通 404、断连、5xx、畸形应答和超时均不重发，薄壳继续服务](../test/shell.test.js#L262)<br>[SHL-07 配置 75 毫秒，服务端 250 毫秒后成功也不重放](../test/shell.test.js#L378) |
| SHL-08 | [bin/licha-order-mcp.js](../bin/licha-order-mcp.js) · post、forward、initialize、rebuild、close | [SHL-08 输入关闭后 DELETE 会话，404 或挂起均有界退出且不重建](../test/shell.test.js#L290)<br>[SHL-08 重建中关闭输入，结束最新远端会话且不再补发工具请求](../test/shell.test.js#L314) |

### 上游访问

| ID | 实现位置 | 对应测试名 |
| --- | --- | --- |
| UPS-01 | [server/qmai.js](../server/qmai.js) · Qmai、post、sign、checkSignature | [BRW-04 BRW-05 BRW-06 菜单分支、过滤和估清，UPS-01 无损分类 ID](../test/browse.test.js#L70)<br>[BRW-10 UPS-01 UPS-03 OUT-02 OUT-03 重试重签、读超时和异常响应](../test/browse.test.js#L285)<br>[UPS-01 R4 响应数组、嵌套字段与字符串中的数字保持无损](../test/browse.test.js#L391)<br>[UPS-01 R21 损坏的密钥封装不作为普通字符串签名](../test/browse.test.js#L482) |
| UPS-02 | [server/qmai.js](../server/qmai.js) · Qmai、post、sign、checkSignature | [UPS-02 全局队列按实际发送时刻限速、慢响应可并行](../test/browse.test.js#L354) |
| UPS-03 | [server/qmai.js](../server/qmai.js) · Qmai、post、sign、checkSignature | [BRW-10 UPS-01 UPS-03 OUT-02 OUT-03 重试重签、读超时和异常响应](../test/browse.test.js#L285)<br>[UPS-03 读超时覆盖收到响应头后的半截响应体](../test/quota-time.test.js#L120) |
| UPS-04 | [server/qmai.js](../server/qmai.js) · Qmai、post、sign、checkSignature | [UPS-04 签名实现损坏时真实启动拒绝就绪](../test/browse.test.js#L397) |
