import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearUsageCache, readUsage } from '../src/usage.mjs';

const usage = totalTokens => JSON.stringify({ type: 'message', message: { role: 'assistant', usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 5, totalTokens } } });

async function dir(t, lines) {
  const base = await mkdtemp(join(tmpdir(), 'rex-usage-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  if (lines) await writeFile(join(base, 'session.jsonl'), lines.map(line => `${line}\n`).join(''));
  return base;
}

test('the current working set is the last usage record, not a sum of every turn', async t => {
  const base = await dir(t, [usage(1200), JSON.stringify({ type: 'message', message: { role: 'user' } }), usage(8600), usage(12400)]);
  assert.deepEqual(await readUsage(base), { tokens: 12400, at: undefined });
});

test('a missing or usage-free session reports no tokens instead of failing', async t => {
  assert.deepEqual(await readUsage(await dir(t)), {});
  const control = await dir(t, [{ type: 'message', message: { role: 'assistant' } }, 'not json at all', '']);
  assert.deepEqual(await readUsage(control), {});
});

test('an unchanged file is served from cache and an appended record refreshes it', async t => {
  const base = await dir(t, [usage(2400)]);
  const path = join(base, 'session.jsonl');
  assert.equal((await readUsage(base)).tokens, 2400);
  clearUsageCache();
  await appendFile(path, `${usage(9600)}\n`);
  assert.equal((await readUsage(base)).tokens, 9600);
  const after = await stat(path);
  assert.equal((await readUsage(base)).tokens, 9600);
  assert.ok(after.size > 0);
});

// Child sessions reach hundreds of kilobytes; the reader must never load them
// whole, and a record living only near the end must still be found.
test('a large session is read from its tail and still yields the last record', async t => {
  const filler = Array.from({ length: 900 }, (_, i) => JSON.stringify({ type: 'message', message: { role: 'user', content: 'x'.repeat(200) } }));
  const base = await dir(t, [...filler, usage(4200), usage(51000)]);
  const size = (await stat(join(base, 'session.jsonl'))).size;
  assert.ok(size > 200 * 1024, `expected a large fixture, got ${size}`);
  assert.equal((await readUsage(base)).tokens, 51000);
});
