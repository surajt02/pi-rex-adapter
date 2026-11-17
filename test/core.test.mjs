import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Rex, prepareRun, readJson, listRuns, atomicJson, piArgs, contextSnapshot, tailFile, runStatus,
  composeUserMessage, COMPOSE_USER_MESSAGE } from '../src/core.mjs';
import adapter from '../src/index.mjs';

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-rex-test-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
test('BTW placement anchors on the parent, preserves focus, and keeps arguments literal', async () => {
  let args;
  const rex = new Rex('rex', async (_file, argv) => { args = argv; return '{"block_ids":["new","parent"]}'; });
  assert.equal(await rex.open({ kind: 'btw', anchor: 'parent', rexSession: 'session', cwd: '/tmp/a b', name: '$(touch BAD)', dir: '/tmp/x y' }, '/path/runner.mjs'), 'new');
  assert.deepEqual(args.slice(0, 5), ['split', '-b', 'parent', '--split=right', '--ratio=50']);
  assert.ok(args.includes('--focus=false'));
  assert.ok(args.includes('--shell=none'));
  assert.ok(args.includes('$(touch BAD)'));
  assert.equal(args.at(-1), '/tmp/x y');
});
test('a job is created inside its floating layer instead of being split in', async () => {
  const calls = [];
  const rex = new Rex('rex', async (_file, argv) => {
    calls.push(argv); return JSON.stringify({ layer_id: 'layer-1', block_ids: ['chip'], revision: 3 });
  });
  const run = { kind: 'shell', runtime: 'shell-runner', rexSession: 'session', cwd: '/tmp/a b', name: 'build',
    dir: '/tmp/r y', layout: { mode: 'chip', window: 'window-1', bounds: [0.54, 0.04, 0.44, 0.3] } };
  assert.equal(await rex.open(run, '/path/runner.mjs'), 'chip');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 3), ['api', 'call', 'session.new_layer']);
  const params = JSON.parse(calls[0][3]);
  assert.equal(params.session_id, 'session');
  assert.equal(params.window_id, 'window-1');
  assert.deepEqual(params.bounds, [0.54, 0.04, 0.44, 0.3]);
  assert.equal(params.focus, false);
  assert.equal(params.layout.block.flavor, 'com.superlogical.terminal.shell');
  assert.equal(params.layout.block.label, 'build');
  // Keep-open, no shell wrapper, and the same runner invocation the CLI would make.
  assert.deepEqual(params.layout.block.options, { shell: 'none',
    command: [process.execPath, '/path/runner.mjs', '/tmp/r y'], cwd: '/tmp/a b', exit: { on_completion: false } });
  assert.equal(run.block, 'chip');
  assert.equal(run.layout.layer, 'layer-1');
});

test('a job falls back to being split in when Rex refuses the floating layer', async () => {
  const calls = [];
  const rex = new Rex('rex', async (_file, argv) => {
    calls.push(argv);
    if (argv[2] === 'session.new_layer') throw new Error('unknown method: session.new_layer');
    return JSON.stringify({ block_ids: ['new'], window_id: 'window-1' });
  });
  const run = { kind: 'shell', rexSession: 'session', cwd: '/tmp', name: 'build', dir: '/tmp/r',
    anchor: 'parent', layout: { mode: 'chip', anchor: 'parent', bounds: [0.54, 0.04, 0.44, 0.3] } };
  assert.equal(await rex.open(run, '/path/runner.mjs'), 'new');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].slice(0, 5), ['split', '-b', 'parent', '--split=right', '--ratio=50']);
  // No layer yet, so applyChip still has to float the pane out of the layout.
  assert.equal(run.layout.layer, undefined);
});

test('unknown creation result is not retried', async () => {
  let calls = 0;
  const rex = new Rex('rex', async () => { calls++; return '{}'; });
  await assert.rejects(rex.open({ kind: 'agent' }, 'runner'), /no block ID/);
  assert.equal(calls, 1);
});
test('context only includes current supplied branch text, omits tool payloads and thinking', () => {
  const context = contextSnapshot([
    { type: 'message', message: { role: 'user', content: 'question' } },
    { type: 'message', message: { role: 'toolResult', content: 'SECRET TOOL' } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'SECRET' }, { type: 'text', text: 'answer' }] } },
  ]);
  assert.match(context, /question/); assert.match(context, /answer/); assert.doesNotMatch(context, /SECRET/);
  assert.match(contextSnapshot([{ type: 'compaction', summary: '123456789' }], 3), /omitted\]\n789$/);
});
test('fresh child session, literal prompt file and explicit extension; BTW has limited default tools', async t => {
  const root = await temporary(t);
  const run = await prepareRun(root, { kind: 'btw', task: '`touch BAD`', name: 'test' }, 'context');
  const args = piArgs(run, '/extension.mjs');
  assert.ok(args.includes('read,grep,find,ls'));
  assert.ok(args.includes('--no-mcp'));
  assert.ok(!args.includes('--print'));
  assert.equal(args.at(-2), '--');
  assert.equal((await readJson(join(run.dir, 'run.json'))).id, run.id);
  assert.match(await readFile(join(run.dir, 'prompt.md'), 'utf8'), /`touch BAD`/);
});
test('a composed message reaches prompt.md while run.task stays the raw question', async t => {
  const root = await temporary(t);
  const run = await prepareRun(root, { kind: 'btw', task: 'q', message: 'pre\n\nq\n\npost', name: 'q' }, '');
  assert.equal(await readFile(join(run.dir, 'prompt.md'), 'utf8'), [
    'This is an independent side conversation. Answer the side question; do not continue the parent task. Only /btw-return sends a conclusion back.',
    'Current task:\npre\n\nq\n\npost',
  ].join('\n\n'));
  assert.equal(run.task, 'q');
  const stored = await readJson(join(run.dir, 'run.json'));
  assert.equal(stored.task, 'q');
  assert.ok(!('message' in stored));
});
test('without a composed message prompt.md and run.json are unchanged', async t => {
  const root = await temporary(t);
  const run = await prepareRun(root, { kind: 'btw', task: 'q', name: 'q' }, '');
  assert.match(await readFile(join(run.dir, 'prompt.md'), 'utf8'), /Current task:\nq$/);
  assert.equal((await readJson(join(run.dir, 'run.json'))).task, 'q');
});
test('the user-message composer is optional, feature-detected and fails safe', () => {
  // No composer registered: the text is delivered untouched.
  assert.equal(composeUserMessage('q', {}), 'q');
  assert.equal(composeUserMessage('q', { [COMPOSE_USER_MESSAGE]: 'not a function' }), 'q');
  const registry = { [COMPOSE_USER_MESSAGE]: text => `pre\n\n${text}\n\npost` };
  assert.equal(composeUserMessage('q', registry), 'pre\n\nq\n\npost');
  // A composer that returns nothing usable must not erase the question.
  for (const value of [undefined, '', 42, null]) {
    assert.equal(composeUserMessage('q', { [COMPOSE_USER_MESSAGE]: () => value }), 'q');
  }
  // A throwing composer is the caller's problem to report, not silently swallowed.
  assert.throws(() => composeUserMessage('q', { [COMPOSE_USER_MESSAGE]: () => { throw new Error('broken snippet'); } }), /broken snippet/);
});

test('real shell runner captures stdout/stderr, nonzero exit and bounded result with full log', async t => {
  const root = await temporary(t);
  const run = await prepareRun(root, { kind: 'shell', task: 'printf hello; printf error >&2; exit 7', cwd: root }, '');
  const child = spawn(process.execPath, [resolve('src/runner.mjs'), run.dir], { stdio: 'ignore' });
  const [code] = await once(child, 'close');
  assert.equal(code, 7);
  assert.equal((await readJson(join(run.dir, 'exit.json'))).code, 7);
  const result = await readJson(join(run.dir, 'result.json'));
  assert.equal(result.status, 'failed'); assert.match(result.text, /hello/); assert.match(result.text, /error/);
  assert.equal((await tailFile(join(run.dir, 'output.log'), 3)).length, 3);
});
test('missing Pi executable produces an exit record instead of hanging', async t => {
  const root = await temporary(t);
  const run = await prepareRun(root, { kind: 'agent', task: 'test', name: 'x', cwd: root, piBin: '/missing/pi' }, '');
  const child = spawn(process.execPath, [resolve('src/runner.mjs'), run.dir], { stdio: 'ignore' });
  await once(child, 'close');
  assert.match((await readJson(join(run.dir, 'exit.json'))).error, /ENOENT/);
});
test('successful shell retains full log but bounds completion payload', async t => {
  const root = await temporary(t);
  const run = await prepareRun(root, { kind: 'shell', task: 'i=0; while [ "$i" -lt 3000 ]; do printf "1234567890"; i=$((i+1)); done', cwd: root }, '');
  const child = spawn(process.execPath, [resolve('src/runner.mjs'), run.dir], { stdio: 'ignore' });
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
  const result = await readJson(join(run.dir, 'result.json'));
  assert.equal(result.status, 'completed'); assert.equal(result.text.length, 16000);
  assert.equal((await readFile(join(run.dir, 'output.log'), 'utf8')).length, 30000);
});

test('shell jobs default Python to unbuffered output and preserve an explicit setting', async t => {
  const root = await temporary(t);
  for (const configured of [undefined, '', '0']) {
    const env = { ...process.env };
    if (configured === undefined) delete env.PYTHONUNBUFFERED;
    else env.PYTHONUNBUFFERED = configured;
    const run = await prepareRun(root, { kind: 'shell', cwd: root,
      task: `${JSON.stringify(process.execPath)} -p 'process.env.PYTHONUNBUFFERED'` }, '');
    const child = spawn(process.execPath, [resolve('src/runner.mjs'), run.dir], { stdio: 'ignore', env });
    assert.equal((await once(child, 'close'))[0], 0);
    assert.equal((await readFile(join(run.dir, 'output.log'), 'utf8')).trim(), configured ?? '1');
  }
});

// `overlay` turns on a UI with a scripted ctx.ui.custom: dialogs are recorded in
// `pickers` and answered by driving their component, so a modal command can be
// tested without a terminal. Without it the session stays headless, exactly as
// the existing tests expect.
function harness(root, entries = [], dependencies = {}, overlay = false) {
  const events = {}, commands = {}, tools = {}, messages = [], pickers = [], statuses = [];
  const ctx = { cwd: root, hasUI: Boolean(overlay), isIdle: () => true, sessionManager: {
    getSessionDir: () => root, getSessionId: () => 'parent', getEntries: () => entries, getBranch: () => entries,
  }, ui: { notify() {}, setStatus: (key, text) => { statuses.push({ key, text }); },
    custom: (factory, config) => overlay ? new Promise(resolve => {
      const component = factory({ terminal: { rows: 32 }, requestRender() {} }, {},
        { matches: (data, key) => data === key }, resolve);
      pickers.push({ component, config, render: () => component.render(87).join('\n') });
    }) : Promise.reject(new Error('overlay opened without a UI')),
  } };
  adapter({ on: (n, f) => { events[n] = f; }, registerCommand: (n, f) => { commands[n] = f; },
    registerTool: t => { tools[t.name] = t; }, getThinkingLevel: () => 'off',
    sendMessage: (m, options) => { messages.push({ ...m, options }); entries.push({ type: 'custom_message', ...m }); },
  }, dependencies);
  return { ctx, events, commands, tools, messages, entries, pickers, statuses };
}
async function until(predicate) {
  for (let i = 0; i < 350; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 20)); }
  assert.fail('Timed out waiting for event');
}
test('completion pushes one follow-up, reload does not replay it, BTW returns only explicitly', async t => {
  const dir = await temporary(t), root = join(dir, 'rex-adapter', 'parent');
  const run = await prepareRun(root, { kind: 'shell', name: 'build', task: 'true' }, '');
  await atomicJson(join(run.dir, 'result.json'), { status: 'completed', text: 'PASS' });
  await atomicJson(join(run.dir, 'exit.json'), { code: 0 });
  const h = harness(dir); t.after(() => h.events.session_shutdown());
  await h.events.session_start({}, h.ctx);
  await until(() => h.messages.length === 1);
  assert.equal(h.messages[0].options.triggerTurn, true);
  assert.equal(h.messages[0].options.deliverAs, undefined);
  await h.events.session_start({}, h.ctx);
  const side = await prepareRun(root, { kind: 'btw', name: 'aside', task: 'question' }, '');
  await atomicJson(join(side.dir, 'result.json'), { text: 'PRIVATE' });
  await atomicJson(join(side.dir, 'return-1.json'), { text: 'SHARED', status: 'returned' });
  await h.events.session_start({}, h.ctx); // Discover a fixture created outside the adapter launch path.
  await until(() => h.messages.length === 2);
  assert.match(h.messages[1].content, /SHARED/);
  assert.ok(h.messages.every(m => !m.content.includes('PRIVATE')));
  await h.events.session_start({}, h.ctx);
  await new Promise(r => setTimeout(r, 150));
  assert.equal(h.messages.length, 2);
});
test('/btw carries the composed user message but keeps the raw question as name and task', async t => {
  const dir = await temporary(t), h = harness(dir, [], { rex: {
    inspect: async () => ({ window: 'w' }), open: async () => 'block' } });
  const saved = { session: process.env.REX_SESSION, block: process.env.REX_BLOCK };
  process.env.REX_SESSION = 'rex'; process.env.REX_BLOCK = 'parent-block';
  globalThis[COMPOSE_USER_MESSAGE] = text => `pre\n\n${text}\n\npost`;
  t.after(() => {
    h.events.session_shutdown();
    delete globalThis[COMPOSE_USER_MESSAGE];
    for (const [key, value] of [['REX_SESSION', saved.session], ['REX_BLOCK', saved.block]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  await h.events.session_start({}, h.ctx);
  await h.commands.btw.handler('why is it like this', h.ctx);
  const [run] = await listRuns(join(dir, 'rex-adapter', 'parent'));
  assert.equal(run.block, 'block');
  assert.equal(run.task, 'why is it like this');
  assert.equal(run.name, 'why is it like this');
  assert.match(await readFile(join(run.dir, 'prompt.md'), 'utf8'), /Current task:\npre\n\nwhy is it like this\n\npost$/);
});
test('control rejects arbitrary IDs without contacting Rex', async t => {
  const dir = await temporary(t), h = harness(dir); t.after(() => h.events.session_shutdown());
  await h.events.session_start({}, h.ctx);
  const result = await h.tools.rex_control.execute('call', { id: '../someone-else', action: 'close' }, undefined, undefined, h.ctx);
  assert.equal(result.isError, true); assert.match(result.details.error, /Unknown task/);
});
test('switching sessions does not deliver an old session result into the new session', async t => {
  const dir = await temporary(t), h = harness(dir); t.after(() => h.events.session_shutdown());
  const run = await prepareRun(join(dir, 'rex-adapter', 'parent'), { kind: 'shell', name: 'old', task: 'true' }, '');
  await h.events.session_start({}, h.ctx);
  h.events.session_shutdown();
  const newCtx = { ...h.ctx, sessionManager: { ...h.ctx.sessionManager, getSessionId: () => 'new-parent' } };
  await h.events.session_start({}, newCtx);
  await atomicJson(join(run.dir, 'result.json'), { status: 'completed', text: 'OLD RESULT' });
  await atomicJson(join(run.dir, 'exit.json'), { code: 0 });
  await new Promise(r => setTimeout(r, 200));
  assert.equal(h.messages.length, 0);
  await h.events.session_start({}, h.ctx);
  await until(() => h.messages.length === 1);
  assert.match(h.messages[0].content, /OLD RESULT/);
});

test('delegated agents start a full interactive Pi, and own a retained tab', async t => {
  const root = await temporary(t);
  const run = await prepareRun(root, { kind: 'agent', name: 'review', task: 'review', cwd: root }, '');
  assert.equal(run.interactive, true);
  assert.ok(!piArgs(run, '/extension.mjs').includes('--print'));
  const rex = new Rex('rex', async (_bin, args) => {
    assert.equal(args[0], 'run');
    return JSON.stringify({ block_ids: ['child'], window_id: 'tab' });
  });
  assert.equal(await rex.open(run, '/runner.mjs'), 'child');
  assert.equal(run.window, 'tab');
});

test('busy parent consumes all ready results at one turn boundary without queuing follow-ups', async t => {
  const dir = await temporary(t), root = join(dir, 'rex-adapter', 'parent');
  for (const name of ['one', 'two', 'three']) {
    const run = await prepareRun(root, { kind: 'shell', name, task: 'true' }, '');
    await atomicJson(join(run.dir, 'result.json'), { status: 'completed', text: name });
    await atomicJson(join(run.dir, 'exit.json'), { code: 0 });
  }
  const h = harness(dir); h.ctx.isIdle = () => false;
  t.after(() => h.events.session_shutdown());
  await h.events.session_start({}, h.ctx);
  const event = { entries: [], context: { canContinue: true }, outcome: 'completed' };
  const batch = await h.events.turn_end(event, h.ctx);
  assert.equal(h.messages.length, 0);
  assert.equal(batch.continue, true);
  assert.equal(batch.entries.length, 1);
  assert.equal(batch.entries[0].details.receipts.length, 3);
  h.entries.push(...batch.entries);
  assert.equal(await h.events.agent_before_settle(event, h.ctx), undefined);
  await h.events.session_start({}, h.ctx);
  assert.equal(await h.events.turn_end(event, h.ctx), undefined);
});

test('idle parent wakes once for a batch; error detail survives an existing result', async t => {
  const dir = await temporary(t), root = join(dir, 'rex-adapter', 'parent');
  for (let i = 0; i < 3; i++) {
    const run = await prepareRun(root, { kind: 'shell', name: `job-${i}`, task: 'false' }, '');
    await atomicJson(join(run.dir, 'result.json'), { status: 'failed', text: 'partial stdout' });
    await atomicJson(join(run.dir, 'exit.json'), { code: 1, error: 'spawn ENOENT' });
  }
  const h = harness(dir); t.after(() => h.events.session_shutdown());
  await h.events.session_start({}, h.ctx);
  await until(() => h.messages.length === 1);
  assert.equal(h.messages[0].details.receipts.length, 3);
  assert.match(h.messages[0].content, /partial stdout/);
  assert.match(h.messages[0].content, /Exit error: spawn ENOENT/);
});

test('close is idempotent, coalesces concurrent calls and cancellation wins the exit race', async t => {
  const dir = await temporary(t), root = join(dir, 'rex-adapter', 'parent');
  const run = await prepareRun(root, { kind: 'shell', name: 'long-job', task: 'sleep 30', status: 'running' }, '');
  let calls = 0;
  const h = harness(dir, [], { rex: { async control() {
    calls++;
    // The process exits while Rex is still acknowledging close.
    await atomicJson(join(run.dir, 'exit.json'), { code: null, error: 'Terminated by SIGTERM' });
    await atomicJson(join(run.dir, 'result.json'), { text: 'partial', status: 'failed' });
    await new Promise(r => setTimeout(r, 30));
  } } });
  t.after(() => h.events.session_shutdown());
  await h.events.session_start({}, h.ctx);
  const close = () => h.tools.bg_kill.execute('x', { id: run.id }, undefined, undefined, h.ctx);
  const results = await Promise.all([close(), close()]);
  results.push(await close());
  assert.equal(calls, 1);
  assert.ok(results.every(r => !r.isError && r.details.status === 'cancelled'));
  await until(() => h.messages.length === 1);
  assert.equal(h.messages[0].details.results[0].status, 'cancelled');
  assert.match(h.messages[0].content, /SIGTERM/);
});

test('closing a previously completed job preserves its outcome', () => {
  assert.equal(runStatus({ closed: true, completedBeforeClose: true }, { code: 7 }, { status: 'failed' }), 'failed');
  assert.equal(runStatus({ closed: true, completedBeforeClose: true }, { code: 0 }, { status: 'completed' }), 'completed');
  assert.equal(runStatus({ closed: true }, { code: null }, { status: 'failed' }), 'cancelled');
});

test('interactive agent turn reports arrive without process exit; future turns remain distinct', async t => {
  const dir = await temporary(t), root = join(dir, 'rex-adapter', 'parent');
  const run = await prepareRun(root, { kind: 'agent', name: 'review', task: 'review' }, '');
  await atomicJson(join(run.dir, 'turn-1.json'), { text: 'first answer', status: 'completed' });
  const h = harness(dir); h.ctx.isIdle = () => false; t.after(() => h.events.session_shutdown());
  await h.events.session_start({}, h.ctx);
  const event = { entries: [], context: { canContinue: true }, outcome: 'completed' };
  const first = await h.events.turn_end(event, h.ctx);
  assert.match(first.entries[0].content, /first answer/);
  h.entries.push(...first.entries);
  await atomicJson(join(run.dir, 'turn-2.json'), { text: 'next answer', status: 'completed' });
  let next;
  await until(() => Boolean(next = h.events.turn_end(event, h.ctx)));
  assert.equal(next.entries[0].details.receipts.length, 1);
  assert.match(next.entries[0].content, /next answer/);
});

test('aborted boundary does not force a continuation', async t => {
  const dir = await temporary(t), h = harness(dir); h.ctx.isIdle = () => false;
  t.after(() => h.events.session_shutdown());
  await h.events.session_start({}, h.ctx);
  assert.equal(await h.events.turn_end({ entries: [], context: { canContinue: false }, outcome: 'aborted' }, h.ctx), undefined);
});

test('user abort suppresses an already scheduled idle wake; results survive for the next user turn', async t => {
  const dir = await temporary(t), root = join(dir, 'rex-adapter', 'parent');
  const run = await prepareRun(root, { kind: 'shell', name: 'test', task: 'true' }, '');
  await atomicJson(join(run.dir, 'result.json'), { text: 'saved result', status: 'completed' });
  await atomicJson(join(run.dir, 'exit.json'), { code: 0 });
  const h = harness(dir); t.after(() => h.events.session_shutdown());
  await h.events.session_start({}, h.ctx);
  await h.events.agent_settled({ aborted: true });
  await new Promise(r => setTimeout(r, 450));
  assert.equal(h.messages.length, 0);
  h.ctx.isIdle = () => false;
  h.events.agent_start();
  const batch = await h.events.turn_end({ entries: [], context: { canContinue: true }, outcome: 'completed' }, h.ctx);
  assert.match(batch.entries[0].content, /saved result/);
});

test('failed close does not persist a cancellation and can be retried', async t => {
  const dir = await temporary(t), root = join(dir, 'rex-adapter', 'parent');
  const run = await prepareRun(root, { kind: 'shell', name: 'test', task: 'true' }, '');
  let calls = 0;
  const h = harness(dir, [], { rex: { async control() { if (++calls === 1) throw new Error('connection failed'); } } });
  t.after(() => h.events.session_shutdown());
  await h.events.session_start({}, h.ctx);
  const close = () => h.tools.bg_kill.execute('x', { id: run.id }, undefined, undefined, h.ctx);
  assert.equal((await close()).isError, true);
  assert.equal((await readJson(join(run.dir, 'run.json'))).closed, undefined);
  assert.equal((await close()).details.closed, true);
  assert.equal(calls, 2);
});

test('closing an idle interactive Pi preserves its completed task when close causes a signal exit', async t => {
  const dir = await temporary(t), root = join(dir, 'rex-adapter', 'parent');
  const run = await prepareRun(root, { kind: 'agent', name: 'review', task: 'review', rexSession: 'rex' }, '');
  await atomicJson(join(run.dir, 'result.json'), { text: 'done', status: 'completed' });
  await atomicJson(join(run.dir, 'activity.json'), { task: 'completed', process: 'idle' });
  const h = harness(dir, [], { rex: { async control() {
    await atomicJson(join(run.dir, 'exit.json'), { code: null, error: 'Terminated by SIGTERM' });
  } } });
  t.after(() => h.events.session_shutdown());
  await h.events.session_start({}, h.ctx);
  const result = await h.tools.rex_control.execute('x', { id: run.id, action: 'close' }, undefined, undefined, h.ctx);
  assert.equal(result.isError, undefined);
  const tasks = await h.tools.rex_tasks.execute('list', {}, undefined, undefined, h.ctx);
  assert.equal(tasks.details[0].taskState, 'completed');
  assert.equal(tasks.details[0].processState, 'exited');
  assert.equal(tasks.details[0].blockState, 'closed');
});

test('status close wins over an in-flight open inspection, and closed records never inspect again', async t => {
  const dir = await temporary(t), root = join(dir, 'rex-adapter', 'parent');
  const run = await prepareRun(root, { kind: 'agent', task: 'task', block: 'block' }, '');
  let inspections = 0;
  const h = harness(dir, [], { rex: { async inspect() {
    inspections++;
    await atomicJson(join(run.dir, 'run.json'), { ...run, closed: true, status: 'cancelled', blockState: 'open' });
    return { window: 'old-window' };
  } } });
  t.after(() => h.events.session_shutdown());
  await h.events.session_start({}, h.ctx);
  for (let i = 0; i < 2; i++) {
    const result = await h.tools.rex_tasks.execute('x', {}, undefined, undefined, h.ctx);
    assert.equal(result.details[0].blockState, 'closed');
    assert.equal(result.details[0].closed, true);
  }
  assert.equal(inspections, 1);
});

test('failed block inspection reports unverified, never a stale open field', async t => {
  const dir = await temporary(t), root = join(dir, 'rex-adapter', 'parent');
  await prepareRun(root, { kind: 'agent', task: 'task', block: 'gone', blockState: 'open' }, '');
  const h = harness(dir, [], { rex: { async inspect() { throw new Error('block not found'); } } });
  t.after(() => h.events.session_shutdown());
  await h.events.session_start({}, h.ctx);
  const result = await h.tools.rex_tasks.execute('x', {}, undefined, undefined, h.ctx);
  assert.equal(result.details[0].blockState, 'unverified');
  assert.match(result.details[0].locationError, /not found/);
});

test('cancelled shell without result.json retains signal reason and reports resultAvailable=false', async t => {
  const dir = await temporary(t), root = join(dir, 'rex-adapter', 'parent');
  const run = await prepareRun(root, { kind: 'shell', task: 'sleep 30' }, '');
  await atomicJson(join(run.dir, 'run.json'), { ...run, closed: true, status: 'cancelled' });
  await atomicJson(join(run.dir, 'exit.json'), { code: null, error: 'Terminated by SIGHUP' });
  const h = harness(dir); t.after(() => h.events.session_shutdown());
  await h.events.session_start({}, h.ctx);
  await until(() => h.messages.length === 1);
  assert.match(h.messages[0].content, /Cancelled by user/); assert.match(h.messages[0].content, /SIGHUP/);
  const result = await h.tools.rex_tasks.execute('x', {}, undefined, undefined, h.ctx);
  assert.equal(result.details[0].resultAvailable, false);
  assert.equal(result.details[0].taskState, 'cancelled');
});

// A live side conversation on disk, as the picker finds it.
async function btwPane(dir, createdAt = '2024-01-01T00:00:00.000Z', name = 'why werent subagents spawned') {
  const run = await prepareRun(join(dir, 'rex-adapter', 'parent'), { kind: 'btw', name, task: name }, '');
  const live = { ...run, block: `block-${run.id.slice(0, 8)}`, rexSession: 'rex', status: 'running', createdAt };
  await atomicJson(join(run.dir, 'run.json'), live);
  return live;
}
function pickerRex() {
  const calls = [];
  let opened = 0;
  return { calls,
    async inspect(run) { calls.push(['inspect', run.block]); return { window: 'window-1' }; },
    async open(run) { calls.push(['open', run.kind]); return `new-block-${++opened}`; },
    async control(run, action) { calls.push([action, run.block]); },
  };
}
function rexEnvironment(t) {
  const saved = { session: process.env.REX_SESSION, block: process.env.REX_BLOCK };
  process.env.REX_SESSION = 'rex'; process.env.REX_BLOCK = 'parent-block';
  t.after(() => {
    for (const [key, value] of [['REX_SESSION', saved.session], ['REX_BLOCK', saved.block]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}
async function pickerFor(h, args) {
  const pending = h.commands.btw.handler(args, h.ctx);
  await until(() => h.pickers.length === 1);
  return { pending, picker: h.pickers[0] };
}

test('/btw with one side conversation offers it beside a new one, and the pane takes the question', async t => {
  const dir = await temporary(t), client = pickerRex();
  rexEnvironment(t);
  const pane = await btwPane(dir);
  const h = harness(dir, [], { rex: client }, true);
  t.after(() => h.events.session_shutdown());
  await h.events.session_start({}, h.ctx);
  const { pending, picker } = await pickerFor(h, 'why is this happening');
  const lines = picker.render();
  assert.match(lines, /\n Side Conversations\n/);
  assert.match(lines, /→ why werent subagents spawned · Running · /);
  assert.match(lines, /＋ New side conversation/);
  assert.match(lines, /Selected: why werent subagents spawned/);
  assert.match(lines, /Ctrl\+N to start a new side conversation/);
  // Inline, like Pi's own pickers: no overlay options and no side borders.
  assert.equal(picker.config, undefined);
  assert.doesNotMatch(lines, /│/);
  assert.doesNotMatch(lines, /Enter sends the question/);
  // The first row is the live pane; confirming it queues the question there.
  picker.component.handleInput('tui.select.confirm');
  await pending;
  assert.equal(client.calls.some(([name]) => name === 'open'), false);
  assert.equal((await listRuns(join(dir, 'rex-adapter', 'parent'))).length, 1);
  const inputs = (await readdir(pane.dir)).filter(name => name.startsWith('input-'));
  assert.equal(inputs.length, 1);
  assert.equal((await readJson(join(pane.dir, inputs[0]))).text, 'why is this happening');
  assert.ok(h.statuses.some(status => status.key === 'rex-action'));
});

test('ctrl+n in the side-conversation picker starts a second pane and leaves the first alone', async t => {
  const dir = await temporary(t), client = pickerRex();
  rexEnvironment(t);
  const pane = await btwPane(dir);
  const h = harness(dir, [], { rex: client }, true);
  t.after(() => h.events.session_shutdown());
  await h.events.session_start({}, h.ctx);
  const { pending, picker } = await pickerFor(h, 'a second question');
  picker.component.handleInput('\x0e');
  await pending;
  assert.equal(client.calls.filter(([name]) => name === 'open').length, 1);
  const runs = await listRuns(join(dir, 'rex-adapter', 'parent'));
  assert.equal(runs.length, 2);
  const second = runs.find(run => run.id !== pane.id);
  assert.equal(second.task, 'a second question');
  // The picker's choice belongs to the launch, never to the stored run.
  assert.equal(second.btwChoice, undefined);
  // The pane the reader did not pick keeps its history and gets no question.
  assert.equal((await readJson(join(pane.dir, 'run.json'))).closed, undefined);
  assert.equal((await readdir(pane.dir)).some(name => name.startsWith('input-')), false);
  assert.equal((await readFile(join(second.dir, 'prompt.md'), 'utf8')).includes('Current task:\na second question'), true);
});

test('bare /btw picks which side conversation to focus and offers no new one', async t => {
  const dir = await temporary(t), client = pickerRex();
  rexEnvironment(t);
  const first = await btwPane(dir, '2024-01-01T00:00:00.000Z', 'older aside');
  const second = await btwPane(dir, '2024-01-02T00:00:00.000Z', 'newer aside');
  const h = harness(dir, [], { rex: client }, true);
  t.after(() => h.events.session_shutdown());
  await h.events.session_start({}, h.ctx);
  const { pending, picker } = await pickerFor(h, undefined);
  const lines = picker.render();
  assert.doesNotMatch(lines, /│/);
  assert.doesNotMatch(lines, /New side conversation/);
  assert.doesNotMatch(lines, /Ctrl\+N/);
  // Newest first: the cursor starts on the second pane, which is listed above
  // the older one.
  assert.match(lines, /→ newer aside/);
  assert.ok(lines.indexOf('newer aside') < lines.indexOf('older aside'));
  picker.component.handleInput('tui.select.confirm');
  await pending;
  assert.deepEqual(client.calls.filter(([name]) => name !== 'inspect'), [['focus', second.block]]);
});

test('Esc in the picker launches nothing and consumes nothing', async t => {
  const dir = await temporary(t), client = pickerRex();
  rexEnvironment(t);
  const pane = await btwPane(dir);
  const h = harness(dir, [], { rex: client }, true);
  t.after(() => h.events.session_shutdown());
  await h.events.session_start({}, h.ctx);
  const { pending, picker } = await pickerFor(h, 'never sent');
  picker.component.handleInput('tui.select.cancel');
  await pending;
  assert.equal((await listRuns(join(dir, 'rex-adapter', 'parent'))).length, 1);
  assert.equal(client.calls.some(([name]) => name === 'open'), false);
  assert.equal((await readdir(pane.dir)).some(name => name.startsWith('input-')), false);
  // A cancelled picker is not a task that started, was reused, or failed.
  assert.ok(h.statuses.every(status => status.key !== 'rex-action'));
});

test('without a UI a side question still reuses the live conversation silently', async t => {
  const dir = await temporary(t), client = pickerRex();
  rexEnvironment(t);
  const pane = await btwPane(dir);
  const h = harness(dir, [], { rex: client });
  t.after(() => h.events.session_shutdown());
  await h.events.session_start({}, h.ctx);
  await h.commands.btw.handler('headless question', h.ctx);
  assert.equal(h.pickers.length, 0);
  const inputs = (await readdir(pane.dir)).filter(name => name.startsWith('input-'));
  assert.equal(inputs.length, 1);
  assert.equal((await readJson(join(pane.dir, inputs[0]))).text, 'headless question');
});
