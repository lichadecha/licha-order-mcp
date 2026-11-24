import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('顾客说明书给出零实付、无日期临期积分、选券确认和重新收码的口径', async () => {
  const guide = await readFile(new URL('../SKILL.md', import.meta.url), 'utf8');
  assert.match(guide, /实付是 ¥0\.00 时，只说「这单实付 0 元。请打开李茶小程序『我的订单』核对这单的状态。」/);
  assert.doesNotMatch(guide, /优惠全抵了/);
  assert.match(guide, /没有日期时只说「其中有 Z 积分近期到期」/);
  assert.match(guide, /「随便」或没反对，只保留这张券。[^\n]*明确确认数量、优惠、金额三样后，才调用 place_order/);
  assert.match(guide, /会员信息有变化」时[^\n]*只带手机号重新收码。验证通过后重新组单/);
});
