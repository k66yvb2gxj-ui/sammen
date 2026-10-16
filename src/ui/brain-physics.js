'use strict';

// Small, deterministic force simulation shared by the animated and reduced-motion views.
// Positions belong to Brain: mutate their coordinates so rerenders can retain the layout.
(() => {
  const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
  const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
  const REPULSION_RANGE = 240;
  const MIN_X = 108, MIN_Y = 78;

  function direction(key) {
    let hash = 2166136261;
    for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
    const angle = (hash >>> 0) / 4294967296 * Math.PI * 2;
    return { x: Math.cos(angle), y: Math.sin(angle) };
  }

  function createSimulation({ nodes = [], edges = [], groups = [], positions = new Map() } = {}) {
    const groupById = new Map(groups.map(group => [group.projectId, group]));
    const seen = new Set();
    const bodies = nodes.filter(node => {
      if (!node || node.key == null || seen.has(node.key)) return false;
      seen.add(node.key); return true;
    }).slice().sort((a, b) => String(a.key).localeCompare(String(b.key), 'en')).map((node, index) => {
      const group = groupById.get(node.projectId);
      const cx = finite(group?.cx, finite(group?.x) + finite(group?.width, 520) / 2);
      const cy = finite(group?.cy, finite(group?.y) + finite(group?.height, 360) / 2);
      const point = positions.get(node.key) || { x: cx, y: cy };
      point.x = finite(point.x, cx); point.y = finite(point.y, cy);
      positions.set(node.key, point);
      return { key: node.key, index, point, cx, cy, group, vx: 0, vy: 0, fx: 0, fy: 0, pinned: null, degree: 0 };
    });
    const byKey = new Map(bodies.map(body => [body.key, body]));
    const uniqueLinks = new Set();
    const links = edges.flatMap(edge => {
      const from = byKey.get(edge.from), to = byKey.get(edge.to);
      if (!from || !to || from === to) return [];
      const key = [from.index, to.index].sort((a, b) => a - b).join(':');
      if (uniqueLinks.has(key)) return [];
      uniqueLinks.add(key); from.degree++; to.degree++;
      return [{ from, to }];
    });
    let alpha = bodies.length ? .8 : 0, ticks = 0, quietTicks = 0, active = !!bodies.length, maxSpeed = 0;

    function wake(heat = .7) {
      if (!bodies.length) return;
      alpha = Math.max(alpha, clamp(finite(heat, .7), .15, 1));
      quietTicks = 0; active = true;
    }

    function pin(key, x, y) {
      const body = byKey.get(key);
      if (!body || !Number.isFinite(x) || !Number.isFinite(y)) return false;
      body.pinned = { x, y }; body.point.x = x; body.point.y = y;
      body.vx = body.vy = 0; wake(.6);
      return true;
    }

    function release(key) {
      const body = byKey.get(key);
      if (!body || !body.pinned) return false;
      body.pinned = null; wake(.7); return true;
    }

    function neighbourPairs(visit) {
      // The finite interaction radius and spatial hash keep work local as projects grow.
      const grid = new Map();
      for (const body of bodies) {
        const gx = Math.floor(body.point.x / REPULSION_RANGE), gy = Math.floor(body.point.y / REPULSION_RANGE);
        body.gx = gx; body.gy = gy;
        const key = `${gx}:${gy}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(body);
      }
      for (const body of bodies) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        for (const other of grid.get(`${body.gx + dx}:${body.gy + dy}`) || []) {
          if (other.index > body.index) visit(body, other);
        }
      }
    }

    function separation(a, b) {
      let dx = b.point.x - a.point.x, dy = b.point.y - a.point.y;
      if (Math.abs(dx) + Math.abs(dy) < .001) {
        const unit = direction(`${a.key}|${b.key}`); dx = unit.x * .01; dy = unit.y * .01;
      }
      return { dx, dy, distance: Math.hypot(dx, dy) };
    }

    function step() {
      if (!active) return false;
      ticks++;
      for (const body of bodies) {
        body.fx = (body.cx - body.point.x) * .0032 * alpha;
        body.fy = (body.cy - body.point.y) * .0032 * alpha;
        body.outside = false;
        // The project boundary is a restoring force, not a clamp: releasing a file
        // outside its region should glide home instead of teleporting on the next tick.
        if (body.group) {
          const left = finite(body.group.x, body.cx - 260) + 56;
          const top = finite(body.group.y, body.cy - 180) + 44;
          const right = left + Math.max(0, finite(body.group.width, 520) - 112);
          const bottom = top + Math.max(0, finite(body.group.height, 360) - 96);
          const restoreX = clamp(body.point.x, left, right) - body.point.x;
          const restoreY = clamp(body.point.y, top, bottom) - body.point.y;
          body.fx += restoreX * .025 * alpha;
          body.fy += restoreY * .025 * alpha;
          body.outside = !!(restoreX || restoreY);
        }
      }
      neighbourPairs((a, b) => {
        const { dx, dy, distance } = separation(a, b);
        if (distance >= REPULSION_RANGE) return;
        const force = Math.min(4, 2600 / Math.max(400, distance * distance)) * (1 - distance / REPULSION_RANGE) * alpha;
        const fx = dx / distance * force, fy = dy / distance * force;
        a.fx -= fx; a.fy -= fy; b.fx += fx; b.fy += fy;
      });
      for (const { from, to } of links) {
        const { dx, dy, distance } = separation(from, to);
        // A link between projects should remain visible without collapsing their regions.
        const crossProject = from.group !== to.group;
        const restLength = crossProject ? Math.hypot(to.cx - from.cx, to.cy - from.cy) : 126;
        const strength = (crossProject ? .0015 : .022) * alpha / Math.sqrt(Math.max(from.degree, to.degree));
        const force = clamp((distance - restLength) * strength, -5, 5);
        const fx = dx / distance * force, fy = dy / distance * force;
        from.fx += fx; from.fy += fy; to.fx -= fx; to.fy -= fy;
      }

      maxSpeed = 0;
      for (const body of bodies) {
        if (body.pinned) {
          body.point.x = body.pinned.x; body.point.y = body.pinned.y;
          body.vx = body.vy = 0; continue;
        }
        const damping = body.outside ? .74 : .78;
        body.vx = clamp(finite((body.vx + body.fx) * damping), -16, 16);
        body.vy = clamp(finite((body.vy + body.fy) * damping), -16, 16);
        body.point.x = finite(body.point.x + body.vx, body.cx);
        body.point.y = finite(body.point.y + body.vy, body.cy);
        maxSpeed = Math.max(maxSpeed, Math.hypot(body.vx, body.vy));
      }

      let maxCorrection = 0;
      // Two positional passes resolve collisions even after heat has cooled. Elliptical
      // spacing reserves the label beneath each 22px circle as well as the circle itself.
      for (let pass = 0; pass < 2; pass++) neighbourPairs((a, b) => {
        if (a.pinned && b.pinned) return;
        const { dx, dy } = separation(a, b);
        const overlap = Math.hypot(dx / MIN_X, dy / MIN_Y);
        if (overlap >= 1) return;
        const correction = (1 - overlap) * .52 / Math.max(overlap, .00001);
        const ax = a.pinned ? 0 : b.pinned ? 1 : .5;
        const bx = b.pinned ? 0 : a.pinned ? 1 : .5;
        const moveX = dx * correction, moveY = dy * correction;
        a.point.x -= moveX * ax; a.point.y -= moveY * ax;
        b.point.x += moveX * bx; b.point.y += moveY * bx;
        maxCorrection = Math.max(maxCorrection, Math.hypot(moveX, moveY));
      });

      alpha *= .976;
      quietTicks = alpha < .018 && maxSpeed < .08 && maxCorrection < .08 ? quietTicks + 1 : 0;
      // A finite run also handles an overfull project where every label cannot fit.
      if (quietTicks >= 12 || alpha < .00025) {
        alpha = 0; active = false;
        for (const body of bodies) body.vx = body.vy = 0;
        maxSpeed = 0;
      }
      return active;
    }

    function settle(iterations = 80) {
      const count = clamp(Math.floor(finite(iterations, 80)), 0, 1000);
      for (let i = 0; i < count && active; i++) step();
      // Reduced motion requests a static result, rather than an unfinished RAF loop.
      alpha = 0; active = false; maxSpeed = 0;
      for (const body of bodies) body.vx = body.vy = 0;
      return positions;
    }

    function getState() {
      return { active, alpha, ticks, maxSpeed, nodeCount: bodies.length, linkCount: links.length,
        pinnedCount: bodies.filter(body => body.pinned).length,
        bodies: bodies.map(body => ({ key: body.key, x: body.point.x, y: body.point.y, vx: body.vx, vy: body.vy, pinned: !!body.pinned })) };
    }

    return { step, wake, pin, release, settle, getState };
  }

  window.SammenBrainPhysics = Object.freeze({ createSimulation });
})();
