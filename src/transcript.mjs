import { clampSegments, formatDuration, formatTokens } from './columns.mjs';
import { plain, stateGlyph } from './overview.mjs';

// The transcript row for a delegated launch. Pi renders a tool row in two slots —
// renderCall for the header and renderResult for the body — so this module only
// turns a snapshot of the agents into lines of [text, themeToken] segments and
// measures them on plain text. The extension paints and clamps with columns.mjs.
//
// The grammar is the one the rest of this UI uses for agents: a ● heading, one
// row per agent, a ⎿ line of facts under it, and the report underneath when the
// row is expanded.

export const PREVIEW_LINES = 6;
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

function previewLines(agent, at, expanded) {
  if (!expanded || !agent.text) return [];
  const lines = String(agent.text).split('\n').map(line => plain(line)).filter(line => line.trim());
  const shown = lines.slice(0, PREVIEW_LINES);
  const rest = lines.length - shown.length;
  const out = shown.map(line => [indent(at), [line.trim(), 'muted']]);
  if (rest > 0) out.push([indent(at), [`… ${rest} more ${rest === 1 ? 'line' : 'lines'}`, 'dim']]);
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
  return [statsLine(agent, width, 2), ...previewLines(agent, 4, expanded)];
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
    lines.push(row, statsLine(agent, width, 6), ...previewLines(agent, 8, expanded));
  });
  return lines;
}

export const agentSnapshot = agent => ({
  label: agent.label, role: agent.role, model: agent.model, state: agent.state,
  tokens: agent.tokens, turns: agent.turns, toolUses: agent.toolUses, seconds: agent.seconds, text: agent.text,
});

// What has to change for the row to be worth repainting.
export const fingerprint = agents => JSON.stringify(agents.map(agent => [
  agent.label, agent.role, agent.state, agent.tokens, agent.turns, agent.toolUses, agent.seconds,
  agent.text ? String(agent.text).length : 0,
]));

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
