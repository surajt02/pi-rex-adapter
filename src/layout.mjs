import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJson, listRuns, readJson, runStatus } from './core.mjs';
import { firstLeafIndex, floatingLayers, gridPlan, gridTree, layerTakesSlot, paneCount, windowOf, windowPanes } from './grid.mjs';

export { withLayoutLock } from './core.mjs';
import { missingBlock, recordLifecycle } from './lifecycle.mjs';

// Called under the parent's layout lock, only while choosing/reusing a pane.
// Keep ambiguous failures blocking; an exited process plus an explicitly absent
// block is enough to retire the stale record without sending another close.
async function inspectOrRetire(client, run, signal) {
  try { return await client.inspect(run, signal); }
  catch (error) {
    signal?.throwIfAborted();
    if (error.code !== 'REX_BLOCK_NOT_FOUND' || error.block !== run.block || error.rexSession !== run.rexSession) throw error;
    if (run.runtime === 'direct-pi' && missingBlock(error, run)) {
      await recordLifecycle(run, { closed: true }, signal);
      return undefined;
    }
    const [latest, exit, result] = await Promise.all(['run', 'exit', 'result'].map(name => readJson(join(run.dir, `${name}.json`))));
    signal?.throwIfAborted();
    if (!latest || latest.id !== run.id || latest.block !== run.block || latest.rexSession !== run.rexSession ||
        !exit || !(exit.code === null || Number.isInteger(exit.code))) throw error;
    Object.assign(run, latest, { closed: true, completedBeforeClose: true,
      resolvedAt: new Date().toISOString(), resolution: 'Rex confirmed block absent; process exit record exists.' });
    run.status = runStatus(run, exit, result);
    await atomicJson(join(run.dir, 'run.json'), run);
    return undefined;
  }
}

export async function existingBtw(root, client, options) {
  const { signal } = options;
  signal?.throwIfAborted();
  const candidates = (await listRuns(root)).filter(r => r.kind === 'btw' && !r.closed && r.rexSession === options.rexSession);
  for (const run of candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const exit = await readJson(join(run.dir, 'exit.json'));
    if (!run.block) throw new Error(`BTW launch ${run.id} is unresolved; inspect Rex before retrying.`);
    const actual = await inspectOrRetire(client, run, signal);
    if (!actual) continue;
    signal?.throwIfAborted();
    run.window = actual.window;
    if (exit && options.task) {
      await client.control(run, 'close', signal);
      run.closed = true; run.completedBeforeClose = true;
      await atomicJson(join(run.dir, 'run.json'), run);
      continue;
    }
    if (options.task) {
      if (run.inputProtocol !== 1) throw new Error('Reload this existing BTW Pi to enable question delivery, or close it and start a new BTW.');
      if ((options.cwd && options.cwd !== run.cwd) || (options.model && options.model !== run.model)) {
        throw new Error('Existing BTW uses another cwd/model. Close it before starting a new conversation.');
      }
      const request = randomUUID();
      signal?.throwIfAborted();
      await atomicJson(join(run.dir, `input-${request}.json`), { id: request, text: options.task, createdAt: new Date().toISOString() });
      return { id: run.id, block: run.block, window: run.window, reused: true, request, status: 'queued', artifacts: run.dir };
    }
    await client.control(run, 'focus', signal);
    return { id: run.id, block: run.block, window: run.window, reused: true, status: 'focused', artifacts: run.dir };
  }
}

// Every live sibling of the same kind, inspected, with the window it is in now.
async function liveMembers(root, client, run, role, signal) {
  const members = (await listRuns(root)).filter(r => r.id !== run.id && r.layout?.role === role && r.rexSession === run.rexSession);
  const live = [];
  for (const member of members) {
    if (member.closed) continue;
    if (!member.block) throw new Error(`Layout acquisition ${member.id} is unresolved; inspect Rex before launching more ${role}.`);
    const actual = await inspectOrRetire(client, member, signal);
    if (!actual) continue;
    signal?.throwIfAborted();
    live.push({ member, window: actual.window });
  }
  return live;
}

export async function choosePlacement(root, client, run, signal) {
  signal?.throwIfAborted();
  if (run.kind === 'btw') {
    const parent = await client.inspect({ rexSession: run.rexSession, block: run.anchor }, signal);
    return { role: 'btw', mode: 'split', anchor: run.anchor, direction: 'right', window: parent.window };
  }
  const role = run.kind === 'agent' ? 'agents' : 'jobs';
  const live = await liveMembers(root, client, run, role, signal);
  if (role === 'agents') return agentsPlacement(run, live, client, signal);
  return chipPlacement(run, live, client, signal);
}

// Agents never spill into an "Agents 2" tab: the whole group grows in one grid
// and a crowded tab is read by zooming, not by paging. The tab we manage is the
// window most live agents still sit in, so a pane the user dragged somewhere
// else is left alone and never counted.
async function agentsPlacement(run, live, client, signal) {
  const title = `Agents · ${run.owner.slice(0, 8)}`;
  const recorded = new Map();
  for (const { member } of live) {
    const window = member.layout.window;
    if (typeof window === 'string') recorded.set(window, (recorded.get(window) || 0) + 1);
  }
  const window = [...recorded].sort((a, b) => b[1] - a[1])[0]?.[0];
  const panes = live.filter(entry => entry.window === window).map(entry => entry.member.block);
  if (!window || !panes.length) return { role: 'agents', mode: 'window', title };
  // The tab is the same size as the tab it was opened from, so the parent pane
  // is the frame both for choosing the grid and for repairing it after launch.
  const frame = await client.size({ rexSession: run.rexSession, block: run.anchor }, signal);
  signal?.throwIfAborted();
  const plan = gridPlan(panes.length + 1, frame);
  return { role: 'agents', mode: 'grid', window, anchor: panes[0], direction: 'right', rows: plan.rows, frame, title };
}

// A background job is a chip: a floating layer, minimized from the moment it
// exists, so it never takes room from the pane the user is reading. These are
// where a chip sits when it is popped open again; several jobs stack down the
// right side instead of covering each other.
const CHIP_SLOTS = Object.freeze([
  [0.54, 0.04, 0.44, 0.3],
  [0.54, 0.36, 0.44, 0.3],
  [0.54, 0.68, 0.44, 0.3],
]);

async function chipPlacement(run, live, client, signal) {
  const taken = new Set(live.filter(entry => entry.member.layout?.mode === 'chip')
    .map(entry => entry.member.layout.slot).filter(slot => Number.isInteger(slot)));
  const placement = { role: 'jobs', mode: 'chip', anchor: run.anchor, slot: 0, bounds: CHIP_SLOTS[0] };
  // The chip belongs to the window the parent pane is in, which the layer has to
  // be told up front. Without it the server would use the active window, which
  // is usually the same one; an unreachable parent is reported by the launch.
  try {
    const view = await client.view(run.rexSession, signal);
    const window = windowOf(view, run.anchor);
    if (window) {
      placement.window = window;
      // Count every floating layer in that window, not only this parent's chips:
      // another Pi may already have a chip sitting on one of these slots.
      for (const layer of floatingLayers(view, window)) {
        CHIP_SLOTS.forEach((slot, index) => { if (layerTakesSlot(layer.bounds, slot)) taken.add(index); });
      }
    }
  } catch (error) { if (signal?.aborted) throw error; }
  const free = CHIP_SLOTS.findIndex((_, index) => !taken.has(index));
  placement.slot = free === -1 ? taken.size % CHIP_SLOTS.length : free;
  placement.bounds = CHIP_SLOTS[placement.slot];
  return placement;
}

// The job is split in beside the parent pane and then floated out of the tiled
// layout, which gives the parent its space back at once. Minimizing is what
// turns it into a chip; the block keeps running either way.
export async function applyChip(client, run, signal) {
  const layout = run.layout || {};
  if (!layout.layer) {
    // A chip created by the fallback split is still a tiled pane at this point.
    const { layer_id: layer } = await client.float(run.rexSession, run.block, layout.bounds, signal);
    layout.layer = layer;
    signal?.throwIfAborted();
  }
  await client.minimize(run.rexSession, layout.layer, signal);
}

// Rex can only split the side of one pane at a time, so a grid is built by
// detaching the group and placing the panes back in reading order. The newcomer
// always takes the last cell, which keeps existing panes in their cells.
async function placeTree(client, session, node, order, anchor, signal) {
  if (!node || node.index !== undefined) return;
  const block = order[firstLeafIndex(node.after)];
  if (!block) throw new Error('Grid placement ran out of panes.');
  await client.move(session, { block, anchor, direction: node.direction, ratio: node.ratio }, signal);
  signal?.throwIfAborted();
  await placeTree(client, session, node.after, order, block, signal);
  await placeTree(client, session, node.before, order, anchor, signal);
}

// A pane that stays detached is invisible but still running, which loses a
// child's pane without telling anyone. Put any straggler back beside the first
// pane before reporting the failure.
async function rescue(client, session, window, order) {
  const placed = new Set(windowPanes(await client.view(session), window));
  for (const block of order) {
    if (placed.has(block)) continue;
    await client.move(session, { block, anchor: order[0], direction: 'horizontal', ratio: 0.5 });
  }
}

export async function applyGrid(client, run, signal) {
  const layout = run.layout || {};
  const session = run.rexSession, window = layout.window;
  const view = await client.view(session, signal);
  const all = windowPanes(view, window);
  const mine = await ownBlocks(run);
  // Another Pi can put panes in the same tab. The grid's shape is defined over
  // the whole tab, so rearranging ours around theirs would either move a pane we
  // do not own or misdescribe the tab; the provisional split is left in place.
  if (all.some(block => !mine.has(block))) return;
  const seen = all;
  // Nothing to arrange, or a tab that no longer holds the newcomer: leave a tab
  // whose state we cannot read exactly as it is rather than rearranging it.
  if (seen.length < 2 || !seen.includes(run.block)) return;
  // The newcomer belongs in the last cell, so the panes that were already there
  // keep their order and nothing appears to jump between launches.
  const order = [...seen.filter(block => block !== run.block), run.block];
  const rows = paneCount(layout.rows) === order.length ? layout.rows : gridPlan(order.length, layout.frame).rows;
  try {
    for (const block of order.slice(1)) await client.detach(session, block, signal);
    signal?.throwIfAborted();
    await placeTree(client, session, gridTree(rows), order, order[0], signal);
  } catch (error) {
    // Restoring stragglers must not depend on the signal that just cancelled us.
    await rescue(client, session, window, order).catch(() => {});
    throw error;
  }
  const after = windowPanes(await client.view(session, signal), window).filter(block => mine.has(block));
  if (after.length !== order.length) {
    throw new Error(`Grid placement left ${after.length} of ${order.length} panes in the tab.`);
  }
}

// The agent panes this parent owns, from its own records. Anything else in the
// tab belongs to another Pi session and is never counted or moved.
async function ownBlocks(run) {
  const mine = new Set([run.block]);
  for (const record of await listRuns(dirname(run.dir))) {
    if (record.closed || record.layout?.role !== 'agents' || !record.block) continue;
    mine.add(record.block);
  }
  return mine;
}
