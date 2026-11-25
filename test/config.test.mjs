import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, formatConfigReport, isDryRun, DEFAULT_CONFIG } from '../src/config.mjs';
import { overviewLines, rowLabel } from '../src/overview.mjs';
import { panelComponent } from '../src/dialog.mjs';
import { prepareRun, atomicJson } from '../src/core.mjs';
import { registerChild } from '../src/child.mjs';
import adapter from '../src/index.mjs';

async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'rex-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function settings(dir, value) {
  await mkdir(join(dir, '.pi'), { recursive: true });
  await writeFile(join(dir, '.pi', 'rex.json'), JSON.stringify(value));
}
function envFor(t, dir) {
  const previous = Object.fromEntries(['PI_CODING_AGENT_DIR', 'REX_SESSION', 'REX_BLOCK'].map(k => [k, process.env[k]]));
  process.env.PI_CODING_AGENT_DIR = join(dir, 'global');
  process.env.REX_SESSION = 'rex'; process.env.REX_BLOCK = 'parent';
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
}

test('missing configuration defaults to English and two panes without creating files', async t => {
  const dir = await temp(t);
  assert.deepEqual(await loadConfig(dir, { env: {}, home: dir }), { config: DEFAULT_CONFIG, errors: [] });
});

test('project overrides only its fields and respects a custom Pi agent directory', async t => {
  const dir = await temp(t), global = join(dir, 'custom-agent');
  await mkdir(global); await writeFile(join(global, 'rex.json'), JSON.stringify({ language: 'zh' }));
  await settings(dir, {});
  const loaded = await loadConfig(dir, { env: { PI_CODING_AGENT_DIR: '~/custom-agent' }, home: dir });
  assert.deepEqual(loaded, { config: { language: 'zh', closeFinishedAgentsOnExit: true }, errors: [] });
});

test('bad fields retain valid inherited values and malformed JSON is reported without crashing', async t => {
  const dir = await temp(t), global = join(dir, '.pi', 'agent');
  await mkdir(global, { recursive: true });
  await writeFile(join(global, 'rex.json'), JSON.stringify({ language: 'zh' }));
  // panesPerTab capped how many jobs shared a tab; jobs are chips now, so it is
  // reported as an unknown setting rather than silently ignored.
  for (const panesPerTab of [0, -1, 1.5, '3', null, 2]) {
    await settings(dir, { language: 'xx', panesPerTab, extra: true });
    const loaded = await loadConfig(dir, { env: {}, home: dir });
    assert.deepEqual(loaded.config, { language: 'zh', closeFinishedAgentsOnExit: true });
    assert.equal(loaded.errors.length, 3);
    assert.ok(loaded.errors.every(error => error.includes(join(dir, '.pi', 'rex.json'))));
    assert.ok(loaded.errors.some(error => error.includes('panesPerTab')));
  }
  for (const content of ['{', 'null', '[]']) {
    await writeFile(join(dir, '.pi', 'rex.json'), content);
    const loaded = await loadConfig(dir, { env: {}, home: dir });
    assert.equal(loaded.errors.length, 1);
    assert.deepEqual(loaded.config, { language: 'zh', closeFinishedAgentsOnExit: true });
  }
});

test('a finished agent closes on quit unless closeFinishedAgentsOnExit is turned off', async t => {
  const dir = await temp(t);
  await settings(dir, { closeFinishedAgentsOnExit: false });
  assert.deepEqual((await loadConfig(dir, { env: {}, home: dir })).config,
    { language: 'en', closeFinishedAgentsOnExit: false });
  await settings(dir, { closeFinishedAgentsOnExit: 'yes' });
  const invalid = await loadConfig(dir, { env: {}, home: dir });
  assert.equal(invalid.config.closeFinishedAgentsOnExit, true, 'an invalid value falls back to the default');
  assert.match(invalid.errors[0], /closeFinishedAgentsOnExit must be true or false/);
});

test('--dry-run is off unless the flag is on the loader argv', async t => {
  const dir = await temp(t);
  assert.equal(isDryRun(['node', 'pi']), false);
  assert.equal(isDryRun(['node', 'pi', '--model', 'x']), false);
  assert.equal(isDryRun(['node', 'pi', '--dry-run']), true);
  // Everything after a bare `--` is a positional prompt, not a flag.
  assert.equal(isDryRun(['node', 'pi', '--', '--dry-run']), false);
  assert.equal(isDryRun(['node', 'pi', '--', 'explain --dry-run']), false);
  // Without the flag the result keeps its two-field shape, so callers that apply
  // config never have to know the report exists.
  assert.deepEqual(await loadConfig(dir, { env: {}, home: dir, argv: ['node', 'pi'] }),
    { config: DEFAULT_CONFIG, errors: [] });
});

test('a dry run reports each value and which file produced it, applying nothing', async t => {
  const dir = await temp(t), global = join(dir, '.pi', 'agent');
  await mkdir(global, { recursive: true });
  await writeFile(join(global, 'rex.json'), JSON.stringify({ language: 'zh' }));
  await settings(dir, { closeFinishedAgentsOnExit: false });
  const argv = ['node', 'pi', '--dry-run'];
  const dry = await loadConfig(dir, { env: {}, home: dir, argv });
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.config, { language: 'zh', closeFinishedAgentsOnExit: false });
  assert.deepEqual(dry.errors, []);
  assert.equal(dry.sources.language, join(global, 'rex.json'), 'the global file set the language');
  assert.equal(dry.sources.closeFinishedAgentsOnExit, join(dir, '.pi', 'rex.json'), 'the project file overrode the default');
  assert.deepEqual(dry.files, [
    { path: join(global, 'rex.json'), read: true },
    { path: join(dir, '.pi', 'rex.json'), read: true }]);
  // The same inputs, read without the flag, resolve to the same values: a dry
  // run explains a resolution rather than performing a different one.
  const applied = await loadConfig(dir, { env: {}, home: dir, argv: ['node', 'pi'] });
  assert.deepEqual(applied, { config: dry.config, errors: [] });
});

test('a dry run marks unconfigured values as defaults and unread files as missing', async t => {
  const dir = await temp(t);
  const dry = await loadConfig(dir, { env: {}, home: dir, argv: ['node', 'pi', '--dry-run'] });
  assert.deepEqual(dry.config, DEFAULT_CONFIG);
  assert.deepEqual(dry.sources, { language: 'default', closeFinishedAgentsOnExit: 'default' });
  assert.ok(dry.files.every(file => !file.read), 'nothing was there to read');
  const report = formatConfigReport(dry);
  assert.match(report, /dry run/);
  assert.match(report, /language = "en"  \(default\)/);
  assert.match(report, new RegExp(`missing: ${join(dir, '.pi', 'rex.json').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.doesNotMatch(report, /problem/, 'no errors are invented by the report');
});

test('a dry run keeps reporting invalid settings while the file still wins nothing', async t => {
  const dir = await temp(t), global = join(dir, '.pi', 'agent');
  await mkdir(global, { recursive: true });
  await writeFile(join(global, 'rex.json'), JSON.stringify({ language: 'zh' }));
  await settings(dir, { language: 'xx', extra: true });
  const dry = await loadConfig(dir, { env: {}, home: dir, argv: ['node', 'pi', '--dry-run'] });
  assert.deepEqual(dry.config, { language: 'zh', closeFinishedAgentsOnExit: true });
  assert.equal(dry.sources.language, join(global, 'rex.json'), 'a rejected value never becomes the source');
  assert.equal(dry.sources.closeFinishedAgentsOnExit, 'default');
  assert.equal(dry.errors.length, 2);
  const report = formatConfigReport(dry);
  assert.match(report, /2 problems:/);
  assert.match(report, /Unknown setting: extra/);
  assert.match(report, /read: .*rex\.json/);
});

test('a malformed file still appears in the dry-run report and the format refuses a normal result', async t => {
  const dir = await temp(t);
  await settings(dir, {});
  await writeFile(join(dir, '.pi', 'rex.json'), '{');
  const dry = await loadConfig(dir, { env: {}, home: dir, argv: ['node', 'pi', '--dry-run'] });
  assert.equal(dry.files.at(-1).read, true, 'the file was read, it just did not parse');
  assert.equal(dry.errors.length, 1);
  assert.match(formatConfigReport(dry), /1 problem:/);
  const applied = await loadConfig(dir, { env: {}, home: dir, argv: ['node', 'pi'] });
  assert.throws(() => formatConfigReport(applied), /needs a dry-run result/);
});

function harness(dir, t) {
  const events = {}, commands = {}, tools = {}, widgets = [], statuses = [], entries = [];
  const blocks = new Map([['parent', 'main']]);
  const layouts = []; let serial = 0;
  const client = {
    inspect: async r => { assert.ok(blocks.has(r.block)); return { window: blocks.get(r.block) }; },
    size: async () => ({ columns: 174, rows: 80, cellWidth: 16, cellHeight: 30 }),
    view: async () => ({ windows: [] }),
    detach: async () => ({}),
    move: async () => ({}),
    float: async () => ({ layer_id: 'layer-1' }),
    minimize: async () => ({}),
    open: async run => {
      const block = `b-${++serial}`;
      run.window = run.layout.window || `w-${serial}`; run.layout.window = run.window;
      blocks.set(block, run.window); layouts.push({ ...run.layout }); return block;
    },
  };
  const ctx = { cwd: dir, hasUI: true, isIdle: () => false,
    sessionManager: { getSessionDir: () => dir, getSessionId: () => 'parent', getEntries: () => entries, getBranch: () => entries },
    ui: { setWidget: (_id, widget) => widgets.push(widget), setStatus: (_id, status) => statuses.push(status), notify() {} },
  };
  adapter({ on: (n, f) => { events[n] = f; }, registerCommand: (n, c) => { commands[n] = c; }, registerTool: tool => { tools[tool.name] = tool; },
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }), getThinkingLevel: () => 'off',
  }, { rex: client });
  t.after(() => events.session_shutdown());
  return { ctx, events, tools, commands, widgets, statuses, layouts, blocks,
    launch: (kind, task) => tools[kind].execute('call',
      kind === 'bg_run' ? { command: task } : kind === 'subagent' ? { task, label: 'Delegated task' } : { task }, undefined, undefined, ctx) };
}

test('agents share one grid tab and every job becomes its own chip', async t => {
  const dir = await temp(t); envFor(t, dir); await settings(dir, { language: 'en' });
  const h = harness(dir, t); await h.events.session_start({}, h.ctx);
  let start = h.layouts.length;
  for (let i = 0; i < 4; i++) assert.equal((await h.launch('subagent', `task ${i}`)).isError, undefined);
  const agents = h.layouts.slice(start);
  assert.deepEqual(agents.map(x => x.mode), ['window', 'grid', 'grid', 'grid']);
  assert.ok(agents.slice(1).every(x => x.window === agents[0].window), 'one Agents tab, never a second');
  assert.deepEqual(agents.slice(1).map(x => x.rows), [[2], [3], [2, 2]]);
  start = h.layouts.length;
  for (let i = 0; i < 4; i++) assert.equal((await h.launch('bg_run', `job ${i}`)).isError, undefined);
  const jobs = h.layouts.slice(start);
  assert.deepEqual(jobs.map(x => x.mode), ['chip', 'chip', 'chip', 'chip']);
  assert.deepEqual(jobs.map(x => x.slot), [0, 1, 2, 0]);
  // Reloading never moves or resizes an existing tab, and agents still join theirs.
  const before = [...h.blocks];
  await settings(dir, { language: 'en' }); await h.events.session_start({}, h.ctx);
  assert.deepEqual([...h.blocks], before);
  assert.equal((await h.launch('subagent', 'after reload')).isError, undefined);
  assert.equal(h.layouts.at(-1).mode, 'grid');
  assert.equal(h.layouts.at(-1).window, agents[0].window);
  assert.deepEqual(h.layouts.at(-1).rows, [2, 3]);
  assert.equal((await h.launch('btw', 'side question')).isError, undefined);
  assert.equal(h.layouts.at(-1).mode, 'split'); assert.equal(h.layouts.at(-1).anchor, 'parent');
});

test('main-agent overview, footer and task manager switch language on reload; English is the default', async t => {
  const dir = await temp(t); envFor(t, dir);
  const run = await prepareRun(join(dir, 'rex-adapter', 'parent'), { kind: 'agent', name: 'review', task: 'Review code' }, '');
  await atomicJson(join(run.dir, 'activity.json'), { task: 'running', process: 'running' });
  const h = harness(dir, t);
  for (const language of ['en', 'zh', 'en']) {
    if (language === 'zh' || h.widgets.length) await settings(dir, { language });
    await h.events.session_start({}, h.ctx);
    const widget = h.widgets.at(-1)().render(100).join('\n');
    // The list shows the goal, not a translated state word: same text in both languages.
    assert.match(widget, /review/); assert.doesNotMatch(widget, /Rex Tasks|Rex 任务|Running|运行中/);
    assert.ok(h.statuses.includes(language === 'en' ? 'Rex: 1 active' : 'Rex：1 项活跃任务'));
    let screen;
    h.ctx.ui.custom = async factory => {
      const component = factory({ terminal: { rows: 24 }, requestRender() {} }, {}, { matches: () => false }, () => {});
      screen = component.render(84).join('\n'); return undefined;
    };
    await h.commands['rex-tasks'].handler('', h.ctx);
    assert.match(screen, language === 'en' ? /Hide main-page overview/ : /隐藏主页面概览/);
    assert.match(screen, language === 'en' ? /Esc to go back/ : /Esc 返回/);
    if (language === 'en') assert.doesNotMatch(screen + widget, /\p{Script=Han}/u);
  }
});

test('all visible states translate; language never rewrites task text or machine states', () => {
  const states = ['running', 'completed', 'failed', 'interrupted', 'cancelled', 'launching', 'uncertain', 'exited'];
  for (const taskState of states) {
    const row = { kind: 'agent', name: 'review', taskState, processState: 'idle' };
    assert.doesNotMatch(rowLabel(row), /\p{Script=Han}/u);
    assert.match(rowLabel(row, 'zh'), /\p{Script=Han}/u);
    assert.equal(row.taskState, taskState);
  }
  const lines = overviewLines([{ id: 'a', kind: 'agent', name: 'review', taskState: 'running',
    label: '保留用户原文', task: '保留用户原文' }], 120);
  const rendered = lines.join('\n');
  assert.match(rendered, /保留用户原文/);
  // State is a glyph and a colour, never a translated word in the parent list.
  assert.doesNotMatch(rendered, /Running|运行中|Completed|已完成/);
  for (const language of ['en', 'zh']) {
    const viewer = panelComponent({ tui: { terminal: { rows: 24 } }, theme: {}, keys: {}, done() {}, title: 'Logs', text: 'output', language });
    assert.match(viewer.render(84).join('\n'), language === 'en' ? /to scroll · Esc to go back/ : /滚动 · Esc 返回/);
  }
});

test('child UI uses the parent configuration directory even when delegated cwd differs', async t => {
  const dir = await temp(t); envFor(t, dir);
  const childCwd = join(dir, 'checkout'); await settings(childCwd, { language: 'en' });
  await settings(dir, { language: 'zh' });
  const run = await prepareRun(join(dir, 'runs'), { kind: 'btw', name: 'side', task: 'question', cwd: childCwd, configCwd: dir }, '');
  const events = {}, commands = {}, notices = [];
  const ctx = { cwd: childCwd, hasUI: true, isIdle: () => false,
    sessionManager: { getEntries: () => [], getBranch: () => [] }, ui: { notify: text => notices.push(text), setStatus() {} } };
  registerChild({ on: (n, f) => { events[n] = f; }, registerCommand: (n, c) => { commands[n] = c; } }, run.dir);
  t.after(() => events.session_shutdown());
  await events.session_start({}, ctx);
  await commands['btw-return'].handler('answer', ctx);
  assert.equal(notices.at(-1), '结论已排入主会话接收队列');
  await settings(dir, { language: 'en' }); await events.session_start({}, ctx);
  await commands['btw-return'].handler('answer', ctx);
  assert.equal(notices.at(-1), 'Conclusion queued for the parent session');
});
