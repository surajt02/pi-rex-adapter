import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import adapter from '../src/index.mjs';
import { prepareRun, atomicJson, readJson } from '../src/core.mjs';
import { overviewLines, buildGroups, fit, focusTarget, orderRows, activeOverviewRows, visibleRows, rowLabel, MAX_ROWS, FRAME_MS } from '../src/overview.mjs';
import { measure } from '../src/columns.mjs';

async function fixture(t, control) {
  const dir = await mkdtemp(join(tmpdir(), 'rex-overview-'));
  const events = {}, commands = {}, tools = {}, entries = [], widgets = [], messages = [], calls = [];
  const ctx = { cwd: dir, hasUI: true, isIdle: () => false,
    sessionManager: { getSessionDir: () => dir, getSessionId: () => 'parent', getEntries: () => entries },
    ui: { setWidget: (...args) => widgets.push(args), setStatus() {}, notify() {} },
  };
  adapter({ on: (name, handler) => { events[name] = handler; }, registerCommand: (name, command) => { commands[name] = command; },
    registerTool: tool => { tools[tool.name] = tool; },
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
    sendMessage: message => { messages.push(message); entries.push({ type: 'custom_message', ...message }); },
  }, { cleanupRetryMs: 100, rex: {
    control: async (...args) => { calls.push(args); return control?.(...args); },
    inspect: async () => ({ window: 'window' }),
    // The app has to be asked to show the pane's window, not only the server.
    view: async () => ({ windows: [{ window_id: 'window', layers: [{ kind: 'tiled',
      blocks: ['agent-block', 'shell-block'].map(block_id => ({ block_id })) }] }] }),
    reveal: async (...args) => { calls.push(['reveal', ...args]); return true; },
  } });
  const root = join(dir, 'rex-adapter', 'parent');
  const boundary = () => events.turn_end({ entries: [], context: { canContinue: true }, outcome: 'completed' }, ctx);
  t.after(async () => { events.session_shutdown(); await rm(dir, { recursive: true, force: true }); });
  return { dir, root, events, commands, tools, entries, widgets, messages, calls, ctx, boundary };
}
async function until(predicate) {
  for (let i = 0; i < 400; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 10)); }
  assert.fail('Timed out');
}
function driveOverlays(ctx, scripts) {
  // Inline panels only: no overlay options, exactly as the extension opens them.
  ctx.ui.custom = async (factory, options) => {
    assert.equal(options, undefined);
    let result;
    const component = factory({ terminal: { rows: 24 }, requestRender() {} }, {},
      { matches: (data, key) => data === key }, value => { result = value; });
    component.render(100);
    const script = scripts.shift() || ['cancel'];
    if (typeof script === 'function') script(component);
    else for (const key of script) component.handleInput(`tui.select.${key}`);
    return result;
  };
}
async function task(root, kind, status = 'completed') {
  const run = await prepareRun(root, { kind, name: `${kind}-test`, task: `${kind} delegated task`, cwd: root, block: `${kind}-block` }, '');
  await atomicJson(join(run.dir, 'result.json'), { text: 'result text', status });
  if (kind === 'shell') await atomicJson(join(run.dir, 'exit.json'), { code: status === 'completed' ? 0 : 7 });
  else await atomicJson(join(run.dir, 'activity.json'), { task: status, process: status === 'running' ? 'running' : 'idle' });
  return run;
}

test('main-page widget shows active agents and shell tasks only; can hide and restore across reload', async t => {
  const h = await fixture(t);
  for (const kind of ['agent', 'shell', 'btw']) {
    const run = await task(h.root, kind, 'running');
    if (kind === 'shell') {
      await rm(join(run.dir, 'exit.json'));
      await atomicJson(join(run.dir, 'activity.json'), { task: 'running', process: 'running' });
    }
  }
  await h.events.session_start({}, h.ctx); await h.boundary();
  const widget = h.widgets.at(-1);
  // The slot's default placement; WIDGET_ORDER decides where in it the rows sit.
  assert.equal(widget[2], undefined);
  assert.ok(globalThis[Symbol.for('pi:above-editor-widgets')].has('rex-tasks'));
  const lines = widget[1]().render(120).join('\n');
  for (const kind of ['agent', 'shell']) assert.match(lines, new RegExp(`${kind} delegated task`));
  assert.doesNotMatch(lines, /BTW|btw delegated|Pi idle|Closed/);
  assert.equal(widget[1]().render(120).length, 2);
  driveOverlays(h.ctx, [['confirm'], ['cancel']]);
  await h.commands['rex-tasks'].handler('', h.ctx);
  assert.equal(h.widgets.at(-1)?.[1], undefined);
  await h.events.session_start({}, h.ctx); await h.boundary();
  assert.equal(h.widgets.at(-1)?.[1], undefined);
  driveOverlays(h.ctx, [['confirm'], ['cancel']]);
  await h.commands['rex-tasks'].handler('', h.ctx);
  assert.equal(typeof h.widgets.at(-1)[1], 'function');
  h.events.session_shutdown(); assert.equal(h.widgets.at(-1)?.[1], undefined);
});

for (const status of ['completed', 'failed']) test(`shell ${status}: close only after its result is persisted, retain outcome and records`, async t => {
  const h = await fixture(t), run = await task(h.root, 'shell', status);
  await h.events.session_start({}, h.ctx);
  const batch = await h.boundary();
  assert.equal(h.calls.length, 0);
  h.entries.push(...batch.entries);
  await h.boundary();
  await until(async () => (await readJson(join(run.dir, 'run.json')))?.closed);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0][1], 'close');
  assert.equal((await readJson(join(run.dir, 'run.json'))).closed, true);
  assert.equal((await readJson(join(run.dir, 'result.json'))).status, status);
  await h.boundary(); assert.equal(h.calls.length, 1);
});

test('agent remains open after delivery; main agent can finish only when completed and idle', async t => {
  const h = await fixture(t), run = await task(h.root, 'agent');
  await atomicJson(join(run.dir, 'turn-1.json'), { text: 'done', status: 'completed' });
  await h.events.session_start({}, h.ctx);
  const batch = await h.boundary();
  assert.match(batch.entries[0].content, /rex_finish/);
  assert.match(batch.entries[0].content, /promptly call rex_finish/);
  assert.match(batch.entries[0].content, /Closing retains its files, result, and session records/);
  assert.match(batch.entries[0].content, /unless you need another turn/);
  h.entries.push(...batch.entries); await h.boundary();
  assert.equal(h.calls.length, 0);
  const finish = () => h.tools.rex_finish.execute('x', { id: run.id }, undefined, undefined, h.ctx);
  await atomicJson(join(run.dir, 'activity.json'), { task: 'running', process: 'running' });
  assert.equal((await finish()).isError, true); assert.equal(h.calls.length, 0);
  await atomicJson(join(run.dir, 'activity.json'), { task: 'completed', process: 'idle' });
  assert.equal((await finish()).isError, undefined); assert.equal(h.calls.length, 1);
  await finish(); assert.equal(h.calls.length, 1);
  const row = (await h.tools.rex_tasks.execute('x', {}, undefined, undefined, h.ctx)).details[0];
  assert.equal(row.taskState, 'completed'); assert.equal(row.blockState, 'closed');
});

for (const language of ['en', 'zh']) test(`agent overlay uses durable latest-turn receipts, survives reload and keeps lifecycle unchanged (${language})`, async t => {
  const h = await fixture(t), run = await task(h.root, 'agent');
  await mkdir(join(h.dir, '.pi'));
  await atomicJson(join(h.dir, '.pi', 'rex.json'), { language });
  const report = { text: 'same answer', status: 'completed', sequence: 1, createdAt: '2026-01-01T00:00:00.001Z' };
  await atomicJson(join(run.dir, 'result.json'), report);
  await atomicJson(join(run.dir, 'turn-first.json'), report);
  await h.events.session_start({}, h.ctx);
  const pending = language === 'en' ? /Completed · awaiting delivery/ : /已完成 · 待回传/;
  const delivered = language === 'en' ? /Delivered · awaiting close/ : /已回传 · 待关闭/;
  async function screen(scripts = [['cancel']]) {
    const screens = [];
    driveOverlays(h.ctx, scripts.map(keys => component => {
      screens.push(component.render(100).join('\n'));
      for (const key of keys) component.handleInput(`tui.select.${key}`);
    }));
    await h.commands['rex-tasks'].handler('', h.ctx);
    return screens.join('\n');
  }
  assert.match(await screen(), pending);
  const batch = h.boundary(); // Queued at a boundary, but not persisted yet.
  assert.match(await screen(), pending);
  assert.equal(h.calls.length, 0);
  h.entries.push(...batch.entries);
  const received = await screen([['down', 'confirm'], ['confirm'], ['cancel'], ['cancel'], ['cancel']]);
  assert.match(received, delivered);
  assert.match(received, language === 'en' ? /review is not confirmed/ : /不代表已审核/);
  assert.doesNotMatch(received, pending);
  await h.events.session_start({}, h.ctx);
  assert.match(await screen(), delivered);

  // Same answer on a new turn is still a new delivery, including the brief
  // interval between writing result.json and publishing its turn file.
  const next = { ...report, sequence: 2, createdAt: '2026-01-01T00:00:00.002Z' };
  await atomicJson(join(run.dir, 'result.json'), next);
  assert.match(await screen(), pending);
  await atomicJson(join(run.dir, 'turn-second.json'), next);
  assert.match(await screen(), pending);
  h.entries.push({ type: 'custom_message', customType: 'rex_result', details: { receipts: [`${run.id}/turn-second.json`] } });
  assert.match(await screen(), delivered);
  assert.equal(h.calls.length, 0); assert.equal(h.messages.length, 0);
  // Completed but still open: visible, because the pane is what the reader inspects.
  assert.equal(typeof h.widgets?.at(-1)?.[1], 'function');

  await atomicJson(join(run.dir, 'activity.json'), { task: 'running', process: 'running' });
  const running = await screen();
  assert.doesNotMatch(running, pending); assert.doesNotMatch(running, delivered);
  await atomicJson(join(run.dir, 'activity.json'), { task: 'completed', process: 'idle' });
  assert.equal((await h.tools.rex_finish.execute('finish', { id: run.id }, undefined, undefined, h.ctx)).isError, undefined);
  const closed = await screen();
  assert.match(closed, language === 'en' ? /Closed/ : /已关闭/);
  assert.doesNotMatch(closed, pending); assert.doesNotMatch(closed, delivered);
  assert.equal(h.calls.length, 1);
});

test('BTW and failed tasks never acquire a delivery/close label', async t => {
  const h = await fixture(t);
  const btw = await task(h.root, 'btw'), failed = await task(h.root, 'agent', 'failed');
  for (const run of [btw, failed]) h.entries.push({ type: 'custom_message', customType: 'rex_result', details: { receipt: `${run.id}/result.json` } });
  await h.events.session_start({}, h.ctx);
  let screen;
  driveOverlays(h.ctx, [component => { screen = component.render(100).join('\n'); component.handleInput('tui.select.cancel'); }]);
  await h.commands['rex-tasks'].handler('', h.ctx);
  assert.match(screen, /BTW/); assert.match(screen, /Failed/);
  assert.doesNotMatch(screen, /awaiting delivery|awaiting close/);
  assert.equal(h.calls.length, 0);
});

test('finish rejects BTW, promoted sessions and failed subagents', async t => {
  const h = await fixture(t);
  const btw = await task(h.root, 'btw'), failed = await task(h.root, 'agent', 'failed'),
    session = await task(h.root, 'session', 'completed');
  await h.events.session_start({}, h.ctx);
  for (const run of [btw, failed, session]) {
    const result = await h.tools.rex_finish.execute('x', { id: run.id }, undefined, undefined, h.ctx);
    assert.equal(result.isError, true);
  }
  assert.equal(h.calls.length, 0);
});

test('automatic shell close failure keeps the terminal and result; subsequent reconciliation retries', async t => {
  let attempts = 0;
  const h = await fixture(t, () => { if (++attempts === 1) throw new Error('Rex unavailable'); });
  const run = await task(h.root, 'shell');
  await h.events.session_start({}, h.ctx);
  const batch = await h.boundary(); h.entries.push(...batch.entries);
  await h.boundary();
  await until(() => attempts === 1);
  assert.equal((await readJson(join(run.dir, 'run.json'))).closed, undefined);
  assert.equal(typeof h.widgets.at(-1)?.[1], 'function'); // Open pane, so still listed.
  await until(async () => { await h.boundary(); return (await readJson(join(run.dir, 'run.json')))?.closed; });
  assert.equal(attempts, 2);
});

test('overview is bounded, prioritizes active tasks, and sanitizes terminal control input', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ id: `id-${i}`, name: `name-${i}`, kind: 'agent',
    label: 'Task ' + i, task: '\x1b[31m中文任务\nnext\x1b]0;title\x07', closed: false, taskState: 'running',
    processState: i === 8 ? 'running' : 'exited', createdAt: '2026-01-01T00:00:00Z' }));
  assert.equal(orderRows(rows).length, 12);
  const lines = overviewLines(rows, 40);
  assert.equal(lines.length, MAX_ROWS);
  assert.ok(lines.every(line => !/[\x00-\x1f\x7f]/.test(line)));
  assert.match(lines.at(-1), /3 more · \/rex-tasks for all/);
  assert.equal(fit('中文中文', 5), '中文…');
  assert.equal(fit('abc', 0), '');
});

const past = seconds => new Date(Date.now() - seconds * 1000).toISOString();
function scenario() {
  const chain = { id: 'chain-1' };
  const rows = [
    { id: 's1', kind: 'agent', name: 'scout 1/3 · reload safety', role: 'scout', label: 'Read chain persistence',
      taskState: 'completed', createdAt: past(67), endedAt: past(0), tokens: 8600, closed: false, chain: { ...chain, index: 0, total: 3, title: 'reload safety' } },
    { id: 's2', kind: 'agent', name: 'planner 2/3', role: 'planner', label: 'Plan reload recovery',
      taskState: 'running', createdAt: past(372), tokens: 12400, closed: false, chain: { ...chain, index: 1, total: 3, title: 'reload safety' } },
    { id: 'l1', kind: 'agent', name: 'researcher', role: 'researcher', label: 'Research reload semantics',
      taskState: 'running', createdAt: past(161), tokens: 5200, closed: false },
    { id: 'l2', kind: 'agent', name: 'probe-hang', role: 'worker', label: 'Write probe script',
      taskState: 'interrupted', createdAt: past(41), endedAt: past(0), tokens: 3100, closed: false },
  ];
  const chains = new Map([['chain-1', { id: 'chain-1', title: 'reload safety', status: 'running', steps: [
    { index: 0, agent: 'scout', label: 'Read chain persistence', status: 'completed', runId: 's1' },
    { index: 1, agent: 'planner', label: 'Plan reload recovery', status: 'running', runId: 's2' },
    { index: 2, agent: 'reviewer', label: 'Review plan vs code', status: 'pending' }] }]]);
  return { rows, chains };
}

test('a pipeline renders as one ◆ block of ├/└ steps; loose rows keep a blank gutter', () => {
  const { rows, chains } = scenario();
  const lines = overviewLines(rows, 126, undefined, 'en', chains);
  assert.match(lines[0], /^   ◆ reload safety · 1\/3$/);
  assert.match(lines[1], /^   ├ ● scout /);
  assert.match(lines[2], /^   ├ [·✢✳✶✻✽] planner /);
  assert.match(lines[3], /^   └ ○ reviewer /);      // a not-yet-launched step still shows
  assert.match(lines[4], /^   [·✢✳✶✻✽] researcher /);
  assert.match(lines[5], /^   ● worker /);
  assert.equal(lines.length, 6);
});

test('a step a failed chain never reached reads as skipped, not as waiting', () => {
  const { rows, chains } = scenario();
  // Same rows, but the chain stopped at step 2: step 3 was never launched.
  const failed = new Map([['chain-1', { ...chains.get('chain-1'), status: 'failed', steps: [
    ...chains.get('chain-1').steps.slice(0, 2), { index: 2, agent: 'reviewer', label: 'Review plan vs code', status: 'pending' }] }]]);
  const group = buildGroups(rows, failed).groups[0];
  assert.deepEqual(group.steps.map(step => step.state), ['completed', 'running', 'skipped']);
  const lines = overviewLines(rows, 126, undefined, 'en', failed);
  assert.match(lines[3], /^   └ ○ reviewer /, 'a skipped step still occupies its row');
});

test('the running glyph is the same dot cycle the rest of the UI spins', () => {
  const frames = ['·', '✢', '✳', '✶', '✻', '✽', '✽', '✻', '✶', '✳', '✢', '·'];
  const row = { id: 'a', kind: 'agent', role: 'scout', label: 'Read chain persistence', taskState: 'running',
    createdAt: past(9), closed: false };
  // Align the clock to a cycle boundary so frame 0 is really the first frame.
  const real = Date.now, cycle = FRAME_MS * frames.length, base = Math.floor(1_000_000 / cycle) * cycle;
  try {
    const seen = frames.map((expected, index) => {
      Date.now = () => base + index * FRAME_MS;
      const line = overviewLines([row], 60);
      assert.equal(line[0].slice(3, 4), expected, `frame ${index}`);
      return expected;
    });
    assert.equal(new Set(seen).size, 6, 'the cycle passes through six glyphs, not ten braille frames');
  } finally { Date.now = real; }
  assert.equal(FRAME_MS, 170, 'cadence matches the UI spinner, so both tick together');
});

test('label column is shared by grouped and loose rows while the stats stay flush right', () => {
  const { rows, chains } = scenario();
  for (const width of [126, 80, 62]) {
    const lines = overviewLines(rows, width, undefined, 'en', chains);
    for (const line of lines.slice(1)) assert.equal(measure(line), width, `width ${width}: ${line}`);
    assert.ok(measure(lines[0]) <= width);
    const labelled = lines.slice(1).filter(line => !/○ reviewer/.test(line));
    const offsets = labelled.map(line => measure(line.slice(0, line.search(/Read chain|Plan reload|Research reload|Write probe/))));
    assert.deepEqual(new Set(offsets).size, 1, `label offsets differ: ${offsets}`);
    const arrows = lines.slice(1).filter(line => line.includes('↓')).map(line => measure(line.slice(0, line.indexOf('↓'))));
    assert.equal(new Set(arrows).size, 1, `stats columns differ: ${arrows}`);
    const tokenEnds = lines.slice(1).filter(line => line.includes('tokens')).map(line => line.length);
    assert.equal(new Set(tokenEnds).size, 1);
  }
});

test('alignment survives colour, the defect that made a red row slide one column left', () => {
  const { rows, chains } = scenario();
  const theme = { fg: (token, text) => `\x1b[38;5;${token === 'error' ? '167m' : '35m'}${text}\x1b[0m` };
  const lines = overviewLines(rows, 90, theme, 'en', chains);
  for (const line of lines.slice(1)) assert.equal(measure(line), 90);
  const arrows = lines.slice(1).filter(line => line.includes('↓')).map(line => measure(line.slice(0, line.indexOf('↓'))));
  assert.equal(new Set(arrows).size, 1);
});

test('panel maps selected task to owned full ID and rejects actions after session switch', async t => {
  const h = await fixture(t); await task(h.root, 'agent');
  await h.events.session_start({}, h.ctx); await h.boundary();
  driveOverlays(h.ctx, [['down', 'confirm'], component => {
    h.events.session_shutdown(); component.handleInput('tui.select.confirm');
  }]);
  await h.commands['rex-tasks'].handler('', h.ctx);
  assert.equal(h.calls.length, 0);
});


test('an open pane stays listed whatever its state; closed panes and BTW never are', () => {
  const rows = ['completed', 'failed', 'interrupted', 'cancelled', 'exited'].map((taskState, i) => ({
    id: `${i}`, kind: 'agent', taskState, closed: false, label: `Task ${i}`, createdAt: past(i),
  }));
  rows.push({ id: 'btw', kind: 'btw', taskState: 'running' }, { id: 'closed', kind: 'shell', taskState: 'running', closed: true },
    { id: 'session', kind: 'session', taskState: 'running', name: 'aside', closed: false });
  // Only running work counts as active for the status line; a promoted session is
  // a conversation, never work...
  assert.deepEqual(activeOverviewRows(rows), []);
  // ...but the list is the set of panes still open for inspection, and a promoted
  // session is a conversation the reader drives, so it keeps out of the widget and
  // is found in /rex-tasks instead.
  assert.deepEqual(visibleRows(rows).map(row => row.id).sort(), ['0', '1', '2', '3', '4']);
  assert.equal(visibleRows(rows)[0].id, '1'); // a failed pane outranks completed ones
  assert.equal(overviewLines(rows, 80).length, 5);
  assert.deepEqual(visibleRows([rows[5]]), []);
  assert.deepEqual(overviewLines([rows[5]], 80), []);
  assert.deepEqual(visibleRows([rows[7]]), []);
  assert.deepEqual(overviewLines([rows[7]], 80), []);
  assert.match(rowLabel(rows[7]), /^\[Session\] aside · Running/);
});

test('widget survives completion and disappears only when the pane closes', async t => {
  const h = await fixture(t), run = await task(h.root, 'agent', 'running');
  await h.events.session_start({}, h.ctx); await h.boundary();
  assert.equal(typeof h.widgets.at(-1)[1], 'function');
  await atomicJson(join(run.dir, 'result.json'), { text: 'done', status: 'completed' });
  await atomicJson(join(run.dir, 'activity.json'), { task: 'completed', process: 'idle' });
  await h.boundary();
  // Completed but still open: it is exactly what the reader must be able to finish.
  assert.equal(typeof h.widgets.at(-1)[1], 'function');
  assert.match(h.widgets.at(-1)[1]().render(80).join('\n'), /agent-test/);
  await h.tools.rex_finish.execute('x', { id: run.id }, undefined, undefined, h.ctx);
  await h.boundary();
  await until(() => h.widgets.at(-1)[1] === undefined);
  const history = await h.tools.rex_tasks.execute('x', {}, undefined, undefined, h.ctx);
  assert.equal(history.details.length, 1);
  assert.equal(history.details[0].taskState, 'completed');
});

test('theme paints the chain marker slate blue, roles muted and stats dim, with no rules or heading', () => {
  const tokens = [];
  const theme = { fg: (token, text) => { tokens.push(token); return `<${{}}${token}>${text}`; }, style: (text, options) => { tokens.push(options.fg); return text; } };
  const { rows, chains } = scenario();
  const lines = overviewLines(rows, 80, theme, 'en', chains);
  assert.doesNotMatch(lines.join(''), /Rex Tasks|─{10}/);
  assert.match(lines[0], /◆ reload safety/);
  assert.ok(tokens.some(token => token?.kind === 'rgb' && token.r === 126 && token.g === 152 && token.b === 173));
  assert.ok(tokens.includes('muted')); assert.ok(tokens.includes('dim')); assert.ok(tokens.includes('accent'));
  assert.ok(tokens.includes('success')); assert.ok(!tokens.includes('warning'));
});

test('task list and details stay in inline panels, with no notification or transcript dump', async t => {
  const h = await fixture(t); await task(h.root, 'agent');
  await h.events.session_start({}, h.ctx); await h.boundary();
  let notices = 0;
  h.ctx.ui.notify = () => { notices++; };
  driveOverlays(h.ctx, [['down', 'confirm'], ['confirm'], ['cancel'], ['cancel']]);
  await h.commands['rex-tasks'].handler('', h.ctx);
  assert.equal(notices, 0); assert.equal(h.messages.length, 0);
  assert.deepEqual(Object.keys(h.commands).sort(), ['bg', 'btw', 'rex-agent', 'rex-tasks']);
});

test('only rows that name a pane are clickable: the chain heading and unstarted steps are not', () => {
  const { rows, chains } = scenario();
  for (const row of rows) row.block = `block:${row.id}`;
  const hits = [];
  const lines = overviewLines(rows, 126, undefined, 'en', chains, hits);
  assert.equal(lines.length, 6);
  // Step 3 is still pending, so it has no pane and no hit: the reader cannot be
  // sent to a pane that does not exist yet.
  assert.deepEqual(hits, [{ y: 1, id: 's1' }, { y: 2, id: 's2' }, { y: 4, id: 'l1' }, { y: 5, id: 'l2' }]);
  assert.equal(hits.some(hit => hit.y === 0), false, 'the ◆ heading is a heading, not a pane');
  assert.equal(focusTarget({ id: 'x', block: 'block:x' }, 'skipped'), undefined);
  assert.equal(focusTarget({ id: 'y', block: 'block:y' }, 'queued'), undefined);
  assert.equal(focusTarget({ id: 'z' }, 'running'), undefined, 'a run without a block has nowhere to go');
  assert.equal(focusTarget({ id: 'c', block: 'block:c', closed: true }, 'completed'), undefined);
  assert.equal(focusTarget({ id: 'd', block: 'block:d' }, 'running'), 'd');
});

test('a click on a row focuses that pane; a press alone, a right-click, and empty rows do nothing', async t => {
  const h = await fixture(t), run = await task(h.root, 'agent', 'running');
  await h.events.session_start({}, h.ctx); await h.boundary();
  const component = h.widgets.at(-1)[1]({ requestRender() {}, terminal: { rows: 24 } }, {});
  const lines = component.render(100);
  assert.equal(lines.length, 1);
  const event = extra => ({ button: 'left', x: 5, width: 100, height: lines.length, ...extra });
  // Pi synthesizes a click only when the press was claimed, so the press must be
  // handled without acting, and the click is the one action.
  assert.deepEqual(component.handleMouse(event({ type: 'press', y: 0 })), { handled: true });
  assert.equal(h.calls.length, 0, 'claiming the press does not move focus');
  assert.deepEqual(component.handleMouse(event({ type: 'click', y: 0 })), { handled: true, render: true });
  await until(() => h.calls.some(call => call[1] === 'focus'));
  const focused = h.calls.filter(call => call[1] === 'focus');
  assert.equal(focused[0][0].block, run.block);
  assert.equal(component.handleMouse(event({ type: 'click', y: 0, button: 'right' })), undefined);
  assert.equal(component.handleMouse(event({ type: 'press', y: 1 })), undefined, 'below the last row is not ours');
});

test('a click asks the app to show the pane\'s tab, then focuses it', async t => {
  const h = await fixture(t), run = await task(h.root, 'agent', 'running');
  await h.events.session_start({}, h.ctx); await h.boundary();
  const component = h.widgets.at(-1)[1]({ requestRender() {}, terminal: { rows: 24 } }, {});
  component.render(100);
  component.handleMouse({ type: 'press', button: 'left', x: 5, y: 0, width: 100, height: 1 });
  component.handleMouse({ type: 'click', button: 'left', x: 5, y: 0, width: 100, height: 1 });
  await until(() => h.calls.some(call => call[1] === 'focus'));
  const reveal = h.calls.findIndex(call => call[0] === 'reveal');
  const focus = h.calls.findIndex(call => call[1] === 'focus');
  assert.ok(reveal >= 0 && reveal < focus, `reveal must come before focus: ${JSON.stringify(h.calls)}`);
  // The fixture's runs carry no rex session, so only the window matters here.
  assert.equal(h.calls[reveal][0], 'reveal');
  assert.equal(h.calls[reveal][2], 'window');
  assert.equal(h.calls[focus][0].block, run.block);
});

test('each row keeps its own target, so a click lands on the row under the cursor', async t => {
  const h = await fixture(t);
  const first = await task(h.root, 'agent', 'running');
  const second = await task(h.root, 'shell', 'running');
  await rm(join(second.dir, 'exit.json'));
  await atomicJson(join(second.dir, 'activity.json'), { task: 'running', process: 'running' });
  await h.events.session_start({}, h.ctx); await h.boundary();
  const component = h.widgets.at(-1)[1]({ requestRender() {}, terminal: { rows: 24 } }, {});
  const lines = component.render(100);
  assert.equal(lines.length, 2);
  const click = y => component.handleMouse({ type: 'click', button: 'left', x: 5, y, width: 100, height: lines.length });
  click(0); click(1);
  await until(() => h.calls.filter(call => call[1] === 'focus').length >= 2);
  const focused = h.calls.filter(call => call[1] === 'focus').map(call => call[0].block);
  assert.deepEqual(new Set(focused), new Set([first.block, second.block]), 'two rows, two panes');
  assert.equal(new Set(focused).size, 2, 'the second row did not repeat the first row\'s target');
});

test('a named task says its name once, and only when a role did not push it out', () => {
  const row = over => ({ id: 'x', kind: 'agent', name: 'auth-research', named: true, taskState: 'running',
    label: 'Map the auth flow', createdAt: new Date().toISOString(), tokens: 12, ...over });
  const withRole = overviewLines([row({ role: 'scout' })], 80, null, 'en', new Map()).join('\n');
  assert.match(withRole, /auth-research · Map the auth flow/);
  // With no role the column is already the name, so the label must not repeat it.
  const noRole = overviewLines([row({})], 80, null, 'en', new Map()).join('\n');
  assert.match(noRole, /auth-research {2,}Map the auth flow/);
  assert.doesNotMatch(noRole, /auth-research · Map/);
  const unnamed = overviewLines([row({ role: 'scout', named: false })], 80, null, 'en', new Map()).join('\n');
  assert.match(unnamed, /scout +Map the auth flow/);
  assert.doesNotMatch(unnamed, /auth-research · Map/);
});
