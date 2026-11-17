import test from 'node:test';
import assert from 'node:assert/strict';
import { dialogComponent, nativePickerComponent, createDialogs, wrapText, matchesChord } from '../src/dialog.mjs';

function component(config) {
  const results = [];
  const tui = { terminal: { rows: 16 }, requestRender() {} };
  return { tui, results, component: dialogComponent({ tui, theme: {},
    keys: { matches: (data, key) => data === key }, done: value => results.push(value), ...config }) };
}

test('floating menu scrolls, follows selection after resize, and returns stable task IDs', () => {
  const h = component({ title: 'Rex Tasks', choices: Array.from({ length: 40 }, (_, i) => ({ label: `Task ${i}`, value: `uuid-${i}` })) });
  h.component.render(50);
  for (let i = 0; i < 12; i++) h.component.handleInput('tui.select.down');
  h.tui.terminal.rows = 10;
  const lines = h.component.render(35);
  assert.ok(lines.length <= 8);
  assert.match(lines.join('\n'), /› Task 12/);
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

test('session shutdown dismisses active overlays and resolves their promises', async () => {
  const dialogs = createDialogs();
  let overlay;
  const ctx = { hasUI: true, ui: { custom: (factory, options) => new Promise(resolve => {
    assert.equal(options.overlay, true); assert.equal(options.overlayOptions.anchor, 'center'); assert.equal(options.overlayOptions.width, 84);
    overlay = factory({ terminal: { rows: 24 }, requestRender() {} }, {}, { matches() { return false; } }, resolve);
  }) } };
  const pending = dialogs.view(ctx, 'Task details', 'body');
  assert.match(overlay.render(60).join('\n'), /body/);
  dialogs.closeAll();
  assert.equal(await pending, undefined);
  dialogs.closeAll();
});

test('empty task panel has a bounded opaque frame, padding and a separate selected row', () => {
  const styles = [];
  const theme = { style: (text, options) => { styles.push(options); return text; } };
  const h = component({ title: 'Rex Tasks', theme, description: '暂无任务\n使用 /bg 或 /rex-agent 启动任务。',
    choices: [{ label: '隐藏主页面概览', value: 'toggle' }] });
  h.tui.terminal.rows = 30;
  const lines = h.component.render(84);
  assert.match(lines[0], /^╭─+╮$/);
  assert.match(lines.at(-1), /^╰─+╯$/);
  assert.match(lines.join('\n'), /│  Rex Tasks/);
  assert.match(lines.join('\n'), /暂无任务/);
  assert.match(lines.join('\n'), /使用 \/bg 或 \/rex-agent/);
  assert.ok(lines.slice(1, -1).every(line => line.startsWith('│') && line.endsWith('│')));
  assert.ok(styles.every(style => style.bg?.kind === 'rgb'));
  assert.ok(styles.some(style => style.bg.r === 40 && style.bg.g === 60 && style.bg.b === 79));
  assert.ok(styles.some(style => style.bold));
});

test('large task lists remain scrollable inside the frame without overflowing the height budget', () => {
  const h = component({ title: 'Rex Tasks', description: '80 项任务',
    choices: Array.from({ length: 80 }, (_, i) => ({ label: `Task ${i}`, value: `${i}` })) });
  for (const rows of [10, 16, 30]) {
    h.tui.terminal.rows = rows;
    const lines = h.component.render(50);
    assert.ok(lines.length <= Math.floor(rows * 0.8));
    assert.match(lines.at(-1), /^╰/);
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

test('a dismissed dialog ignores queued confirmation, navigation and cancellation', () => {
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

test('hotkeys are ignored without choices and the hint line defaults to selectHint', () => {
  const viewer = component({ title: 'Logs', text: 'line one' });
  viewer.component.render(84);
  viewer.component.handleInput('\x0e');
  assert.deepEqual(viewer.results, []);
  const standard = component({ title: 'Tasks', choices: [{ value: 'one', label: 'One' }] });
  // The overlay row is fitted, which collapses runs of spaces to one.
  assert.match(standard.component.render(84).join('\n'), /↑↓ Select +Enter Confirm +Esc Back/);
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

test('dialogs.pick is inline and dialogs.select stays an overlay', async () => {
  const calls = [];
  const ctx = { hasUI: true, ui: { custom: (factory, config) => {
    calls.push(config);
    factory({ terminal: { rows: 24 }, requestRender() {} }, {}, { matches: () => false }, () => {});
    return Promise.resolve(undefined);
  } } };
  const dialogs = createDialogs(() => 'en');
  await dialogs.pick(ctx, panes);
  await dialogs.select(ctx, 'Tasks', [{ value: 'a', label: 'A' }]);
  assert.equal(calls[0], undefined);
  assert.equal(calls[1].overlay, true);
});
