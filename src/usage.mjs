import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';

// A child's numbers come from its own Pi session file: the token count of its
// last assistant message, plus how many turns and tool calls it has taken.
//
// Tokens are a working set, not a sum, so the last usage record wins. Turns and
// tool uses are counts, so they are accumulated. Both are derived from one pass
// over the file that only ever reads bytes it has not read before: the first
// scan of a ~350 KB session costs a few milliseconds, every later scan reads the
// appended tail and a stat.

const cache = new Map();

export function clearUsageCache() {
  cache.clear();
}

const empty = () => ({ tokens: undefined, turns: 0, toolUses: 0, at: undefined });

function account(state, entry) {
  const message = entry?.message;
  if (!message || message.role !== 'assistant') return;
  state.turns += 1;
  for (const part of Array.isArray(message.content) ? message.content : []) {
    if (part && (part.type === 'toolCall' || part.type === 'tool_use' || part.type === 'tool_call')) state.toolUses += 1;
  }
  const usage = message.usage;
  if (usage && Number.isFinite(usage.totalTokens)) {
    state.tokens = usage.totalTokens;
    state.at = message.timestamp || entry.timestamp;
  }
}

function absorb(state, text) {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') continue;
    let entry;
    try { entry = JSON.parse(trimmed); } catch { continue; }
    account(state, entry);
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
async function advance(path, info) {
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
  if (newline !== -1) absorb(state, combined.slice(0, newline));
  cache.set(path, {
    size: info.size, mtimeMs: info.mtimeMs, counts: state, offset: info.size,
    carry: newline === -1 ? combined : combined.slice(newline + 1),
  });
  return state;
}

export async function readUsage(dir) {
  const path = join(dir, 'session.jsonl');
  let info;
  try { info = await stat(path); } catch { return {}; }
  try {
    // A copy: callers must not mutate the counts the cache keeps adding to.
    return { ...(await advance(path, info)) };
  } catch { return {}; }
}
