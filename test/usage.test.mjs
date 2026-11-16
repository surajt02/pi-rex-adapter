import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearUsageCache, readUsage } from '../src/usage.mjs';

const usage = (totalTokens, parts = []) => JSON.stringify({ type: 'message',
  message: { role: 'assistant', content: parts, usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 5, totalTokens } } });
const call = (id, name = 'read', args) => ({ type: 'toolCall', id, name, arguments: args });
// The action list is asserted on its own below; the counts here are what matter.
const counts = async base => {
  const { actions, ...rest } = await readUsage(base);
  return rest;
};
const turn = (totalTokens, calls = 0) => usage(totalTokens, Array.from({ length: calls }, (_, i) => call(`c${i}`)));

async function dir(t, lines) {
  const base = await mkdtemp(join(tmpdir(), 'rex-usage-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  if (lines) await writeFile(join(base, 'session.jsonl'), lines.map(line => `${line}\n`).join(''));
  return base;
}

test('the current working set is the last usage record, not a sum of every turn', async t => {
  const base = await dir(t, [usage(1200), JSON.stringify({ type: 'message', message: { role: 'user' } }), usage(8600), usage(12400)]);
  assert.equal((await readUsage(base)).tokens, 12400, 'the last record wins');
  assert.equal((await readUsage(base)).turns, 3, 'turns are counted, not summed from usage');
});

test('turns and tool uses are counted from the child session', async t => {
  const base = await dir(t, [
    JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } }),
    turn(1000, 2), turn(2500, 1), turn(4100, 0),
  ]);
  assert.deepEqual(await counts(base), { tokens: 4100, turns: 3, toolUses: 3, at: undefined });
});

test('a half-written last line is counted once, when it completes', async t => {
  const base = await dir(t, [turn(1000, 1)]);
  const path = join(base, 'session.jsonl');
  await appendFile(path, turn(2500, 2).slice(0, 40));            // no newline yet
  assert.deepEqual(await counts(base), { tokens: 1000, turns: 1, toolUses: 1, at: undefined });
  const tail = turn(2500, 2).slice(40);
  await appendFile(path, tail + '\n');
  assert.deepEqual(await counts(base), { tokens: 2500, turns: 2, toolUses: 3, at: undefined });
});

test('a truncated session starts its counts over instead of double counting', async t => {
  const base = await dir(t, [turn(1000, 2), turn(2000, 1)]);
  assert.equal((await readUsage(base)).turns, 2);
  await writeFile(join(base, 'session.jsonl'), `${turn(900, 1)}\n`);
  assert.deepEqual(await counts(base), { tokens: 900, turns: 1, toolUses: 1, at: undefined });
});

test('a missing or usage-free session reports no tokens instead of failing', async t => {
  assert.deepEqual(await readUsage(await dir(t)), {});
  const control = await dir(t, [{ type: 'message', message: { role: 'assistant' } }, 'not json at all', '']);
  // The two junk lines are not JSON, so nothing is counted and nothing throws.
  assert.deepEqual(await counts(control), { tokens: undefined, turns: 0, toolUses: 0, at: undefined });
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

// Child sessions reach hundreds of kilobytes. The first scan reads the file once,
// every later scan only what was appended — that is what keeps a redrawing row cheap.
test('a large session is parsed once, then only its new tail', async t => {
  const filler = Array.from({ length: 900 }, (_, i) => JSON.stringify({ type: 'message', message: { role: 'user', content: 'x'.repeat(200) } }));
  const base = await dir(t, [...filler, turn(4200, 1), turn(51000, 2)]);
  const size = (await stat(join(base, 'session.jsonl'))).size;
  assert.ok(size > 200 * 1024, `expected a large fixture, got ${size}`);
  assert.deepEqual(await counts(base), { tokens: 51000, turns: 2, toolUses: 3, at: undefined });
  clearUsageCache();
  const again = await readUsage(base);
  assert.equal(again.turns, 2);
  await appendFile(join(base, 'session.jsonl'), `${turn(60000, 1)}\n`);
  assert.deepEqual(await counts(base), { tokens: 60000, turns: 3, toolUses: 4, at: undefined });
});

test('the tools a child ran are named once each, up to a point', async t => {
  const base = await dir(t, [
    usage(1000, [call('a', 'read', { path: 'src/columns.mjs' }), call('b', 'grep', { pattern: 'export' })]),
    usage(2000, [call('c', 'bash', { command: 'npm test\nsecond line' }), call('d', 'read', { path: 'src/columns.mjs' })]),
  ]);
  const { actions } = await readUsage(base);
  assert.deepEqual(actions, ['read src/columns.mjs', 'grep export', 'bash npm test'], 'repeat and extra lines dropped');
});

test('an action with no useful argument is just the tool name, and the cap holds', async t => {
  const calls = Array.from({ length: 20 }, (_, i) => call(`c${i}`, `tool${i}`));
  const { actions } = await readUsage(await dir(t, [usage(1000, calls)]));
  assert.equal(actions[0], 'tool0');
  assert.equal(actions.length, 12, 'MAX_ACTIONS keeps a long session from growing the row');
});

test('a long argument is cut at the column, not at the byte', async t => {
  const { actions } = await readUsage(await dir(t, [usage(1000, [call('a', 'bash', { command: 'x'.repeat(200) })])]));
  assert.equal(actions[0].length, 'bash '.length + 48 + 1, 'kept 48 columns plus the ellipsis');
  assert.match(actions[0], /…$/);
});

test('an action names a path relative to where the child ran', async t => {
  const base = await dir(t, [usage(1000, [
    call('a', 'read', { path: '/repo/fork/src/columns.mjs' }),
    call('b', 'bash', { command: 'grep -n export /repo/fork/src/overview.mjs' }),
    call('c', 'read', { path: '/elsewhere/notes.md' }),
  ])]);
  await writeFile(join(base, 'run.json'), JSON.stringify({ cwd: '/repo/fork' }));
  const { actions } = await readUsage(base);
  assert.deepEqual(actions, [
    'read src/columns.mjs',
    'bash grep -n export src/overview.mjs',
    'read /elsewhere/notes.md',
  ], 'only paths under the run cwd are shortened');
});
