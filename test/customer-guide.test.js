import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('顾客说明书给出零实付、无日期临期积分、选券确认和重新收码的口径', async () => {
  const guide = await readFile(new URL('../SKILL.md', import.meta.url), 'utf8');
  assert.match(guide, /实付是 ¥0\.00 时，只说「这单实付 0 元。请打开李茶的茶小程序『我的订单』核对这单的状态。」/);
  assert.doesNotMatch(guide, /优惠全抵了/);
  assert.match(guide, /没有日期时只说「其中有 Z 积分近期到期」/);
  assert.match(guide, /「随便」，就保留这张券；用户没表态，算还没确认优惠，接着问。[^\n]*明确确认数量、优惠、金额三样后，才调用 place_order/);
  assert.doesNotMatch(guide, /或没反对/);
  assert.match(guide, /会员信息有变化」时[^\n]*只带手机号重新收码。验证通过后重新组单/);
});

test('顾客说明书的接待口径：装好后按工具列表说一句，不让顾客猜，不讲安装', async () => {
  const guide = await readFile(new URL('../SKILL.md', import.meta.url), 'utf8');
  assert.match(guide, /\*\*有\*\* prepare_order：「好了，现在可以帮你点李茶的茶了。想喝点什么？」/);
  assert.match(guide, /\*\*没有\*\* prepare_order：「好了，现在可以帮你看李茶的茶的菜单、把单组好，下单要你自己在李茶的茶小程序里点。想喝点什么？」/);
  assert.doesNotMatch(guide, /如果开了下单能力|这套安装/);
  assert.doesNotMatch(guide, /高德地图 MCP|这台电脑|## 版本史/);
});

test('公开仓首页第一屏是给 Agent 的接待说明，不推荐具体 Agent', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme.split('\n')[2], /写给 AI 助手看的/);
  assert.match(readme, /「我现在只能跟你进行网页对话，不是 Agent，没法帮你点单。你可以找一个 Agent 下载使用/);
  assert.match(readme, /不要推荐具体是哪一个 Agent 或哪一款产品/);
  assert.doesNotMatch(readme, /LICHA_|环境变量表|豆包|元宝|WorkBuddy|Claude|ChatGPT|Codex/);
});

test('每个入口第一句让 Agent 确认找对了，说法不误导顾客（RCP-03）', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const guide = await readFile(new URL('../SKILL.md', import.meta.url), 'utf8');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(readme, /你找到这里就对了\*\*：这是李茶的茶官方的 AI 点单入口/);
  assert.match(readme, /李茶的茶、李茶、LEECHA、lichadecha 是同一个品牌/);
  assert.match(readme, /`github:lichadecha\/licha-order-mcp`/);
  assert.doesNotMatch(readme, /licha-order-mcp#/);
  assert.match(pkg.description, /^李茶的茶（LEECHA）官方 AI 点单/);
  assert.match(guide, /^description: 李茶的茶（也写作李茶、LEECHA、lichadecha）官方点单助手/m);
  assert.doesNotMatch(guide, /收银台|李茶小程序|只读，不会/);
  assert.doesNotMatch(readme + guide, /一期|测试版|只读/);
  assert.match(readme, /\n装上就能真实下单。\n/);
});
