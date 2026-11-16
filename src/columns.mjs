import { stripVTControlCharacters } from 'node:util';

// Column arithmetic for the agent list. Everything here measures PLAIN text and
// paints afterwards: an ANSI escape is several bytes but zero columns, and a
// length-based pad is exactly how a red row once slid one column left of a green
// one. Keep that rule in one place and it cannot come back.

export const TIME_WIDTH = 7;
export const TOKEN_WIDTH = 5;
// time + ' · ' + '↓ ' + tokens + ' tokens'
export const STATS_WIDTH = TIME_WIDTH + 3 + 2 + TOKEN_WIDTH + 7;
const GAP = 8;

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
// Real terminal width, not byte length: wide East-Asian and emoji cells take two
// columns, combining marks take none, and ambiguous glyphs (● ↓ · … ⠋) take one.
const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]|[\u{1F300}-\u{1FAFF}]|[\u{20000}-\u{3FFFD}]/u;
const cellWidth = grapheme => {
  if (/^[\x20-\x7e]+$/.test(grapheme)) return grapheme.length;
  if (/^\p{Mn}+$/u.test(grapheme)) return 0;
  return WIDE.test(grapheme) ? 2 : 1;
};

export function measure(text) {
  let width = 0;
  for (const { segment } of segmenter.segment(stripVTControlCharacters(String(text ?? '')))) width += cellWidth(segment);
  return width;
}

// Cut to a column budget without adding an ellipsis; callers decide the marker.
export function cut(text, width) {
  if (width <= 0) return '';
  let output = '', used = 0;
  for (const { segment } of segmenter.segment(stripVTControlCharacters(String(text ?? '')))) {
    const size = cellWidth(segment);
    if (used + size > width) break;
    output += segment; used += size;
  }
  return output;
}

// 41s · 1m 07s · 1h 42m — always at most TIME_WIDTH columns. Hours keep the
// clock readable past an hour; 99h+ is the clamp that keeps the field fixed.
export function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  if (total < 3600) {
    const minutes = Math.floor(total / 60), rest = total % 60;
    return minutes ? `${minutes}m ${String(rest).padStart(2, '0')}s` : `${rest}s`;
  }
  const hours = Math.floor(total / 3600), minutes = Math.floor((total % 3600) / 60);
  if (hours > 99) return '99h+';
  return `${hours}h ${String(minutes).padStart(2, '0')}m`;
}

// At most TOKEN_WIDTH columns: 940 · 8.6k · 99.9k · 104k · 1.0M.
export function formatTokens(tokens) {
  const count = Math.max(0, Math.floor(Number(tokens) || 0));
  if (count >= 999_500) return '1.0M';
  if (count >= 100_000) return `${Math.round(count / 1000)}k`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return String(count);
}

// Every stats block is the same width, including rows with no token count yet:
// a shorter block would drag the time column right on those rows only.
export function statsText(seconds, tokens) {
  const time = formatDuration(seconds).padStart(TIME_WIDTH);
  const tail = Number.isFinite(tokens)
    ? `↓ ${formatTokens(tokens).padStart(TOKEN_WIDTH)} tokens`
    : ' '.repeat(2 + TOKEN_WIDTH + 7);
  return `${time} · ${tail}`;
}

export function statsBlank() {
  return ' '.repeat(STATS_WIDTH);
}

// Segments are [text, paint] pairs. paint is applied last, never measured.
export function paintSegments(segments) {
  return segments.map(([text, paint]) => (paint ? paint(text) : text)).join('');
}

export function clampSegments(segments, limit) {
  const kept = [];
  let used = 0;
  for (const [text, paint] of segments) {
    const value = String(text ?? '');
    const width = measure(value);
    if (used + width <= limit) { kept.push([value, paint]); used += width; continue; }
    const room = limit - used;
    if (room > 1) {
      const head = cut(value, room - 1);
      kept.push([`${head}…`, paint]);
      used += measure(head) + 1;
    }
    break;
  }
  return { segments: kept, used };
}

export function alignRow(left, stats, width) {
  if (width <= 0) return '';
  const limit = width - STATS_WIDTH;
  if (limit < GAP) return paintSegments(clampSegments(left, width).segments);
  const { segments, used } = clampSegments(left, limit);
  return paintSegments(segments) + ' '.repeat(Math.max(0, limit - used)) + stats;
}
