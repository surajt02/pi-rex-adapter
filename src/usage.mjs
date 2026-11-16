import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';

// A child's token count is read from its own Pi session file. The widget shows
// the current working set, so only the LAST usage record matters: no summing, no
// full-file read, no per-token bookkeeping in run.json.
//
// Files reach ~350 KB, so the tail is read instead of the whole file, and the
// parse result is cached against size+mtime to keep a redrawing widget cheap.

const TAIL = 64 * 1024;
const DEEP_TAIL = 512 * 1024;
const cache = new Map();

export function clearUsageCache() {
  cache.clear();
}

function lastUsage(text) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || line[0] !== '{') continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const usage = entry?.message?.usage;
    if (!usage || !Number.isFinite(usage.totalTokens)) continue;
    return { tokens: usage.totalTokens, at: entry.message.timestamp || entry.timestamp };
  }
  return undefined;
}

async function tail(path, bytes, size) {
  const start = Math.max(0, size - bytes);
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8');
    if (start === 0) return text;
    // The first line of a tail is almost always partial; drop it.
    const newline = text.indexOf('\n');
    return newline === -1 ? '' : text.slice(newline + 1);
  } finally {
    await handle.close();
  }
}

export async function readUsage(dir) {
  const path = join(dir, 'session.jsonl');
  let info;
  try { info = await stat(path); } catch { return {}; }
  const hit = cache.get(path);
  if (hit && hit.size === info.size && hit.mtimeMs === info.mtimeMs) return hit.value;
  let value = {};
  try {
    value = lastUsage(await tail(path, TAIL, info.size))
      || (info.size > TAIL ? lastUsage(await tail(path, DEEP_TAIL, info.size)) : undefined)
      || {};
  } catch { value = {}; }
  cache.set(path, { size: info.size, mtimeMs: info.mtimeMs, value });
  return value;
}
