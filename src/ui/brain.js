'use strict';

// The Brain view shares the app's existing editor and persistence functions.
(() => {
  const filters = [['all', 'Alle filer'], ['note', 'Notater'], ['source', 'Kilder'], ['mindmap', 'Tankekart'], ['ai', 'KI']];
  const kindIcon = item => isAi(item) ? 'sparkle' : item.type === 'source' ? 'globe' : item.type === 'mindmap' ? 'map' : 'file';
  const projectName = projectId => state.projects.find(project => project.id === projectId)?.title || 'Prosjekt';
  let graphController = null;
  const nodeMemory = new Map();
  const MIN_ZOOM = .03, MAX_ZOOM = 8, ZOOM_STEP = 1.5;
  const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

  function fitCamera(bounds, width, height, padding = 48) {
    return { cx: (bounds.left + bounds.right) / 2, cy: (bounds.top + bounds.bottom) / 2, zoom: clamp(Math.min(Math.max(1, width - padding * 2) / Math.max(1, bounds.right - bounds.left), Math.max(1, height - padding * 2) / Math.max(1, bounds.bottom - bounds.top)), .04, 1.6) };
  }

  function zoomAt(camera, factor, point, width, height) {
    const zoom = clamp(camera.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const worldX = camera.cx + (point.x - width / 2) / camera.zoom;
    const worldY = camera.cy + (point.y - height / 2) / camera.zoom;
    return { ...camera, zoom, cx: worldX - (point.x - width / 2) / zoom, cy: worldY - (point.y - height / 2) / zoom };
  }

  function panCamera(camera, dx, dy) {
    return { ...camera, cx: camera.cx - dx / camera.zoom, cy: camera.cy - dy / camera.zoom };
  }

  function titleOpacity(zoom, group, width, height) {
    const projected = Math.max(group.width * zoom / Math.max(1, width), group.height * zoom / Math.max(1, height));
    const progress = clamp((projected - .92) / .65, 0, 1);
    return 1 - progress * progress * (3 - 2 * progress);
  }

  function layoutClusters(nodes, projectIds) {
    const columns = Math.max(1, Math.ceil(Math.sqrt(projectIds.length)));
    const gap = 240, positions = new Map(), groups = [];
    let top = 0;
    for (let row = 0; row < Math.ceil(projectIds.length / columns); row++) {
      const rowGroups = projectIds.slice(row * columns, (row + 1) * columns).map(projectId => {
        const members = nodes.filter(node => node.projectId === projectId);
        const nodeColumns = Math.max(1, Math.min(10, Math.ceil(Math.sqrt(members.length * 1.5))));
        return { projectId, nodes: members, nodeColumns, width: members.length <= 12 ? 520 : Math.max(520, nodeColumns * 112 + 80), height: members.length <= 12 ? 360 : Math.max(360, Math.ceil(members.length / nodeColumns) * 94 + 120) };
      });
      const rowHeight = Math.max(...rowGroups.map(group => group.height));
      let left = 0;
      for (const group of rowGroups) {
        const cx = left + group.width / 2, cy = top + group.height / 2;
        groups.push({ ...group, x: left, y: top, cx, cy });
        group.nodes.forEach((node, index) => {
          if (group.nodes.length <= 12) {
            const angle = Math.PI * 2 * index / group.nodes.length - Math.PI / 2;
            positions.set(node.key, { x: cx + (group.nodes.length === 1 ? 0 : Math.cos(angle) * 164), y: cy + (group.nodes.length === 1 ? 0 : Math.sin(angle) * 102) });
          } else {
            const countInRow = Math.min(group.nodeColumns, group.nodes.length - Math.floor(index / group.nodeColumns) * group.nodeColumns);
            positions.set(node.key, { x: cx + (index % group.nodeColumns - (countInRow - 1) / 2) * 112, y: top + 67 + Math.floor(index / group.nodeColumns) * 94 });
          }
        });
        left += group.width + gap;
      }
      top += rowHeight + gap;
    }
    return { positions, groups, bounds: { left: -36, top: -55, right: Math.max(...groups.map(group => group.x + group.width), 1) + 36, bottom: Math.max(...groups.map(group => group.y + group.height), 1) + 36 } };
  }

  function showFile(item) {
    go('brain', ui.projectId, item.id);
  }

  function visibleFiles() {
    const query = (ui.brainQuery || '').toLocaleLowerCase('nb-NO').trim();
    return itemsForProject().filter(item => (ui.brainFilter === 'all' || (ui.brainFilter === 'ai' ? isAi(item) : item.type === ui.brainFilter && !isAi(item))) && (!query || `${item.title} ${item.content || ''}`.toLocaleLowerCase('nb-NO').includes(query))).sort((a, b) => a.title.localeCompare(b.title, 'nb'));
  }

  function renderGraphTools(data, cameraActions) {
    return el('div', { class: 'brain-graph-top' },
      el('div', { class: 'brain-graph-search-tools' },
        el('label', { class: 'brain-search' }, icon('search', 15), el('input', { id: 'brain-search', placeholder: 'Søk', 'aria-label': 'Søk i Brain', value: ui.brainQuery, oninput: event => { ui.brainQuery = event.target.value; renderMain(); } })),
        el('select', { id: 'brain-filter', class: 'brain-filter', 'aria-label': 'Filtrer grafen', value: ui.brainFilter, onchange: event => { ui.brainFilter = event.target.value; renderMain(); } }, filters.map(([key, title]) => el('option', { value: key }, title)))),
      el('div', { class: 'brain-graph-tools' },
        el('div', { class: 'brain-zoom-tools', 'aria-label': 'Grafvisning' },
          el('button', { type: 'button', class: 'brain-zoom-button', title: 'Zoom ut (−)', 'aria-label': 'Zoom ut', onclick: () => cameraActions.zoomBy(1 / ZOOM_STEP) }, '−'),
          el('output', { class: 'brain-zoom-level', 'aria-label': 'Zoomnivå' }, '100%'),
          el('button', { type: 'button', class: 'brain-zoom-button', title: 'Zoom inn (+)', 'aria-label': 'Zoom inn', onclick: () => cameraActions.zoomBy(ZOOM_STEP) }, '+'),
          el('button', { type: 'button', class: 'brain-fit-button', title: 'Tilpass grafen (0)', 'aria-label': 'Tilpass grafen', onclick: () => cameraActions.fit() }, 'Tilpass')),
        el('span', { class: 'brain-graph-stats', title: `${data.nodes.length} noder · ${data.edges.length} koblinger` }, `${data.nodes.length} noder`),
        el('button', { type: 'button', class: 'brain-toolbar-action', title: 'Nytt notat', 'aria-label': 'Nytt notat', onclick: () => newItem('note') }, icon('add', 16), 'Notat'),
        el('button', { type: 'button', class: 'brain-toolbar-action', title: 'Nytt tankekart', 'aria-label': 'Nytt tankekart', onclick: () => newItem('mindmap') }, icon('map', 16), 'Tankekart')));
  }

  function svgEl(tag, attrs = {}, content) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, String(value)));
    if (content !== undefined) node.textContent = content;
    return node;
  }

  function graphData(files) {
    const nodes = files.map(item => ({ key: `item:${item.id}`, item, projectId: item.projectId, title: item.title || 'Uten tittel', kind: isAi(item) ? 'ai' : item.type }));
    const fileKeys = new Set(nodes.map(node => node.key));
    const edges = new Map();
    const addEdge = (from, to, kind) => {
      if (from === to) return;
      const key = [from, to].sort().join('|');
      if (!edges.has(key)) edges.set(key, { from, to, kind });
    };
    for (const item of files) for (const citation of item.citations || []) {
      const target = `item:${citation.sourceId}`;
      if (fileKeys.has(target)) addEdge(`item:${item.id}`, target, 'citation');
    }
    for (const card of state.flashcards || []) {
      if (ui.projectId && card.projectId !== ui.projectId) continue;
      const sources = (card.sourceIds || []).filter(sourceId => fileKeys.has(`item:${sourceId}`));
      if (!sources.length) continue;
      const key = `card:${card.id}`;
      nodes.push({ key, card, projectId: card.projectId, title: card.question || 'Flashcard', kind: 'card' });
      for (const sourceId of sources) addEdge(key, `item:${sourceId}`, 'card');
    }
    return { nodes, edges: [...edges.values()] };
  }

  function mountProjectMenu(viewport, canOpen = () => true) {
    let menu = null, disposed = false;
    const removalObserver = new MutationObserver(() => { if (!viewport.isConnected) dispose(); });

    function close(restoreFocus = false) {
      if (!menu) return;
      menu.remove(); menu = null;
      if (restoreFocus && viewport.isConnected) viewport.focus({ preventScroll: true });
    }

    function open(point) {
      if (disposed || !canOpen() || document.querySelector('#modal-root .modal')) return;
      close();
      const create = el('button', { type: 'button', class: 'brain-project-create', onclick: () => {
        close(true);
        newProjectModal(null, { fromBrain: true });
      } }, icon('add', 17), 'Nytt prosjekt');
      menu = el('div', { class: 'brain-project-menu', role: 'dialog', 'aria-label': 'Opprett prosjekt' }, create,
        el('button', { type: 'button', class: 'brain-project-menu-close', 'aria-label': 'Lukk prosjektmeny', onclick: () => close(true) }, icon('close', 14)));
      viewport.append(menu);
      menu.style.left = `${clamp(point.x, 10, Math.max(10, viewport.clientWidth - menu.offsetWidth - 10))}px`;
      menu.style.top = `${clamp(point.y, 10, Math.max(10, viewport.clientHeight - menu.offsetHeight - 10))}px`;
      create.focus({ preventScroll: true });
    }

    function doubleClick(event) {
      if (event.button !== 0 || event.target.closest('.brain-graph-node, .brain-empty-project, button, input, select, textarea, a, [role="dialog"]')) return;
      event.preventDefault();
      const bounds = viewport.getBoundingClientRect();
      open({ x: event.clientX - bounds.left, y: event.clientY - bounds.top });
    }

    function keyDown(event) {
      if (event.key === 'Escape' && menu) { event.preventDefault(); event.stopPropagation(); close(true); }
      else if (event.key === 'Tab' && menu?.contains(event.target)) {
        const buttons = [...menu.querySelectorAll('button')];
        if (event.shiftKey && event.target === buttons[0]) { event.preventDefault(); buttons.at(-1).focus(); }
        else if (!event.shiftKey && event.target === buttons.at(-1)) { event.preventDefault(); buttons[0].focus(); }
      } else if ((event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) && event.target === viewport) {
        event.preventDefault(); open({ x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 });
      }
    }

    function outside(event) { if (menu && !menu.contains(event.target)) close(); }
    function dismiss() { close(); }
    function dispose() {
      if (disposed) return;
      disposed = true; close(); removalObserver.disconnect();
      viewport.removeEventListener('dblclick', doubleClick);
      viewport.removeEventListener('keydown', keyDown);
      viewport.removeEventListener('wheel', dismiss);
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', dismiss);
    }

    viewport.addEventListener('dblclick', doubleClick);
    viewport.addEventListener('keydown', keyDown);
    viewport.addEventListener('wheel', dismiss, { passive: true });
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', dismiss);
    queueMicrotask(() => {
      if (disposed) return;
      const main = document.getElementById('main-content');
      if (main) removalObserver.observe(main, { childList: true });
    });
    return { dispose };
  }

  function mountCamera(viewport, svg, world, titles, layout, cameraActions, readout, physics) {
    const key = JSON.stringify([state.brainSpace?.activeId || 'personal', ui.projectId || '*', ui.brainFilter || 'all', (ui.brainQuery || '').trim().toLocaleLowerCase('nb-NO')]);
    ui.brainCamera ||= {};
    const camera = ui.brainCamera[key] ||= { cx: 0, cy: 0, zoom: 1, autoFit: true, width: 0, height: 0 };
    const layoutBounds = JSON.stringify(layout.bounds);
    // Search drafts should not accumulate an unlimited number of camera snapshots.
    const keys = Object.keys(ui.brainCamera);
    if (keys.length > 40) for (const oldKey of keys.slice(0, keys.length - 40)) if (oldKey !== key) delete ui.brainCamera[oldKey];
    let disposed = false, drag = null, suppressClickUntil = 0, suppressMenuUntil = 0, animationFrame = 0;
    let cameraFrame = 0, physicsFrame = 0, lastCameraTime = 0, lastPhysicsTime = 0, physicsTime = 0, physicsActive = true, zoomAnchor = null;
    const target = { ...camera };
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let resizeObserver = null, removalObserver = null;
    const projectMenu = mountProjectMenu(viewport, () => canCreateProjects() && !drag?.moved && performance.now() >= suppressMenuUntil);
    const pointAt = event => { const rect = viewport.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
    const worldAt = point => ({ x: camera.cx + (point.x - camera.width / 2) / camera.zoom, y: camera.cy + (point.y - camera.height / 2) / camera.zoom });

    function stopCamera() {
      cancelAnimationFrame(cameraFrame); cameraFrame = 0; lastCameraTime = 0; zoomAnchor = null;
      Object.assign(target, camera);
    }

    function animateCamera(time) {
      cameraFrame = 0;
      if (disposed || !viewport.isConnected) return;
      const elapsed = lastCameraTime ? clamp(time - lastCameraTime, 1, 48) : 16;
      lastCameraTime = time;
      const blend = 1 - Math.exp(-elapsed / 62);
      camera.zoom = Math.exp(Math.log(camera.zoom) + (Math.log(target.zoom) - Math.log(camera.zoom)) * blend);
      if (zoomAnchor) {
        camera.cx = zoomAnchor.world.x - (zoomAnchor.point.x - camera.width / 2) / camera.zoom;
        camera.cy = zoomAnchor.world.y - (zoomAnchor.point.y - camera.height / 2) / camera.zoom;
      } else {
        camera.cx += (target.cx - camera.cx) * blend;
        camera.cy += (target.cy - camera.cy) * blend;
      }
      camera.autoFit = target.autoFit;
      const complete = Math.abs(Math.log(target.zoom / camera.zoom)) < .0003 && Math.hypot(target.cx - camera.cx, target.cy - camera.cy) * camera.zoom < .2;
      if (complete) { Object.assign(camera, target); lastCameraTime = 0; zoomAnchor = null; }
      paint();
      if (!complete) cameraFrame = requestAnimationFrame(animateCamera);
    }

    function moveCamera() {
      if (motion.matches) { Object.assign(camera, target); paint(); }
      else if (!cameraFrame) cameraFrame = requestAnimationFrame(animateCamera);
    }

    function animatePhysics(time) {
      physicsFrame = 0;
      if (disposed || !viewport.isConnected || document.hidden) return;
      physicsTime += lastPhysicsTime ? clamp(time - lastPhysicsTime, 0, 48) : 1000 / 60;
      lastPhysicsTime = time;
      for (let steps = 0; physicsTime >= 1000 / 60 && steps < 3; steps++) {
        physicsActive = physics.simulation.step();
        physicsTime -= 1000 / 60;
        if (!physicsActive) break;
      }
      physics.paint();
      viewport.dataset.physics = physicsActive ? 'moving' : 'settled';
      if (physicsActive) physicsFrame = requestAnimationFrame(animatePhysics);
      else { lastPhysicsTime = 0; physicsTime = 0; physics.save(); }
    }

    function wakePhysics() {
      physicsActive = true;
      if (motion.matches) { physics.simulation.settle(120); physics.paint(); physics.save(); viewport.dataset.physics = 'settled'; }
      else if (!physicsFrame && !document.hidden) physicsFrame = requestAnimationFrame(animatePhysics);
    }

    function visibilityChange() {
      if (document.hidden) { cancelAnimationFrame(physicsFrame); physicsFrame = 0; lastPhysicsTime = 0; }
      else if (physicsActive) wakePhysics();
    }

    function motionChange() {
      if (!motion.matches) return;
      cancelAnimationFrame(cameraFrame); cameraFrame = 0; Object.assign(camera, target); paint();
      cancelAnimationFrame(physicsFrame); physicsFrame = 0; wakePhysics();
    }

    function paint() {
      if (disposed || !camera.width || !camera.height) return;
      svg.setAttribute('viewBox', `0 0 ${camera.width} ${camera.height}`);
      world.setAttribute('transform', `translate(${camera.width / 2 - camera.cx * camera.zoom} ${camera.height / 2 - camera.cy * camera.zoom}) scale(${camera.zoom})`);
      for (const { group, text } of titles) {
        text.setAttribute('x', camera.width / 2 + (group.cx - camera.cx) * camera.zoom);
        text.setAttribute('y', camera.height / 2 + (group.y - 20 - camera.cy) * camera.zoom);
        text.setAttribute('opacity', titleOpacity(camera.zoom, group, camera.width, camera.height).toFixed(3));
        const maxChars = Math.max(14, Math.min(65, Math.floor(group.width * camera.zoom / 7.5)));
        const title = projectName(group.projectId);
        text.textContent = title.length > maxChars ? `${title.slice(0, maxChars - 1)}…` : title;
      }
      readout.textContent = `${Math.round(camera.zoom * 100)}%`;
      viewport.dataset.zoom = camera.zoom.toFixed(4);
      viewport.dataset.cameraKey = key;
      viewport.dataset.cameraX = camera.cx.toFixed(3);
      viewport.dataset.cameraY = camera.cy.toFixed(3);
    }

    function resize() {
      if (disposed) return;
      if (!viewport.isConnected) return dispose();
      const width = viewport.clientWidth, height = viewport.clientHeight;
      if (!width || !height) return;
      const changed = camera.width !== width || camera.height !== height;
      if (changed) stopCamera();
      camera.width = width; camera.height = height;
      if (camera.autoFit && (changed || camera.layoutBounds !== layoutBounds)) { stopCamera(); Object.assign(camera, fitCamera(layout.bounds, width, height)); }
      Object.assign(target, { width, height });
      if (!cameraFrame) Object.assign(target, camera);
      camera.layoutBounds = layoutBounds;
      paint();
    }

    function zoomBy(factor, point = { x: camera.width / 2, y: camera.height / 2 }) {
      if (disposed) return;
      const worldPoint = worldAt(point), zoom = clamp(target.zoom * factor, MIN_ZOOM, MAX_ZOOM);
      zoomAnchor = { point, world: worldPoint };
      Object.assign(target, { zoom, cx: worldPoint.x - (point.x - camera.width / 2) / zoom, cy: worldPoint.y - (point.y - camera.height / 2) / zoom, autoFit: false });
      moveCamera();
    }

    function fit() {
      if (disposed) return;
      zoomAnchor = null;
      const bounds = { ...layout.bounds };
      for (const point of layout.positions.values()) { bounds.left = Math.min(bounds.left, point.x - 100); bounds.right = Math.max(bounds.right, point.x + 100); bounds.top = Math.min(bounds.top, point.y - 60); bounds.bottom = Math.max(bounds.bottom, point.y + 70); }
      Object.assign(target, fitCamera(bounds, camera.width, camera.height), { autoFit: true });
      moveCamera();
    }

    function wheel(event) {
      event.preventDefault();
      if (drag?.moved) return;
      const delta = clamp(event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? camera.height : 1), -180, 180);
      zoomBy(Math.exp(-delta * (event.ctrlKey ? .009 : .005)), pointAt(event));
    }

    function pointerDown(event) {
      if (event.button !== 0 || drag || event.target.closest('.brain-empty-project, .brain-project-menu')) return;
      const node = event.target.closest('.brain-graph-node');
      const nodeKey = node?.dataset.nodeKey, point = layout.positions.get(nodeKey);
      stopCamera();
      drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, camera: { ...camera }, nodeKey: point ? nodeKey : null, point: point ? { ...point } : null, element: node, moved: false };
    }

    function pointerMove(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      if (!drag.moved) {
        drag.moved = true;
        try { viewport.setPointerCapture(event.pointerId); } catch {}
        viewport.classList.add(drag.nodeKey ? 'dragging-node' : 'panning');
        drag.element?.classList.add('dragging');
        camera.autoFit = target.autoFit = false;
      }
      event.preventDefault();
      if (drag.nodeKey) {
        physics.simulation.pin(drag.nodeKey, drag.point.x + dx / camera.zoom, drag.point.y + dy / camera.zoom);
        physics.paint(); wakePhysics();
      } else {
        Object.assign(camera, panCamera(drag.camera, dx, dy), { autoFit: false });
        Object.assign(target, camera); paint();
      }
    }

    function pointerEnd(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (drag.moved) suppressClickUntil = suppressMenuUntil = performance.now() + 250;
      const previous = drag;
      drag = null;
      if (previous.nodeKey && previous.moved) { physics.simulation.release(previous.nodeKey); wakePhysics(); }
      previous.element?.classList.remove('dragging');
      try { if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId); } catch {}
      viewport.classList.remove('panning', 'dragging-node');
    }

    function cancelDrag() { if (drag) pointerEnd({ pointerId: drag.pointerId }); }

    function guardDragClick(event) {
      if (performance.now() >= suppressClickUntil) return;
      event.preventDefault(); event.stopImmediatePropagation();
      suppressClickUntil = 0;
    }

    function keyDown(event) {
      if (event.target.closest('.brain-project-menu, input, select, textarea, [contenteditable="true"]')) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const directions = { ArrowLeft: [60, 0], ArrowRight: [-60, 0], ArrowUp: [0, 60], ArrowDown: [0, -60] };
      if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomBy(ZOOM_STEP); }
      else if (event.key === '-' || event.key === '−') { event.preventDefault(); zoomBy(1 / ZOOM_STEP); }
      else if (event.key === '0' || event.key === 'Home') { event.preventDefault(); fit(); }
      else if (directions[event.key]) { event.preventDefault(); stopCamera(); Object.assign(camera, panCamera(camera, ...directions[event.key]), { autoFit: false }); Object.assign(target, camera); paint(); }
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      projectMenu.dispose();
      cancelAnimationFrame(animationFrame);
      cancelAnimationFrame(cameraFrame); cancelAnimationFrame(physicsFrame);
      if (drag?.nodeKey && drag.moved) physics.simulation.release(drag.nodeKey);
      drag?.element?.classList.remove('dragging'); physics.save();
      resizeObserver?.disconnect(); removalObserver?.disconnect();
      viewport.removeEventListener('wheel', wheel);
      viewport.removeEventListener('pointerdown', pointerDown);
      viewport.removeEventListener('keydown', keyDown);
      viewport.removeEventListener('click', guardDragClick, true);
      window.removeEventListener('pointermove', pointerMove);
      window.removeEventListener('pointerup', pointerEnd);
      window.removeEventListener('pointercancel', pointerEnd);
      viewport.removeEventListener('lostpointercapture', pointerEnd);
      window.removeEventListener('blur', cancelDrag);
      document.removeEventListener('visibilitychange', visibilityChange);
      motion.removeEventListener('change', motionChange);
      if (drag) { try { viewport.releasePointerCapture(drag.pointerId); } catch {} }
      viewport.classList.remove('panning', 'dragging-node');
      if (graphController === controller) graphController = null;
    }

    const controller = { dispose, zoomBy, fit, getState: () => ({ ...camera, key }) };
    graphController = controller;
    Object.assign(cameraActions, { zoomBy, fit });
    viewport.addEventListener('wheel', wheel, { passive: false });
    viewport.addEventListener('pointerdown', pointerDown);
    viewport.addEventListener('keydown', keyDown);
    viewport.addEventListener('click', guardDragClick, true);
    window.addEventListener('pointermove', pointerMove, { passive: false });
    window.addEventListener('pointerup', pointerEnd);
    window.addEventListener('pointercancel', pointerEnd);
    viewport.addEventListener('lostpointercapture', pointerEnd);
    window.addEventListener('blur', cancelDrag);
    document.addEventListener('visibilitychange', visibilityChange);
    motion.addEventListener('change', motionChange);
    animationFrame = requestAnimationFrame(() => {
      if (disposed) return;
      resize();
      if (disposed) return;
      wakePhysics();
      resizeObserver = new ResizeObserver(resize); resizeObserver.observe(viewport);
      const main = document.getElementById('main-content');
      if (main) { removalObserver = new MutationObserver(() => { if (!viewport.isConnected) dispose(); }); removalObserver.observe(main, { childList: true }); }
    });
    return controller;
  }

  function renderGraph(files) {
    const brainId = state.brainSpace?.activeId || 'personal';
    const data = graphData(files);
    const panel = el('section', { class: 'brain-graph-panel', 'aria-label': 'Kunnskapsgraf' });
    const cameraActions = { zoomBy: () => {}, fit: () => {} };
    const tools = renderGraphTools(data, cameraActions);
    if (brainReadOnly()) for (const button of tools.querySelectorAll('.brain-toolbar-action')) button.disabled = true;
    panel.append(tools);
    const projectIds = state.projects.filter(project => (!ui.projectId || project.id === ui.projectId) &&
      ((!ui.brainQuery.trim() && ui.brainFilter === 'all') || data.nodes.some(node => node.projectId === project.id))).map(project => project.id);
    if (!projectIds.length) {
      for (const button of tools.querySelectorAll('.brain-zoom-tools button')) button.disabled = true;
      tools.querySelector('.brain-zoom-level').textContent = '—';
      const viewport = el('div', { id: 'brain-graph-viewport', class: 'brain-graph-viewport brain-graph-empty-viewport', tabindex: 0, role: 'region', 'aria-label': 'Tom Brain-graf. Dobbeltklikk for å opprette et prosjekt.', 'aria-keyshortcuts': 'Shift+F10' }, renderEmpty());
      const projectMenu = mountProjectMenu(viewport, canCreateProjects);
      const controller = { dispose: () => { projectMenu.dispose(); if (graphController === controller) graphController = null; }, getState: () => null };
      graphController = controller;
      panel.append(viewport);
      return panel;
    }
    const layout = layoutClusters(data.nodes, projectIds);
    const { positions } = layout;
    const groupsByProject = new Map(layout.groups.map(group => [group.projectId, group]));
    for (const node of data.nodes) {
      const saved = nodeMemory.get(`${brainId}:${node.key}`), group = groupsByProject.get(node.projectId);
      if (saved?.projectId === node.projectId && Number.isFinite(saved.x) && Number.isFinite(saved.y)) Object.assign(positions.get(node.key), { x: group.cx + clamp(saved.x, -group.width * .75, group.width * .75), y: group.cy + clamp(saved.y, -group.height * .75, group.height * .75) });
    }
    const simulation = window.SammenBrainPhysics.createSimulation({ ...data, groups: layout.groups, positions });
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) simulation.settle(160);
    else for (let tick = 0; tick < 18; tick++) simulation.step();
    const viewport = el('div', { id: 'brain-graph-viewport', class: 'brain-graph-viewport', tabindex: 0, role: 'region', 'aria-label': 'Kunnskapsgraf. Dra i en node for å flytte den, eller på et tomt sted for å panorere. Dobbeltklikk på et tomt sted for nytt prosjekt. Zoom med pluss og minus, og tilpass med 0.', 'aria-keyshortcuts': '+ - 0 ArrowLeft ArrowRight ArrowUp ArrowDown Shift+F10' });
    const svg = svgEl('svg', { class: 'brain-graph-svg', role: 'group', 'aria-label': 'Filer og flashcards, gruppert etter prosjekt' });
    const world = svgEl('g', { class: 'brain-graph-world' });
    const titleLayer = svgEl('g', { class: 'brain-graph-title-layer', 'aria-hidden': 'true' });
    const titles = [];
    const gradientId = `brain-project-cloud-${id()}`;
    const defs = svgEl('defs');
    const gradient = svgEl('radialGradient', { id: gradientId, cx: '.5', cy: '.5', r: '.5' });
    gradient.append(svgEl('stop', { offset: '0%', 'stop-color': '#eee0f9', 'stop-opacity': '.58' }), svgEl('stop', { offset: '52%', 'stop-color': '#f1e5fa', 'stop-opacity': '.38' }), svgEl('stop', { offset: '100%', 'stop-color': '#f7f1fc', 'stop-opacity': '0' }));
    defs.append(gradient); svg.append(defs, world, titleLayer);
    for (const group of layout.groups) {
      world.append(svgEl('ellipse', { cx: group.cx, cy: group.cy, rx: group.width / 2 + 34, ry: group.height / 2 + 28, fill: `url(#${gradientId})`, class: 'brain-graph-group', 'data-project-id': group.projectId }));
      const title = svgEl('text', { 'text-anchor': 'middle', class: 'brain-graph-project', 'data-project-id': group.projectId }, projectName(group.projectId));
      titleLayer.append(title); titles.push({ group, text: title });
      if (!group.nodes.length) {
        const addNote = svgEl('g', { class: 'brain-empty-project', tabindex: 0, role: 'button', 'data-project-id': group.projectId, 'aria-label': `Nytt notat i ${projectName(group.projectId)}` });
        const create = () => { go('brain', group.projectId, null); newItem('note'); };
        addNote.addEventListener('click', create);
        addNote.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); create(); } });
        addNote.append(svgEl('circle', { cx: group.cx, cy: group.cy, r: 23, class: 'brain-empty-project-shape' }));
        const plus = icon('add', 20); plus.setAttribute('x', group.cx - 10); plus.setAttribute('y', group.cy - 10);
        addNote.append(plus, svgEl('text', { x: group.cx, y: group.cy + 44, 'text-anchor': 'middle', class: 'brain-node-title' }, 'Nytt notat'));
        world.append(addNote);
      }
    }
    const edgeElements = [], nodeElements = [];
    for (const edge of data.edges) {
      const from = positions.get(edge.from), to = positions.get(edge.to);
      if (!from || !to) continue;
      const path = svgEl('path', { class: `brain-graph-edge ${edge.kind}` });
      world.append(path); edgeElements.push({ edge, path });
    }
    for (const node of data.nodes) {
      const point = positions.get(node.key);
      const group = svgEl('g', { class: `brain-graph-node ${node.kind}`, 'data-node-key': node.key, 'data-item-id': node.item?.id || '', tabindex: 0, role: 'button', 'aria-label': `Åpne ${node.kind === 'card' ? 'flashcard: ' : ''}${node.title}` });
      const open = () => {
        if (node.item) showFile(node.item);
        else {
          ui.cardId = node.card.id; ui.cardMode = 'all';
          if (ui.study) Object.assign(ui.study, { mode: 'cards', filter: 'all', selected: node.card.id, flipped: false });
          go('flashcards', node.projectId);
        }
      };
      group.addEventListener('click', event => { if (event.target.closest('.brain-node-shape, .brain-node-icon')) open(); });
      group.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
      group.append(svgEl('title', {}, node.title));
      group.append(svgEl('circle', { cx: 0, cy: 0, r: node.kind === 'card' ? 19 : 23, class: 'brain-node-shape' }));
      const symbol = icon(node.kind === 'card' ? 'cards' : kindIcon(node.item), node.kind === 'card' ? 18 : 21);
      symbol.setAttribute('x', -(node.kind === 'card' ? 9 : 10.5));
      symbol.setAttribute('y', -(node.kind === 'card' ? 9 : 10.5));
      symbol.classList.add('brain-node-icon');
      group.append(symbol);
      const title = node.title.length > 21 ? `${node.title.slice(0, 20)}…` : node.title;
      group.append(svgEl('text', { x: 0, y: 44, 'text-anchor': 'middle', class: 'brain-node-title' }, title));
      world.append(group);
      nodeElements.push({ group, point });
    }
    function paintPositions() {
      for (const { group, point } of nodeElements) group.setAttribute('transform', `translate(${point.x.toFixed(3)} ${point.y.toFixed(3)})`);
      for (const { edge, path } of edgeElements) {
        const from = positions.get(edge.from), to = positions.get(edge.to);
        path.setAttribute('d', `M${from.x} ${from.y} Q${(from.x + to.x) / 2 + 16} ${(from.y + to.y) / 2 - 25} ${to.x} ${to.y}`);
      }
    }
    function savePositions() {
      for (const node of data.nodes) {
        const point = positions.get(node.key), group = groupsByProject.get(node.projectId);
        nodeMemory.set(`${brainId}:${node.key}`, { projectId: node.projectId, x: point.x - group.cx, y: point.y - group.cy });
      }
      if (nodeMemory.size > 5000) for (const key of [...nodeMemory.keys()].slice(0, nodeMemory.size - 5000)) nodeMemory.delete(key);
    }
    paintPositions();
    viewport.append(svg);
    panel.append(viewport, el('div', { class: 'brain-graph-legend' }, el('span', {}, el('i', { class: 'brain-legend-line' }), 'Kildehenvisning'), el('span', {}, el('i', { class: 'brain-legend-line card' }), 'Flashcard-kilde'), data.edges.length ? null : el('span', { class: 'brain-graph-no-links' }, 'Ingen lagrede koblinger ennå')));
    mountCamera(viewport, svg, world, titles, layout, cameraActions, tools.querySelector('.brain-zoom-level'), { simulation, paint: paintPositions, save: savePositions });
    return panel;
  }

  function renderEmpty() {
    if (brainReadOnly()) return el('div', { class: 'brain-empty' }, el('span', { class: 'brain-empty-doodle' }, icon('globe', 45)), el('h3', {}, 'Felles for alle i Sammen'), el('p', {}, 'Koble til den offentlige Brainen for å åpne felles prosjekter.'), el('button', { type: 'button', class: 'button brain-create-button', onclick: () => window.SammenBrainSpaces?.openConnect?.() }, icon('link', 16), 'Koble til Offentlig Brain'));
    return el('div', { class: 'brain-empty' }, el('span', { class: 'brain-empty-doodle' }, icon('brain', 45)), el('h3', {}, 'En ny tanke?'), el('button', { type: 'button', class: 'button brain-create-button', onclick: () => newItem('note') }, icon('add', 16), 'Nytt notat'));
  }

  function renderDocument(item) {
    if (!item) return renderEmpty();
    const panel = renderEditor(item);
    panel.classList.add('brain-note-editor');
    const content = panel.querySelector('#editor-content');
    if (content) content.placeholder = 'Skriv her …';
    const title = panel.querySelector('#editor-title');
    if (title) title.placeholder = 'Uten tittel';
    const notice = panel.querySelector('.editor-notice');
    if (notice) notice.replaceChildren(icon('sparkle', 13), editor.status === 'reviewed' ? 'KI · kontrollert av elev' : 'KI-utkast · sjekk kildene');
    const status = panel.querySelector('#editor-status');
    if (status) for (const option of status.options) option.textContent = option.value === 'reviewed' ? 'Kontrollert' : 'Utkast';
    const references = panel.querySelector('.reference-list h4');
    if (references) references.textContent = 'Kilder';
    const sourceHeading = panel.querySelector('.editor-source > div');
    if (sourceHeading) sourceHeading.textContent = 'Kilde';
    return panel;
  }

  function render() {
    graphController?.dispose();
    if (!filters.some(([key]) => key === ui.brainFilter)) ui.brainFilter = 'all';
    if (!['document', 'graph'].includes(ui.brainMode)) ui.brainMode = 'graph';
    const files = visibleFiles();
    const selected = state.items.find(item => item.id === ui.itemId && (!ui.projectId || item.projectId === ui.projectId));
    if (ui.brainMode === 'document' && !selected) { ui.brainMode = 'graph'; ui.itemId = null; }
    const documentMode = ui.brainMode === 'document';
    if (documentMode && selected && (!editor || editor.id !== selected.id || !editor.dirty)) editor = makeEditor(selected);
    if (!documentMode && !editor?.dirty) editor = null;
    const page = el('div', { class: `brain-workspace ${documentMode ? 'brain-mode-document' : 'brain-mode-graf'}` });
    page.append(el('h1', { class: 'visually-hidden' }, 'Brain'));
    if (window.SammenBrainSpaces) page.append(window.SammenBrainSpaces.render());
    const stage = el('section', { class: 'brain-stage', 'aria-label': documentMode ? selected.title || 'Dokument' : 'Brain-graf' });
    if (documentMode) stage.append(el('div', { class: 'brain-document-head' }, el('button', { type: 'button', id: 'brain-back-to-graph', class: 'brain-back-button', 'aria-label': 'Tilbake til Brain-grafen', onclick: () => go('brain', ui.projectId, null) }, icon('chevron', 14), 'Brain')));
    stage.append(el('div', { id: 'brain-document-area', class: 'brain-document-area' }, documentMode ? renderDocument(selected) : renderGraph(files)));
    page.append(stage);
    return page;
  }

  window.SammenBrain = { render, dispose: () => graphController?.dispose(), getCameraState: () => graphController?.getState() || null, cameraMath: { fitCamera, zoomAt, panCamera, titleOpacity, layoutClusters } };
})();
