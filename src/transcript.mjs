import { clampSegments, cut, formatDuration, formatTokens, measure, wrapSegments } from './columns.mjs';
import { plain, stateGlyph } from './overview.mjs';

// The transcript row for a delegated launch. Pi renders a tool row in two slots —
// renderCall for the header and renderResult for the body — so this module only
// turns a snapshot of the agents into lines of [text, themeToken] segments and
// measures them on plain text. The extension paints and clamps with columns.mjs.
//
// The grammar is the one the rest of this UI uses for agents: a ● heading, one
// row per agent, a ⎿ line of facts under it, and the report underneath when the
// row is expanded.

// How many distinct actions a row admits to naming before it counts the rest.
export const MAX_ACTIONS = 4;
// The parent stores at most this much of a report, so a full row can say so.
export const REPORT_LIMIT = 4000;
// Below this width the model name costs more than it explains.
export const COMPACT_WIDTH = 90;

const STATE_WORD = {
  completed: 'Done', running: 'Running', launching: 'Starting', uncertain: 'Unverified',
  failed: 'Failed', interrupted: 'Interrupted', cancelled: 'Cancelled', exited: 'Exited',
  pending: 'Waiting', queued: 'Waiting',
};
const ACTIVE = new Set(['running', 'launching', 'uncertain', 'queued', 'pending']);

export const isActive = state => ACTIVE.has(state);
// Only these animate: a queued step's ○ and a settled ● are static, so a row in
// those states has no reason to repaint between data changes.
export const spinning = state => ['running', 'launching', 'uncertain'].includes(state);
export const stateWord = state => STATE_WORD[state] || 'Waiting';
export const severity = state => (state === 'completed' ? 'success'
  : ['failed', 'interrupted', 'cancelled', 'exited', 'error'].includes(state) ? 'error' : 'dim');

const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

function facts(agent, width) {
  if (agent.state === 'queued' || agent.state === 'pending') return [[stateWord(agent.state), 'dim']];
  const pieces = [[stateWord(agent.state), severity(agent.state)]];
  if (agent.model && width >= COMPACT_WIDTH) pieces.push([plain(agent.model).split('/').pop(), 'dim']);
  if (agent.turns) pieces.push([plural(agent.turns, 'turn'), 'dim']);
  if (agent.toolUses) pieces.push([plural(agent.toolUses, 'tool use'), 'dim']);
  if (Number.isFinite(agent.tokens)) pieces.push([`${formatTokens(agent.tokens)} token`, 'dim']);
  if (Number.isFinite(agent.seconds)) pieces.push([formatDuration(agent.seconds), 'dim']);
  const joined = [];
  pieces.forEach((piece, index) => { if (index) joined.push([' · ', 'dim']); joined.push(piece); });
  return joined;
}

const indent = count => [' '.repeat(count), null];

function statsLine(agent, width, at) {
  return [...(agent.state === 'queued' || agent.state === 'pending'
    ? [indent(at), ['⎿ ', 'dim'], ['Waiting for the previous step', 'dim']]
    : [indent(at), ['⎿ ', 'dim'], ...facts(agent, width)])];
}

// The action line is one line: it names as many actions as fit and counts the
// rest, rather than growing past the pane and being clipped without a word.
export function actionText(agent, width = 0) {
  const all = Array.isArray(agent.actions) ? agent.actions.filter(action => typeof action === 'string' && action) : [];
  if (!all.length) return '';
  let shown = all.slice(0, MAX_ACTIONS);
  for (;;) {
    const rest = all.length - shown.length;
    const text = rest > 0 ? `${shown.join(' · ')} · +${rest} more` : shown.join(' · ');
    if (!width || measure(text) <= width) return text;
    if (shown.length <= 1) return `${cut(shown[0], Math.max(4, width - 1))}…`;
    shown = shown.slice(0, -1);
  }
}

const TABLE_RULE = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/;

// A report is markdown, and markdown at 126 columns is mostly pipes. Table rows
// become "cell · cell · cell", heading marks and backticks go, and the rule rows
// that carry no information are dropped entirely.
export function flattenReport(text) {
  const lines = String(text ?? '').split('\n').map(line => plain(line).trim());
  const out = [];
  for (const line of lines) {
    if (!line) continue;
    if (TABLE_RULE.test(line)) continue;
    const cells = line.includes('|') ? line.split('|').map(cell => cell.trim()).filter(Boolean) : [line];
    const joined = cells.join(' · ')
      .replace(/`/g, '')
      .replace(/^#{1,6}\s+/, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/__(.+?)__/g, '$1')
      .trim();
    if (joined) out.push(joined);
  }
  return out;
}

// Expanded means the whole report: it wraps to the pane instead of being clipped,
// and nothing is left saying "… 21 more lines" with no way to reach line seven.
function previewLines(agent, at, expanded, width) {
  if (!expanded) return [];
  const out = [];
  const room = Math.max(8, Math.floor((Number(width) || 120) - at));
  const actions = actionText(agent, room);
  if (actions) out.push([indent(at), [actions, 'dim']]);
  for (const line of flattenReport(agent.text)) {
    for (const wrapped of wrapSegments([[line, 'muted']], room)) out.push([indent(at), ...wrapped]);
  }
  if (String(agent.text ?? '').length >= REPORT_LIMIT) {
    out.push([indent(at), [`… report truncated at ${REPORT_LIMIT} characters`, 'dim']]);
  }
  return out;
}

// A single agent is its own header row: the glyph is the state, so there is no
// separate "launched" line to read.
export function agentHeader(agent, { now = Date.now(), hint } = {}) {
  const [symbol, token] = stateGlyph(agent.state, now);
  const line = [[symbol, token], [' ', null], [plain(agent.label || 'agent'), 'bold']];
  if (agent.role) line.push([' ', null], [`(${plain(agent.role)})`, 'muted']);
  if (hint) line.push([' ', null], [`(${hint})`, 'dim']);
  return [line];
}

export function pipelineHeader({ title, done, total }, { hint } = {}) {
  const line = [['●', 'accent'], [' ', null], ['Pipeline', 'bold']];
  if (title) line.push([' · ', 'dim'], [plain(title), 'dim']);
  if (Number.isFinite(total)) line.push([' · ', 'dim'], [`${done}/${total} done`, 'dim']);
  if (hint) line.push([' ', null], [`(${hint})`, 'dim']);
  return [line];
}

export function agentBody(agent, { width, expanded } = {}) {
  return [statsLine(agent, width, 2), ...previewLines(agent, 4, expanded, width)];
}

// One row per step, connected, each with its own ⎿ line: a chain is sequential,
// so a step that has not started says so instead of showing zeros.
export function pipelineBody({ agents }, { width, expanded, now = Date.now() } = {}) {
  const lines = [];
  agents.forEach((agent, index) => {
    const last = index === agents.length - 1;
    const [symbol, token] = stateGlyph(agent.state, now);
    const row = [indent(2), [last ? '└ ' : '├ ', 'dim'], [symbol, token], [' ', null], [plain(agent.label || 'agent'), 'bold']];
    if (agent.role) row.push([' ', null], [`(${plain(agent.role)})`, 'muted']);
    lines.push(row, statsLine(agent, width, 6), ...previewLines(agent, 8, expanded, width));
  });
  return lines;
}

export const agentSnapshot = agent => ({
  label: agent.label, role: agent.role, model: agent.model, state: agent.state,
  tokens: agent.tokens, turns: agent.turns, toolUses: agent.toolUses, seconds: agent.seconds,
  actions: agent.actions, text: agent.text,
});

// What has to change for the row to be worth repainting.
// A chain outlives its panes. finishChain closes every completed step, so the
// rows that produced this snapshot are gone by the time the last step reports —
// which is why the count froze at n-1/N. The chain record still knows, so the
// header and the states come from it, and the numbers we last measured are kept
// for the rows that no longer exist.
export function chainSnapshot(record, previous) {
  const steps = Array.isArray(record?.steps) ? record.steps : [];
  if (!steps.length) return undefined;
  const before = Array.isArray(previous?.agents) ? previous.agents : [];
  return {
    title: record.title,
    done: steps.filter(step => step.status === 'completed').length,
    total: steps.length,
    agents: steps.map((step, index) => {
      const kept = before[index] || {};
      return agentSnapshot({
        label: step.label || kept.label, role: step.agent || kept.role, model: kept.model,
        state: step.status, tokens: kept.tokens, turns: kept.turns, toolUses: kept.toolUses,
        seconds: kept.seconds, actions: kept.actions, text: step.text || kept.text,
      });
    }),
  };
}

// `progress` matters as much as the agents: a chain's done/total comes from
// chain.json, so a step finishing can move the header while every agent row is
// already settled — and a row that only hashes its agents keeps the old count.
export const fingerprint = (agents, progress = '') => JSON.stringify([progress, agents.map(agent => [
  agent.label, agent.role, agent.state, agent.tokens, agent.turns, agent.toolUses, agent.seconds,
  Array.isArray(agent.actions) ? agent.actions.length : 0,
  agent.text ? String(agent.text).length : 0,
])]);

export function toLines(lines, width) {
  return lines.map(segments => clampSegments(segments, width).segments);
}

// A component Pi can mount: it renders on demand, so the caller keeps the state
// and invalidates the row when that state moves. `paint(token, text)` applies the
// theme; it runs after measurement, never before.
export function component(build, paint = (_token, text) => text) {
  return {
    render(width) {
      const usable = Math.max(1, Math.floor(width));
      return toLines(build(usable), usable).map(segments => segments.map(([text, token]) => (token ? paint(token, text) : text)).join(''));
    },
    invalidate() {},
    dispose() {},
  };
}
