import test from 'node:test';
import assert from 'node:assert/strict';
import { panelComponent, nativePickerComponent, createDialogs, wrapText, matchesChord } from '../src/dialog.mjs';

function component(config) {
  const results = [];
  const tui = { terminal: { rows: 16 }, requestRender() {} };
  return { tui, results, component: panelComponent({ tui, theme: {},
    keys: { matches: (data, key) => data === key }, done: value => results.push(value), ...config }) };
}

test('inline menu scrolls, follows selection after resize, and returns stable task IDs', () => {
  const h = component({ title: 'Rex Tasks', choices: Array.from({ length: 40 }, (_, i) => ({ label: `Task ${i}`, value: `uuid-${i}` })) });
  h.component.render(50);
  for (let i = 0; i < 12; i++) h.component.handleInput('tui.select.down');
  h.tui.terminal.rows = 10;
  const lines = h.component.render(35);
  assert.ok(lines.length <= 10);
  assert.match(lines.join('\n'), /→ Task 12/);
  h.component.handleInput('tui.select.confirm');
  assert.deepEqual(h.results, ['uuid-12']);
});

test('detail viewer wraps long lines, preserves indentation and scrolls without altering content', () => {
  const text = Array.from({ length: 60 }, (_, i) => `  line ${i}: ${'中文'.repeat(20)}`).join('\n');
  assert.ok(wrapText(text, 40)[0].startsWith('  line 0'));
  const h = component({ title: 'Logs', text });
  const initial = h.component.render(40).join('\n');
  assert.match(initial, /line 0/);
  h.component.handleInput('tui.select.pageDown');
  const scrolled = h.component.render(40).join('\n');
  assert.notEqual(scrolled, initial);
  assert.doesNotMatch(scrolled, /line 0:/);
  h.component.handleInput('tui.select.pageUp');
  assert.equal(h.component.render(40).join('\n'), initial);
  h.component.handleInput('tui.select.cancel');
  assert.deepEqual(h.results, [undefined]);
});

test('viewer strips injected terminal commands and fits a narrow terminal', () => {
  const h = component({ title: 'Details', text: '\x1b]0;evil\x07\x1b[31m中文\n  log\x00' });
  for (const width of [1, 8, 20]) {
    const lines = h.component.render(width);
    assert.ok(lines.every(line => !/[\x00-\x1f\x7f]/.test(line)));
    assert.ok(lines.every(line => [...line].reduce((n, ch) => n + (/[\u4e00-\u9fff]/.test(ch) ? 2 : 1), 0) <= width));
  }
});

test('session shutdown dismisses active panels and resolves their promises', async () => {
  const dialogs = createDialogs();
  let panel;
  const ctx = { hasUI: true, ui: { custom: (factory) => new Promise(resolve => {
    panel = factory({ terminal: { rows: 24 }, requestRender() {} }, {}, { matches() { return false; } }, resolve);
  }) } };
  const pending = dialogs.view(ctx, 'Task details', 'body');
  assert.match(panel.render(60).join('\n'), /body/);
  dialogs.closeAll();
  assert.equal(await pending, undefined);
  dialogs.closeAll();
});

test('panels use the picker chrome and theme tokens, never an opaque box', () => {
  const tokens = [];
  const theme = { fg: (token, text) => { tokens.push(token); return text; } };
  const h = component({ title: 'Rex Tasks', theme, description: '暂无任务\n使用 /bg 或 /rex-agent 启动任务。',
    choices: [{ label: '隐藏主页面概览', value: 'toggle' }] });
  h.tui.terminal.rows = 30;
  const lines = h.component.render(84);
  // A dim rule at each end, the title under it, and no side borders or fill.
  assert.equal(lines[0], '─'.repeat(84));
  assert.equal(lines.at(-1), '─'.repeat(84));
  assert.equal(lines[1], ' Rex Tasks');
  assert.ok(lines.every(line => !/[│╭╮╰╯]/.test(line)));
  assert.match(lines.join('\n'), /暂无任务/);
  assert.match(lines.join('\n'), /使用 \/bg 或 \/rex-agent/);
  for (const token of ['border', 'accent', 'muted', 'dim']) assert.ok(tokens.includes(token), token);
  assert.equal(tokens.includes('background'), false);
});

test('large task lists remain scrollable without overflowing the terminal height', () => {
  const h = component({ title: 'Rex Tasks', description: '80 项任务',
    choices: Array.from({ length: 80 }, (_, i) => ({ label: `Task ${i}`, value: `${i}` })) });
  for (const rows of [10, 16, 30]) {
    h.tui.terminal.rows = rows;
    const lines = h.component.render(50);
    assert.ok(lines.length <= rows);
    assert.match(lines.at(-1), /^─+$/);
  }
});

test('reopening a menu restores selected ID and scroll offset after viewing details', () => {
  const state = {};
  const config = { title: 'Tasks', state, choices: Array.from({ length: 40 }, (_, i) => ({ label: `Task ${i}`, value: `id-${i}` })) };
  const first = component(config);
  first.component.render(60);
  for (let i = 0; i < 19; i++) first.component.handleInput('tui.select.down');
  const expected = first.component.render(60);
  first.component.handleInput('tui.select.confirm');
  assert.equal(state.value, 'id-19'); assert.ok(state.offset > 0);
  const reopened = component(config);
  assert.deepEqual(reopened.component.render(60), expected);
  reopened.component.handleInput('tui.select.confirm');
  assert.deepEqual(reopened.results, ['id-19']);
});

test('a dismissed panel ignores queued confirmation, navigation and cancellation', () => {
  for (const first of ['cancel', 'confirm']) {
    const state = {};
    const h = component({ title: 'Tasks', state, choices: [{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }] });
    h.component.render(60);
    h.component.handleInput(`tui.select.${first}`);
    for (const key of ['down', 'confirm', 'cancel']) h.component.handleInput(`tui.select.${key}`);
    assert.deepEqual(h.results, [first === 'confirm' ? 'one' : undefined]);
    assert.equal(state.value, 'one');
  }
});

test('ctrl+n is recognised in the three terminal encodings and nothing else', () => {
  // Legacy control byte, Kitty CSI-u (with and without an event suffix), and
  // xterm modifyOtherKeys; a plain n, arrow keys and other chords are not it.
  for (const data of ['\x0e', '\x1b[110;5u', '\x1b[110;5:1u', '\x1b[110;5:3u', '\x1b[27;5;110~']) {
    assert.equal(matchesChord(data, 'ctrl+n'), true, JSON.stringify(data));
  }
  for (const data of ['n', '\x0dn', '\x1b[110;3u', '\x1b[110;1u', '\x1b[27;3;110~', '\x1b[27;5;109~', '', '\x1b[A']) {
    assert.equal(matchesChord(data, 'ctrl+n'), false, JSON.stringify(data));
  }
  for (const chord of [undefined, '', 'n', 'n+ctrl', 'ctrl+', 'shift+n']) assert.equal(matchesChord('\x0e', chord), false, String(chord));
});

test('hotkeys are ignored without choices and the hint line follows Pi wording', () => {
  const viewer = component({ title: 'Logs', text: 'line one' });
  viewer.component.render(84);
  viewer.component.handleInput('\x0e');
  assert.deepEqual(viewer.results, []);
  const standard = component({ title: 'Tasks', choices: [{ value: 'one', label: 'One' }] });
  assert.match(standard.component.render(84).join('\n'), /↑↓ to move · Enter to select · Esc to go back/);
  const long = component({ title: 'Logs', text: Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n') });
  assert.match(long.component.render(84).join('\n'), /1\/80/);
});

function nativePicker(config) {
  const results = [];
  const tui = { terminal: { rows: 16 }, requestRender() {} };
  return { tui, results, component: nativePickerComponent({ tui, theme: {}, language: 'en',
    title: 'Side Conversations', keys: { matches: (data, key) => data === key },
    done: value => results.push(value), choices: [], ...config }) };
}
const panes = [
  { value: 'pane-1', label: 'why werent subagents spawned', detail: 'Pi idle · 12m',
    full: 'why werent subagents spawned for this task' },
  { value: 'pane-2', label: 'observational memory warning', detail: 'Running · 48m',
    full: 'i got this warning: Warning: Observational memory' },
  { value: 'new', label: '＋ New side conversation', full: '＋ New side conversation' },
];

test('the side-conversation picker uses the model picker chrome, not the overlay box', () => {
  const h = nativePicker({ choices: panes, canCreate: true, hotkeys: { 'ctrl+n': 'new' } });
  const lines = h.component.render(87);
  assert.equal(lines[0], '─'.repeat(87));
  assert.equal(lines.at(-1), '─'.repeat(87));
  assert.ok(lines.every(line => !line.includes('│') && !line.includes('›')));
  // Title under the rule, like the prompt-snippets menu; then a blank line.
  assert.equal(lines[1], ' Side Conversations');
  assert.equal(lines[2], '');
  assert.match(lines.join('\n'), /^ {2}→ why werent subagents spawned · Pi idle · 12m$/m);
  assert.match(lines.join('\n'), /^ {4}observational memory warning · Running · 48m$/m);
  assert.match(lines.join('\n'), /^ {4}＋ New side conversation$/m);
  assert.match(lines.join('\n'), /Selected: why werent subagents spawned for this task/);
  assert.match(lines.join('\n'),
    /Enter to select · Ctrl\+N to start a new side conversation · Esc to cancel/);
});

test('the picker follows the cursor in its footer and hides New without a question', () => {
  const h = nativePicker({ choices: panes.slice(0, 2) });
  assert.doesNotMatch(h.component.render(87).join('\n'), /Ctrl\+N/);
  assert.match(h.component.render(87).join('\n'), /Selected: why werent subagents spawned for this task/);
  h.component.handleInput('tui.select.down');
  assert.match(h.component.render(87).join('\n'), /^ {2}→ observational memory warning/m);
  assert.match(h.component.render(87).join('\n'), /Selected: i got this warning: Warning: Observational memory/);
});

test('picker keys: ctrl+n picks New, Enter confirms, Esc cancels', () => {
  const hotkey = nativePicker({ choices: panes, canCreate: true, hotkeys: { 'ctrl+n': 'new' } });
  hotkey.component.render(87);
  hotkey.component.handleInput('\x0e');
  assert.deepEqual(hotkey.results, ['new']);

  const confirm = nativePicker({ choices: panes, canCreate: true });
  confirm.component.render(87);
  confirm.component.handleInput('tui.select.down');
  confirm.component.handleInput('tui.select.confirm');
  assert.deepEqual(confirm.results, ['pane-2']);

  const cancel = nativePicker({ choices: panes, canCreate: true });
  cancel.component.render(87);
  cancel.component.handleInput('tui.select.cancel');
  assert.deepEqual(cancel.results, [undefined]);
  cancel.component.handleInput('tui.select.confirm');
  assert.deepEqual(cancel.results, [undefined]);
});

test('a long picker list scrolls inside the terminal and reports its position', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ value: `p${i}`, label: `pane ${i}`, detail: 'idle' }));
  const h = nativePicker({ choices: many, canCreate: true });
  const lines = h.component.render(60);
  assert.ok(lines.length <= h.tui.terminal.rows, `${lines.length} lines for ${h.tui.terminal.rows} rows`);
  assert.match(lines.join('\n'), /\(1\/40\)/);
  for (let i = 0; i < 12; i++) h.component.handleInput('tui.select.down');
  const scrolled = h.component.render(60).join('\n');
  assert.match(scrolled, /→ pane 12/);
  assert.match(scrolled, /\(13\/40\)/);
});

test('every dialog is inline: no overlay options are ever passed', async () => {
  const calls = [], rendered = [];
  const ctx = { hasUI: true, ui: { custom: (factory, config) => {
    calls.push(config);
    const component = factory({ terminal: { rows: 24 }, requestRender() {} }, { fg: (_, text) => text },
      { matches: () => false }, () => {});
    rendered.push(component.render(70).join('\n'));
    return Promise.resolve(undefined);
  } } };
  const dialogs = createDialogs(() => 'en');
  await dialogs.pick(ctx, panes);
  await dialogs.select(ctx, 'Tasks', [{ value: 'a', label: 'A' }]);
  await dialogs.view(ctx, 'Logs', 'body');
  assert.deepEqual(calls, [undefined, undefined, undefined]);
  for (const screen of rendered) assert.doesNotMatch(screen, /[│╭╮╰╯]/);
});
