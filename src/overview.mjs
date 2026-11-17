import { stripVTControlCharacters } from 'node:util';
import { runStates } from './core.mjs';
import { t } from './i18n.mjs';
import { deriveLabel } from './labels.mjs';
import { STATS_WIDTH, alignRow, measure, statsBlank, statsText } from './columns.mjs';

export function plain(value) {
  return stripVTControlCharacters(String(value ?? '')).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
}
// Conservative display width: non-ASCII graphemes reserve two columns. No
// terminal escapes are accepted from task names/output; narrow panes stay safe.
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export function fit(text, width) {
  if (width <= 0) return '';
  const parts = [...segmenter.segment(plain(text))].map(x => x.segment);
  const size = s => /^[\x20-\x7e]+$/.test(s) ? s.length : 2;
  if (parts.reduce((n, s) => n + size(s), 0) <= width) return parts.join('');
  let output = '', used = 0;
  for (const part of parts) {
    if (used + size(part) > width - 1) break;
    output += part; used += size(part);
  }
  return output + '…';
}
export function taskRow(run, exit, result, activity, language = 'en') {
  return { id: run.id, block: run.block, name: run.name, kind: run.kind, task: run.task,
    cwd: run.cwd, createdAt: run.createdAt, artifacts: run.dir,
    ...runStates(run, exit, result, activity), closed: Boolean(run.closed),
    summary: result?.text || (exit ? t(language, 'noSummary') : undefined), resultAvailable: Boolean(result), error: exit?.error || run.error, exitCode: exit?.code };
}
const kinds = { agent: 'Agent', shell: 'Shell', btw: 'BTW' };
export function rowLabel(row, language = 'en') {
  const process = row.closed ? t(language, 'closed') : row.processState === 'idle' ? t(language, 'idle')
    : row.processState === 'exited' ? t(language, 'processExited') : row.processState === 'unknown' ? t(language, 'processUnknown') : '';
  const delivery = row.kind === 'agent' && row.taskState === 'completed' && !row.closed && row.deliveryState
    ? t(language, `delivery_${row.deliveryState}`) : undefined;
  return `[${kinds[row.kind] || row.kind}] ${delivery ? fit(row.name, 28) : plain(row.name)} · ${delivery || `${t(language, row.taskState)}${process ? ` / ${process}` : ''}`}${row.cleanupError ? ` · ${t(language, 'cleanupFailed')}` : ''}`;
}
// A side conversation's state, in the words the rest of the UI already uses:
// an exited process first, then an idle Pi, then the task state (starting,
// running, …). Age is when the pane last reported activity.
export function ageText(value, now = Date.now()) {
  const start = Date.parse(value || '');
  if (!start) return '';
  const minutes = Math.floor(Math.max(0, now - start) / 60000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}
// One picker row: the name in the accent colour, the state and age as muted
// detail, and the untruncated name for the "Selected:" footer.
export function btwRowParts(pane, language = 'en', now = Date.now()) {
  const { run, exit, result, activity } = pane;
  const states = runStates(run, exit, result, activity);
  const state = exit ? t(language, 'exited')
    : states.processState === 'idle' ? t(language, 'idle') : t(language, states.taskState);
  const age = ageText(activity?.at ?? run.createdAt, now);
  return { name: plain(run.name), detail: [state, age].filter(Boolean).join(' · '), full: plain(run.name) };
}
function rank(row) {
  if (row.closed) return 3;
  if (['running', 'launching', 'uncertain'].includes(row.taskState)) return 0;
  return row.taskState === 'failed' ? 1 : 2;
}
export function orderRows(rows) {
  return [...rows].sort((a, b) => rank(a) - rank(b) || String(b.createdAt).localeCompare(String(a.createdAt)) || a.id.localeCompare(b.id));
}
export function activeOverviewRows(rows) {
  return orderRows(rows.filter(row => row.kind !== 'btw' && !row.closed &&
    ['running', 'launching', 'uncertain'].includes(row.taskState)));
}
// The list shows every task whose pane is still open, not only the running ones:
// a completed agent awaiting rex_finish and a stuck or failed pane are exactly
// what the reader needs to see. BTW lives in its own split, never here.
export function visibleRows(rows) {
  return orderRows(rows.filter(row => row.kind !== 'btw' && !row.closed));
}
// Desaturated slate blue (#7e98ad); Theme.style handles truecolor/256-color.
export function softBlue(theme, text) {
  return theme?.style ? theme.style(text, { fg: { kind: 'rgb', r: 126, g: 152, b: 173 } })
    : theme?.fg ? theme.fg('muted', text) : text;
}

// The rest of this Pi UI spins one dot cycle (pi-claude-code-ui / OpenBrawd),
// so the list must not animate in a second visual language. The ping-pong
// order is theirs too: the ends and the middle glyph hold for two frames.
const SPIN = ['·', '✢', '✳', '✶', '✻', '✽', '✽', '✻', '✶', '✳', '✢', '·'];
export const FRAME_MS = 170;
const TERMINAL = ['failed', 'interrupted', 'cancelled', 'exited', 'error'];

function glyph(state, now) {
  if (['running', 'launching', 'uncertain'].includes(state)) return [SPIN[Math.floor(now / FRAME_MS) % SPIN.length], 'accent'];
  if (state === 'pending' || state === 'queued' || state === 'skipped') return ['○', 'dim'];
  if (TERMINAL.includes(state)) return ['●', 'error'];
  return ['●', 'success'];
}

// Shared with the transcript renderer so both places animate identically.
export { glyph as stateGlyph };
function elapsed(row, now = Date.now()) {
  const start = Date.parse(row?.createdAt || '');
  if (!start) return 0;
  const end = row?.endedAt ? Date.parse(row.endedAt) : now;
  return Math.max(0, Math.round((((end || now) - start)) / 1000));
}
function roleText(step) {
  return plain(step.row?.role || step.agent || step.row?.name || '');
}

// A pipeline is a block of steps under one ◆ line; anything else is a loose row
// with a blank gutter. Membership is the connector glyph, nothing else.
export function buildGroups(rows, chains) {
  const byChain = new Map(), loose = [];
  for (const row of visibleRows(rows)) {
    const id = row.chain?.id;
    if (!id) { loose.push(row); continue; }
    if (!byChain.has(id)) byChain.set(id, []);
    byChain.get(id).push(row);
  }
  const groups = [];
  for (const [id, chainRows] of byChain) {
    const chain = chains?.get?.(id);
    const total = chain?.steps?.length || chainRows[0].chain?.total || chainRows.length;
    const stopped = Boolean(chain) && chain.status !== 'running';
    const steps = [];
    for (let index = 0; index < total; index++) {
      const row = chainRows.find(candidate => candidate.chain?.index === index);
      const record = chain?.steps?.[index];
      if (!row && !record) continue;
      const state = row?.taskState || record?.status || 'pending';
      // A step the chain never reached is not waiting for anything: there is no
      // previous step left to finish, so it is skipped rather than pending.
      steps.push({ index, row, agent: record?.agent,
        state: stopped && (state === 'pending' || state === 'queued') ? 'skipped' : state,
        label: row?.label || record?.label || deriveLabel(row?.task || record?.task) });
    }
    const done = chain ? chain.steps.filter(step => step.status === 'completed').length
      : steps.filter(step => step.state === 'completed').length;
    if (!steps.length) continue;
    groups.push({ id, title: plain(chain?.title || chainRows[0].chain?.title || 'pipeline'), done, total, steps });
  }
  return { groups, loose };
}

function roleColumn(groups, loose) {
  const widths = [...groups.flatMap(group => group.steps), ...loose.map(row => ({ row }))]
    .map(step => measure(roleText(step)));
  return Math.min(12, Math.max(6, ...widths));
}

function chainLine(group, width, theme) {
  const head = '   ', mark = '◆ ';
  const rest = `${group.title} · ${group.done}/${group.total}`;
  if (measure(head + mark + rest) <= width) return `${head}${softBlue(theme, mark)}${rest}`;
  return fit(head + mark + rest, width);
}

function stepLine(step, { connector, last, roleWidth, width, theme, language, now }) {
  const paint = (token, text) => theme?.fg ? theme.fg(token, text) : text;
  const color = token => (text => paint(token, text));
  const [symbol, token] = glyph(step.state, now);
  const prefix = connector ? ['   ', last ? '└ ' : '├ '] : ['   ', ''];
  const cell = roleText(step).padEnd(roleWidth + (connector ? 2 : 4));
  const label = plain(step.label);
  const segments = [
    [prefix[0], color('dim')], [prefix[1], color('dim')], [symbol, color(token)], [' ', undefined],
    [cell, color('muted')], [label, undefined],
  ];
  const stats = step.row ? statsText(elapsed(step.row, now), step.row.tokens) : statsBlank();
  return alignRow(segments, stats, width);
}

// A widget is a couple of lines above the editor, not a task manager: past this
// many rows the rest are behind /rex-tasks.
export const MAX_ROWS = 10;

// A row can be clicked only when it names a pane the reader can be sent to. A
// step the chain has not started has no pane yet; a skipped one never will.
const UNREACHABLE = new Set(['pending', 'queued', 'skipped']);
export function focusTarget(row, state) {
  return row?.block && !row.closed && !UNREACHABLE.has(state) ? row.id : undefined;
}

// `hits`, when passed, collects the line each clickable row was drawn on: the
// widget answers a click by looking up its local y in that map, so the mapping
// is always the frame the reader was looking at.
export function overviewLines(rows, width, theme, language = 'en', chains, hits) {
  if (!width || width <= 0) return [];
  const { groups, loose } = buildGroups(rows, chains);
  if (!groups.length && !loose.length) return [];
  const roleWidth = roleColumn(groups, loose);
  const now = Date.now();
  const dim = text => (theme?.fg ? theme.fg('dim', text) : text);
  const lines = [];
  let budget = MAX_ROWS, rendered = 0;
  const push = (line, target) => {
    if (target && hits) hits.push({ y: lines.length, id: target });
    lines.push(line); budget--;
  };
  for (const group of groups) {
    if (budget <= 1) break;
    // The chain line is a heading, not a pane: it has nothing to focus.
    push(chainLine(group, width, theme));
    for (const [index, step] of group.steps.entries()) {
      if (budget <= 1) break;
      push(stepLine(step, { connector: true, last: index === group.steps.length - 1, roleWidth, width, theme, language, now }),
        focusTarget(step.row, step.state));
      rendered++;
    }
  }
  for (const row of loose) {
    if (budget <= 1) break;
    push(stepLine({ row, label: row.label, state: row.taskState }, { connector: false, roleWidth, width, theme, language, now }),
      focusTarget(row, row.taskState));
    rendered++;
  }
  const total = groups.reduce((count, group) => count + group.steps.length, 0) + loose.length;
  const hidden = total - rendered;
  if (hidden > 0) lines.push(dim(fit(t(language, 'more', { count: hidden }), width)));
  return lines;
}

export function showOverview(ctx, rows, enabled, language = 'en', chains, options) {
  if (!ctx?.hasUI) return;
  if (!enabled || !visibleRows(rows).length) {
    ctx.ui.setWidget('rex-tasks', undefined, { placement: 'aboveEditor' });
    return;
  }
  ctx.ui.setWidget('rex-tasks', (tui, theme) => {
    const targets = new Map();
    const component = {
      render(width) {
        const hits = [];
        const lines = overviewLines(rows, width, theme, language, chains, hits);
        targets.clear();
        if (options?.focus) for (const hit of hits) targets.set(hit.y, hit.id);
        return lines;
      },
      // Pi only synthesizes a click when the press was claimed by a component,
      // so claim the press and act on the click that follows it. Anything that
      // is not a clickable row returns undefined, which leaves text selection,
      // the wheel, and the rest of the widget to Pi.
      handleMouse(event) {
        if (event.button !== 'left' || !options?.focus) return undefined;
        const id = targets.get(event.y);
        if (!id) return undefined;
        if (event.type === 'press') return { handled: true };
        if (event.type !== 'click') return undefined;
        options.focus(id);
        return { handled: true, render: true };
      },
      invalidate() {},
      dispose() { if (component.clock) clearInterval(component.clock); component.clock = undefined; },
    };
    // The spinner and the clocks tick, so the widget refreshes itself instead of
    // waiting for unrelated TUI activity. unref keeps tests and scripts free to exit.
    if (tui?.requestRender) {
      component.clock = setInterval(() => { component.invalidate(); tui.requestRender(); }, FRAME_MS);
      component.clock.unref?.();
    }
    return component;
  }, { placement: 'aboveEditor' });
}
