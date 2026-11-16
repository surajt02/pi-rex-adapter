// A label is the short goal phrase the parent pane shows for a task: six words
// at most, one line, never truncated with an ellipsis. The parent writes it when
// it launches the task, because only the parent knows the goal in six words.
//
// Derivation below is the degraded safety net, not the main path: it exists for
// runs that predate the field and for commands (/rex-agent) that take no
// arguments. It is deliberately conservative and will sometimes read badly; the
// fix for a bad derived label is to pass an explicit one.

export const MAX_LABEL_WORDS = 6;

// Words that make a label read like a cut-off sentence.
const TRAILING = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'how', 'in', 'into',
  'is', 'its', 'of', 'on', 'or', 'the', 'their', 'then', 'to', 'vs', 'what', 'when', 'whether', 'which', 'with']);
const BREAK = /[:;.!?—]|(?:\s-\s)/;
const MARKER = /^(?:[-*•#>]+|\d+[.)])\s+/;

export function labelWords(text) {
  return String(text ?? '').trim().split(/\s+/).filter(Boolean);
}

// Validation is strict on purpose: silently trimming a seven-word label would
// hide the truncation the label exists to prevent.
export function checkLabel(value) {
  const raw = String(value ?? '');
  if (/[\r\n\u0000-\u001f\u007f]/.test(raw)) return { ok: false, reason: 'label must be a single line of plain text' };
  const text = raw.trim().replace(/\s+/g, ' ');
  if (!text) return { ok: false, reason: 'label is required: describe the goal in six words or fewer' };
  const count = labelWords(text).length;
  if (count > MAX_LABEL_WORDS) {
    return { ok: false, reason: `label must be ${MAX_LABEL_WORDS} words or fewer, got ${count}: "${text}"` };
  }
  return { ok: true, label: text };
}

export function requireLabel(value, where = '') {
  const check = checkLabel(value);
  if (!check.ok) throw new Error(`${where}${check.reason}`);
  return check.label;
}

export function deriveLabel(task) {
  const first = String(task ?? '').split('\n').map(line => line.trim()).find(Boolean) || '';
  const text = first.replace(MARKER, '').replace(/\s+/g, ' ').trim();
  if (!text) return 'Task';
  // A stated goal usually ends at punctuation; prefer that whole statement.
  const stop = BREAK.exec(text);
  const candidate = stop && stop.index >= 8 ? text.slice(0, stop.index) : text;
  let parts = labelWords(candidate);
  if (parts.length > MAX_LABEL_WORDS) {
    parts = parts.slice(0, MAX_LABEL_WORDS);
    while (parts.length > 1 && TRAILING.has(parts.at(-1).toLowerCase().replace(/[,;:.]+$/, ''))) parts.pop();
  }
  return parts.join(' ').replace(/[,;:.]+$/, '').trim() || 'Task';
}

export function resolveLabel(run) {
  const explicit = checkLabel(run?.label);
  return explicit.ok ? explicit.label : deriveLabel(run?.task);
}
