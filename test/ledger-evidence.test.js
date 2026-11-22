import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { digest } from '../server/common.js';
import { basket, bind, bookFile, count, failure, place, prepare, withBound } from '../test-support/commerce.js';
import { PATHS } from '../server/qmai.js';

test('LED-03 恢复证据相互矛盾时保留现场并停单', async t => {
  const { r, s } = await withBound(t);
  const file = bookFile(r);
  const prior = await readFile(file, 'utf8');
  await place(s, await prepare(s));
  await r.stop();
  const candidate = await readFile(file, 'utf8');
  assert.equal(JSON.parse(candidate).records[0].state, 'success');
  const dbPath = join(r.dataDir, '.ledger-lock.sqlite');
  const journal = new DatabaseSync(dbPath);
  try {
    journal.prepare('INSERT INTO pending_snapshot VALUES (1, ?, ?)').run(prior, digest(candidate));
  } finally { journal.close(); }
  const markerPath = join(r.dataDir, '.orders-need-review');
  // 两份标记各自都是完整的有效快照。第二轮只改变现场文件的字节，记录内容和内置校验和仍有效。
  for (const [marker, onDisk] of [[candidate, candidate], [prior, candidate + '\n']]) {
    await writeFile(markerPath, marker);
    await writeFile(file, onDisk);
    await r.start();
    const resumed = await r.session();
    await bind(resumed);
    await failure(resumed, 'prepare_order', basket, /账本不可用/);
    await r.stop();
    assert.equal(await readFile(file, 'utf8'), onDisk);
    assert.equal(await readFile(markerPath, 'utf8'), marker);
    const db = new DatabaseSync(dbPath, {readOnly:true});
    try {
      const pending = db.prepare('SELECT previous, candidate_hash FROM pending_snapshot WHERE id=1').get();
      assert.equal(pending.previous, prior);
      assert.equal(pending.candidate_hash, digest(candidate));
    } finally { db.close(); }
    assert.equal(count(r, PATHS.create), 1);
  }
});
