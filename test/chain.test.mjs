import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import adapter from '../src/index.mjs';
import { atomicJson } from '../src/core.mjs';
import { composeTask, chainSummary, createChain, MAX_STEPS } from '../src/chain.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// 400 polls are 4 s, shorter than the adapter's 5 s reconcile, and most waits here
// can legitimately land on that reconcile when a watcher event is missed — so they
// get 9 s. A real failure still surfaces, just later.
async function until(condition, label = 'condition', attempts = 900) {
  for (let i = 0; i < attempts; i++) { if (await condition()) return; await delay(10); }
  assert.fail(`Timed out waiting for ${label}`);
}

function fakeRex() {
  const calls = { open: [], control: [], inspect: [] };
  let blocks = 0;
  return { calls,
    // Current Rex sets only REX_BLOCK, so the launch asks which session holds it.
    async session() { return 'session:parent'; },
    async open(run) {
      calls.open.push({ name: run.name, task: run.task, model: run.model, thinking: run.thinking, chain: run.chain, role: run.role, tools: run.tools });
      const id = `block-${++blocks}`;
      run.window = run.layout.mode === 'window' ? `window-${blocks}` : run.layout.window;
      return id;
    },
    async inspect(run) { calls.inspect.push(run.block); return { window: `window-${blocks}` }; },
    async control(run, action) { calls.control.push({ id: run.id, action }); },
    async reveal() { return true; },
    events() { return () => {}; },
  };
}

async function fixture(t, client) {
  const dir = await mkdtemp(join(tmpdir(), 'rex-chain-'));
  const agentDir = join(dir, 'agent');
  await mkdir(join(agentDir, 'agents'), { recursive: true });
  await writeFile(join(agentDir, 'agents', 'scout.md'),
    '---\ndescription: maps code\nmodel: opencode-go/scout-model\nthinking: low\ntools: read,grep\n---\nYou are a scout.\n');
  await writeFile(join(agentDir, 'agents', 'worker.md'),
    '---\ndescription: writes code\nmodel: opencode-go/worker-model\nthinking: high\ntools: read,edit\n---\nYou are a worker.\n');
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const root = join(dir, 'rex-adapter', 'parent');
  const events = {}, tools = {}, entries = [], messages = [];
  const ctx = { cwd: dir, hasUI: false, isIdle: () => false, sessionManager: {
    getSessionDir: () => dir, getSessionId: () => 'parent', getEntries: () => entries, getBranch: () => entries,
  }, ui: { setWidget() {}, setStatus() {}, notify() {} } };
  const pi = { on: (name, fn) => { events[name] = fn; }, registerTool: tool => { tools[tool.name] = tool; },
    registerCommand() {}, getThinkingLevel: () => 'off', appendEntry() {},
    sendMessage: message => { messages.push(message); entries.push({ type: 'custom_message', ...message }); } };
  adapter(pi, { rex: client });
  t.after(async () => {
    events.session_shutdown();
    await delay(20);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
  const call = (name, params, signal) => tools[name].execute('call', params, signal, undefined, ctx);
  const boundary = () => events.turn_end({ entries: [], context: { canContinue: true }, outcome: 'completed' }, ctx);
  await events.session_start({}, ctx);
  return { dir, root, tools, entries, messages, ctx, call, boundary };
}

// Mirrors what the child extension writes after a settled turn.
async function turn(dir, text, status = 'completed') {
  const result = { text, status, sequence: Date.now(), createdAt: new Date().toISOString() };
  await atomicJson(join(dir, 'result.json'), result);
  await atomicJson(join(dir, 'activity.json'), { task: status, process: 'idle', at: new Date().toISOString() });
  await atomicJson(join(dir, `turn-${Date.now()}.json`), result);
}

test('step one receives only its own task', async t => {
  const chain = await createChain(await mkdtemp(join(tmpdir(), 'rex-compose-')), {
    title: 'x', task: 'map it', steps: [{ agent: 'scout', task: 'map it' }, { agent: 'worker', task: 'fix it' }],
  });
  const first = composeTask(chain, 0);
  assert.match(first, /^Complete step 1 of 2 in a pipeline/);
  assert.match(first, /# Task\n\nmap it/);
  assert.doesNotMatch(first, /Overall task/);
  t.diagnostic(first);
});

test('a later step receives the overall task, the previous report and its own task', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rex-compose-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const chain = await createChain(root, {
    title: 'x', task: 'map it', steps: [{ agent: 'scout', task: 'map it' }, { agent: 'worker', task: 'fix it' }],
  });
  chain.steps[0].text = 'auth lives in src/auth.ts';
  const second = composeTask(chain, 1);
  assert.match(second, /# Overall task\n\nmap it/);
  assert.match(second, /# Report from step 1 \(scout\)\n\nauth lives in src\/auth\.ts/);
  assert.match(second, /# Your step\n\nfix it/);
  assert.match(second, /Do not delegate further/);
});

test('the summary reports every step once, and points at a failure', async () => {
  const chain = { id: 'chain-1', title: 'auth', status: 'completed', steps: [
    { index: 0, agent: 'scout', status: 'completed', runId: 'run-1', text: 'mapped the module' },
    { index: 1, agent: 'worker', status: 'completed', runId: 'run-2', text: 'added the test' },
  ] };
  const summary = chainSummary(chain, { artifacts: '/tmp/chain-1' });
  assert.match(summary, /Rex pipeline auth \(chain-1\): completed; steps=2/);
  assert.match(summary, /Step 1\/2 scout: completed \(run-1\) — mapped the module/);
  assert.match(summary, /Final report \(worker\):\nadded the test/);
  assert.match(summary, /Artifacts: \/tmp\/chain-1/);
  assert.doesNotMatch(summary, /rex_finish/);

  chain.status = 'failed';
  chain.steps[1].status = 'failed';
  chain.steps[1].error = 'turn failed';
  chain.steps[1].block = 'block:abc';
  const failed = chainSummary(chain, { artifacts: '/tmp/chain-1' });
  assert.match(failed, /Failing step report \(worker\)/);
  assert.match(failed, /still open for inspection: block:abc/, 'a confirmed pane is named by its block');

  delete chain.steps[1].block;
  assert.match(chainSummary(chain, { artifacts: '/tmp/chain-1' }),
    /left no pane to inspect/, 'a launch that was never verified has no pane to point at');
});

test('a launch that is never verified fails its step instead of stalling the chain', async t => {
  const client = fakeRex();
  // Rex never answers: the block may exist, but no id comes back, so nothing can
  // observe the run and no receipt can ever arrive.
  client.open = async () => { throw new Error('rex: connection timed out'); };
  const h = await fixture(t, client);
  const started = JSON.parse((await h.call('pipeline', {
    title: 'timeout',
    steps: [{ agent: 'scout', label: 'Map auth', task: 'map it' }, { agent: 'worker', label: 'Add test', task: 'fix it' }],
  })).content[0].text);
  const chainFile = join(started.artifacts, 'chain.json');
  const stepDir = join(h.root, started.first);
  await until(async () => (await readFile(join(stepDir, 'run.json'), 'utf8')).includes('uncertain'), 'the uncertain run');

  // Age the run past the grace instead of waiting two real minutes.
  const run = JSON.parse(await readFile(join(stepDir, 'run.json'), 'utf8'));
  assert.equal(run.status, 'uncertain');
  await writeFile(join(stepDir, 'run.json'), JSON.stringify({ ...run, createdAt: new Date(Date.now() - 5 * 60_000).toISOString() }));

  // A missed watcher event leaves the 5 s reconcile as the only trigger.
  await until(async () => JSON.parse(await readFile(chainFile, 'utf8')).status === 'failed', 'the chain to fail', 900);
  const chain = JSON.parse(await readFile(chainFile, 'utf8'));
  assert.equal(chain.steps[0].status, 'failed');
  assert.equal(chain.steps[1].runId, undefined, 'the second step is never launched');
  assert.match(chain.steps[0].text, /never verified/);
  let message;
  await until(() => { const value = h.boundary(); if (value) message = value.entries.at(-1); return Boolean(value); }, 'the failed chain report');
  assert.match(message.content, /: failed/);
  assert.match(message.content, /left no pane to inspect/);
});

test('a finished chain still reads N/N after its own panes closed', async t => {
  const client = fakeRex();
  const h = await fixture(t, client);
  const started = JSON.parse((await h.call('pipeline', {
    title: 'row check',
    steps: [{ agent: 'scout', label: 'Map auth', task: 'map it' }, { agent: 'worker', label: 'Add test', task: 'fix it' }],
  })).content[0].text);
  const chainFile = join(started.artifacts, 'chain.json');

  await turn(join(h.root, started.first), 'mapped');
  await until(async () => JSON.parse(await readFile(chainFile, 'utf8')).steps[1]?.runId, 'step two');
  const second = JSON.parse(await readFile(chainFile, 'utf8')).steps[1].runId;
  await turn(join(h.root, second), 'fixed');

  const theme = { bold: text => text, fg: (_token, text) => text };
  // The count is in the call slot and the steps are in the result slot; a row is both.
  const args = { title: 'row check', steps: [{ agent: 'scout', label: 'Map auth' }, { agent: 'worker', label: 'Add test' }] };
  const render = () => {
    const context = () => ({ toolCallId: 'call', args, invalidate() {}, state: {}, cwd: h.ctx.cwd });
    const head = h.tools.pipeline.renderCall(args, theme, context()).render(126).join('\n');
    const body = h.tools.pipeline.renderResult(
      { content: [], details: {} }, { expanded: false, isPartial: false }, theme, context(),
    ).render(126).join('\n');
    return `${head}\n${body}`;
  };

  // finishChain closes every completed step pane, so the rows are gone by the time
  // the last step reports; the count has to come from the chain record instead.
  await until(() => /2\/2 done/.test(render()), 'the finished count');
  assert.match(render(), /Add test \(worker\)/, 'the closed step is still named');
  assert.match(render(), /Map auth \(scout\)/);
});

test('a delegated agent must state its goal in six words, and the label is recorded for the list', async t => {
  const client = fakeRex();
  const h = await fixture(t, client);
  const error = async params => JSON.parse((await h.call('subagent', params)).content[0].text).error;
  assert.match(await error({ task: 'Review the change' }), /label is required/);
  assert.match(await error({ task: 'Review the change', label: 'one two three four five six seven' }),
    /label must be 6 words or fewer, got 7/);
  assert.equal(client.calls.open.length, 0, 'a rejected label never opens a pane');

  const started = await h.call('subagent', { task: 'Review the change', label: 'Review plan vs code', agent: 'scout' });
  assert.equal(started.details.status, 'running');
  const dir = join(h.root, started.details.id);
  const run = JSON.parse(await readFile(join(dir, 'run.json'), 'utf8'));
  assert.equal(run.label, 'Review plan vs code');
  assert.equal(run.role, 'scout', 'the resolved role is part of the audit trail');
});

test('pipeline steps keep their labels in chain.json', async t => {
  const client = fakeRex();
  const h = await fixture(t, client);
  const started = await h.call('pipeline', { title: 'auth', steps: [
    { agent: 'scout', task: 'Map the auth module', label: 'Map auth module' },
    { agent: 'worker', task: 'Add the missing test', label: 'Add missing test' },
  ] });
  const chain = JSON.parse(await readFile(join(started.details.artifacts, 'chain.json'), 'utf8'));
  assert.deepEqual(chain.steps.map(step => step.label), ['Map auth module', 'Add missing test']);
  const run = JSON.parse(await readFile(join(h.root, started.details.first, 'run.json'), 'utf8'));
  assert.equal(run.label, 'Map auth module');
});

test('a pipeline runs each role in its own pane and delivers one report', async t => {
  const client = fakeRex();
  const h = await fixture(t, client);
  const started = await h.call('pipeline', { title: 'auth', steps: [
    { agent: 'scout', task: 'Map the auth module', label: 'Map the auth module' },
    { agent: 'worker', task: 'Add the missing test', label: 'Add the missing test' },
  ] });
  assert.equal(started.details.status, 'running');
  assert.equal(started.details.steps.length, 2);
  assert.equal(client.calls.open.length, 1);
  const first = client.calls.open[0];
  assert.equal(first.chain.index, 0);
  assert.equal(first.chain.total, 2);
  assert.equal(first.role, 'scout');
  assert.equal(first.model, 'opencode-go/scout-model', 'the role pins the model');
  assert.equal(first.thinking, 'low');
  assert.equal(first.tools, 'read,grep');
  assert.match(first.task, /^Complete step 1 of 2/);

  await turn(join(h.root, started.details.first), 'auth lives in src/auth.ts');
  assert.equal(h.boundary(), undefined, 'an intermediate step reports nothing to the parent');
  await until(() => client.calls.open.length === 2, 'the second step to launch');
  const second = client.calls.open[1];
  assert.equal(second.chain.index, 1);
  assert.equal(second.role, 'worker');
  assert.equal(second.model, 'opencode-go/worker-model');
  assert.match(second.task, /# Overall task\n\nMap the auth module/);
  assert.match(second.task, /# Report from step 1 \(scout\)\n\nauth lives in src\/auth\.ts/);
  assert.match(second.task, /# Your step\n\nAdd the missing test/);

  const rows = (await h.call('rex_tasks', {})).details;
  assert.equal(rows.length, 2, 'both steps are tracked while the chain runs');
  const worker = rows.find(row => String(row.name).startsWith('worker'));
  assert.ok(worker, 'the second step is tracked as the worker step');
  await turn(join(h.root, worker.id), 'test added, suite green');

  let message;
  await until(() => { const value = h.boundary(); if (value) message = value.entries.at(-1); return Boolean(value); }, 'the combined report');
  assert.match(message.content, /Rex pipeline auth \(.*\): completed; steps=2/);
  assert.match(message.content, /Final report \(worker\):\ntest added, suite green/);
  assert.equal(message.details.receipts.length, 1, 'one message for the whole chain');
  // `finish` validates the handoff and then closes the block, so Rex sees a close.
  await until(() => client.calls.control.length === 2, 'completed panes to close');
  assert.deepEqual(client.calls.control.map(call => call.action), ['close', 'close']);
  // Closed tasks stay in history; they must report terminal states, not linger as running.
  await until(async () => (await h.call('rex_tasks', {})).details
    .every(row => row.taskState === 'completed' && row.blockState === 'closed'), 'both steps to close');
});

test('a failing step stops the chain, keeps its pane and reports where it stopped', async t => {
  const client = fakeRex();
  const h = await fixture(t, client);
  const started = await h.call('pipeline', { steps: [
    { agent: 'scout', task: 'Map it', label: 'Map it' },
    { agent: 'worker', task: 'Change it', label: 'Change it' },
  ] });
  await turn(join(h.root, started.details.first), 'could not find the module', 'failed');
  let message;
  await until(() => { const value = h.boundary(); if (value) message = value.entries.at(-1); return Boolean(value); }, 'the failed chain report');
  assert.match(message.content, /Rex pipeline .*: failed/);
  assert.match(message.content, /Failing step report \(scout\)/);
  assert.match(message.content, /could not find the module/);
  assert.match(message.content, /still open for inspection/);
  assert.equal(client.calls.open.length, 1, 'no later step is launched after a failure');
  assert.equal(client.calls.control.length, 0, 'the failing pane stays open');
});

test('a pipeline rejects too many steps and unknown roles before launching anything', async t => {
  const client = fakeRex();
  const h = await fixture(t, client);
  const error = async params => JSON.parse((await h.call('pipeline', params)).content[0].text).error;
  assert.match(await error({ steps: Array.from({ length: MAX_STEPS + 1 }, () => ({ task: 'x', label: 'x' })) }), new RegExp(`at most ${MAX_STEPS}`));
  assert.match(await error({ steps: [{ agent: 'nobody', task: 'x', label: 'x' }] }), /Unknown agent role "nobody" in step 1/);
  assert.match(await error({ steps: [] }), /at least one step/);
  assert.match(await error({ steps: [{ agent: 'scout' }] }), /Step 1 needs a task/);
  assert.match(await error({ steps: [{ agent: 'scout', task: 'x' }, { agent: 'worker', task: 'y' }] }), /Step 1: label is required/);
  assert.match(await error({ steps: [{ agent: 'scout', task: 'x', label: 'Map it' },
    { agent: 'worker', task: 'y', label: 'one two three four five six seven' }] }), /Step 2: label must be 6 words or fewer, got 7/);
  assert.equal(client.calls.open.length, 0, 'validation happens before any pane exists');
});

test('a step whose pane closes without a report fails the chain instead of stalling it', async t => {
  const client = fakeRex();
  const h = await fixture(t, client);
  const started = await h.call('pipeline', { steps: [
    { agent: 'scout', task: 'Map it', label: 'Map it' },
    { agent: 'worker', task: 'Change it', label: 'Change it' },
  ] });
  const dir = join(h.root, started.details.first);
  const run = JSON.parse(await readFile(join(dir, 'run.json'), 'utf8'));
  await atomicJson(join(dir, 'run.json'), { ...run, closed: true });
  let message;
  await until(() => { const value = h.boundary(); if (value) message = value.entries.at(-1); return Boolean(value); }, 'the stalled chain to report');
  assert.match(message.content, /: failed/);
  assert.match(message.content, /Failing step report \(scout\):\nThe step ended without a report \(pane closed\)/);
  assert.equal(client.calls.open.length, 1, 'the chain stops instead of starting the next step');
});

test('a failed first launch leaves a terminal chain, not a running one', async t => {
  const client = fakeRex();
  // Launch throws for reasons of its own (no Rex environment, placement failure,
  // duplicate name); a failed create is caught inside launch and returns 'uncertain'.
  const saved = [process.env.REX_SESSION, process.env.REX_BLOCK];
  delete process.env.REX_SESSION; delete process.env.REX_BLOCK;
  t.after(() => { if (saved[0] !== undefined) process.env.REX_SESSION = saved[0]; if (saved[1] !== undefined) process.env.REX_BLOCK = saved[1]; });
  const h = await fixture(t, client);
  const failed = await h.call('pipeline', { steps: [
    { agent: 'scout', task: 'Map it', label: 'Map it' }, { agent: 'worker', task: 'Change it', label: 'Change it' }] });
  assert.match(failed.content[0].text, /Start Pi inside Rex/);
  assert.equal(failed.isError, true);
  const chains = await readdir(join(h.root)).catch(() => []);
  const chainFile = (await Promise.all(chains.map(async name => {
    const path = join(h.root, name, 'chain.json');
    return readFile(path, 'utf8').then(text => ({ path, text }), () => undefined);
  }))).find(Boolean);
  const chain = JSON.parse(chainFile.text);
  assert.equal(chain.status, 'failed');
  assert.equal(chain.steps[0].status, 'failed');
  assert.match(chain.steps[0].error, /Start Pi inside Rex/);
  assert.equal(h.boundary(), undefined, 'the tool call already reported the failure');
});

test('a launch with only REX_BLOCK takes the session rex reports for the pane', async t => {
  const client = fakeRex();
  const saved = [process.env.REX_SESSION, process.env.REX_BLOCK];
  delete process.env.REX_SESSION;
  process.env.REX_BLOCK = 'block:parent';
  t.after(() => { if (saved[0] !== undefined) process.env.REX_SESSION = saved[0]; if (saved[1] !== undefined) process.env.REX_BLOCK = saved[1]; });
  const h = await fixture(t, client);
  const response = await h.call('subagent', { task: 'Map the auth flow', label: 'Map the auth flow', name: 'auth-research' });
  const result = JSON.parse(response.content[0].text);
  assert.equal(result.status, 'running', 'the launch is not refused for want of REX_SESSION');
  const record = JSON.parse(await readFile(join(h.root, response.details.id, 'run.json'), 'utf8'));
  assert.equal(record.rexSession, 'session:parent', 'later commands target the session that holds the pane');
  assert.equal(record.anchor, 'block:parent');
});

test('a step line marks a cut sentence and does not repeat the state as a reason', () => {
  const long = 'The step never reported: its launch was never verified, so there was nothing to observe at all, and this sentence keeps going well past the excerpt budget of one hundred and sixty characters to prove the cut.';
  const chain = { id: 'c', title: 't', status: 'failed', steps: [
    { index: 0, agent: 'scout', status: 'failed', runId: 'r1', text: long, error: 'failed' },
    { index: 1, agent: 'scout', status: 'pending' },
  ] };
  const lines = chainSummary(chain, { artifacts: '/tmp/c' }).split('\n');
  assert.match(lines[1], /…$/, 'a truncated excerpt says it was cut');
  assert.doesNotMatch(lines[1], / — failed$/, 'the state word is not repeated as the reason');
  assert.ok(lines[1].length < 260, `line stayed bounded: ${lines[1].length}`);

  chain.steps[0].error = 'Operation aborted';
  assert.match(chainSummary(chain, { artifacts: '/tmp/c' }).split('\n')[1], / — Operation aborted$/,
    'a reason that is not the state word is still shown');
});

test('a launch name is two words, so a tab title stays a strip and not a sentence', async t => {
  const client = fakeRex();
  const h = await fixture(t, client);
  const error = async params => JSON.parse((await h.call('subagent', params)).content[0].text).error;
  assert.match(await error({ task: 'Review the change', label: 'Review plan vs code', name: 'map the auth flow' }),
    /name must be 2 words or fewer, got 4/);
  assert.equal(client.calls.open.length, 0, 'a rejected name never opens a pane');
  const named = await h.call('subagent', { task: 'Review the change', label: 'Review plan vs code', name: 'auth-research' });
  const record = JSON.parse(await readFile(join(h.root, named.details.id, 'run.json'), 'utf8'));
  assert.equal(record.name, 'auth-research');
  assert.equal(record.named, true, 'a name the caller wrote is worth showing beside the goal');
});

test('a name a live pane carries is taken until that pane closes', async t => {
  const client = fakeRex();
  const h = await fixture(t, client);
  const launch = params => h.call('subagent', params).then(r => JSON.parse(r.content[0].text));

  const first = await launch({ task: 'Map the auth flow', label: 'Map the auth flow', name: 'auth-research' });
  assert.equal(first.status, 'running');

  const taken = await launch({ task: 'Map the session schema', label: 'Map session schema', name: 'auth-research' });
  assert.match(taken.error, /name "auth-research" is already carried by live/);
  assert.equal(client.calls.open.length, 1, 'a taken name never opens a second pane');

  const other = await launch({ task: 'Map the session schema', label: 'Map session schema', name: 'auth-schema' });
  assert.equal(other.status, 'running', 'a different name is free while the first runs');

  // Closing is what frees the handle: a closed pane is not a place to look for.
  await h.call('rex_control', { id: first.id, action: 'close' });
  await h.boundary();
  await until(async () => !(await launch({ task: 'Map the auth flow', label: 'Map auth again', name: 'auth-research' })).error,
    'the closed name to be free again');
});

test('a side conversation is exempt from the name a live task holds', async t => {
  const client = fakeRex();
  const h = await fixture(t, client);
  const launch = (tool, params) => h.call(tool, params).then(r => JSON.parse(r.content[0].text));

  const task = await launch('subagent', { task: 'Map the auth flow', label: 'Map the auth flow', name: 'auth-research' });
  assert.equal(task.status, 'running');

  // btw is one reused pane, not a task you compare against, so the handle it
  // shares with a live task is not a collision.
  const aside = await launch('btw', { task: 'What does the name rule protect?', name: 'auth-research' });
  assert.equal(aside.error, undefined, 'a side conversation is never refused a name');
  assert.equal(aside.status, 'running');

  // And it does not take the handle either: a task may still claim it after.
  const other = await launch('subagent', { task: 'Map the session schema', label: 'Map session schema', name: 'auth-schema' });
  assert.equal(other.status, 'running');
  assert.equal(client.calls.open.length, 3);
});
