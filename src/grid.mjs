// Agents share one tab, and that tab is a grid: rows of equal panes. The agent
// count decides how many panes sit in a row, and the tab's size in pixels
// decides how many rows, because a wide window wants wide rows and a square one
// wants square cells. One, two and three agents stay on a single row so each new
// agent only adds a column; from four the tab becomes a grid.
const FALLBACK_FRAME = Object.freeze({ columns: 174, rows: 80, cellWidth: 16, cellHeight: 30 });

export function normalizeFrame(frame) {
  const pick = (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback);
  return {
    columns: pick(frame?.columns, FALLBACK_FRAME.columns),
    rows: pick(frame?.rows, FALLBACK_FRAME.rows),
    cellWidth: pick(frame?.cellWidth, FALLBACK_FRAME.cellWidth),
    cellHeight: pick(frame?.cellHeight, FALLBACK_FRAME.cellHeight),
  };
}

// A pane's shape is judged in pixels: a 58x36 pane is taller than it is wide
// while 87x27 is wider than it is tall, so counting cells alone misleads.
function worstAspect(counts, width, height) {
  const rowHeight = height / counts.length;
  let worst = 0;
  for (const count of counts) {
    const paneWidth = width / count;
    worst = Math.max(worst, paneWidth / rowHeight, rowHeight / paneWidth);
  }
  return worst;
}

// Rows are filled evenly and the spare panes go to the lower rows, so five
// agents read as two on top and three below.
export function gridPlan(count, frame) {
  const total = Math.max(1, Math.trunc(count));
  const size = normalizeFrame(frame);
  const width = size.columns * size.cellWidth, height = size.rows * size.cellHeight;
  if (total <= 3) return { rows: [total], worst: worstAspect([total], width, height) };
  let best;
  for (let rowCount = 1; rowCount <= total; rowCount++) {
    const base = Math.floor(total / rowCount), extra = total % rowCount;
    const counts = [...Array(rowCount - extra).fill(base), ...Array(extra).fill(base + 1)];
    const worst = worstAspect(counts, width, height);
    // Equal worst aspect keeps the shape with fewer rows, so rows only appear
    // when they actually make the panes better.
    if (!best || worst < best.worst - 1e-9 || (worst - best.worst <= 1e-9 && counts.length < best.rows.length)) {
      best = { rows: counts, worst };
    }
  }
  return best;
}

export function paneCount(rows) {
  return (rows || []).reduce((sum, count) => sum + count, 0);
}

// Rex splits one side at a time, so equal panes are nested splits: the first
// pane takes 1/count of the space and the rest share what is left.
function equalRow(count, offset) {
  if (count <= 1) return { index: offset };
  return {
    direction: 'horizontal', ratio: 1 / count,
    before: { index: offset }, after: equalRow(count - 1, offset + 1),
  };
}

// The tree leaves carry their position in reading order, which is the order the
// panes have on screen: rows top to bottom, panes left to right.
export function gridTree(rows) {
  const build = (counts, offset) => {
    if (counts.length === 1) return equalRow(counts[0], offset);
    return {
      direction: 'vertical', ratio: 1 / counts.length,
      before: equalRow(counts[0], offset),
      after: build(counts.slice(1), offset + counts[0]),
    };
  };
  return build(rows && rows.length ? rows : [1], 0);
}

export function firstLeafIndex(node) {
  let current = node;
  while (current && current.index === undefined) current = current.before;
  return current.index;
}

// Panes in reading order for one window, taken from the tiled layer so a
// floating pane elsewhere in the window never disturbs the grid.
export function windowPanes(view, windowId) {
  const window = (view?.windows || []).find(w => w?.window_id === windowId);
  const layers = window?.layers || [];
  const layer = layers.find(l => l?.kind === 'tiled' && l.layout) || layers.find(l => l?.layout);
  const order = [];
  const walk = node => {
    if (!node) return;
    if (typeof node.block_id === 'string') { order.push(node.block_id); return; }
    walk(node.split?.before);
    walk(node.split?.after);
  };
  walk(layer?.layout);
  return order;
}

// Reading a window's floating layers lets a chip avoid another parent's chip
// that happens to sit at the same bounds.
export function floatingLayers(view, windowId) {
  const window = (view?.windows || []).find(w => w?.window_id === windowId);
  return (window?.layers || []).filter(layer => layer?.kind === 'floating' && Array.isArray(layer.bounds))
    .map(layer => ({ layer: layer.layer_id, state: layer.state || 'normal', bounds: layer.bounds }));
}

// The window a block is in right now, which is how a chip finds the window of
// the pane it belongs beside without trusting a recorded value.
export function windowOf(view, block) {
  for (const window of view?.windows || []) {
    for (const layer of window?.layers || []) {
      for (const entry of layer?.blocks || []) if (entry?.block_id === block) return window.window_id;
    }
  }
  return undefined;
}

// A slot is taken when a layer overlaps it at all: a chip the user moved or
// resized still reserves the space it covers, not just its original rectangle.
export function layerTakesSlot(bounds, slot, epsilon = 1e-6) {
  if (!Array.isArray(bounds) || bounds.length !== 4 || bounds.some(value => !Number.isFinite(value))) return false;
  const [x, y, w, h] = bounds, [sx, sy, sw, sh] = slot;
  return Math.min(x + w, sx + sw) - Math.max(x, sx) > epsilon
    && Math.min(y + h, sy + sh) - Math.max(y, sy) > epsilon;
}
