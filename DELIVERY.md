# 李茶的茶点单 MCP v1.2 交付清单

根包提供顾客端 stdio 薄壳，独立的 `server/` 包提供 Streamable HTTP 服务端和本机账本运维命令。三个入口均可从任意工作目录按绝对路径启动。[运行说明](README.md)

## 验证记录

- 本轮在 Linux、Node 22.23.1 下执行根目录 `npm test`。88 项通过（83 个顶层用例，另含 3 个空白歧义子用例和 2 个账本文件子用例），失败、跳过和取消均为 0。测试使用真实服务端和薄壳子进程、临时账本与回环 HTTP 模拟企迈。
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
| 独立验收 | 本轮回归为开发侧测试。v1.2 的独立黑盒复验尚未进行。 |

## 本地提交

本轮修改留在工作区，由负责人提交。

## 规格缺口与实现取舍

| 对应范围 | 取舍与依据 |
| --- | --- |
| BRW-08、OUT-02 | 做法值与加料都按上游原名逐字选中。另一个原名若仅在首尾空白或连续空白的数量、形式上有差别，就报歧义。空白归一化只用于发现冲突。 |
| UNR-03、UNR-04 | 新版保存商品编号、名称摘要与数量，同一商品分多行时合计比较。早期快照缺少商品证据、列表行却带明细时保持未决。缺少证据不靠实付金额或订单状态补猜。判无单要求完整覆盖的窗口内没有任何订单。 |
| PRE-11、R23 | 已核实有单的提醒按原发送时刻计时。早期快照中不合格的订单号不会进入提醒，也不会因此释放已占额度。 |
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
| SES-02 | [server/commerce.js](server/commerce.js) · createCommerce、sweep、call | [设备隔离、跨设备替代、过期清理 SES-02/03 PRE-08/09 WRT-03](test/commerce.test.js#L139)<br>[SES-02 SES-03 SES-04 SES-06 绑定跨会话保留、跨设备隔离，浏览与拒绝不续期](test/session.test.js#L64)<br>[SES-02 SES-04 SES-06 关会话保留待确认单，绑定过期后同会员重绑也不能提交旧单](test/session.test.js#L269) |
| SES-03 | [server/commerce.js](server/commerce.js) · createCommerce、sweep、call | [设备隔离、跨设备替代、过期清理 SES-02/03 PRE-08/09 WRT-03](test/commerce.test.js#L139)<br>[SES-02 SES-03 SES-04 SES-06 绑定跨会话保留、跨设备隔离，浏览与拒绝不续期](test/session.test.js#L64) |
| SES-04 | [server/commerce.js](server/commerce.js) · createCommerce、sweep、call | [SES-02 SES-03 SES-04 SES-06 绑定跨会话保留、跨设备隔离，浏览与拒绝不续期](test/session.test.js#L64)<br>[SES-02 SES-04 SES-06 关会话保留待确认单，绑定过期后同会员重绑也不能提交旧单](test/session.test.js#L269) |
| SES-05 | [server/commerce.js](server/commerce.js) · createCommerce、sweep、call | [同会员在途、最后总额度与会员配额原子竞争 WRT-07/09 LED-01/05/07 SES-05](test/commerce.test.js#L223)<br>[SES-05 SES-09 跨会话共用滑动窗口；重启清除限流与绑定](test/session.test.js#L86) |
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
| BND-01 | [server/commerce.js](server/commerce.js) · bind | [绑定预检、幂等、换绑与识别值最小化 BND-01/02/03/04/05/06/08/10 PRE-01/08/10 WRT-02/04 QRY-01](test/commerce.test.js#L81) |
| BND-02 | [server/commerce.js](server/commerce.js) · bind | [绑定预检、幂等、换绑与识别值最小化 BND-01/02/03/04/05/06/08/10 PRE-01/08/10 WRT-02/04 QRY-01](test/commerce.test.js#L81)<br>[BND-02 R24 会员查询支持标量编号，未知形态报告查询失败并保留原绑定](test/commerce.test.js#L803) |
| BND-03 | [server/commerce.js](server/commerce.js) · bind | [绑定预检、幂等、换绑与识别值最小化 BND-01/02/03/04/05/06/08/10 PRE-01/08/10 WRT-02/04 QRY-01](test/commerce.test.js#L81) |
| BND-04 | [server/commerce.js](server/commerce.js) · bind | [绑定预检、幂等、换绑与识别值最小化 BND-01/02/03/04/05/06/08/10 PRE-01/08/10 WRT-02/04 QRY-01](test/commerce.test.js#L81) |
| BND-05 | [server/commerce.js](server/commerce.js) · bind | [绑定预检、幂等、换绑与识别值最小化 BND-01/02/03/04/05/06/08/10 PRE-01/08/10 WRT-02/04 QRY-01](test/commerce.test.js#L81) |
| BND-06 | [server/commerce.js](server/commerce.js) · bind | [绑定预检、幂等、换绑与识别值最小化 BND-01/02/03/04/05/06/08/10 PRE-01/08/10 WRT-02/04 QRY-01](test/commerce.test.js#L81) |
| BND-07 | [server/commerce.js](server/commerce.js) · bind | [未决隔离、静默期、分页及唯一正证据 BND-07 WRT-07 UNR-01/02/03/04/05/06/07/08](test/commerce.test.js#L366) |
| BND-08 | [server/commerce.js](server/commerce.js) · bind | [绑定预检、幂等、换绑与识别值最小化 BND-01/02/03/04/05/06/08/10 PRE-01/08/10 WRT-02/04 QRY-01](test/commerce.test.js#L81) |
| BND-09 | [server/commerce.js](server/commerce.js) · bind | [绑定查询限流不计预检与限流拒绝 BND-09](test/commerce.test.js#L128)<br>[BND-09 格式预检、设备一小时与全局一分钟滑窗分别计数，在边界释放](test/window.test.js#L70) |
| BND-10 | [server/commerce.js](server/commerce.js) · bind | [绑定预检、幂等、换绑与识别值最小化 BND-01/02/03/04/05/06/08/10 PRE-01/08/10 WRT-02/04 QRY-01](test/commerce.test.js#L81) |

### 组单

| ID | 实现位置 | 对应测试名 |
| --- | --- | --- |
| PRE-01 | [server/commerce.js](server/commerce.js) · requireBinding、prepare | [绑定预检、幂等、换绑与识别值最小化 BND-01/02/03/04/05/06/08/10 PRE-01/08/10 WRT-02/04 QRY-01](test/commerce.test.js#L81) |
| PRE-02 | [server/commerce.js](server/commerce.js) · requireBinding、prepare | [发送前账本故障时停止创建、重启后仍可浏览查单 PRE-02 WRT-06/11 LED-02/03](test/commerce.test.js#L430) |
| PRE-03 | [server/browse.js](server/browse.js) · quote、#item | [BRW-09 PRE-03 PRE-04 PRE-05 PRE-06 现价、必选、内部 ID 与签发快照](test/browse.test.js#L164)<br>[BRW-09 PRE-03 同毫秒开始的旧浏览响应晚到，保留组单现读缓存](test/browse.test.js#L318) |
| PRE-04 | [server/commerce.js](server/commerce.js) · requireBinding、prepare | [BRW-09 PRE-03 PRE-04 PRE-05 PRE-06 现价、必选、内部 ID 与签发快照](test/browse.test.js#L164) |
| PRE-05 | [server/price.js](server/price.js) · priceLine | [BRW-09 PRE-03 PRE-04 PRE-05 PRE-06 现价、必选、内部 ID 与签发快照](test/browse.test.js#L164) |
| PRE-06 | [server/commerce.js](server/commerce.js) · prepare、checkOrderFields，分行内部 ID 核对见 price.js | [BRW-09 PRE-03 PRE-04 PRE-05 PRE-06 现价、必选、内部 ID 与签发快照](test/browse.test.js#L164)<br>[BRW-08 PRE-06 加料原文、展示同名和做法双重解释都核对至创建请求](test/browse.test.js#L386)<br>[递归拒绝七个预约字段 PRE-06](test/commerce.test.js#L191) |
| PRE-07 | [server/commerce-view.js](server/commerce-view.js) · couponView，单次筛券见 commerce.js 的 prepare | [券预测优先级、投影、一次查询和缺门店编码 PRE-07 OUT-01/02](test/commerce.test.js#L161) |
| PRE-08 | [server/commerce.js](server/commerce.js) · requireBinding、prepare | [绑定预检、幂等、换绑与识别值最小化 BND-01/02/03/04/05/06/08/10 PRE-01/08/10 WRT-02/04 QRY-01](test/commerce.test.js#L81)<br>[设备隔离、跨设备替代、过期清理 SES-02/03 PRE-08/09 WRT-03](test/commerce.test.js#L139) |
| PRE-09 | [server/commerce.js](server/commerce.js) · requireBinding、prepare | [设备隔离、跨设备替代、过期清理 SES-02/03 PRE-08/09 WRT-03](test/commerce.test.js#L139) |
| PRE-10 | [server/commerce.js](server/commerce.js) · requireBinding、prepare | [绑定预检、幂等、换绑与识别值最小化 BND-01/02/03/04/05/06/08/10 PRE-01/08/10 WRT-02/04 QRY-01](test/commerce.test.js#L81) |
| PRE-11 | [server/commerce.js](server/commerce.js) · prepare | [并发提交、复述金额与成功回读 WRT-01/05/10/12/13/15/16/17/19 PRE-11](test/commerce.test.js#L197)<br>[PRE-11 自动认领与停服人工裁决均按发出时刻提醒再下单](test/commerce.test.js#L705) |

### 下单

| ID | 实现位置 | 对应测试名 |
| --- | --- | --- |
| WRT-01 | [server/session.js](server/session.js) · extraPlaceField、dispatch | [并发提交、复述金额与成功回读 WRT-01/05/10/12/13/15/16/17/19 PRE-11](test/commerce.test.js#L197) |
| WRT-02 | [server/commerce.js](server/commerce.js) · place | [绑定预检、幂等、换绑与识别值最小化 BND-01/02/03/04/05/06/08/10 PRE-01/08/10 WRT-02/04 QRY-01](test/commerce.test.js#L81) |
| WRT-03 | [server/commerce.js](server/commerce.js) · place | [设备隔离、跨设备替代、过期清理 SES-02/03 PRE-08/09 WRT-03](test/commerce.test.js#L139) |
| WRT-04 | [server/commerce.js](server/commerce.js) · place | [绑定预检、幂等、换绑与识别值最小化 BND-01/02/03/04/05/06/08/10 PRE-01/08/10 WRT-02/04 QRY-01](test/commerce.test.js#L81) |
| WRT-05 | [server/commerce.js](server/commerce.js) · place | [并发提交、复述金额与成功回读 WRT-01/05/10/12/13/15/16/17/19 PRE-11](test/commerce.test.js#L197) |
| WRT-06 | [server/commerce.js](server/commerce.js) · place | [发送前账本故障时停止创建、重启后仍可浏览查单 PRE-02 WRT-06/11 LED-02/03](test/commerce.test.js#L430) |
| WRT-07 | [server/commerce.js](server/commerce.js) · place | [同会员在途、最后总额度与会员配额原子竞争 WRT-07/09 LED-01/05/07 SES-05](test/commerce.test.js#L223)<br>[未决隔离、静默期、分页及唯一正证据 BND-07 WRT-07 UNR-01/02/03/04/05/06/07/08](test/commerce.test.js#L366) |
| WRT-08 | [server/commerce.js](server/commerce.js) · place | [零元预估不占位 WRT-08](test/commerce.test.js#L420) |
| WRT-09 | [server/commerce.js](server/commerce.js) · place | [同会员在途、最后总额度与会员配额原子竞争 WRT-07/09 LED-01/05/07 SES-05](test/commerce.test.js#L223)<br>[WRT-09 LED-07 LOG-03 并发占最后一额跨北京午夜，账本与写审计记录占额日](test/quota-time.test.js#L39) |
| WRT-10 | [server/commerce.js](server/commerce.js) · place | [并发提交、复述金额与成功回读 WRT-01/05/10/12/13/15/16/17/19 PRE-11](test/commerce.test.js#L197)<br>[资金出口拒绝明确失败；不确定回执从不重试 WRT-10/12/14 LED-07 OUT-03](test/commerce.test.js#L263)<br>[WRT-10 持久防重记录命中时归还占位，不再请求创建](test/commerce.test.js#L637) |
| WRT-11 | [server/commerce.js](server/commerce.js) · place · [recordSending](server/ledger.js) · [Qmai.write](server/qmai.js) | [发送前账本故障时停止创建、重启后仍可浏览查单 PRE-02 WRT-06/11 LED-02/03](test/commerce.test.js#L430)<br>[WRT-11 等待实际发送名额超时，账本空且个人、全局占位都释放](test/quota-time.test.js#L99)<br>[ORD-02 WRT-11 写出口拒绝缺失、伪造、跨次复用的落盘凭据](test/write-gate.test.js#L12) |
| WRT-12 | [server/commerce.js](server/commerce.js) · place | [并发提交、复述金额与成功回读 WRT-01/05/10/12/13/15/16/17/19 PRE-11](test/commerce.test.js#L197)<br>[资金出口拒绝明确失败；不确定回执从不重试 WRT-10/12/14 LED-07 OUT-03](test/commerce.test.js#L263) |
| WRT-13 | [server/commerce.js](server/commerce.js) · place | [并发提交、复述金额与成功回读 WRT-01/05/10/12/13/15/16/17/19 PRE-11](test/commerce.test.js#L197) |
| WRT-14 | [server/commerce.js](server/commerce.js) · place · [orderNumber](server/commerce-view.js) | [资金出口拒绝明确失败；不确定回执从不重试 WRT-10/12/14 LED-07 OUT-03](test/commerce.test.js#L263)<br>[WRT-14 QRY-04 R23 占位文字不算订单号；列表逐行校验 12 至 40 位英数](test/commerce.test.js#L734) |
| WRT-15 | [server/commerce.js](server/commerce.js) · place | [并发提交、复述金额与成功回读 WRT-01/05/10/12/13/15/16/17/19 PRE-11](test/commerce.test.js#L197)<br>[安全读回和优惠证据 WRT-15/16/17/18/19](test/commerce.test.js#L291) |
| WRT-16 | [server/commerce-view.js](server/commerce-view.js) · placedView、discountView | [并发提交、复述金额与成功回读 WRT-01/05/10/12/13/15/16/17/19 PRE-11](test/commerce.test.js#L197)<br>[安全读回和优惠证据 WRT-15/16/17/18/19](test/commerce.test.js#L291) |
| WRT-17 | [server/commerce-view.js](server/commerce-view.js) · placedView、discountView | [并发提交、复述金额与成功回读 WRT-01/05/10/12/13/15/16/17/19 PRE-11](test/commerce.test.js#L197)<br>[安全读回和优惠证据 WRT-15/16/17/18/19](test/commerce.test.js#L291)<br>[WRT-17 WRT-19 金额未知的券保留、类型未知保留不确定、零元告警只核对差额](test/commerce.test.js#L772) |
| WRT-18 | [server/commerce-view.js](server/commerce-view.js) · placedView、discountView | [安全读回和优惠证据 WRT-15/16/17/18/19](test/commerce.test.js#L291) |
| WRT-19 | [server/commerce-view.js](server/commerce-view.js) · placedView、discountView | [并发提交、复述金额与成功回读 WRT-01/05/10/12/13/15/16/17/19 PRE-11](test/commerce.test.js#L197)<br>[安全读回和优惠证据 WRT-15/16/17/18/19](test/commerce.test.js#L291)<br>[WRT-17 WRT-19 金额未知的券保留、类型未知保留不确定、零元告警只核对差额](test/commerce.test.js#L772) |

### 账本

| ID | 实现位置 | 对应测试名 |
| --- | --- | --- |
| LED-01 | [server/ledger.js](server/ledger.js) · Ledger，占位与状态转换见 commerce.js 的 place | [同会员在途、最后总额度与会员配额原子竞争 WRT-07/09 LED-01/05/07 SES-05](test/commerce.test.js#L223)<br>[已发出与核对结果持久化失败仍保留未决 LED-01/03/07 UNR-04/05/07](test/commerce.test.js#L462)<br>[强杀真实进程、跨重启人工核对及唯一认领 LED-01/04/05/06/07/08 UNR-05/06](test/commerce.test.js#L501) |
| LED-02 | [server/ledger.js](server/ledger.js) · Ledger 核对文件与恢复快照 | [发送前账本故障时停止创建、重启后仍可浏览查单 PRE-02 WRT-06/11 LED-02/03](test/commerce.test.js#L430)<br>[LED-02 LED-06 逐个破坏已下单账本文件，单实例故障态与双实例唯一胜者仍可浏览查单](test/commerce.test.js#L893)<br>[LED-02 LED-06 既有账本截为零字节仍能独占并保持故障态](test/commerce.test.js#L954) |
| LED-03 | [server/ledger.js](server/ledger.js) · Ledger、#save、#confirmSnapshot、#restoreOnUncertainCommit · [place、orders](server/commerce.js) | [发送前账本故障时停止创建、重启后仍可浏览查单 PRE-02 WRT-06/11 LED-02/03](test/commerce.test.js#L430)<br>[已发出与核对结果持久化失败仍保留未决 LED-01/03/07 UNR-04/05/07](test/commerce.test.js#L462)<br>[LED-03 发送前记录已替换后确认失败，重启恢复空额](test/commerce.test.js#L888)<br>[LED-03 成功终态已替换后确认失败，重启保留发送前记录](test/commerce.test.js#L889)<br>[LED-03 明确失败终态已替换后确认失败，重启仍保留占额](test/commerce.test.js#L890)<br>[LED-03 未决认领已替换后确认失败，重启保留未决](test/commerce.test.js#L891)<br>[LED-03 撤销记录已删除才报错，重启从重建的撤销记录恢复](test/commerce.test.js#L1041)<br>[LED-03 提交后数据库持续报错，重启保留直接恢复的旧文件](test/commerce.test.js#L1042)<br>[LED-03 提交报错且两个恢复出口都失败，重启保留现场并拒绝下单](test/commerce.test.js#L1043) |
| LED-04 | [server/ledger.js](server/ledger.js) · Ledger，占位与状态转换见 commerce.js 的 place | [强杀真实进程、跨重启人工核对及唯一认领 LED-01/04/05/06/07/08 UNR-05/06](test/commerce.test.js#L501) |
| LED-05 | [server/ledger.js](server/ledger.js) · Ledger，占位与状态转换见 commerce.js 的 place | [同会员在途、最后总额度与会员配额原子竞争 WRT-07/09 LED-01/05/07 SES-05](test/commerce.test.js#L223)<br>[强杀真实进程、跨重启人工核对及唯一认领 LED-01/04/05/06/07/08 UNR-05/06](test/commerce.test.js#L501) |
| LED-06 | [server/ledger.js](server/ledger.js) · Ledger 取得与释放目录锁 | [强杀真实进程、跨重启人工核对及唯一认领 LED-01/04/05/06/07/08 UNR-05/06](test/commerce.test.js#L501)<br>[全新目录双实例并发抢锁、别名与死亡接管 LED-06](test/commerce.test.js#L572)<br>[LED-02 LED-06 逐个破坏已下单账本文件，单实例故障态与双实例唯一胜者仍可浏览查单](test/commerce.test.js#L893)<br>[LED-02 LED-06 既有账本截为零字节仍能独占并保持故障态](test/commerce.test.js#L954)<br>[LED-06 账本目录不可写时启动失败，恢复写权限后可接管](test/commerce.test.js#L968) |
| LED-07 | [server/ledger.js](server/ledger.js) · Ledger，占位与状态转换见 commerce.js 的 place | [同会员在途、最后总额度与会员配额原子竞争 WRT-07/09 LED-01/05/07 SES-05](test/commerce.test.js#L223)<br>[资金出口拒绝明确失败；不确定回执从不重试 WRT-10/12/14 LED-07 OUT-03](test/commerce.test.js#L263)<br>[已发出与核对结果持久化失败仍保留未决 LED-01/03/07 UNR-04/05/07](test/commerce.test.js#L462)<br>[强杀真实进程、跨重启人工核对及唯一认领 LED-01/04/05/06/07/08 UNR-05/06](test/commerce.test.js#L501)<br>[WRT-09 LED-07 LOG-03 并发占最后一额跨北京午夜，账本与写审计记录占额日](test/quota-time.test.js#L39) |
| LED-08 | [server/ledger-cli.js](server/ledger-cli.js) · run | [强杀真实进程、跨重启人工核对及唯一认领 LED-01/04/05/06/07/08 UNR-05/06](test/commerce.test.js#L501)<br>[LED-08 运维按固定字段列未决，R23 不合格单号及未知请求退出非零且账本不变](test/commerce.test.js#L927) |

### 未决核对

| ID | 实现位置 | 对应测试名 |
| --- | --- | --- |
| UNR-01 | [server/commerce.js](server/commerce.js) · unresolved、orders | [未决隔离、静默期、分页及唯一正证据 BND-07 WRT-07 UNR-01/02/03/04/05/06/07/08](test/commerce.test.js#L366) |
| UNR-02 | [server/commerce.js](server/commerce.js) · unresolved、orders | [查单严格核对归属、时间和状态 QRY-02/03/04/05 UNR-02/08](test/commerce.test.js#L330)<br>[未决隔离、静默期、分页及唯一正证据 BND-07 WRT-07 UNR-01/02/03/04/05/06/07/08](test/commerce.test.js#L366) |
| UNR-03 | [server/commerce.js](server/commerce.js) · orders · [rowTime、listedProducts、sameProducts](server/commerce-view.js) | [未决隔离、静默期、分页及唯一正证据 BND-07 WRT-07 UNR-01/02/03/04/05/06/07/08](test/commerce.test.js#L366)<br>[恢复多笔未决后按请求时间认领并引导人工复核 UNR-03/05/06/07](test/commerce.test.js#L590)<br>[UNR-03 商品名称、编号和杯数随发送记录恢复，畸形时间不能用于正负核对](test/commerce.test.js#L662) |
| UNR-04 | [server/commerce.js](server/commerce.js) · unresolved、orders | [未决隔离、静默期、分页及唯一正证据 BND-07 WRT-07 UNR-01/02/03/04/05/06/07/08](test/commerce.test.js#L366)<br>[已发出与核对结果持久化失败仍保留未决 LED-01/03/07 UNR-04/05/07](test/commerce.test.js#L462) |
| UNR-05 | [server/commerce.js](server/commerce.js) · unresolved、orders | [未决隔离、静默期、分页及唯一正证据 BND-07 WRT-07 UNR-01/02/03/04/05/06/07/08](test/commerce.test.js#L366)<br>[已发出与核对结果持久化失败仍保留未决 LED-01/03/07 UNR-04/05/07](test/commerce.test.js#L462)<br>[强杀真实进程、跨重启人工核对及唯一认领 LED-01/04/05/06/07/08 UNR-05/06](test/commerce.test.js#L501)<br>[恢复多笔未决后按请求时间认领并引导人工复核 UNR-03/05/06/07](test/commerce.test.js#L590)<br>[迟到的订单列表只核对查询开始时的未决 UNR-05](test/commerce.test.js#L618) |
| UNR-06 | [server/commerce.js](server/commerce.js) · unresolved、orders | [未决隔离、静默期、分页及唯一正证据 BND-07 WRT-07 UNR-01/02/03/04/05/06/07/08](test/commerce.test.js#L366)<br>[强杀真实进程、跨重启人工核对及唯一认领 LED-01/04/05/06/07/08 UNR-05/06](test/commerce.test.js#L501)<br>[恢复多笔未决后按请求时间认领并引导人工复核 UNR-03/05/06/07](test/commerce.test.js#L590) |
| UNR-07 | [server/commerce.js](server/commerce.js) · unresolved、orders | [未决隔离、静默期、分页及唯一正证据 BND-07 WRT-07 UNR-01/02/03/04/05/06/07/08](test/commerce.test.js#L366)<br>[已发出与核对结果持久化失败仍保留未决 LED-01/03/07 UNR-04/05/07](test/commerce.test.js#L462)<br>[恢复多笔未决后按请求时间认领并引导人工复核 UNR-03/05/06/07](test/commerce.test.js#L590) |
| UNR-08 | [server/commerce.js](server/commerce.js) · unresolved、orders | [查单严格核对归属、时间和状态 QRY-02/03/04/05 UNR-02/08](test/commerce.test.js#L330)<br>[未决隔离、静默期、分页及唯一正证据 BND-07 WRT-07 UNR-01/02/03/04/05/06/07/08](test/commerce.test.js#L366) |

### 查单

| ID | 实现位置 | 对应测试名 |
| --- | --- | --- |
| QRY-01 | [server/commerce.js](server/commerce.js) · requireBinding、status、orders | [绑定预检、幂等、换绑与识别值最小化 BND-01/02/03/04/05/06/08/10 PRE-01/08/10 WRT-02/04 QRY-01](test/commerce.test.js#L81) |
| QRY-02 | [server/commerce.js](server/commerce.js) · requireBinding、status、orders | [查单严格核对归属、时间和状态 QRY-02/03/04/05 UNR-02/08](test/commerce.test.js#L330) |
| QRY-03 | [server/commerce-view.js](server/commerce-view.js) · statusView | [查单严格核对归属、时间和状态 QRY-02/03/04/05 UNR-02/08](test/commerce.test.js#L330) |
| QRY-04 | [server/commerce.js](server/commerce.js) · orders · [orderNumber、decimalId、orderView](server/commerce-view.js) | [查单严格核对归属、时间和状态 QRY-02/03/04/05 UNR-02/08](test/commerce.test.js#L330)<br>[WRT-14 QRY-04 R23 占位文字不算订单号；列表逐行校验 12 至 40 位英数](test/commerce.test.js#L734)<br>[QRY-04 R24 归属缺失与形态异常分别处理、商品名称按主备字段投影](test/commerce.test.js#L754) |
| QRY-05 | [server/commerce.js](server/commerce.js) · requireBinding、status、orders | [查单严格核对归属、时间和状态 QRY-02/03/04/05 UNR-02/08](test/commerce.test.js#L330) |

### 审计

| ID | 实现位置 | 对应测试名 |
| --- | --- | --- |
| LOG-01 | [server/logs.js](server/logs.js) · createLogs，调用点见 session.js、qmai.js、commerce.js | [LOG-01 LOG-02 LOG-03 LOG-04 LOG-06 LOG-07 出口审计、来源白名单、整条日志脱敏](test/session.test.js#L142) |
| LOG-02 | [server/logs.js](server/logs.js) · createLogs，调用点见 session.js、qmai.js、commerce.js | [LOG-01 LOG-02 LOG-03 LOG-04 LOG-06 LOG-07 出口审计、来源白名单、整条日志脱敏](test/session.test.js#L142) |
| LOG-03 | [server/logs.js](server/logs.js) · createLogs、issueConfirmation、currentQuotaDay · [企迈回执](server/qmai.js) · [已确认快照](server/ledger.js) | [WRT-09 LED-07 LOG-03 并发占最后一额跨北京午夜，账本与写审计记录占额日](test/quota-time.test.js#L39)<br>[LOG-01 LOG-02 LOG-03 LOG-04 LOG-06 LOG-07 出口审计、来源白名单、整条日志脱敏](test/session.test.js#L142)<br>[LOG-03 写审计默认掩码，伪造的令牌、订单回执和账本对象不能取得全值](test/session.test.js#L297) |
| LOG-04 | [server/logs.js](server/logs.js) · createLogs，调用点见 session.js、qmai.js、commerce.js | [LOG-01 LOG-02 LOG-03 LOG-04 LOG-06 LOG-07 出口审计、来源白名单、整条日志脱敏](test/session.test.js#L142) |
| LOG-05 | [server/logs.js](server/logs.js) · createLogs，调用点见 session.js、qmai.js、commerce.js | [LOG-05 三本日志介质故障不改变业务结果](test/session.test.js#L180) |
| LOG-06 | [server/logs.js](server/logs.js) · createLogs，调用点见 session.js、qmai.js、commerce.js | [LOG-01 LOG-02 LOG-03 LOG-04 LOG-06 LOG-07 出口审计、来源白名单、整条日志脱敏](test/session.test.js#L142) |
| LOG-07 | [test-support/rig.js](test-support/rig.js) · rig，安装测试另建独立临时目录 | [LOG-01 LOG-02 LOG-03 LOG-04 LOG-06 LOG-07 出口审计、来源白名单、整条日志脱敏](test/session.test.js#L142) |

### 出参

| ID | 实现位置 | 对应测试名 |
| --- | --- | --- |
| OUT-01 | [server/catalog.js](server/catalog.js) · itemCard、menuItem，交易投影见 commerce-view.js | [BRW-07 OUT-01 卡片投影、空值、估清优先级和商品一致性](test/browse.test.js#L105)<br>[OUT-01 BRW-07 畸形公开 ID 字段不能携出无关的识别值](test/browse.test.js#L345)<br>[券预测优先级、投影、一次查询和缺门店编码 PRE-07 OUT-01/02](test/commerce.test.js#L161) |
| OUT-02 | [server/common.js](server/common.js) · projectText | [BRW-10 UPS-01 UPS-03 OUT-02 OUT-03 重试重签、读超时和异常响应](test/browse.test.js#L223)<br>[券预测优先级、投影、一次查询和缺门店编码 PRE-07 OUT-01/02](test/commerce.test.js#L161)<br>[OUT-02 错误文本投影按码点截断并移除网址、凭证、电话与长数字](test/session.test.js#L190) |
| OUT-03 | [server/qmai.js](server/qmai.js) · readHint，写结果未知文案见 commerce.js 的 unknownMessage | [BRW-10 UPS-01 UPS-03 OUT-02 OUT-03 重试重签、读超时和异常响应](test/browse.test.js#L223)<br>[资金出口拒绝明确失败；不确定回执从不重试 WRT-10/12/14 LED-07 OUT-03](test/commerce.test.js#L263) |

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
