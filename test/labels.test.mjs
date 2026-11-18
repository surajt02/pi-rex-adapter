import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_LABEL_WORDS, MAX_NAME_CHARS, MAX_NAME_WORDS, checkLabel, checkName, deriveLabel, requireLabel, resolveLabel } from '../src/labels.mjs';

test('a label is one line of six words or fewer, and seven is an error rather than a silent trim', () => {
  assert.deepEqual(checkLabel('Read chain persistence'), { ok: true, label: 'Read chain persistence' });
  assert.deepEqual(checkLabel('  Plan   reload   recovery '), { ok: true, label: 'Plan reload recovery' });
  assert.equal(checkLabel('one two three four five six').ok, true);
  const many = checkLabel('Review the plan against the code and tests');
  assert.equal(many.ok, false);
  assert.match(many.reason, new RegExp(`must be ${MAX_LABEL_WORDS} words or fewer, got 8`));
  assert.match(many.reason, /"Review the plan against the code and tests"/);
  assert.equal(checkLabel('').ok, false);
  assert.match(checkLabel('').reason, /required/);
  assert.equal(checkLabel('two\nlines').ok, false);
  assert.match(checkLabel('two\nlines').reason, /single line/);
  assert.equal(checkLabel(undefined).ok, false);
});

test('requireLabel throws the reason with the caller-supplied prefix', () => {
  assert.equal(requireLabel('Scan changelog', 'Step 2: '), 'Scan changelog');
  assert.throws(() => requireLabel('a b c d e f g', 'Step 2: '), /^Error: Step 2: label must be 6 words or fewer, got 7/);
});

// The derivation is the degraded path for runs and commands without a label.
// It must read as a statement: no ellipsis, no dangling preposition.
test('derived labels cut at the stated goal and never end in an ellipsis or a function word', () => {
  const cases = [
    ["Map how a pipeline's chain state is persisted and recovered: read src/chain.mjs", "Map how a pipeline's chain state"],
    ["Using the scout's map, decide whether a chain survives a /reload at each moment.", "Using the scout's map, decide"],
    ['Review the plan for reload safety of the pipeline feature. Check its claims', 'Review the plan for reload safety'],
    ['Research the reload semantics of Pi extensions', 'Research the reload semantics of Pi'],
    ['Write probe script', 'Write probe script'],
    ['- Fix the widget so that stats align with the labels', 'Fix the widget so that stats'],
  ];
  for (const [task, expected] of cases) assert.equal(deriveLabel(task), expected);
  for (const [task] of cases) {
    const label = deriveLabel(task);
    assert.doesNotMatch(label, /…/);
    assert.ok(label.split(/\s+/).length <= MAX_LABEL_WORDS, label);
    assert.doesNotMatch(label, /\b(the|a|of|and|to|for|is)$/i, label);
  }
});

test('derivation survives empty, banner and CJK tasks without producing an empty label', () => {
  assert.equal(deriveLabel(''), 'Task');
  assert.equal(deriveLabel(undefined), 'Task');
  assert.equal(deriveLabel('1. Inspect the reducers'), 'Inspect the reducers');
  const cjk = deriveLabel('检查磁盘使用情况并报告');
  assert.ok(cjk.length > 0);
  assert.doesNotMatch(cjk, /…/);
});

test('resolveLabel prefers an explicit label and falls back to the task', () => {
  assert.equal(resolveLabel({ label: 'Read chain persistence', task: 'whatever' }), 'Read chain persistence');
  assert.equal(resolveLabel({ task: 'Write probe script' }), 'Write probe script');
  assert.equal(resolveLabel({ label: 'too many words in this label here', task: 'Write probe script' }), 'Write probe script');
  assert.equal(resolveLabel({}), 'Task');
});

test('a name is one line of two words or fewer, and three is an error rather than a silent cut', () => {
  assert.deepEqual(checkName('auth-research'), { ok: true, name: 'auth-research' });
  assert.deepEqual(checkName('auth research'), { ok: true, name: 'auth research' });
  assert.deepEqual(checkName('  auth   research '), { ok: true, name: 'auth research' });
  const many = checkName('map the authentication flow');
  assert.equal(many.ok, false);
  assert.match(many.reason, new RegExp(`must be ${MAX_NAME_WORDS} words or fewer, got 4`));
  assert.match(many.reason, /"map the authentication flow"/);
  assert.equal(checkName('auth\nresearch').ok, false);
  // A launch without a name is normal: it is named from its task instead.
  assert.deepEqual(checkName(''), { ok: true, name: undefined });
  assert.deepEqual(checkName(undefined), { ok: true, name: undefined });
});

test('a handle long enough to push the goal out of its column is not a handle', () => {
  const long = 'supercalifragilisticexpialidocious';
  const check = checkName(long);
  assert.equal(check.ok, false);
  assert.match(check.reason, new RegExp(`must be ${MAX_NAME_CHARS} characters or fewer, got ${long.length}`));
  const atLimit = 'a'.repeat(MAX_NAME_CHARS);
  assert.deepEqual(checkName(atLimit), { ok: true, name: atLimit });
  assert.equal(checkName('a'.repeat(MAX_NAME_CHARS + 1)).ok, false);
});
