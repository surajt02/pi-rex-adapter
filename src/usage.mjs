import { open, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { cut } from './columns.mjs';

// A child's numbers come from its own Pi session file: the token count of its
// last assistant message, how many turns and tool calls it has taken, and what
// those calls touched — the last one is what makes an expanded row worth
// expanding, because "what did it actually read" is the question it answers.
//
// Tokens are a working set, not a sum, so the last usage record wins. Turns and
// tool uses are counts, so they are accumulated. Both are derived from one pass
// over the file that only ever reads bytes it has not read before: the first
// scan of a ~350 KB session costs a few milliseconds, every later scan reads the
// appended tail and a stat.

const cache = new Map();
// Where the child ran, so a tool call can name `src/columns.mjs` instead of the
// same file's absolute path filling the whole line.
const cwdCache = new Map();

export function clearUsageCache() {
  cache.clear();
  cwdCache.clear();
}

// Distinct actions only: a scout that reads the same file twelve times has one
// action and twelve tool uses, and the count already says so.
const MAX_ACTIONS = 12;
const ACTION_WIDTH = 48;

const empty = () => ({ tokens: undefined, turns: 0, toolUses: 0, actions: [], at: undefined });

function actionOf(part, cwd) {
  const name = typeof part?.name === 'string' ? part.name : '';
  if (!name) return '';
  const args = part.arguments && typeof part.arguments === 'object' ? part.arguments : {};
  const hint = args.path || args.file_path || args.pattern || args.command || args.query || args.displaySummary || '';
  const first = relative(String(hint).split('\n')[0].trim(), cwd);
  if (!first) return name;
  const kept = cut(first, ACTION_WIDTH);
  return `${name} ${kept === first ? first : `${kept}…`}`;
}

const relative = (text, cwd) => (cwd && cwd.length > 1 ? text.split(`${cwd}/`).join('') : text);

function note(state, action) {
  if (!action || state.actions.includes(action) || state.actions.length >= MAX_ACTIONS) return;
  state.actions.push(action);
}

function account(state, entry, cwd) {
  const message = entry?.message;
  if (!message || message.role !== 'assistant') return;
  state.turns += 1;
  for (const part of Array.isArray(message.content) ? message.content : []) {
    if (!part) continue;
    if (part.type !== 'toolCall' && part.type !== 'tool_use' && part.type !== 'tool_call') continue;
    state.toolUses += 1;
    note(state, actionOf(part, cwd));
  }
  const usage = message.usage;
  if (usage && Number.isFinite(usage.totalTokens)) {
    state.tokens = usage.totalTokens;
    state.at = message.timestamp || entry.timestamp;
  }
}

function absorb(state, text, cwd) {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') continue;
    let entry;
    try { entry = JSON.parse(trimmed); } catch { continue; }
    account(state, entry, cwd);
  }
}

async function readFrom(path, offset, size) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(Math.max(0, size - offset));
    if (!buffer.length) return '';
    await handle.read(buffer, 0, buffer.length, offset);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

// A whole file read once, then only its new tail. A half-written last line is
// held back so its counts are not lost or double counted.
async function advance(path, info, cwd) {
  const hit = cache.get(path);
  if (hit && hit.size === info.size && hit.mtimeMs === info.mtimeMs) return hit.counts;

  // Continue from where the last scan stopped; a shrunk or replaced file starts over.
  const resume = Boolean(hit) && info.size >= hit.offset;
  const state = resume ? hit.counts : empty();
  const offset = resume ? hit.offset : 0;
  const carry = resume ? hit.carry || '' : '';

  const text = await readFrom(path, offset, info.size);
  const combined = carry + text;
  const newline = combined.lastIndexOf('\n');
  if (newline !== -1) absorb(state, combined.slice(0, newline), cwd);
  cache.set(path, {
    size: info.size, mtimeMs: info.mtimeMs, counts: state, offset: info.size,
    carry: newline === -1 ? combined : combined.slice(newline + 1),
  });
  return state;
}

// The run record says where the child ran; one small file, cached by mtime.
async function runCwd(dir) {
  const path = join(dir, 'run.json');
  let info;
  try { info = await stat(path); } catch { return ''; }
  const hit = cwdCache.get(path);
  if (hit && hit.mtimeMs === info.mtimeMs) return hit.cwd;
  let cwd = '';
  try { cwd = JSON.parse(await readFile(path, 'utf8'))?.cwd || ''; } catch { cwd = ''; }
  cwdCache.set(path, { mtimeMs: info.mtimeMs, cwd });
  return cwd;
}

export async function readUsage(dir) {
  const path = join(dir, 'session.jsonl');
  let info;
  try { info = await stat(path); } catch { return {}; }
  try {
    // A copy, actions included: callers must not mutate what the cache keeps adding to.
    const counts = await advance(path, info, await runCwd(dir));
    return { ...counts, actions: [...counts.actions] };
  } catch { return {}; }
}
