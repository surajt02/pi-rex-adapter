import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gridPlan, gridTree, windowPanes, paneCount, firstLeafIndex,
  floatingLayers, layerTakesSlot, windowOf } from '../src/grid.mjs';
import { applyGrid } from '../src/layout.mjs';

// Cell size is 16x30 px, so a 174x80 tab is 2784x2400 px: nearly square.
const frame = (columns, rows) => ({ columns, rows, cellWidth: 16, cellHeight: 30 });
const order = (blocks) => blocks.length === 1
  ? { block_id: blocks[0] }
  : { split: { direction: 'horizontal', ratio: 0.5, before: order([blocks[0]]), after: order(blocks.slice(1)) } };
const view = blocks => ({ windows: [{ window_id: 'w', layers: [{ kind: 'tiled', layout: order(blocks) }] }] });

// applyGrid arranges only this parent's panes and finds them in its own records,
// so a test run needs real sibling run.json files. `own` lists the blocks this
// parent owns; anything else in the tab is another Pi's pane.
async function parent(t, blocks, { block = blocks.at(-1), layout = { window: 'w', rows: [2, 2] }, own = blocks, closed = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'grid-own-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let dir;
  for (const [index, name] of own.entries()) {
    const id = `0000000${index}-0000-4000-8000-000000000000`;
    const at = join(root, id);
    await mkdir(at, { recursive: true });
    const record = { id, kind: 'agent', block: name, closed: closed.includes(name), layout: { role: 'agents' } };
    if (name === block) record.layout = { role: 'agents', ...layout };
    await writeFile(join(at, 'run.json'), JSON.stringify(record));
    if (name === block) dir = at;
  }
  return { rexSession: 'rex', block, dir, layout };
}

test('one to three agents are columns, and four onward is a grid', () => {
  const square = frame(174, 80);
  assert.deepEqual([1, 2, 3].map(n => gridPlan(n, square).rows), [[1], [2], [3]]);
  assert.deepEqual(gridPlan(4, square).rows, [2, 2]);
  assert.deepEqual(gridPlan(5, square).rows, [2, 3]);
  assert.deepEqual(gridPlan(6, square).rows, [3, 3]);
  assert.deepEqual(gridPlan(7, square).rows, [3, 4]);
  assert.deepEqual(gridPlan(8, square).rows, [4, 4]);
  assert.deepEqual(gridPlan(9, square).rows, [3, 3, 3]);
  assert.deepEqual(gridPlan(10, square).rows, [3, 3, 4]);
  assert.deepEqual(gridPlan(12, square).rows, [4, 4, 4]);
});

test('a wide tab prefers wide rows over more rows of squarer panes', () => {
  // 286x90 is 4576x2700 px, wide enough that two rows beat a 3x3 grid at nine.
  const wide = frame(286, 90);
  assert.deepEqual(gridPlan(5, wide).rows, [2, 3]);
  assert.deepEqual(gridPlan(6, wide).rows, [3, 3]);
  assert.deepEqual(gridPlan(8, wide).rows, [4, 4]);
  assert.deepEqual(gridPlan(9, wide).rows, [4, 5]);
  assert.deepEqual(gridPlan(12, wide).rows, [4, 4, 4]);
  // The same nine panes on the square tab instead want three rows of three.
  assert.deepEqual(gridPlan(9, frame(174, 80)).rows, [3, 3, 3]);
});

test('grid trees nest equal splits and index panes in reading order', () => {
  const tree = gridTree([2, 3]);
  assert.equal(tree.direction, 'vertical');
  assert.equal(tree.ratio, 0.5);
  assert.deepEqual(tree.before, { direction: 'horizontal', ratio: 0.5, before: { index: 0 }, after: { index: 1 } });
  assert.equal(tree.after.ratio, 1 / 3);
  assert.deepEqual(tree.after.after, { direction: 'horizontal', ratio: 0.5, before: { index: 3 }, after: { index: 4 } });
  assert.equal(firstLeafIndex(tree.after), 2);
  assert.equal(paneCount([2, 3]), 5);
  // A single row has no vertical wrapper: one pane, then a column per agent.
  assert.deepEqual(gridTree([1]), { index: 0 });
  assert.deepEqual(gridTree([3]), {
    direction: 'horizontal', ratio: 1 / 3, before: { index: 0 },
    after: { direction: 'horizontal', ratio: 0.5, before: { index: 1 }, after: { index: 2 } },
  });
});

test('window panes come from the tiled layer in reading order', () => {
  const floating = { kind: 'floating', layout: { block_id: 'float' } };
  const tiled = { kind: 'tiled', layout: { split: { direction: 'vertical', ratio: 0.5,
    before: { block_id: 'a' }, after: { split: { direction: 'horizontal', ratio: 0.5, before: { block_id: 'b' }, after: { block_id: 'c' } } } } } };
  assert.deepEqual(windowPanes({ windows: [{ window_id: 'w', layers: [floating, tiled] }] }, 'w'), ['a', 'b', 'c']);
  assert.deepEqual(windowPanes({ windows: [{ window_id: 'w', layers: [] }] }, 'w'), []);
  assert.deepEqual(windowPanes({ windows: [] }, 'w'), []);
});

function layoutClient(blocks, { failOn } = {}) {
  const calls = [], list = [...blocks];
  const drop = block => { const at = list.indexOf(block); if (at >= 0) list.splice(at, 1); };
  const insertAfter = (anchor, block) => { const at = list.indexOf(anchor); list.splice(at + 1, 0, block); };
  let moves = 0;
  return { calls, list,
    async view() { return view(list); },
    async detach(_session, block) { calls.push(['detach', block]); drop(block); },
    async move(_session, { block, anchor, direction, ratio }) {
      calls.push(['move', block, anchor, direction, ratio]);
      if (failOn && ++moves === failOn) throw new Error('Rex refused the move');
      drop(block); insertAfter(anchor, block);
    },
  };
}

test('a grid is built by detaching the panes and placing them back in reading order', async t => {
  const client = layoutClient(['a', 'b', 'c', 'd']);
  await applyGrid(client, await parent(t, ['a', 'b', 'c', 'd']));
  assert.deepEqual(client.calls.filter(call => call[0] === 'detach').map(call => call[1]), ['b', 'c', 'd']);
  // The newcomer takes the last cell, so the panes already there keep their order.
  assert.deepEqual(client.calls.filter(call => call[0] === 'move'), [
    ['move', 'c', 'a', 'vertical', 0.5],
    ['move', 'd', 'c', 'horizontal', 0.5],
    ['move', 'b', 'a', 'horizontal', 0.5],
  ]);
  assert.deepEqual(client.list, ['a', 'b', 'c', 'd']);
});

test('the grid is recomputed when the tab holds a different number of panes', async t => {
  const client = layoutClient(['a', 'b', 'c']);
  await applyGrid(client, await parent(t, ['a', 'b', 'c']));
  assert.deepEqual(client.calls.filter(call => call[0] === 'move'), [
    ['move', 'b', 'a', 'horizontal', 1 / 3],
    ['move', 'c', 'b', 'horizontal', 0.5],
  ]);
  assert.deepEqual(client.list, ['a', 'b', 'c']);
});

test('a failed re-tile puts the detached panes back instead of hiding them', async t => {
  const client = layoutClient(['a', 'b', 'c', 'd'], { failOn: 2 });
  await assert.rejects(
    applyGrid(client, await parent(t, ['a', 'b', 'c', 'd'])),
    /Rex refused the move/,
  );
  assert.deepEqual([...client.list].sort(), ['a', 'b', 'c', 'd']);
});

test('a single pane is left alone', async t => {
  const client = layoutClient(['a']);
  await applyGrid(client, await parent(t, ['a'], { layout: { window: 'w', rows: [1] } }));
  assert.deepEqual(client.calls, []);
});

test("a tab holding another parent's pane is left exactly as it is", async t => {
  // 'x' is not in this parent's records: rearranging around it would move a pane
  // this adapter does not own, so the provisional split stays where it landed.
  const client = layoutClient(['a', 'b', 'x', 'c']);
  await applyGrid(client, await parent(t, ['a', 'b', 'x', 'c'], { own: ['a', 'b', 'c'] }));
  assert.deepEqual(client.calls, []);
  assert.deepEqual(client.list, ['a', 'b', 'x', 'c']);
});

test('a pane whose own record is closed is no longer counted as ours', async t => {
  // 'a' finished and was retired, so the block still in the tab is not ours to
  // move and the newcomer is left where the split put it.
  const client = layoutClient(['a', 'b']);
  await applyGrid(client, await parent(t, ['a', 'b'], { closed: ['a'] }));
  assert.deepEqual(client.calls, []);
});

test('window and slot readers see floating layers and where a block lives', () => {
  const window = { window_id: 'w', layers: [
    { kind: 'tiled', layout: { block_id: 'a' }, blocks: [{ block_id: 'a' }] },
    { kind: 'floating', layer_id: 'l1', state: 'minimized', bounds: [0.54, 0.04, 0.44, 0.3], blocks: [{ block_id: 'b' }] },
  ] };
  const view = { windows: [window] };
  assert.equal(windowOf(view, 'b'), 'w');
  assert.equal(windowOf(view, 'nope'), undefined);
  assert.deepEqual(floatingLayers(view, 'w'), [{ layer: 'l1', state: 'minimized', bounds: [0.54, 0.04, 0.44, 0.3] }]);
  assert.deepEqual(floatingLayers(view, 'other'), []);
  // A slot is taken by anything overlapping it, so a chip the user resized keeps
  // reserving the space it covers.
  assert.equal(layerTakesSlot([0.54, 0.04, 0.44, 0.3], [0.54, 0.04, 0.44, 0.3]), true);
  assert.equal(layerTakesSlot([0.6, 0.1, 0.2, 0.1], [0.54, 0.04, 0.44, 0.3]), true);
  assert.equal(layerTakesSlot([0.54, 0.36, 0.44, 0.3], [0.54, 0.04, 0.44, 0.3]), false);
  assert.equal(layerTakesSlot(undefined, [0.54, 0.04, 0.44, 0.3]), false);
});
