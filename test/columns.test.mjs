import test from 'node:test';
import assert from 'node:assert/strict';
import { STATS_WIDTH, TIME_WIDTH, TOKEN_WIDTH, alignRow, cut, formatDuration, formatTokens,
  measure, paintSegments, statsBlank, statsText, wrapSegments } from '../src/columns.mjs';

const red = text => `\x1b[38;5;167m${text}\x1b[0m`;
const green = text => `\x1b[38;5;35m${text}\x1b[0m`;

test('durations stay inside the time column and clamp at 99h+', () => {
  const cases = [[0, '0s'], [41, '41s'], [59, '59s'], [60, '1m 00s'], [3599, '59m 59s'],
    [3600, '1h 00m'], [3725, '1h 02m'], [6125, '1h 42m'], [359999, '99h 59m'], [360000, '99h+'], [10_000_000, '99h+']];
  for (const [seconds, expected] of cases) {
    assert.equal(formatDuration(seconds), expected);
    assert.ok(measure(expected) <= TIME_WIDTH, `${expected} exceeds ${TIME_WIDTH}`);
  }
});

test('token counts never exceed five columns', () => {
  const cases = [[0, '0'], [940, '940'], [1000, '1.0k'], [8600, '8.6k'], [12400, '12.4k'],
    [99949, '99.9k'], [100000, '100k'], [104000, '104k'], [999949, '1.0M'], [999500, '1.0M'], [999499, '999k'], [1048576, '1.0M']];
  for (const [tokens, expected] of cases) {
    assert.equal(formatTokens(tokens), expected);
    assert.ok(measure(expected) <= TOKEN_WIDTH, `${expected} exceeds ${TOKEN_WIDTH}`);
  }
});

test('an unknown token count blanks its half of the stats so the time column never moves', () => {
  const known = statsText(67, 8600);
  const unknown = statsText(67);
  assert.equal(measure(known), STATS_WIDTH);
  assert.equal(measure(unknown), STATS_WIDTH);
  assert.equal(measure(statsBlank()), STATS_WIDTH);
  assert.equal(known, ' 1m 07s · ↓  8.6k tokens');
  assert.match(unknown, /^ 1m 07s ·\s+$/);
});

// The defect that started this work: escape bytes counted as columns, so a red
// row was padded one cell less than a green one and slid left.
test('column math ignores ANSI bytes and paints afterwards', () => {
  assert.equal(measure(red('failed')), 6);
  assert.equal(measure(measure(green('●'))), 1);
  const width = 60;
  const rows = [alignRow([['   ', undefined], [red('●'), undefined], [' ', undefined], ['planner', undefined]], statsText(372, 12400), width),
    alignRow([['   ', undefined], [green('●'), undefined], [' ', undefined], ['scout', undefined]], statsText(67, 8600), width)];
  const arrows = rows.map(row => measure(row.slice(0, row.indexOf('↓'))));
  assert.deepEqual(arrows, [arrows[0], arrows[0]]);
  for (const row of rows) assert.equal(measure(row), width);
});

test('the left side is clamped while the stats stay intact, and narrow panes drop the stats', () => {
  const label = 'Read chain persistence and also everything else nearby';
  for (const width of [126, 80, 62, 48]) {
    const row = alignRow([['   ├ ● scout  ', undefined], [label, undefined]], statsText(67, 8600), width);
    assert.equal(measure(row), width, `width ${width}`);
    assert.match(row, /↓\s+8\.6k tokens$/);
  }
  const narrow = alignRow([['   ● scout  ', undefined], [label, undefined]], statsText(67, 8600), 24);
  assert.equal(measure(narrow) <= 24, true);
  assert.doesNotMatch(narrow, /tokens/);
});

test('cut is grapheme-safe and width-aware', () => {
  assert.equal(cut('abcdef', 3), 'abc');
  assert.equal(cut('abcdef', 0), '');
  assert.equal(cut('中文中文', 4), '中文');
  assert.equal(measure(cut('\x1b[31mabcdef\x1b[0m', 2)), 2);
});

test('wrapSegments breaks at spaces, keeps the hang indent, and preserves paint', () => {
  const painted = [['alpha beta ', 'dim'], ['gamma delta', 'muted']];
  const lines = wrapSegments(painted, 12, '  ');
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[0], [['alpha beta', 'dim']], 'trailing space dropped at the break');
  assert.deepEqual(lines[1], [['  ', null], ['gamma', 'muted']]);
  assert.deepEqual(lines[2], [['  ', null], ['delta', 'muted']]);
  for (const line of lines) assert.ok(measure(line.map(([text]) => text).join('')) <= 12);
});

test('wrapSegments hard-breaks a line with nothing to break on, and never loses a glyph', () => {
  const lines = wrapSegments([['x'.repeat(25), 'muted']], 10);
  assert.deepEqual(lines.map(line => line.map(([text]) => text).join('')), ['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
  assert.deepEqual(wrapSegments([], 10), []);
});

test('a token count of zero is blank, because nothing was measured', () => {
  const zero = statsText(8, 0), missing = statsText(8, undefined), counted = statsText(8, 15200);
  assert.equal(zero, missing, 'an unmeasured count keeps the block the same width');
  assert.equal(measure(zero), STATS_WIDTH);
  assert.doesNotMatch(zero, /↓/);
  assert.match(counted, /↓ 15\.2k tokens/);
});
