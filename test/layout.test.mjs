import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { choosePlacement, existingBtw, withLayoutLock, applyChip } from '../src/layout.mjs';
import { Rex, prepareRun, atomicJson, readJson, runStates, listRuns } from '../src/core.mjs';
import { registerChild } from '../src/child.mjs';
import adapter from '../src/index.mjs';

async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-rex-layout-'));
  t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}
function fakeRex() {
  const blocks = new Map([['parent', 'main']]);
  const calls = [];
  let count = 0, windows = 0;
  return { blocks, calls,
    // The tab an agent joins is the size of the tab it was opened from.
    async size() { return { columns: 174, rows: 80, cellWidth: 16, cellHeight: 30 }; },
    async inspect(run) { if (!blocks.has(run.block)) throw new Error('Block unavailable'); return { window: blocks.get(run.block) }; },
    async open(run) {
      calls.push(structuredClone(run.layout));
      const id = `block-${++count}`;
      run.window = run.layout.mode === 'window' ? `window-${++windows}` : run.layout.window || 'window-1';
      run.layout.window = run.window;
      blocks.set(id, run.window); return id;
    },
    async control(run, action) { calls.push({ action, block: run.block }); if (action === 'close') blocks.delete(run.block); },
  };
}
function missingBlock(run) {
  return Object.assign(new Error(`block ${run.block} not found`), {
    code: 'REX_BLOCK_NOT_FOUND', block: run.block, rexSession: run.rexSession,
  });
}
async function create(root, client, kind = 'agent', owner = 'owner-123456') {
  return withLayoutLock(root, async () => {
    const options = { owner, kind, name: kind, task: 'task', cwd: root, rexSession: 'rex', anchor: 'parent' };
    options.layout = await choosePlacement(root, client, options);
    const run = await prepareRun(root, options, '');
    run.block = await client.open(run); run.status = 'running';
    await atomicJson(join(run.dir, 'run.json'), run); return run;
  });
}

test('agents share one grid tab while each job gets its own chip', async t => {
  const root = await temp(t), client = fakeRex();
  const agents = [];
  for (let i = 0; i < 4; i++) agents.push(await create(root, client));
  assert.equal(agents[0].layout.mode, 'window');
  assert.equal(agents[0].layout.title, 'Agents · owner-12');
  // One, two and three agents are columns; the fourth turns the tab into a grid.
  assert.deepEqual(agents.slice(1).map(a => a.layout.mode), ['grid', 'grid', 'grid']);
  assert.deepEqual(agents.slice(1).map(a => a.layout.rows), [[2], [3], [2, 2]]);
  assert.ok(agents.every(a => a.window === agents[0].window), 'every agent stays in the same tab');
  assert.equal(agents[1].layout.anchor, agents[0].block);
  assert.deepEqual(agents[1].layout.frame, { columns: 174, rows: 80, cellWidth: 16, cellHeight: 30 });
  const job = await create(root, client, 'shell');
  assert.equal(job.layout.mode, 'chip');
  assert.equal(job.layout.anchor, 'parent');
  const other = await create(join(root, 'other-parent'), client, 'agent', 'different');
  assert.equal(other.layout.mode, 'window');
  assert.equal(other.layout.title, 'Agents · differen');
});

test('a pane the user dragged elsewhere is never counted, moved back or grown beside', async t => {
  const root = await temp(t), client = fakeRex();
  const first = await create(root, client), second = await create(root, client);
  client.blocks.set(second.block, 'user-tab');
  const third = await create(root, client);
  assert.equal(client.blocks.get(second.block), 'user-tab');
  assert.equal(third.window, first.window);
  // Only the pane still in the managed tab counts, so the grid stays at two.
  assert.deepEqual(third.layout.rows, [2]);
  // With nothing left there, a fresh Agents tab opens instead of growing the tab
  // the user moved those panes to.
  for (const run of [first, second, third]) client.blocks.set(run.block, 'user-tab');
  const fourth = await create(root, client);
  assert.equal(fourth.layout.mode, 'window');
  assert.notEqual(fourth.window, 'user-tab');
  for (const run of [first, second, third]) assert.equal(client.blocks.get(run.block), 'user-tab');
});

test('a chip whose block is gone is retired before the next slot is chosen', async t => {
  const root = await temp(t), client = fakeRex();
  const a = await create(root, client, 'shell'), b = await create(root, client, 'shell');
  // A's block has exited and is gone: its chip slot comes back for the next job.
  await atomicJson(join(a.dir, 'exit.json'), { code: 0 });
  client.blocks.delete(a.block);
  const inspect = client.inspect;
  client.inspect = async r => { if (!client.blocks.has(r.block)) throw missingBlock(r); return inspect(r); };
  const c = await create(root, client, 'shell');
  assert.equal(c.layout.slot, 0);
  assert.equal((await readJson(join(a.dir, 'run.json'))).closed, true);
  assert.equal(b.layout.slot, 1);
});

test('unknown creation or failed inspection never silently creates more panes', async t => {
  const root = await temp(t), client = fakeRex();
  const run = await prepareRun(root, { kind: 'agent', name: 'lost', task: 'task', rexSession: 'rex', layout: { role: 'agents', page: 1 } }, '');
  await assert.rejects(create(root, client), /unresolved/);
  assert.equal(client.calls.length, 0);
  run.closed = true; await atomicJson(join(run.dir, 'run.json'), run);
  const first = await create(root, client);
  client.blocks.delete(first.block);
  await assert.rejects(create(root, client), /unavailable/);
  assert.equal(client.calls.length, 1);
});

test('only the exact Rex missing-block response is classified for recovery', async () => {
  const run = { block: 'block:missing', rexSession: 'session:owner' };
  for (const message of [
    '/usr/local/bin/rex: Error: block target "block:missing" not found\n',
    '/usr/local/bin/rex: Error: block target "block:other" not found\n',
    '/usr/local/bin/rex: Error: session target "session:owner" not found\n',
    '/usr/local/bin/rex: connection timed out',
    '/usr/local/bin/rex: ENOENT executable not found',
  ]) {
    const client = new Rex('/usr/local/bin/rex', async () => { throw new Error(message); });
    await assert.rejects(client.inspect(run), error => {
      const missing = message.includes('block target "block:missing"');
      assert.equal(error.code, missing ? 'REX_BLOCK_NOT_FOUND' : undefined);
      if (missing) { assert.equal(error.block, run.block); assert.equal(error.rexSession, run.rexSession); }
      return true;
    });
  }
});

for (const kind of ['agent', 'shell', 'btw']) test(`${kind}: absent exited panes retire automatically and no longer block creation`, async t => {
  const root = await temp(t), client = fakeRex();
  const run = await create(root, client, kind);
  const result = { status: 'completed', text: 'retained result' }, exit = { code: 0 };
  await atomicJson(join(run.dir, 'result.json'), result);
  await atomicJson(join(run.dir, 'exit.json'), exit);
  client.blocks.delete(run.block);
  const inspect = client.inspect;
  client.inspect = async r => { if (!client.blocks.has(r.block)) throw missingBlock(r); return inspect(r); };
  if (kind === 'btw') {
    assert.equal(await withLayoutLock(root, () => existingBtw(root, client, { rexSession: 'rex', task: 'new question' })), undefined);
    assert.equal((await readdir(run.dir)).some(f => f.startsWith('input-')), false);
  }
  const replacement = await create(root, client, kind);
  const retired = await readJson(join(run.dir, 'run.json'));
  assert.equal(retired.closed, true); assert.equal(retired.status, 'completed');
  assert.equal(retired.completedBeforeClose, true); assert.ok(retired.resolvedAt);
  assert.deepEqual(await readJson(join(run.dir, 'result.json')), result);
  assert.deepEqual(await readJson(join(run.dir, 'exit.json')), exit);
  assert.equal(client.calls.some(c => c.action === 'close'), false);
  if (kind === 'btw') assert.equal(replacement.layout.anchor, 'parent');
  else if (kind === 'agent') {
    assert.equal(replacement.layout.mode, 'window');
    assert.equal(replacement.layout.title, 'Agents · owner-12');
  } else assert.equal(replacement.layout.mode, 'chip');
});

for (const kind of ['agent', 'btw']) test(`${kind}: ambiguous failures and missing exit evidence remain blocking`, async t => {
  const root = await temp(t), client = fakeRex(), run = await create(root, client, kind);
  const launch = () => kind === 'btw'
    ? withLayoutLock(root, () => existingBtw(root, client, { rexSession: 'rex', task: 'next' })) : create(root, client);
  const original = await readJson(join(run.dir, 'run.json'));
  client.inspect = async r => { throw missingBlock(r); };
  await assert.rejects(launch(), /not found/); // No exit.json, even if activity says idle.
  await atomicJson(join(run.dir, 'activity.json'), { process: 'idle' });
  await atomicJson(join(run.dir, 'exit.json'), {});
  await assert.rejects(launch(), /not found/);
  await atomicJson(join(run.dir, 'exit.json'), { code: 0 });
  client.inspect = async () => { throw new Error('connection timed out'); };
  await assert.rejects(launch(), /timed out/);
  client.inspect = async r => { throw { ...missingBlock(r), rexSession: 'another session' }; };
  await assert.rejects(launch());
  assert.deepEqual(await readJson(join(run.dir, 'run.json')), original);
  assert.equal(client.calls.length, 1);
  assert.equal((await readdir(run.dir)).some(f => f.startsWith('input-')), false);
});

test('retiring stale agent groups preserves failed/exited outcomes and concurrent placement', async t => {
  const root = await temp(t), client = fakeRex(), runs = [];
  for (let i = 0; i < 3; i++) runs.push(await create(root, client));
  for (let i = 0; i < runs.length; i++) {
    await atomicJson(join(runs[i].dir, 'exit.json'), { code: [0, 7, null][i] });
    client.blocks.delete(runs[i].block);
  }
  const inspect = client.inspect;
  client.inspect = async r => { if (!client.blocks.has(r.block)) throw missingBlock(r); return inspect(r); };
  const [a, b] = await Promise.all([create(root, client), create(root, client)]);
  assert.equal(a.layout.mode, 'window'); assert.equal(a.layout.title, 'Agents · owner-12');
  assert.equal(b.layout.mode, 'grid'); assert.equal(b.layout.anchor, a.block); assert.deepEqual(b.layout.rows, [2]);
  for (let i = 0; i < runs.length; i++) {
    const r = await readJson(join(runs[i].dir, 'run.json'));
    assert.equal(r.closed, true); assert.equal(r.status, i === 0 ? 'exited' : 'failed');
  }
});

test('BTW reuses the same session, queues literal questions, focuses on bare invocation and reopens after exit', async t => {
  const root = await temp(t), client = fakeRex();
  const run = await create(root, client, 'btw');
  assert.equal(run.layout.window, 'main');
  assert.equal(run.layout.direction, 'right');
  const reused = await existingBtw(root, client, { rexSession: 'rex', task: '/literal $(not a command)' });
  assert.equal(reused.id, run.id); assert.equal(reused.reused, true);
  const input = await readJson(join(run.dir, `input-${reused.request}.json`));
  assert.equal(input.text, '/literal $(not a command)');
  await existingBtw(root, client, { rexSession: 'rex' });
  assert.equal(client.calls.at(-1).action, 'focus');
  await assert.rejects(existingBtw(root, client, { rexSession: 'rex', task: 'different', cwd: '/different' }), /another cwd/);
  await atomicJson(join(run.dir, 'exit.json'), { code: 0 });
  assert.equal(await existingBtw(root, client, { rexSession: 'rex', task: 'restart' }), undefined);
  assert.equal(client.calls.at(-1).action, 'close');
  assert.equal((await readJson(join(run.dir, 'run.json'))).closed, true);
  const replacement = await create(root, client, 'btw');
  assert.notEqual(replacement.id, run.id);
  assert.equal(replacement.layout.anchor, 'parent');
});

test('window CLI has a group title, split targets exact owned block and preserves focus', async () => {
  const calls = [];
  const client = new Rex('rex', async (_bin, args) => { calls.push(args); return JSON.stringify({ block_ids: ['new'], window_id: 'w' }); });
  const run = { kind: 'agent', name: 'Review', cwd: '/tmp', rexSession: 'r', dir: '/tmp/job', layout: { mode: 'window', title: 'Agents · owner' } };
  await client.open(run, '/runner');
  assert.deepEqual(calls[0].slice(0, 3), ['window', 'new', 'Agents · owner']);
  assert.ok(!calls[0].includes('--label'));
  assert.ok(calls[0].includes('--focus=false'));
  run.layout = { mode: 'split', anchor: 'exact', window: 'w', direction: 'right' };
  await client.open(run, '/runner');
  assert.deepEqual(calls[1].slice(0, 5), ['split', '-b', 'exact', '--split=right', '--ratio=50']);
  // A grid pane is split into place first and rearranged afterwards.
  run.layout = { mode: 'grid', anchor: 'exact', window: 'w', rows: [2], direction: 'right' };
  await client.open(run, '/runner');
  assert.deepEqual(calls[2].slice(0, 5), ['split', '-b', 'exact', '--split=right', '--ratio=50']);
  assert.equal(run.window, 'w');
});

test('task completion, idle Pi, retained exited process and closed block remain distinct', () => {
  assert.equal(runStates({}, undefined, { status: 'completed' }, { task: 'completed', process: 'idle' }).processState, 'idle');
  assert.equal(runStates({}, undefined, { status: 'completed' }, { task: 'running', process: 'running' }).taskState, 'running');
  const done = runStates({}, { code: 0 }, { status: 'completed' });
  assert.equal(done.taskState, 'completed'); assert.equal(done.processState, 'exited'); assert.equal(done.blockState, 'unverified');
  const closed = runStates({ closed: true, taskCompletedBeforeClose: true }, { code: null }, { status: 'completed' });
  assert.equal(closed.taskState, 'completed'); assert.equal(closed.blockState, 'closed');
});

test('BTW input bridge defers while busy, batches input and does not replay after reload', async t => {
  const root = await temp(t), events = {}, entries = [], sent = [];
  let idle = false;
  const ctx = { isIdle: () => idle, hasUI: false, sessionManager: { getEntries: () => entries, getBranch: () => [{ type: 'message' }] } };
  registerChild({ on: (name, handler) => { events[name] = handler; }, registerCommand() {},
    sendUserMessage: (text, options) => { sent.push({ text, options }); entries.push({ type: 'message', message: { role: 'user', content: text } }); },
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
  }, root);
  t.after(() => events.session_shutdown());
  await events.session_start({}, ctx);
  for (let i = 0; i < 2; i++) await atomicJson(join(root, `input-${i}.json`), { id: `${i}`, text: `question ${i}`, createdAt: `${i}` });
  await new Promise(r => setTimeout(r, 1100));
  assert.equal(sent.length, 0);
  idle = true;
  await new Promise(r => setTimeout(r, 1100));
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /question 0\n\nquestion 1/);
  assert.equal(sent[0].options.expandPromptTemplates, false);
  await events.session_start({}, ctx);
  await new Promise(r => setTimeout(r, 1100));
  assert.equal(sent.length, 1);
});

test('adapter serializes simultaneous BTW launches into one block and restores it after reload', async t => {
  const root = await temp(t), client = fakeRex(), events = {}, tools = {};
  const previous = { session: process.env.REX_SESSION, block: process.env.REX_BLOCK };
  process.env.REX_SESSION = 'rex'; process.env.REX_BLOCK = 'parent';
  t.after(() => {
    for (const [key, value] of [['REX_SESSION', previous.session], ['REX_BLOCK', previous.block]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  adapter({ on: (name, handler) => { events[name] = handler; }, registerCommand() {}, registerTool: tool => { tools[tool.name] = tool; },
    getThinkingLevel: () => 'off', sendMessage() {},
  }, { rex: client });
  const ctx = { cwd: root, hasUI: false, isIdle: () => false, sessionManager: {
    getSessionDir: () => root, getSessionId: () => 'owner', getEntries: () => [], getBranch: () => [],
  } };
  t.after(() => events.session_shutdown());
  await events.session_start({}, ctx);
  const launch = task => tools.btw.execute('call', { task }, undefined, undefined, ctx);
  const [a, b] = await Promise.all([launch('first'), launch('second')]);
  assert.equal(a.isError, undefined); assert.equal(b.isError, undefined);
  assert.equal(a.details.id, b.details.id); assert.equal(b.details.reused, true);
  assert.equal(client.calls.length, 1);
  await events.session_start({}, ctx);
  const c = await launch('third');
  assert.equal(c.details.id, a.details.id);
  assert.equal((await listRuns(join(root, 'rex-adapter', 'owner'))).length, 1);
  const files = await readdir(a.details.artifacts);
  assert.equal(files.filter(f => f.startsWith('input-')).length, 2);
});

test('new child does not let queued input overtake the initial CLI task', async t => {
  const root = await temp(t), events = {}, sent = [], entries = [];
  const ctx = { isIdle: () => true, hasUI: false, sessionManager: { getEntries: () => entries, getBranch: () => [] } };
  registerChild({ on: (name, handler) => { events[name] = handler; }, registerCommand() {},
    sendUserMessage: text => sent.push(text), appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
  }, root);
  t.after(() => events.session_shutdown());
  await events.session_start({}, ctx);
  await atomicJson(join(root, 'input-1.json'), { id: '1', text: 'second task', createdAt: '1' });
  await new Promise(r => setTimeout(r, 1100));
  assert.equal(sent.length, 0);
  await events.agent_settled({ aborted: false }, ctx);
  await new Promise(r => setTimeout(r, 1100));
  assert.deepEqual(sent, ['second task']);
});

test('each job takes its own chip slot and a closed job frees that slot again', async t => {
  const root = await temp(t), client = fakeRex();
  const jobs = [];
  for (let i = 0; i < 4; i++) jobs.push(await create(root, client, 'shell'));
  // Three slots stack down the right side; the fourth reuses one rather than
  // covering a pane the user can still see.
  assert.deepEqual(jobs.map(job => job.layout.slot), [0, 1, 2, 0]);
  assert.deepEqual(jobs[0].layout.bounds, [0.54, 0.04, 0.44, 0.3]);
  assert.deepEqual(jobs[2].layout.bounds, [0.54, 0.68, 0.44, 0.3]);
  // Every chip belongs to the window the parent pane is in, beside that pane.
  assert.ok(jobs.every(job => job.layout.anchor === 'parent'));
  assert.ok(jobs.every(job => job.layout.window === 'main'));
  const spare = jobs[1];
  spare.closed = true; await atomicJson(join(spare.dir, 'run.json'), spare); client.blocks.delete(spare.block);
  const next = await create(root, client, 'shell');
  assert.equal(next.layout.slot, 1);
});

test('a chip born in its layer is only minimized, never floated', async t => {
  const root = await temp(t), client = fakeRex();
  const calls = [];
  client.float = async () => { calls.push(['float']); return { layer_id: 'wrong' }; };
  client.minimize = async (session, layer) => { calls.push(['minimize', session, layer]); };
  const run = await create(root, client, 'shell');
  run.layout.layer = 'layer-1'; // What session.new_layer returned to open().
  await applyChip(client, run);
  assert.deepEqual(calls, [['minimize', 'rex', 'layer-1']]);
  assert.equal(run.layout.layer, 'layer-1');
});

test('a chip that was split in instead is floated out and then minimized', async t => {
  const root = await temp(t), client = fakeRex();
  const calls = [];
  client.float = async (session, block, bounds) => { calls.push(['float', session, block, bounds]); return { layer_id: 'layer-1' }; };
  client.minimize = async (session, layer) => { calls.push(['minimize', session, layer]); };
  const run = await create(root, client, 'shell');
  await applyChip(client, run);
  assert.deepEqual(calls, [['float', 'rex', run.block, run.layout.bounds], ['minimize', 'rex', 'layer-1']]);
  assert.equal(run.layout.layer, 'layer-1');
});
