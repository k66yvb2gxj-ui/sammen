(() => {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const palette = ['#eee2fa', '#dcecf7', '#f8dfd9', '#e1efdc', '#fbefd0', '#f4dfed'];
  const sessions = new Map();
  let disconnectPrevious = () => {};
  let flushCurrent = () => {};
  const copy = value => JSON.parse(JSON.stringify(value));
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  function svgEl(tag, attrs = {}, children = []) {
    const node = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    for (const child of children) node.append(child);
    return node;
  }
  function subtree(nodeId, nodes) {
    const result = new Set([nodeId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of nodes) if (result.has(node.parentId) && !result.has(node.id)) { result.add(node.id); changed = true; }
    }
    return result;
  }
  function linesFor(text) {
    const source = String(text || 'Ny idé');
    const lines = [];
    for (const paragraph of source.split('\n')) {
      let line = '';
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        if (line.length + word.length > 27 && line) { lines.push(line); line = ''; }
        line = line ? `${line} ${word}` : word;
      }
      lines.push(line);
    }
    if (lines.length > 3) return [...lines.slice(0, 2), `${lines[2].slice(0, 25)}…`];
    return lines.map(line => line.length > 29 ? `${line.slice(0, 27)}…` : line);
  }
  function geometry(node) {
    const lines = linesFor(node.text);
    const width = clamp(Math.max(...lines.map(line => line.length), 8) * 7.4 + 38, 104, 248);
    return { width, height: Math.max(48, lines.length * 18 + 24), lines };
  }
  function layout(nodes) {
    const root = nodes.find(node => !node.parentId) || nodes[0];
    const positions = new Map();
    if (!root) return positions;
    const children = new Map(nodes.map(node => [node.id, []]));
    for (const node of nodes) children.get(node.parentId)?.push(node);
    const seen = new Set();
    const weight = node => {
      if (seen.has(node.id)) return 1;
      seen.add(node.id);
      const count = node.collapsed ? 1 : (children.get(node.id) || []).reduce((sum, child) => sum + weight(child), 0);
      return Math.max(1, count);
    };
    const weights = new Map(nodes.map(node => { seen.clear(); return [node.id, weight(node)]; }));
    const rootX = Number.isFinite(root.x) ? root.x : 0;
    const rootY = Number.isFinite(root.y) ? root.y : 0;
    positions.set(root.id, { x: rootX, y: rootY, side: 0, color: root.color || palette[0], ...geometry(root) });
    const visited = new Set([root.id]);
    function place(node, depth, side, top, branchColor) {
      if (visited.has(node.id)) return;
      visited.add(node.id);
      const height = weights.get(node.id) * 92;
      positions.set(node.id, {
        x: Number.isFinite(node.x) ? node.x : rootX + side * depth * 286,
        y: Number.isFinite(node.y) ? node.y : rootY + top + height / 2,
        side, color: node.color || branchColor, ...geometry(node)
      });
      if (node.collapsed) return;
      let next = top;
      for (const child of children.get(node.id) || []) {
        place(child, depth + 1, side, next, node.color || branchColor);
        next += weights.get(child.id) * 92;
      }
    }
    if (!root.collapsed) {
      const mainTopics = children.get(root.id) || [];
      for (const side of [-1, 1]) {
        const branchList = mainTopics.filter((_, index) => index % 2 === (side < 0 ? 1 : 0));
        let top = -branchList.reduce((sum, node) => sum + weights.get(node.id) * 92, 0) / 2;
        for (const node of branchList) {
          place(node, 1, side, top, palette[(mainTopics.indexOf(node) + 1) % palette.length]);
          top += weights.get(node.id) * 92;
        }
      }
    }
    return positions;
  }
  function render() {
    disconnectPrevious();
    const draft = editor;
    if (!draft?.mindmap?.nodes?.length) return el('div');
    const map = () => draft.mindmap;
    const nodes = () => map().nodes;
    const cacheKey = JSON.stringify([state.brainSpace?.activeId || 'personal', draft.id]);
    let session = sessions.get(cacheKey);
    if (!session) {
      session = { selected: nodes()[0].id, past: [], future: [], view: null, relationFrom: null, draftReference: draft };
      sessions.set(cacheKey, session);
      if (sessions.size > 30) sessions.delete(sessions.keys().next().value);
    }
    if (session.draftReference !== draft && !draft.dirty) {
      session.past = []; session.future = []; session.relationFrom = null;
    }
    session.draftReference = draft;
    if (!nodes().some(node => node.id === session.selected)) session.selected = nodes()[0].id;
    const needsInitialFit = !session.view;
    let positions = layout(nodes());
    let gesture = null;
    let dropTarget = null;
    let textEditor = null;
    let relationLabel = null;
    let commitRelation = null;
    let interactionEndQueued = false;
    let dragCommitPending = false;
    let zoomTarget = null;
    let viewFrame = 0;
    let lastViewTime = 0;
    let disposed = false;
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const host = el('section', { class: 'topic-map', 'aria-label': 'Tankekartredigering' });
    const toolbar = el('div', { class: 'topic-map-toolbar', role: 'toolbar', 'aria-label': 'Tankekartverktøy' });
    const properties = el('div', { class: 'topic-map-properties' });
    const stage = el('div', { class: 'topic-map-stage' });
    const svg = svgEl('svg', { class: 'topic-map-svg', role: 'group', 'aria-label': 'Tankekart. Tab lager underpunkt. Enter lager sidepunkt. Dobbeltklikk for å skrive.', tabindex: 0 });
    const notice = el('div', { class: 'topic-map-notice', 'aria-live': 'polite' });
    const footer = el('div', { class: 'topic-map-footer' });
    const zoomValue = el('span', { class: 'topic-map-zoom-value' });
    stage.append(svg, notice);
    host.append(toolbar, properties, stage, footer);
    flushCurrent = () => {
      if (editor !== draft || !host.isConnected || opening()) return;
      commitText(); commitRelation?.();
    };
    const current = () => nodes().find(node => node.id === session.selected) || nodes()[0];
    const say = text => { notice.textContent = text; };
    const opening = () => Boolean(window.SammenLiveFile?.isOpening?.(draft));
    function interactionEnd(committedDrag = false) {
      dragCommitPending ||= committedDrag;
      if (interactionEndQueued) return;
      interactionEndQueued = true;
      queueMicrotask(() => {
        interactionEndQueued = false;
        const commitDrag = dragCommitPending; dragCommitPending = false;
        if (editor !== draft || !host.isConnected || opening()) return;
        if (commitDrag) markDirty();
        window.SammenLiveFile?.interactionEnd?.(draft);
      });
    }
    function remember() {
      session.past.push(copy(map()));
      if (session.past.length > 70) session.past.shift();
      session.future = [];
    }
    function changed() {
      const alreadyBusy = svg.classList.contains('dragging');
      svg.classList.add('dragging');
      markDirty(); redraw(); renderTools();
      if (!alreadyBusy) svg.classList.remove('dragging');
      interactionEnd();
    }
    function edit(action) { if (opening()) return; remember(); action(); changed(); }
    function viewport() {
      const width = stage.clientWidth || 720, height = stage.clientHeight || 440;
      return { width, height };
    }
    function updateView() {
      const { width, height } = viewport();
      if (!session.view) session.view = { x: 0, y: 0, zoom: 0.85 };
      const view = session.view;
      svg.setAttribute('viewBox', `${view.x - width / view.zoom / 2} ${view.y - height / view.zoom / 2} ${width / view.zoom} ${height / view.zoom}`);
      const percent = `${Math.round(view.zoom * 100)}%`;
      if (zoomValue.textContent !== percent) zoomValue.textContent = percent;
    }
    function stopZoom() {
      if (viewFrame) cancelAnimationFrame(viewFrame);
      viewFrame = 0; lastViewTime = 0; zoomTarget = null;
    }
    function animateView(time) {
      viewFrame = 0;
      if (disposed || !host.isConnected) { stopZoom(); return; }
      if (!zoomTarget) return;
      const view = session.view, target = zoomTarget;
      const elapsed = lastViewTime ? clamp(time - lastViewTime, 0, 64) : 1000 / 60;
      lastViewTime = time;
      const progress = reducedMotion?.matches ? 1 : 1 - Math.exp(-elapsed / 60);
      // The center and inverse zoom share the same easing so the cursor's
      // world point stays fixed throughout the animation, not just at its end.
      view.x += (target.x - view.x) * progress;
      view.y += (target.y - view.y) * progress;
      view.zoom = 1 / (1 / view.zoom + (1 / target.zoom - 1 / view.zoom) * progress);
      const settled = Math.abs(Math.log(target.zoom / view.zoom)) < 0.0003
        && Math.hypot(target.x - view.x, target.y - view.y) * view.zoom < 0.05;
      if (progress === 1 || settled) { session.view = target; zoomTarget = null; lastViewTime = 0; }
      updateView();
      if (zoomTarget) viewFrame = requestAnimationFrame(animateView);
    }
    function fit() {
      stopZoom();
      positions = layout(nodes());
      const values = [...positions.values()];
      const minX = Math.min(...values.map(pos => pos.x - pos.width / 2)) - 72;
      const maxX = Math.max(...values.map(pos => pos.x + pos.width / 2)) + 72;
      const minY = Math.min(...values.map(pos => pos.y - pos.height / 2)) - 72;
      const maxY = Math.max(...values.map(pos => pos.y + pos.height / 2)) + 72;
      const { width, height } = viewport();
      session.view = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, zoom: clamp(Math.min(width / (maxX - minX), height / (maxY - minY)), 0.22, 1.15) };
      updateView();
    }
    function zoom(factor, at = null) {
      if (disposed || gesture || !Number.isFinite(factor) || factor <= 0) return;
      const view = session.view;
      const next = clamp((zoomTarget?.zoom || view.zoom) * factor, 0.15, 2.5);
      if (zoomTarget?.zoom === next || (!zoomTarget && view.zoom === next)) return;
      const anchor = at || view;
      zoomTarget = {
        x: anchor.x - (anchor.x - view.x) * view.zoom / next,
        y: anchor.y - (anchor.y - view.y) * view.zoom / next,
        zoom: next
      };
      if (reducedMotion?.matches) {
        const target = zoomTarget; stopZoom(); session.view = target; updateView();
      } else if (!viewFrame) {
        lastViewTime = 0;
        viewFrame = requestAnimationFrame(animateView);
      }
    }
    function point(event) {
      const matrix = svg.getScreenCTM();
      if (!matrix) return { x: 0, y: 0 };
      const location = svg.createSVGPoint(); location.x = event.clientX; location.y = event.clientY;
      return location.matrixTransform(matrix.inverse());
    }
    function select(nodeId, repaint = true) {
      if (opening()) return;
      session.selected = nodeId;
      if (session.relationFrom) {
        const fromId = session.relationFrom;
        session.relationFrom = null;
        if (fromId !== nodeId && !(map().relations || []).some(rel => rel.fromId === fromId && rel.toId === nodeId)) {
          if ((map().relations || []).length >= 300) {
            say('Kartet kan ha opptil 300 ekstra koblinger.');
            redraw(); renderTools(); return;
          }
          edit(() => { (map().relations ||= []).push({ id: id(), fromId, toId: nodeId, label: '' }); });
          say('Kobling lagt til. Dobbeltklikk på linjen for å navngi den.');
          return;
        }
      }
      if (repaint) redraw();
      else for (const topic of svg.querySelectorAll('[data-topic]')) {
        const selected = topic.getAttribute('data-topic') === nodeId;
        topic.classList.toggle('selected', selected);
        topic.setAttribute('aria-pressed', String(selected));
      }
      renderTools();
    }
    function addTopic(sibling = false) {
      if (opening()) return;
      commitText();
      if (nodes().length >= 150) { say('Kartet kan ha opptil 150 punkter.'); return; }
      const chosen = current();
      const parent = sibling && chosen.parentId ? nodes().find(node => node.id === chosen.parentId) : chosen;
      const next = { id: id(), text: 'Ny idé', parentId: parent.id };
      edit(() => {
        parent.collapsed = false;
        nodes().push(next);
        session.selected = next.id;
      });
      const parentPosition = positions.get(parent.id);
      const auto = positions.get(next.id);
      if (auto && parentPosition && (Number.isFinite(parent.x) || Number.isFinite(parent.y))) {
        next.x = parentPosition.x + (parentPosition.side || 1) * 286;
        const siblings = nodes().filter(node => node.parentId === parent.id && node.id !== next.id);
        next.y = parentPosition.y + siblings.length * 92;
        redraw();
      }
      startText(next.id, true);
    }
    function deleteTopic() {
      if (opening()) return;
      commitText();
      const node = current();
      if (!node.parentId) { say('Hovedideen beholdes.'); return; }
      const removed = subtree(node.id, nodes());
      edit(() => {
        map().nodes = nodes().filter(topic => !removed.has(topic.id));
        map().relations = (map().relations || []).filter(rel => !removed.has(rel.fromId) && !removed.has(rel.toId));
        session.selected = node.parentId;
      });
      say(removed.size === 1 ? 'Punkt slettet. Angre for å hente det tilbake.' : `${removed.size} punkter slettet. Angre for å hente dem tilbake.`);
      svg.focus();
    }
    function undo(redo = false) {
      if (opening()) return;
      commitText();
      const from = redo ? session.future : session.past;
      if (!from.length) return;
      (redo ? session.past : session.future).push(copy(map()));
      draft.mindmap = from.pop();
      if (!nodes().some(node => node.id === session.selected)) session.selected = nodes()[0].id;
      changed(); svg.focus();
    }
    function commitText(cancel = false) {
      if (!textEditor || opening()) return;
      const alreadyBusy = svg.classList.contains('dragging');
      svg.classList.add('dragging');
      const active = textEditor; textEditor = null;
      const topic = nodes().find(node => node.id === active.nodeId);
      const value = active.input.value.trim().slice(0, 180) || 'Ny idé';
      active.overlay.remove();
      if (!cancel && topic && value !== topic.text) edit(() => { topic.text = value; });
      if (!alreadyBusy) svg.classList.remove('dragging');
      interactionEnd();
    }
    function startText(nodeId, selectAll = false) {
      if (opening()) return;
      stopZoom();
      commitText();
      session.selected = nodeId;
      redraw(); renderTools();
      const topic = nodes().find(node => node.id === nodeId), pos = positions.get(nodeId);
      if (!topic || !pos) return;
      const overlay = svgEl('foreignObject', { x: pos.x - pos.width / 2, y: pos.y - pos.height / 2, width: pos.width, height: Math.max(pos.height, 72), class: 'topic-map-text-overlay' });
      const input = document.createElement('textarea');
      input.className = 'topic-map-inline-input'; input.value = topic.text; input.maxLength = 180;
      input.setAttribute('aria-label', 'Tekst i valgt punkt');
      overlay.append(input); svg.append(overlay);
      textEditor = { nodeId, input, overlay };
      input.addEventListener('input', markDirty);
      input.addEventListener('pointerdown', event => event.stopPropagation());
      input.addEventListener('keydown', event => {
        event.stopPropagation();
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); commitText(); saveEditor(); }
        else if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); commitText(); svg.focus(); }
        else if (event.key === 'Escape') { event.preventDefault(); commitText(true); svg.focus(); }
        else if (event.key === 'Tab') { event.preventDefault(); commitText(); addTopic(false); }
      });
      input.addEventListener('blur', () => commitText());
      input.focus(); if (selectAll) input.select();
    }
    function editRelation(relationId) {
      if (opening()) return;
      stopZoom();
      commitText(); commitRelation?.();
      const relation = (map().relations || []).find(rel => rel.id === relationId);
      if (!relation) return;
      relationLabel?.remove();
      const field = el('input', { class: 'topic-map-relation-input', 'aria-label': 'Tekst på kobling', maxlength: 180, value: relation.label || '', placeholder: 'Kobling …' });
      const remove = btn('', () => { finish(true); edit(() => { map().relations = map().relations.filter(rel => rel.id !== relationId); }); }, 'button-quiet button-small', 'trash', { 'aria-label': 'Slett kobling', title: 'Slett kobling' });
      const box = el('div', { class: 'topic-map-relation-editor' }, field, remove);
      relationLabel = box; stage.append(box);
      let finished = false;
      function finish(cancel = false) {
        if (finished || opening()) return; finished = true;
        const alreadyBusy = svg.classList.contains('dragging');
        svg.classList.add('dragging');
        if (!cancel && field.value.trim() !== (relation.label || '')) edit(() => { relation.label = field.value.trim(); });
        box.remove(); relationLabel = null; commitRelation = null;
        if (!alreadyBusy) svg.classList.remove('dragging');
        interactionEnd();
      }
      commitRelation = finish;
      field.addEventListener('input', markDirty);
      field.addEventListener('keydown', event => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); finish(); saveEditor(); }
        else if (event.key === 'Enter' || event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(event.key === 'Escape'); svg.focus(); }
      });
      field.addEventListener('blur', () => { setTimeout(() => { if (!box.contains(document.activeElement)) finish(); }, 0); });
      field.focus(); field.select();
    }
    function renderTools() {
      const node = current();
      const children = nodes().some(topic => topic.parentId === node.id);
      toolbar.replaceChildren(
        btn('Underpunkt', () => addTopic(false), 'button-small', 'add', { title: 'Underpunkt (Tab)' }),
        btn('Sidepunkt', () => addTopic(true), 'button-secondary button-small', 'add', { title: 'Sidepunkt (Enter)' }),
        el('span', { class: 'topic-map-tool-divider', 'aria-hidden': 'true' }),
        btn('', () => startText(node.id, true), 'button-quiet button-small', 'file', { 'aria-label': 'Endre punkttekst', title: 'Endre tekst (F2)' }),
        btn('', () => { session.relationFrom = session.relationFrom ? null : node.id; renderTools(); redraw(); say(session.relationFrom ? 'Velg punktet som skal kobles til.' : ''); }, `button-quiet button-small${session.relationFrom ? ' active' : ''}`, 'link', { 'aria-label': 'Koble to punkter', 'aria-pressed': Boolean(session.relationFrom), title: 'Koble to punkter' }),
        btn('', () => edit(() => { node.collapsed = !node.collapsed; }), 'button-quiet button-small', node.collapsed ? 'add' : 'chevron', { 'aria-label': node.collapsed ? 'Vis underpunkter' : 'Skjul underpunkter', title: node.collapsed ? 'Vis underpunkter' : 'Skjul underpunkter', disabled: !children }),
        btn('', deleteTopic, 'button-quiet button-small', 'trash', { 'aria-label': 'Slett valgt punkt', title: 'Slett punkt og underpunkter (Delete)', disabled: !node.parentId }),
        el('span', { class: 'topic-map-tool-divider', 'aria-hidden': 'true' }),
        btn('↶', () => undo(), 'button-quiet button-small topic-map-history', null, { 'aria-label': 'Angre i tankekart', title: 'Angre (Ctrl+Z)', disabled: !session.past.length }),
        btn('↷', () => undo(true), 'button-quiet button-small topic-map-history', null, { 'aria-label': 'Gjør om i tankekart', title: 'Gjør om (Ctrl+Y)', disabled: !session.future.length })
      );
      const color = node.color || positions.get(node.id)?.color || palette[0];
      const shape = el('select', { class: 'topic-map-shape', 'aria-label': 'Form på valgt punkt', value: node.shape || 'rounded', onchange: event => edit(() => { node.shape = event.target.value; }) },
        el('option', { value: 'rounded' }, 'Avrundet'), el('option', { value: 'rectangle' }, 'Firkant'), el('option', { value: 'ellipse' }, 'Oval'));
      const eligibleParents = nodes().filter(topic => !subtree(node.id, nodes()).has(topic.id));
      const parentSelect = el('select', { class: 'topic-map-parent', 'aria-label': 'Flytt valgt punkt under', value: node.parentId || '', disabled: !node.parentId, onchange: event => edit(() => { node.parentId = event.target.value; const parent = nodes().find(topic => topic.id === node.parentId); if (parent) parent.collapsed = false; }) }, !node.parentId ? el('option', { value: '' }, 'Hovedidé') : null, eligibleParents.map(topic => el('option', { value: topic.id }, `Under ${topic.text.slice(0, 28)}`)));
      properties.replaceChildren(
        el('div', { class: 'topic-map-colors', role: 'group', 'aria-label': 'Punktfarge' }, palette.map((value, index) => {
          const swatch = el('button', { type: 'button', class: `topic-map-swatch${value === color ? ' selected' : ''}`, 'aria-label': ['Lilla punkt', 'Blått punkt', 'Ferskenfarget punkt', 'Grønt punkt', 'Gult punkt', 'Rosa punkt'][index], 'aria-pressed': value === color, onclick: () => edit(() => { node.color = value; }) });
          swatch.style.setProperty('--swatch', value);
          return swatch;
        })),
        shape, parentSelect,
        btn('Rydd', () => { commitText(); edit(() => { for (const topic of nodes()) { delete topic.x; delete topic.y; } }); fit(); }, 'button-quiet button-small', 'map', { title: 'Ordne punktene automatisk' })
      );
    }
    function redraw() {
      positions = layout(nodes());
      const defs = svgEl('defs', {}, [svgEl('marker', { id: `topic-arrow-${draft.id}`, viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 5, markerHeight: 5, orient: 'auto-start-reverse' }, [svgEl('path', { d: 'M 0 0 L 10 5 L 0 10 Z', fill: '#b195c4' })])]);
      const edges = svgEl('g', { class: 'topic-map-edges' });
      for (const topic of nodes()) {
        const pos = positions.get(topic.id), parent = positions.get(topic.parentId);
        if (!pos || !parent) continue;
        const right = pos.x >= parent.x;
        const x1 = parent.x + (right ? 1 : -1) * parent.width / 2;
        const x2 = pos.x + (right ? -1 : 1) * pos.width / 2;
        const middle = (x1 + x2) / 2;
        edges.append(svgEl('path', { d: `M ${x1} ${parent.y} C ${middle} ${parent.y}, ${middle} ${pos.y}, ${x2} ${pos.y}`, class: 'topic-map-branch' }));
      }
      const relations = svgEl('g', { class: 'topic-map-relations' });
      for (const relation of map().relations || []) {
        const from = positions.get(relation.fromId), to = positions.get(relation.toId);
        if (!from || !to) continue;
        const x1 = from.x, y1 = from.y - from.height / 2 - 3;
        const x2 = to.x, y2 = to.y - to.height / 2 - 3;
        const bendY = Math.min(y1, y2) - Math.max(54, Math.abs(x1 - x2) * 0.12);
        const d = `M ${x1} ${y1} C ${x1} ${bendY}, ${x2} ${bendY}, ${x2} ${y2}`;
        const group = svgEl('g', { 'data-relation': relation.id, role: 'button', tabindex: 0, 'aria-label': `Kobling: ${relation.label || 'uten navn'}`, class: 'topic-map-relation' });
        group.append(svgEl('path', { d, class: 'topic-map-relation-hit' }), svgEl('path', { d, class: 'topic-map-relation-path', 'marker-end': `url(#topic-arrow-${draft.id})` }));
        if (relation.label) { const text = svgEl('text', { x: (x1 + x2) / 2, y: (y1 + y2) / 8 + bendY * 0.75 - 6, class: 'topic-map-relation-text', 'text-anchor': 'middle' }); text.textContent = relation.label.length > 34 ? `${relation.label.slice(0, 32)}…` : relation.label; group.append(text); }
        group.addEventListener('dblclick', event => { event.stopPropagation(); editRelation(relation.id); });
        group.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); editRelation(relation.id); } });
        relations.append(group);
      }
      const topics = svgEl('g', { class: 'topic-map-topics' });
      for (const topic of nodes()) {
        const pos = positions.get(topic.id);
        if (!pos) continue;
        const selected = session.selected === topic.id;
        const group = svgEl('g', { transform: `translate(${pos.x} ${pos.y})`, 'data-topic': topic.id, role: 'button', tabindex: 0, 'aria-label': `Punkt: ${topic.text}`, 'aria-pressed': selected, class: `topic-map-topic${selected ? ' selected' : ''}${dropTarget === topic.id ? ' drop-target' : ''}${session.relationFrom === topic.id ? ' relation-start' : ''}` });
        const shape = topic.shape || 'rounded';
        group.append(shape === 'ellipse' ? svgEl('ellipse', { cx: 0, cy: 3, rx: pos.width / 2, ry: pos.height / 2, class: 'topic-map-shadow' }) : svgEl('rect', { x: -pos.width / 2, y: -pos.height / 2 + 4, width: pos.width, height: pos.height, rx: shape === 'rectangle' ? 3 : 16, class: 'topic-map-shadow' }));
        group.append(shape === 'ellipse' ? svgEl('ellipse', { cx: 0, cy: 0, rx: pos.width / 2, ry: pos.height / 2, fill: pos.color, class: 'topic-map-shape-body' }) : svgEl('rect', { x: -pos.width / 2, y: -pos.height / 2, width: pos.width, height: pos.height, rx: shape === 'rectangle' ? 3 : 16, fill: pos.color, class: 'topic-map-shape-body' }));
        const text = svgEl('text', { class: 'topic-map-label', 'text-anchor': 'middle', 'pointer-events': 'none' });
        pos.lines.forEach((line, index) => { const span = svgEl('tspan', { x: 0, y: -(pos.lines.length - 1) * 9 + index * 18 + 5 }); span.textContent = line; text.append(span); });
        const title = svgEl('title'); title.textContent = topic.text;
        group.append(text, title);
        const childCount = nodes().filter(child => child.parentId === topic.id).length;
        if (childCount) {
          const toggle = svgEl('g', { transform: `translate(${pos.width / 2} 0)`, 'data-collapse': topic.id, role: 'button', tabindex: 0, 'aria-label': topic.collapsed ? `Vis underpunkter til ${topic.text}` : `Skjul underpunkter til ${topic.text}`, class: 'topic-map-collapse' });
          toggle.append(svgEl('circle', { r: 10 }));
          const sign = svgEl('text', { 'text-anchor': 'middle', y: 4 }); sign.textContent = topic.collapsed ? '+' : '−'; toggle.append(sign);
          toggle.addEventListener('click', event => { event.stopPropagation(); session.selected = topic.id; edit(() => { topic.collapsed = !topic.collapsed; }); });
          toggle.addEventListener('keydown', event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); session.selected = topic.id; edit(() => { topic.collapsed = !topic.collapsed; }); } });
          group.append(toggle);
        }
        group.addEventListener('dblclick', event => { if (!event.target.closest('[data-collapse]')) { event.stopPropagation(); startText(topic.id, true); } });
        group.addEventListener('keydown', event => { session.selected = topic.id; handleKey(event); });
        topics.append(group);
      }
      svg.replaceChildren(defs, edges, relations, topics);
      updateView();
    }
    function handleKey(event) {
      if (opening()) return;
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
      const control = event.ctrlKey || event.metaKey;
      if (control && event.key.toLowerCase() === 'z') { event.preventDefault(); event.stopPropagation(); undo(event.shiftKey); }
      else if (control && event.key.toLowerCase() === 'y') { event.preventDefault(); event.stopPropagation(); undo(true); }
      else if (event.key === 'Tab' && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); addTopic(false); }
      else if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); addTopic(true); }
      else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); deleteTopic(); }
      else if (event.key === 'F2') { event.preventDefault(); event.stopPropagation(); startText(current().id, true); }
      else if (event.key === 'Escape') { session.relationFrom = null; renderTools(); redraw(); say(''); }
      else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        const from = positions.get(session.selected);
        const direction = event.key.replace('Arrow', '').toLowerCase();
        const candidate = [...positions].filter(([key, pos]) => key !== session.selected && (direction === 'left' ? pos.x < from.x - 4 : direction === 'right' ? pos.x > from.x + 4 : direction === 'up' ? pos.y < from.y - 4 : pos.y > from.y + 4)).sort(([, a], [, b]) => Math.hypot(a.x - from.x, a.y - from.y) - Math.hypot(b.x - from.x, b.y - from.y))[0];
        if (candidate) select(candidate[0]); svg.focus();
      }
    }
    svg.addEventListener('keydown', handleKey);
    svg.addEventListener('pointerdown', event => {
      if (opening()) return;
      if (event.button !== 0 || event.target.closest('[data-collapse], [data-relation], foreignObject')) return;
      stopZoom();
      commitText(); commitRelation?.();
      const topicId = event.target.closest('[data-topic]')?.getAttribute('data-topic');
      const start = point(event);
      if (topicId) {
        select(topicId, false);
        const moving = subtree(topicId, nodes());
        const expandedPositions = layout(nodes().map(topic => ({ ...topic, collapsed: false })));
        const anchor = positions.get(topicId), expandedAnchor = expandedPositions.get(topicId);
        const offset = { x: anchor.x - expandedAnchor.x, y: anchor.y - expandedAnchor.y };
        const movingPositions = new Map([...expandedPositions].filter(([key]) => moving.has(key)).map(([key, pos]) => {
          const visible = positions.get(key);
          return [key, visible ? { x: visible.x, y: visible.y } : { x: pos.x + offset.x, y: pos.y + offset.y }];
        }));
        gesture = { type: 'topic', id: topicId, start, clientX: event.clientX, clientY: event.clientY, original: copy(map()), moving, positions: movingPositions, moved: false, pointerId: event.pointerId };
      } else {
        gesture = { type: 'pan', start, originalView: { ...session.view }, pointerId: event.pointerId };
        svg.setPointerCapture(event.pointerId);
      }
      svg.focus();
    });
    svg.addEventListener('pointermove', event => {
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      if (!(event.buttons & 1)) { finishGesture(event, true); return; }
      if (gesture.type === 'pan') {
        const { width, height } = viewport(), bounds = svg.getBoundingClientRect();
        const location = { x: gesture.originalView.x - width / gesture.originalView.zoom / 2 + (event.clientX - bounds.left) * width / bounds.width / gesture.originalView.zoom, y: gesture.originalView.y - height / gesture.originalView.zoom / 2 + (event.clientY - bounds.top) * height / bounds.height / gesture.originalView.zoom };
        session.view.x = gesture.originalView.x - (location.x - gesture.start.x); session.view.y = gesture.originalView.y - (location.y - gesture.start.y); updateView(); return;
      }
      if (!gesture.moved && Math.hypot(event.clientX - gesture.clientX, event.clientY - gesture.clientY) < 5) return;
      if (!gesture.moved) { remember(); gesture.moved = true; svg.classList.add('dragging'); svg.setPointerCapture(event.pointerId); }
      const location = point(event), dx = location.x - gesture.start.x, dy = location.y - gesture.start.y;
      for (const topic of nodes()) {
        const original = gesture.positions.get(topic.id);
        if (original) { topic.x = clamp(original.x + dx, -20000, 20000); topic.y = clamp(original.y + dy, -20000, 20000); }
      }
      const movingNode = nodes().find(topic => topic.id === gesture.id);
      dropTarget = movingNode?.parentId ? [...positions].find(([key, pos]) => !gesture.moving.has(key) && Math.abs(location.x - pos.x) < pos.width / 2 + 12 && Math.abs(location.y - pos.y) < pos.height / 2 + 12)?.[0] || null : null;
      markDirty(); redraw();
    });
    function finishGesture(event, cancel = false) {
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      if (cancel && gesture.moved) { draft.mindmap = gesture.original; session.past.pop(); }
      else if (gesture.type === 'topic' && gesture.moved && dropTarget) {
        const node = nodes().find(topic => topic.id === gesture.id);
        node.parentId = dropTarget;
        const parent = nodes().find(topic => topic.id === dropTarget); parent.collapsed = false;
        const parentPos = positions.get(dropTarget);
        const branchSide = parentPos.side || positions.get(node.id)?.side || 1;
        const siblings = nodes().filter(topic => topic.parentId === dropTarget && topic.id !== node.id);
        const shift = { x: parentPos.x + branchSide * 286 - node.x, y: parentPos.y + siblings.length * 92 - node.y };
        for (const topic of nodes()) if (gesture.moving.has(topic.id)) {
          if (Number.isFinite(topic.x)) topic.x = clamp(topic.x + shift.x, -20000, 20000);
          if (Number.isFinite(topic.y)) topic.y = clamp(topic.y + shift.y, -20000, 20000);
        }
        say(`Punkt flyttet under ${parent.text}.`);
      }
      const repaint = gesture.type === 'topic' && gesture.moved;
      gesture = null; dropTarget = null; svg.classList.remove('dragging');
      if (repaint) { redraw(); renderTools(); }
      if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
      interactionEnd(repaint && !cancel);
    }
    svg.addEventListener('pointerup', event => finishGesture(event));
    svg.addEventListener('pointercancel', event => finishGesture(event, true));
    svg.addEventListener('wheel', event => {
      if (textEditor || opening()) return;
      event.preventDefault();
      if (gesture || !Number.isFinite(event.deltaY) || event.deltaY === 0) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport().height : 1;
      const delta = clamp(event.deltaY * unit, -240, 240);
      // Trackpads emit small pixel deltas; Ctrl+wheel is their pinch gesture.
      zoom(Math.exp(-delta * (event.ctrlKey ? 0.008 : 0.0015)), point(event));
    }, { passive: false });
    footer.append(el('span', { class: 'topic-map-key-hint' }, el('kbd', {}, 'Tab'), ' underpunkt · ', el('kbd', {}, 'Enter'), ' sidepunkt'),
      el('div', { class: 'topic-map-view-tools' }, btn('−', () => zoom(1 / 1.2), 'button-quiet button-small', null, { 'aria-label': 'Zoom ut i tankekart' }), zoomValue, btn('+', () => zoom(1.2), 'button-quiet button-small', null, { 'aria-label': 'Zoom inn i tankekart' }), btn('Tilpass', fit, 'button-quiet button-small', null, { title: 'Vis hele tankekartet' })));
    renderTools(); redraw();
    const observer = new ResizeObserver(() => { if (host.isConnected) updateView(); else disconnect(); });
    function disconnect() { disposed = true; stopZoom(); observer.disconnect(); }
    observer.observe(stage); disconnectPrevious = disconnect;
    requestAnimationFrame(() => { if (disposed || !host.isConnected) return; if (needsInitialFit) fit(); else updateView(); });
    return host;
  }
  window.SammenMindmap = { render, flush: () => flushCurrent() };
})();
