'use strict';

(() => {
  const NS = 'http://www.w3.org/2000/svg';
  const styles = ['cat', 'fox', 'bear', 'rabbit', 'owl', 'frog', 'panda', 'robot'];
  const colors = ['lilac', 'peach', 'mint', 'sky', 'rose', 'butter'];
  const styleNames = { cat: 'Katt', fox: 'Rev', bear: 'Bjørn', rabbit: 'Kanin', owl: 'Ugle', frog: 'Frosk', panda: 'Panda', robot: 'Robot' };
  const colorNames = { lilac: 'Syrin', peach: 'Fersken', mint: 'Mynte', sky: 'Himmel', rose: 'Rosa', butter: 'Vanilje' };
  const palette = { lilac: '#e9ddf8', peach: '#f9e0cd', mint: '#e0efdb', sky: '#daeaf5', rose: '#f5dce7', butter: '#f7edc9' };
  let memberDialog = null;

  function avatarForId(id) {
    if (!id) return { style: 'cat', color: 'lilac' };
    let hash = 2166136261;
    for (const character of String(id)) hash = Math.imul(hash ^ character.codePointAt(0), 16777619) >>> 0;
    return { style: styles[hash % styles.length], color: colors[Math.floor(hash / styles.length) % colors.length] };
  }
  function personId(person) { return person?.userId || person?.id || null; }
  function selectedBrain(snapshot = state) {
    return snapshot.brainSpace?.brains?.find(brain => brain.id === snapshot.brainSpace.activeId) || { id: 'personal', name: 'Min Brain', isPersonal: true };
  }
  function resolvePerson(person, brain = selectedBrain(), snapshot = state) {
    const id = personId(person);
    if (!id || person?.legacy) return { ...person, id: null, name: person?.name || 'Ukjent', legacy: true };
    const active = brain.id === (snapshot.brainSpace?.activeId || 'personal');
    const candidates = [snapshot.user, ...(brain.members || []), ...(active ? snapshot.sync?.roster || [] : [])];
    const known = candidates.find(candidate => personId(candidate) === id);
    return { ...person, id, name: known?.name || person.name || 'Elev', avatar: known?.avatar || person.avatar };
  }
  function normalizedAvatar(person) {
    const fallback = avatarForId(personId(person));
    return { style: styles.includes(person?.avatar?.style) ? person.avatar.style : fallback.style, color: colors.includes(person?.avatar?.color) ? person.avatar.color : fallback.color };
  }
  function displayName(person) { return person?.name || 'Ukjent'; }
  function personLabel(person) { return person?.label || `${displayName(person)}${person?.legacy ? ' · eldre oppføring' : ''}`; }
  function svgNode(tag, attrs = {}, ...children) {
    const node = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    for (const child of children.flat()) if (child !== null && child !== undefined) node.append(child);
    return node;
  }
  function avatar(person = {}, options = {}) {
    const value = resolvePerson(person);
    const choice = normalizedAvatar(value);
    const size = Number.isFinite(options.size) ? Math.max(12, Math.min(120, options.size)) : 28;
    const node = svgNode('svg', { xmlns: NS, width: size, height: size, viewBox: '0 0 40 40', class: 'people-avatar', focusable: 'false', ...(options.decorative ? { 'aria-hidden': 'true' } : { role: 'img', 'aria-label': options.label || personLabel(value) }) });
    if (!options.decorative) node.append(svgNode('title', {}, options.label || personLabel(value)));
    node.append(svgNode('circle', { cx: 20, cy: 21, r: 18, fill: '#bda4cd', opacity: '.24' }), svgNode('circle', { cx: 20, cy: 19, r: 18, fill: palette[choice.color], stroke: '#ae91c1', 'stroke-width': 1.3 }));
    const face = svgNode('g', { fill: '#fff9f0', stroke: '#856990', 'stroke-width': 1.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
    const dot = (x, y, radius = 1.25, fill = '#70577b') => svgNode('circle', { cx: x, cy: y, r: radius, fill, stroke: 'none' });
    const eyes = (y = 23) => [dot(15, y), dot(25, y)];
    const cheeks = () => [svgNode('ellipse', { cx: 11.8, cy: 26, rx: 2.2, ry: 1.2, fill: '#ecc2c5', stroke: 'none' }), svgNode('ellipse', { cx: 28.2, cy: 26, rx: 2.2, ry: 1.2, fill: '#ecc2c5', stroke: 'none' })];
    const mouth = () => svgNode('path', { d: 'M17.5 28q2.5 2.5 5 0', fill: 'none' });
    if (choice.style === 'cat') {
      face.append(svgNode('path', { d: 'M9 19 8 9l9 5q3-1 6 0l9-5-1 10q3 3 2 8c-1 6-25 6-26 0q-1-5 2-8Z' }), svgNode('path', { d: 'm11 12 1 5 3-2m14-3-1 5-3-2', fill: '#efc4c9', stroke: 'none' }), ...eyes(), dot(20, 26, 1, '#b58e9f'), mouth(), svgNode('path', { d: 'M8 24H4m4 3-4 1m28-4h4m-4 3 4 1', fill: 'none', 'stroke-width': 1 }));
    } else if (choice.style === 'fox') {
      face.append(svgNode('path', { d: 'm8 20 1-12 10 8h2l10-8 1 12-4 9-8 5-8-5Z', fill: '#f2c3a5' }), svgNode('path', { d: 'm9 21 11 5 11-5-5 9-6 4-6-4Z', fill: '#fffaf1', stroke: 'none' }), svgNode('path', { d: 'm12 13 1 6 4-2m11-4-1 6-4-2', fill: '#d39eab', stroke: 'none' }), ...eyes(), dot(20, 27, 1.7), svgNode('path', { d: 'm18 30 2 1 2-1', fill: 'none' }));
    } else if (choice.style === 'bear') {
      face.append(svgNode('circle', { cx: 10, cy: 13, r: 5 }), svgNode('circle', { cx: 30, cy: 13, r: 5 }), svgNode('path', { d: 'M8 23c0-15 24-15 24 0 0 14-24 14-24 0Z', fill: '#f5ddc5' }), ...eyes(), svgNode('ellipse', { cx: 20, cy: 27, rx: 5.5, ry: 4, stroke: 'none' }), dot(20, 25.5, 1.5), mouth(), ...cheeks());
    } else if (choice.style === 'rabbit') {
      face.append(svgNode('ellipse', { cx: 14, cy: 12, rx: 4, ry: 9, transform: 'rotate(-12 14 12)' }), svgNode('ellipse', { cx: 26, cy: 12, rx: 4, ry: 9, transform: 'rotate(12 26 12)' }), svgNode('path', { d: 'M8 24c0-15 24-15 24 0 0 14-24 14-24 0Z' }), svgNode('path', { d: 'm13 7 2 9m12-9-2 9', stroke: '#edc1cb', 'stroke-width': 2.5 }), ...eyes(24), ...cheeks(), dot(20, 27, 1, '#c39bab'), svgNode('path', { d: 'M18 29q2 2 4 0', fill: 'none' }));
    } else if (choice.style === 'owl') {
      face.append(svgNode('path', { d: 'm9 16-1-6 8 4h8l8-4-1 6q4 8-2 15c-5 5-13 5-18 0q-6-7-2-15Z', fill: '#e4cfbc' }), svgNode('circle', { cx: 14, cy: 22, r: 6.5, stroke: 'none' }), svgNode('circle', { cx: 26, cy: 22, r: 6.5, stroke: 'none' }), ...eyes(22), svgNode('path', { d: 'm17.5 25 2.5 4 2.5-4Z', fill: '#e5bf75', stroke: 'none' }), svgNode('path', { d: 'm14 31 2 1m8 0 2-1', fill: 'none', 'stroke-width': 1 }));
    } else if (choice.style === 'frog') {
      face.append(svgNode('path', { d: 'M8 21q-3-15 9-11 3 2 6 0 12-4 9 11 4 14-12 14T8 21Z', fill: '#d3e5bd' }), svgNode('circle', { cx: 12.5, cy: 16.5, r: 4, fill: '#fffcf3', stroke: 'none' }), svgNode('circle', { cx: 27.5, cy: 16.5, r: 4, fill: '#fffcf3', stroke: 'none' }), dot(13, 17), dot(27, 17), ...cheeks(), svgNode('path', { d: 'M13 25q7 7 14 0', fill: 'none' }));
    } else if (choice.style === 'panda') {
      face.append(svgNode('circle', { cx: 10, cy: 13, r: 5, fill: '#9b88a4' }), svgNode('circle', { cx: 30, cy: 13, r: 5, fill: '#9b88a4' }), svgNode('path', { d: 'M7 23c0-16 26-16 26 0 0 15-26 15-26 0Z' }), svgNode('ellipse', { cx: 13.5, cy: 22, rx: 4, ry: 5, fill: '#a392ad', stroke: 'none', transform: 'rotate(25 13.5 22)' }), svgNode('ellipse', { cx: 26.5, cy: 22, rx: 4, ry: 5, fill: '#a392ad', stroke: 'none', transform: 'rotate(-25 26.5 22)' }), dot(14, 21, 1.2, '#fff9f0'), dot(26, 21, 1.2, '#fff9f0'), dot(20, 27, 1.6), mouth());
    } else {
      face.append(svgNode('path', { d: 'M20 9V5', fill: 'none' }), dot(20, 5, 2.2, '#d0b4e1'), svgNode('rect', { x: 7, y: 12, width: 26, height: 21, rx: 6, fill: '#e3deed' }), svgNode('rect', { x: 4, y: 19, width: 3, height: 8, rx: 1.3, fill: '#c9b6d7' }), svgNode('rect', { x: 33, y: 19, width: 3, height: 8, rx: 1.3, fill: '#c9b6d7' }), svgNode('rect', { x: 11, y: 18, width: 6, height: 6, rx: 2, fill: '#fffaf2', stroke: 'none' }), svgNode('rect', { x: 23, y: 18, width: 6, height: 6, rx: 2, fill: '#fffaf2', stroke: 'none' }), ...eyes(21), svgNode('path', { d: 'M16 28h8m-6-1v2m4-2v2', fill: 'none', 'stroke-width': 1.2 }));
    }
    node.append(face);
    return node;
  }
  function distinct(people) {
    const seen = new Set();
    return people.filter(person => { const id = personId(person); if (!id) return true; if (seen.has(id)) return false; seen.add(id); return true; });
  }
  function stack(people = [], options = {}) {
    const values = distinct(people).map(person => resolvePerson(person));
    const max = Number.isInteger(options.max) ? Math.max(1, Math.min(8, options.max)) : 3;
    const node = el('span', { class: 'people-stack', ...(options.decorative ? { 'aria-hidden': 'true' } : { role: 'img', 'aria-label': options.label || values.map(personLabel).join(', ') || 'Ingen medlemmer' }) });
    for (const person of values.slice(0, max)) node.append(avatar(person, { size: options.size || 26, decorative: true }));
    if (values.length > max) node.append(el('span', { class: 'people-stack-more', 'aria-hidden': 'true' }, `+${values.length - max}`));
    return node;
  }
  function contributorPeople(item) {
    const recorded = Array.isArray(item?.contributors) ? item.contributors.filter(person => personId(person)) : [];
    const people = distinct(recorded).map(person => resolvePerson(person));
    const legacyName = typeof item?.legacyAuthor === 'string' ? item.legacyAuthor.trim() : '';
    const author = typeof item?.author === 'string' ? item.author.trim() : '';
    const name = legacyName || (!people.length && item?.origin !== 'ai' && item?.type !== 'ai' ? author : '');
    if (name && name !== 'KI') people.push({ id: null, name, legacy: true, label: `${name} · eldre oppføring`, avatar: { style: 'robot', color: 'lilac' } });
    return people;
  }
  function dateLabel(value) {
    const date = new Date(value);
    return value && Number.isFinite(date.getTime()) ? date.toLocaleDateString('nb-NO', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  }
  function openContributors(item) {
    const people = contributorPeople(item);
    if (!people.length || window.SammenBrainSpaces?.isBusy?.() || window.SammenSharing?.isBusy?.()) return;
    const list = el('ul', { class: 'people-list' }, people.map(person => el('li', { class: 'people-list-row' }, avatar(person, { size: 38, decorative: true }), el('span', { class: 'people-list-person' }, el('strong', {}, displayName(person)), el('small', {}, person.legacy ? 'Eldre oppføring · identitet ikke registrert' : dateLabel(person.lastContributedAt) ? `Sist bidratt ${dateLabel(person.lastContributedAt)}` : 'Har bidratt til filen')), !person.legacy && personId(person) === state.user.id ? el('span', { class: 'people-you' }, 'deg') : null)));
    openModal('Bidragsytere', item.title || '', list, 'people-modal');
  }
  function contributors(item, options = {}) {
    const people = contributorPeople(item);
    if (!people.length) return null;
    const label = `Bidragsytere: ${people.map(personLabel).join(', ')}`;
    return el('button', { type: 'button', class: 'people-contributors', title: label, 'aria-label': label, 'aria-haspopup': 'dialog', onclick: () => openContributors(item) }, stack(people, { size: options.size || 24, max: options.max || 3, decorative: true }), people.length > 1 ? el('span', { class: 'people-contributor-count', 'aria-hidden': 'true' }, people.length) : null);
  }
  function memberPeople(brain = selectedBrain(), options = {}) {
    const snapshot = options.snapshot || state;
    const active = brain.id === (snapshot.brainSpace?.activeId || 'personal');
    const status = options.status || (active ? (options.snapshot ? snapshot.sync : ui.sync || snapshot.sync) || {} : brain.connection || {});
    const localPersonal = brain.id === 'personal' || brain.isPersonal;
    const roster = localPersonal ? [snapshot.user] : active && Array.isArray(status.roster) ? status.roster : Array.isArray(brain.members) ? brain.members : [];
    const online = !localPersonal && status.connected !== false && !status.error ? active ? status.members || [] : brain.onlineMembers || [] : [];
    const presence = new Map(online.filter(person => personId(person)).map(person => [personId(person), person]));
    return distinct([...roster, ...online].filter(person => personId(person))).map(person => {
      const id = personId(person), live = presence.get(id);
      const isYou = id === snapshot.user?.id;
      return { ...resolvePerson(person, brain, snapshot), online: Boolean(live), isYou, localHere: Boolean(localPersonal || (isYou && active && status.mode === 'local')), editingItemId: live?.editingItemId || null };
    }).sort((a, b) => Number(b.isYou) - Number(a.isYou) || Number(b.online) - Number(a.online) || displayName(a).localeCompare(displayName(b), 'nb'));
  }
  function membersList(brain = selectedBrain(), options = {}) {
    const people = memberPeople(brain, options);
    if (!people.length) return el('p', { class: 'people-empty' }, 'Ingen har blitt med ennå.');
    return el('ul', { class: 'people-list' }, people.map(person => el('li', { class: 'people-list-row' }, avatar(person, { size: 36, decorative: true }), el('span', { class: 'people-list-person' }, el('strong', {}, displayName(person)), el('small', { class: `people-presence${person.online ? ' online' : ''}` }, el('i', { 'aria-hidden': 'true' }), person.localHere ? 'På denne PC-en' : person.online ? 'Tilkoblet' : 'Frakoblet')), person.isYou ? el('span', { class: 'people-you' }, 'deg') : null, person.editingItemId ? el('span', { class: 'people-editing', title: state.items.find(item => item.id === person.editingItemId)?.title || 'Redigerer en fil' }, icon('file', 13), el('span', { class: 'visually-hidden' }, 'Redigerer en fil')) : null)));
  }
  function cleanupMembers() {
    memberDialog?.unsubscribe?.();
    memberDialog?.observer?.disconnect();
    memberDialog = null;
  }
  function openMembers(brain = selectedBrain()) {
    if (window.SammenBrainSpaces?.isBusy?.() || window.SammenSharing?.isBusy?.()) return;
    cleanupMembers();
    const container = el('div', { class: 'people-members-panel' });
    const brainId = brain.id;
    function paint(snapshot = state) {
      const current = snapshot.brainSpace?.brains?.find(value => value.id === brainId) || brain;
      const people = memberPeople(current, { snapshot });
      const total = people.length;
      const online = people.filter(person => person.online).length;
      container.replaceChildren(el('div', { class: 'people-members-summary' }, stack(people, { size: 31, max: 5, decorative: true }), el('span', {}, `${total} ${total === 1 ? 'medlem' : 'medlemmer'}${online ? ` · ${online} tilkoblet` : ''}`)), membersList(current, { snapshot }), current.visibility === 'invited' ? el('div', { class: 'modal-actions' }, btn('Inviter', () => window.SammenSharing?.open?.(), 'button-secondary', 'users')) : null);
    }
    paint();
    openModal('Medlemmer', brain.name || 'Brain', container, 'people-modal');
    const context = { container, unsubscribe: null, observer: null };
    memberDialog = context;
    if (typeof api?.onState === 'function') context.unsubscribe = api.onState(value => { if (container.isConnected) paint(value?.state || value); });
    context.observer = new MutationObserver(() => { if (!container.isConnected && memberDialog === context) cleanupMembers(); });
    context.observer.observe(document.getElementById('modal-root'), { childList: true });
  }
  function picker(user, onChange) {
    let choice = normalizedAvatar(user);
    const root = el('div', { class: 'people-picker' });
    function select(next, focusLabel) {
      choice = { ...choice, ...next };
      paint();
      if (focusLabel) [...root.querySelectorAll('[role="radio"]')].find(button => button.getAttribute('aria-label') === focusLabel)?.focus();
      onChange?.({ ...choice });
    }
    function radios(values, labels, type) {
      const row = el('div', { class: `people-picker-${type}`, role: 'radiogroup', 'aria-label': type === 'style' ? 'Velg figur' : 'Velg farge' });
      values.forEach((value, index) => row.append(el('button', { type: 'button', role: 'radio', class: `people-picker-choice${choice[type] === value ? ' selected' : ''}`, 'aria-checked': choice[type] === value, 'aria-label': labels[value], title: labels[value], tabindex: choice[type] === value ? 0 : -1, onclick: () => select({ [type]: value }, labels[value]), onkeydown: event => {
        const next = ['ArrowRight', 'ArrowDown'].includes(event.key) ? (index + 1) % values.length : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? (index + values.length - 1) % values.length : event.key === 'Home' ? 0 : event.key === 'End' ? values.length - 1 : null;
        if (next === null) return;
        event.preventDefault(); select({ [type]: values[next] }, labels[values[next]]);
      } }, type === 'style' ? avatar({ ...user, id: null, userId: null, avatar: { ...choice, style: value } }, { size: 38, decorative: true }) : svgNode('svg', { viewBox: '0 0 30 30', width: 30, height: 30, 'aria-hidden': 'true' }, svgNode('circle', { cx: 15, cy: 15, r: 11, fill: palette[value], stroke: '#b49ac5', 'stroke-width': 1.3 })))));
      return row;
    }
    function paint() {
      root.replaceChildren(el('div', { class: 'people-picker-preview' }, avatar({ ...user, id: null, userId: null, avatar: choice }, { size: 62, label: `Ikonet ditt: ${styleNames[choice.style]}, ${colorNames[choice.color]}` }), el('span', {}, 'Ditt ikon')), el('span', { class: 'people-picker-label' }, 'Figur'), radios(styles, styleNames, 'style'), el('span', { class: 'people-picker-label' }, 'Farge'), radios(colors, colorNames, 'color'));
    }
    paint();
    return root;
  }
  window.SammenPeople = Object.freeze({ avatar, avatarForId, stack, contributorPeople, contributors, memberPeople, membersList, openMembers, picker, styles, colors });
})();
