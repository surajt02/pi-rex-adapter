import { stripVTControlCharacters } from 'node:util';
import { fit, plain } from './overview.mjs';
import { t } from './i18n.mjs';

const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export function wrapText(value, width) {
  const clean = stripVTControlCharacters(String(value ?? '')).replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ');
  const lines = [];
  for (const source of clean.split('\n')) {
    let line = '', used = 0;
    for (const { segment } of segments.segment(source)) {
      const size = /^[\x20-\x7e]+$/.test(segment) ? segment.length : 2;
      if (used + size > width && line) { lines.push(width >= 2 ? line : fit(line, width)); line = ''; used = 0; }
      line += segment; used += size;
    }
    lines.push(width >= 2 ? line : fit(line, width));
  }
  return lines;
}

// Terminal columns for padding the opaque rectangle, including CJK and emoji.
export function cellWidth(text) {
  let width = 0;
  for (const { segment } of segments.segment(stripVTControlCharacters(text))) {
    const c = segment.codePointAt(0);
    if (/^[\p{Mark}\u200d\ufe0f]+$/u.test(segment)) continue;
    const wide = /\p{Emoji_Presentation}|\p{Regional_Indicator}|\u20e3|\ufe0f/u.test(segment) ||
      c >= 0x1100 && (c <= 0x115f || c === 0x2329 || c === 0x232a ||
      c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f || c >= 0xac00 && c <= 0xd7a3 ||
      c >= 0xf900 && c <= 0xfaff || c >= 0xfe10 && c <= 0xfe19 || c >= 0xfe30 && c <= 0xfe6f ||
      c >= 0xff00 && c <= 0xff60 || c >= 0xffe0 && c <= 0xffe6 || c >= 0x20000 && c <= 0x3fffd);
    width += wide ? 2 : 1;
  }
  return width;
}
// Truncate to a display width without collapsing internal runs of spaces, so an
// inline hint keeps the gaps that make "Enter Confirm" readable. The overlay
// path goes through `fit` instead, which normalises whitespace by design.
export function clip(value, width) {
  const clean = stripVTControlCharacters(String(value ?? '')).replace(/\r\n?/g, ' ')
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ');
  if (width <= 0) return '';
  if (cellWidth(clean) <= width) return clean;
  let output = '', used = 0;
  for (const { segment } of segments.segment(clean)) {
    const size = /^[\x20-\x7e]+$/.test(segment) ? segment.length : 2;
    if (used + size > width - 1) break;
    output += segment; used += size;
  }
  return output + '…';
}

const rgb = (r, g, b) => ({ kind: 'rgb', r, g, b });
const palette = { background: rgb(21, 29, 38), border: rgb(79, 103, 125),
  title: rgb(177, 198, 216), text: rgb(205, 215, 225), hint: rgb(140, 157, 174),
  selected: rgb(40, 60, 79), selectedText: rgb(227, 237, 246) };

// Chord matching for the one shortcut an overlay can own without registering a
// global keybinding. This package has no dependencies, so Pi's Keymap is not
// available here; only `ctrl+<letter>` is understood, in the three encodings a
// terminal may send: the legacy control byte (ctrl+n is 0x0e), Kitty CSI-u
// (`ESC [ 110 ; 5 u`, with an optional `:1`/`:3` event suffix) and xterm
// modifyOtherKeys (`ESC [ 27 ; 5 ; 110 ~`). A modifier of 5 is 1 + ctrl.
const CHORD = /^ctrl\+([a-z])$/i;
const CONTROL_MODIFIER = 5;
export function matchesChord(data, chord) {
  const letter = CHORD.exec(String(chord ?? ''))?.[1]?.toLowerCase();
  if (!letter || typeof data !== 'string') return false;
  const code = letter.charCodeAt(0);
  if (data === String.fromCharCode(code - 96)) return true;
  const kitty = /^\x1b\[(\d+);(\d+)(?::\d+)?u$/.exec(data);
  if (kitty) return Number(kitty[1]) === code && Number(kitty[2]) === CONTROL_MODIFIER;
  const xterm = /^\x1b\[27;(\d+);(\d+)~$/.exec(data);
  return Boolean(xterm) && Number(xterm[2]) === code && Number(xterm[1]) === CONTROL_MODIFIER;
}

// One native Pi overlay for menus and scrollable text. Never appends messages
// or notifications to the transcript. Uses Pi's configured keybindings.
export function dialogComponent({ tui, theme, keys, done, title, choices, text, description = '', state = {},
  language = 'en' }) {
  let selected = Math.max(0, choices?.findIndex(item => item.value === state.value) ?? 0);
  let offset = state.offset || 0, capacity = 10, lineCount = 0, closed = false;
  const remember = () => { state.value = choices?.[selected]?.value; state.offset = offset; };
  const finish = value => {
    if (closed) return;
    closed = true; remember(); done(value);
  };
  const paint = (value, color = 'text', selected = false, bold = false) => theme?.style
    ? theme.style(value, { fg: palette[color], bg: selected ? palette.selected : palette.background, bold }) : value;
  const match = (data, action) => keys.matches(data, `tui.select.${action}`);
  return {
    focused: true,
    render(width) {
      if (width <= 0) return [];
      const height = Math.max(5, Math.floor((tui.terminal?.rows || 24) * 0.8));
      const framed = width >= 6;
      const inner = framed ? width - 2 : width;
      const padding = width >= 32 ? 2 : framed ? 1 : 0;
      const contentWidth = Math.max(1, inner - padding * 2);
      const roomy = height >= 12 && width >= 32;
      const intro = description ? wrapText(description, contentWidth).slice(0, roomy ? 2 : 1) : [];
      capacity = Math.max(1, height - 4 - (roomy ? 3 : 0) - intro.length);
      const body = choices ? choices.map((item, i) => `${i === selected ? '›' : ' '} ${plain(item.label)}`)
        : wrapText(text, contentWidth);
      lineCount = body.length;
      if (choices) offset = Math.max(0, Math.min(offset, selected));
      if (choices && selected >= offset + capacity) offset = selected - capacity + 1;
      offset = Math.max(0, Math.min(offset, Math.max(0, lineCount - capacity)));
      remember();
      const row = (value = '', color = 'text', highlighted = false, bold = false) => {
        // Viewer lines are already wrapped; preserve their code/log indentation.
        const clipped = cellWidth(value) <= contentWidth ? value : fit(value, contentWidth);
        const padded = ' '.repeat(padding) + clipped + ' '.repeat(Math.max(0, inner - padding - cellWidth(clipped)));
        return (framed ? paint('│', 'border') : '') + paint(padded, color, highlighted, bold) + (framed ? paint('│', 'border') : '');
      };
      const edge = (left, right) => paint(framed ? left + '─'.repeat(inner) + right : '─'.repeat(width), 'border');
      const visible = body.slice(offset, offset + capacity).map((line, i) =>
        row(line, choices && offset + i === selected ? 'selectedText' : 'text', Boolean(choices && offset + i === selected)));
      const hint = choices ? t(language, 'selectHint')
        : `${t(language, 'scrollHint')}   ${Math.min(offset + 1, lineCount)}/${lineCount}`;
      return [edge('╭', '╮'), ...(roomy ? [row()] : []), row(plain(title), 'title', false, true),
        ...intro.map(line => row(line, 'hint')), ...(roomy ? [row()] : []), ...visible,
        ...(roomy ? [row()] : []), row(fit(hint, contentWidth), 'hint'), edge('╰', '╯')];
    },
    handleInput(data) {
      if (closed) return;
      if (match(data, 'cancel')) return finish(undefined);
      if (choices && match(data, 'confirm')) return finish(choices[selected]?.value);
      let delta = 0;
      if (match(data, 'up')) delta = -1;
      if (match(data, 'down')) delta = 1;
      if (match(data, 'pageUp')) delta = -capacity;
      if (match(data, 'pageDown')) delta = capacity;
      if (choices) selected = Math.max(0, Math.min(choices.length - 1, selected + delta));
      else offset = Math.max(0, Math.min(Math.max(0, lineCount - capacity), offset + delta));
      remember(); tui.requestRender();
    },
    close() { finish(undefined); },
    invalidate() {},
  };
}
// The side-conversation picker, styled the way Pi's own model picker is: theme
// border rules and a `→` cursor, no overlay box and no background fill. Kept
// out of `dialogComponent` so the task-manager overlay can be restyled alone.
export function nativePickerComponent({ tui, theme, keys, done, title = '', choices = [], canCreate = false,
  state = {}, language = 'en', hotkeys }) {
  let selected = Math.max(0, choices.findIndex(choice => choice.value === state.value));
  let offset = state.offset || 0, capacity = 1, closed = false;
  const fg = (color, text) => (color && theme?.fg ? theme.fg(color, text) : text);
  const bold = text => (theme?.bold ? theme.bold(text) : text);
  const remember = () => { state.value = choices[selected]?.value; state.offset = offset; };
  const finish = value => {
    if (closed) return;
    closed = true; remember(); done(value);
  };
  const match = (data, action) => keys.matches(data, `tui.select.${action}`);
  return {
    focused: true,
    render(width) {
      if (width <= 0) return [];
      // Rule, title, blank, rows, blank, "Selected", blank, hint, rule.
      capacity = Math.max(1, Math.max(9, tui.terminal?.rows || 24) - 9);
      if (selected >= offset + capacity) offset = selected - capacity + 1;
      offset = Math.max(0, Math.min(offset, Math.max(0, choices.length - capacity)));
      remember();
      // Style per segment and trim only the part that overflows, so the
      // ANSI-stripping width helpers never see an escape sequence.
      const line = segments => {
        let out = '', left = width;
        for (const [color, text] of segments) {
          if (left <= 0 || !text) continue;
          const part = cellWidth(text) <= left ? text : clip(text, left);
          out += fg(color, part);
          left -= cellWidth(part);
        }
        return out;
      };
      const lines = [fg('border', '─'.repeat(width)),
        fg('accent', bold(clip(` ${plain(title)}`, width))), ''];
      for (const [index, choice] of choices.slice(offset, offset + capacity).entries()) {
        const highlighted = offset + index === selected;
        lines.push(line([
          ['', '  '],
          ['accent', highlighted ? '→ ' : '  '],
          [highlighted ? 'accent' : undefined, plain(choice.label)],
          ...(choice.detail ? [['muted', ` · ${plain(choice.detail)}`]] : []),
        ]));
      }
      if (choices.length > capacity) lines.push(fg('muted', `  (${selected + 1}/${choices.length})`));
      const current = choices[selected];
      lines.push('', fg('muted', `  ${t(language, 'pickerSelected', { name: plain(current?.full ?? current?.label ?? '') })}`), '');
      lines.push(line([
        ['', '  '],
        ['dim', 'Enter'], ['muted', ` ${t(language, 'pickerSelect')}`], ['muted', ' · '],
        ...(canCreate ? [['dim', 'Ctrl+N'], ['muted', ` ${t(language, 'pickerNewAction')}`], ['muted', ' · ']] : []),
        ['dim', 'Esc'], ['muted', ` ${t(language, 'pickerCancel')}`],
      ]));
      lines.push(fg('border', '─'.repeat(width)));
      return lines;
    },
    handleInput(data) {
      if (closed) return;
      if (hotkeys) {
        for (const [chord, value] of Object.entries(hotkeys)) if (matchesChord(data, chord)) return finish(value);
      }
      if (match(data, 'cancel')) return finish(undefined);
      if (match(data, 'confirm')) return finish(choices[selected]?.value);
      let delta = 0;
      if (match(data, 'up')) delta = -1;
      if (match(data, 'down')) delta = 1;
      if (match(data, 'pageUp')) delta = -capacity;
      if (match(data, 'pageDown')) delta = capacity;
      selected = Math.max(0, Math.min(choices.length - 1, selected + delta));
      remember(); tui.requestRender();
    },
    close() { finish(undefined); },
    invalidate() {},
  };
}

export function createDialogs(getLanguage = () => 'en') {
  const dismissals = new Set();
  const show = async (ctx, config) => {
    if (!ctx.hasUI) return;
    let dismiss;
    try {
      return await ctx.ui.custom((tui, theme, keys, done) => {
        const component = dialogComponent({ tui, theme, keys, done, language: getLanguage(), ...config });
        dismiss = () => component.close(); dismissals.add(dismiss);
        return component;
      }, { overlay: true, overlayOptions: { width: 84, maxHeight: '80%', anchor: 'center', margin: 1 } });
    } finally { dismissals.delete(dismiss); }
  };
  // Inline custom UI, like Pi's own pickers: it owns the editor area, so there
  // are no overlay options to pass.
  const showNative = async (ctx, config) => {
    if (!ctx.hasUI) return;
    let dismiss;
    try {
      return await ctx.ui.custom((tui, theme, keys, done) => {
        const component = nativePickerComponent({ tui, theme, keys, done, language: getLanguage(), ...config });
        dismiss = () => component.close(); dismissals.add(dismiss);
        return component;
      });
    } finally { dismissals.delete(dismiss); }
  };
  return {
    select: (ctx, title, choices, options = {}) => show(ctx, { title, choices, ...options }),
    pick: (ctx, choices, options = {}) => showNative(ctx, { choices, ...options }),
    view: (ctx, title, text) => show(ctx, { title, text }),
    closeAll() { for (const dismiss of dismissals) dismiss(); dismissals.clear(); },
  };
}
