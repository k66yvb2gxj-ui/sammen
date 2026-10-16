import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Execute the classic script with its own browser-like global. Keeping test points
// in the same realm avoids measuring VM cross-context wrappers on every frame.
const browser = {};
Function('window', await readFile(new URL('../src/ui/brain-physics.js', import.meta.url), 'utf8'))(browser);
const { createSimulation } = browser.SammenBrainPhysics;

const group = (projectId = 'one', x = 0, y = 0, width = 900, height = 700) => ({ projectId, x, y, width, height, cx: x + width / 2, cy: y + height / 2 });
function fixture(points, edges = [], groups = [group()]) {
  const nodes = points.map((point, i) => ({ key: `n${i}`, projectId: point.projectId || groups[0].projectId }));
  const positions = new Map(points.map((point, i) => [`n${i}`, { x: point.x, y: point.y }]));
  const simulation = createSimulation({ nodes, edges, groups, positions });
  return { simulation, positions, nodes };
}
function run(simulation, frames = 500) {
  let framesRun = 0;
  while (framesRun < frames && simulation.step()) framesRun++;
  return framesRun;
}
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function assertFinite(simulation) {
  for (const body of simulation.getState().bodies) for (const key of ['x', 'y', 'vx', 'vy']) assert.ok(Number.isFinite(body[key]), `${body.key}.${key} is finite`);
}

test('links pull related files closer than unrelated files', () => {
  const points = [{ x: 270, y: 350 }, { x: 630, y: 350 }];
  const linked = fixture(points, [{ from: 'n0', to: 'n1' }]);
  const unrelated = fixture(points);
  run(linked.simulation); run(unrelated.simulation);
  const linkedDistance = distance(...linked.positions.values());
  const unrelatedDistance = distance(...unrelated.positions.values());
  assert.ok(linkedDistance < unrelatedDistance * .85, `${linkedDistance} < .85 × ${unrelatedDistance}`);
  assert.ok(linkedDistance >= 107, 'the spring cannot collapse the circle labels');
});

test('coincident files separate, remain finite and stop without idle jitter', () => {
  const { simulation, positions } = fixture(Array.from({ length: 8 }, () => ({ x: 450, y: 350 })));
  assert.ok(run(simulation) < 500, 'the animation converges within its bounded run');
  assert.equal(simulation.getState().active, false);
  assert.equal(simulation.getState().maxSpeed, 0);
  const points = [...positions.values()];
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
    assert.ok(Math.hypot((points[i].x - points[j].x) / 108, (points[i].y - points[j].y) / 78) > .99, 'circle and label collision spacing is retained');
  }
  assertFinite(simulation);
  const snapshot = JSON.stringify([...positions]);
  for (let i = 0; i < 10; i++) assert.equal(simulation.step(), false);
  assert.equal(JSON.stringify([...positions]), snapshot);
});

test('dragging pins the file, pulls its linked peer and releases without a permanent pin', () => {
  const { simulation, positions } = fixture([{ x: 400, y: 350 }, { x: 520, y: 350 }, { x: 200, y: 200 }], [{ from: 'n0', to: 'n1' }]);
  run(simulation);
  const peerBefore = positions.get('n1').x;
  assert.equal(simulation.pin('n0', 720, 350), true);
  for (let i = 0; i < 35; i++) simulation.step();
  assert.equal(positions.get('n0').x, 720);
  assert.ok(positions.get('n1').x > peerBefore + 35, 'the linked file follows the dragged file');
  assert.equal(simulation.getState().pinnedCount, 1);
  assert.equal(simulation.release('n0'), true);
  assert.equal(simulation.getState().pinnedCount, 0);
  run(simulation);
  assert.ok(positions.get('n0').x < 700, 'a released file can move again');
  assertFinite(simulation);
});

test('project regions stay distinct even with a cross-project link and an outside drag', () => {
  const groups = [group('a', 0, 0, 520, 360), group('b', 760, 0, 520, 360)];
  const points = Array.from({ length: 12 }, (_, i) => ({ projectId: i < 6 ? 'a' : 'b', x: i < 6 ? 260 : 1020, y: 180 }));
  const { simulation, positions, nodes } = fixture(points, [{ from: 'n0', to: 'n6' }], groups);
  simulation.pin('n0', 1000, 180); simulation.step(); simulation.release('n0'); run(simulation);
  for (const node of nodes) {
    const point = positions.get(node.key);
    assert.ok(node.projectId === 'a' ? point.x < 570 : point.x > 710, `${node.key} returns to its own project region`);
  }
  const first = nodes.slice(0, 6).map(node => positions.get(node.key));
  const second = nodes.slice(6).map(node => positions.get(node.key));
  assert.ok(Math.max(...first.map(point => point.x)) + 130 < Math.min(...second.map(point => point.x)), 'visible space remains between projects');
});

test('releasing a file outside its project glides back instead of snapping to a boundary', () => {
  const { simulation, positions } = fixture([{ x: 260, y: 180 }], [], [group('one', 0, 0, 520, 360)]);
  simulation.pin('n0', 1000, 600);
  simulation.step();
  assert.equal(simulation.release('n0'), true);
  simulation.step();
  const afterRelease = { ...positions.get('n0') };
  assert.ok(afterRelease.x > 975 && afterRelease.y > 575, 'the first frame moves only a small distance');
  assert.ok(afterRelease.x < 1000 && afterRelease.y < 600, 'restoring motion begins immediately');
  run(simulation);
  const settled = positions.get('n0');
  assert.ok(settled.x < 500 && settled.y < 350, 'the released file returns to its project');
  assert.equal(simulation.getState().pinnedCount, 0);
});

test('results are deterministic, mutate supplied points, and settle is static until explicitly woken', () => {
  const points = Array.from({ length: 10 }, (_, i) => ({ x: 450 + Math.cos(i) * 100, y: 350 + Math.sin(i) * 90 }));
  const a = fixture(points), b = fixture(points);
  const reference = a.positions.get('n0');
  a.simulation.settle(); b.simulation.settle();
  assert.equal(a.positions.get('n0'), reference, 'point identity is preserved for the renderer');
  assert.equal(JSON.stringify([...a.positions]), JSON.stringify([...b.positions]));
  assert.equal(a.simulation.step(), false);
  a.simulation.wake();
  assert.equal(a.simulation.getState().active, true);
  assert.equal(a.simulation.step(), true);
});

test('empty and malformed references are harmless, without propagating invalid coordinates', () => {
  const empty = createSimulation();
  assert.equal(empty.step(), false); empty.wake(); assert.equal(empty.step(), false);
  assert.equal(empty.pin('missing', 1, 1), false);
  const positions = new Map([['one', { x: NaN, y: Infinity }]]);
  const simulation = createSimulation({ nodes: [{ key: 'one', projectId: 'one' }, { key: 'one', projectId: 'one' }], groups: [group()], positions,
    edges: [{ from: 'missing', to: 'one' }, { from: 'one', to: 'one' }] });
  simulation.pin('one', Infinity, 2); run(simulation);
  assert.equal(simulation.getState().nodeCount, 1);
  assert.equal(simulation.getState().linkCount, 0);
  assertFinite(simulation);
});

test('a graph with 1,200 files keeps finite coordinates and settles', () => {
  const groups = Array.from({ length: 30 }, (_, i) => group(`p${i}`, i % 6 * 1140, Math.floor(i / 6) * 1000));
  const points = groups.flatMap(g => Array.from({ length: 40 }, (_, i) => ({ projectId: g.projectId, x: g.x + 90 + i % 8 * 100, y: g.y + 100 + Math.floor(i / 8) * 100 })));
  const { simulation } = fixture(points, [], groups);
  assert.ok(run(simulation) < 500);
  assert.equal(simulation.getState().nodeCount, 1200);
  assertFinite(simulation);
});
