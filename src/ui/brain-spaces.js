'use strict';

(() => {
  let busy = false;
  let root = null;

  function spaces() {
    const value = state.brainSpace || {};
    const brains = Array.isArray(value.brains) ? value.brains : [];
    return { activeId: value.activeId || 'personal', brains };
  }
  function current() {
    const value = spaces();
    return value.brains.find(brain => brain.id === value.activeId) || { id: value.activeId, name: value.activeId === 'public' ? 'Offentlig Brain' : 'Min Brain', visibility: value.activeId === 'public' ? 'public' : 'personal' };
  }
  function isPersonal(brain) { return brain.id === 'personal' || brain.isPersonal || brain.visibility === 'personal'; }
  function isPublic(brain) { return brain.id === 'public' || brain.isPublic || brain.visibility === 'public'; }
  function connection(brain) {
    const summary = brain.connection || {};
    const active = brain.id === spaces().activeId;
    const sync = active ? (ui.sync || state.sync || {}) : {};
    return ['host', 'client'].includes(sync.mode) ? { ...summary, ...sync } : summary;
  }
  function httpsAddress(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && !url.hash ? url.href : null;
    } catch { return null; }
  }
  function report(container, message) {
    const error = container?.querySelector('.brain-spaces-error');
    if (error) { error.textContent = message || ''; error.hidden = !message; }
    else if (message) showError(new Error(message));
  }
  function lock(container) {
    const modal = container?.closest('.modal');
    if (!modal) return () => {};
    const controls = [...modal.querySelectorAll('button,input,select,textarea')].map(node => ({ node, disabled: node.disabled }));
    for (const { node } of controls) node.disabled = true;
    modal.setAttribute('aria-busy', 'true');
    const status = el('p', { class: 'brain-spaces-working', role: 'status', tabindex: -1 }, 'Et øyeblikk …');
    container.prepend(status);
    status.focus({ preventScroll: true });
    const keepFocus = event => { if (event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); status.focus({ preventScroll: true }); } };
    modal.addEventListener('keydown', keepFocus);
    return () => {
      for (const { node, disabled } of controls) if (node.isConnected) node.disabled = disabled;
      modal.removeAttribute('aria-busy');
      modal.removeEventListener('keydown', keepFocus);
      status.remove();
    };
  }
  function lockWorkspace(showStatus) {
    const workspace = document.querySelector('.app-shell');
    const wasInert = Boolean(workspace?.inert);
    const previousFocus = document.activeElement;
    if (workspace) workspace.inert = true;
    // Dialog status remains focusable outside the application shell. Its own
    // Tab trap is allowed; application shortcuts and typing wait for the switch.
    const stopEditing = event => {
      if (event.type === 'keydown' && event.key === 'Tab' && event.target?.closest?.('#modal-root')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    document.addEventListener('keydown', stopEditing, true);
    document.addEventListener('beforeinput', stopEditing, true);
    document.addEventListener('paste', stopEditing, true);
    document.addEventListener('drop', stopEditing, true);
    const status = showStatus ? el('div', { class: 'brain-spaces-transition-status', role: 'status' }, 'Bytter Brain …') : null;
    if (status) document.body.append(status);
    return () => {
      if (workspace) workspace.inert = wasInert;
      document.removeEventListener('keydown', stopEditing, true);
      document.removeEventListener('beforeinput', stopEditing, true);
      document.removeEventListener('paste', stopEditing, true);
      document.removeEventListener('drop', stopEditing, true);
      status?.remove();
      const nextFocus = previousFocus?.isConnected ? previousFocus : previousFocus?.id ? document.getElementById(previousFocus.id) : null;
      nextFocus?.focus({ preventScroll: true });
    };
  }
  async function performTransition(method, payload) {
    window.SammenMindmap?.flush?.();
    if (editor?.dirty && !await saveEditor()) return false;
    await window.SammenSidechat?.prepareForUpdate?.();
    const result = await invoke(method, payload);
    const next = normalizeState(result);
    if (!next) throw new Error('Brain kunne ikke åpnes. Prøv igjen.');
    window.SammenLiveFile?.detach?.();
    editor = null;
    ui.projectId = null; ui.itemId = null; ui.brainMode = 'graph';
    ui.brainFilter = 'all'; ui.brainQuery = ''; ui.sourceIds = new Set();
    ui.chatId = null; ui.cardId = null; ui.answerVisible = false;
    ui.sync = next.sync;
    ui.view = 'brain';
    applyState(result, { force: true });
    return true;
  }
  async function transition(method, payload, options = {}) {
    if (busy || window.SammenSharing?.isBusy?.()) return false;
    busy = true;
    const container = options.container || null;
    report(container, '');
    const unlockWorkspace = lockWorkspace(!container);
    const unlock = lock(container);
    update();
    let succeeded = false;
    try {
      succeeded = Boolean(await performTransition(method, payload));
    } catch (error) {
      report(container, error?.message || 'Kunne ikke åpne Brain. Prøv igjen.');
    } finally {
      busy = false;
      unlock();
      unlockWorkspace();
      update();
    }
    if (succeeded && options.close !== false) closeModal();
    return succeeded;
  }
  async function choose(id) {
    if (!id || id === spaces().activeId || busy) return;
    const success = await transition('switchBrain', { id }, { close: false });
    if (!success) update();
  }
  function primaryButton(brain, text, handler, iconName) {
    return btn(text, handler, 'brain-spaces-action', iconName, { disabled: busy, id: `brain-space-action-${brain.id}`, title: text });
  }
  function statusLine(brain) {
    const link = connection(brain);
    const online = !link.error && link.connected !== false && ['host', 'client'].includes(link.mode);
    const count = Number.isInteger(link.memberCount) && link.memberCount >= 0 ? link.memberCount : null;
    const text = isPersonal(brain) ? 'Bare deg' : online ? count === null ? 'Tilkoblet' : `${count} tilkoblet` : isPublic(brain) ? 'Ikke tilkoblet' : link.error ? 'Frakoblet' : 'Kun inviterte';
    const title = isPersonal(brain) ? 'Dine prosjekter og filer.' : isPublic(brain) ? online ? 'Felles Brain for alle i Sammen.' : 'En felles server må være koblet til før dere kan jobbe sammen.' : online ? 'Felles Brain for dem som har invitasjonen.' : 'Lagret på denne PC-en. Inviter andre for å samarbeide.';
    const line = el('div', { class: 'brain-spaces-status-line' }, el('span', { class: `brain-spaces-status${online ? ' connected' : ''}`, title }, icon(isPersonal(brain) ? 'lock' : isPublic(brain) ? 'globe' : 'users', 12), el('span', {}, text)));
    if (isPublic(brain)) {
      const hasConnection = online || link.isPublic;
      line.append(primaryButton(brain, hasConnection ? 'Forbindelse' : 'Koble til', () => hasConnection ? window.SammenSharing?.open?.() : openConnect(), hasConnection ? 'globe' : 'link'));
    }
    else if (!isPersonal(brain)) line.append(primaryButton(brain, 'Inviter', () => window.SammenSharing?.open?.(), 'users'));
    if (window.SammenPeople) {
      const people = window.SammenPeople.memberPeople(brain);
      line.append(el('button', { type: 'button', id: `brain-space-members-${brain.id}`, class: 'brain-spaces-members', 'aria-label': `Medlemmer i ${brain.name || 'Brain'}: ${people.length}`, title: people.length ? people.map(person => `${person.name}${person.isYou ? ' (deg)' : ''}`).join(', ') : 'Medlemmer', 'aria-haspopup': 'dialog', disabled: busy, onclick: () => window.SammenPeople.openMembers(brain) }, people.length ? window.SammenPeople.stack(people, { size: 25, max: 3, decorative: true }) : icon('users', 15), el('span', { 'aria-hidden': 'true' }, people.length)));
    }
    return line;
  }
  function contents() {
    const value = spaces();
    const brain = current();
    const invited = value.brains.filter(item => !isPersonal(item) && !isPublic(item));
    const segments = el('div', { class: 'brain-spaces-segments', role: 'group', 'aria-label': 'Velg Brain' });
    const choices = [['personal', 'Min Brain', 'lock'], ['public', 'Offentlig Brain', 'globe']];
    choices.forEach(([id, label, image], index) => {
      segments.append(el('button', { type: 'button', class: `brain-spaces-segment${value.activeId === id ? ' selected' : ''}`, id: `brain-space-${id}`, 'aria-pressed': value.activeId === id, disabled: busy, onclick: () => choose(id), onkeydown: event => {
        const next = event.key === 'ArrowRight' ? (index + 1) % choices.length : event.key === 'ArrowLeft' ? (index + choices.length - 1) % choices.length : event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : null;
        if (next === null) return;
        event.preventDefault();
        const nextId = choices[next][0];
        choose(nextId).then(() => document.getElementById(`brain-space-${nextId}`)?.focus());
      } }, icon(image, 14), label));
    });
    const row = el('div', { class: 'brain-spaces-top' }, segments);
    if (invited.length) {
      const selected = invited.some(item => item.id === value.activeId);
      const select = el('select', { id: 'brain-space-invited', class: `brain-spaces-select${selected ? ' selected' : ''}`, 'aria-label': 'Brains med inviterte', title: 'Brains med inviterte', disabled: busy, value: selected ? value.activeId : '', onchange: event => choose(event.currentTarget.value) }, el('option', { value: '', disabled: true }, 'Andre Brains'), invited.map(item => el('option', { value: item.id }, item.name || 'Brain')));
      row.append(el('span', { class: 'brain-spaces-select-wrap' }, icon('users', 14), select));
    }
    row.append(btn('', openCreate, 'brain-spaces-add', 'add', { id: 'brain-space-add', 'aria-label': 'Ny Brain eller bli med', title: 'Ny Brain eller bli med', disabled: busy }));
    return [row, statusLine(brain)];
  }
  function render() {
    root = el('section', { class: 'brain-spaces', 'aria-label': 'Brains', 'aria-busy': busy });
    root.append(...contents());
    return root;
  }
  function update() {
    if (!root?.isConnected) return;
    const focusedId = root.contains(document.activeElement) ? document.activeElement.id : null;
    root.setAttribute('aria-busy', String(busy));
    root.replaceChildren(...contents());
    if (focusedId) document.getElementById(focusedId)?.focus({ preventScroll: true });
  }
  function errorNode() { return el('p', { class: 'brain-spaces-error', role: 'alert', hidden: true }); }
  function openCreate() {
    if (busy || window.SammenSharing?.isBusy?.()) return;
    const name = el('input', { id: 'brain-space-name', required: true, maxlength: 80, placeholder: 'F.eks. Historiegruppen', autocomplete: 'off' });
    const create = el('button', { type: 'submit', class: 'button' }, icon('add', 14), 'Opprett Brain');
    const form = el('form', { class: 'brain-spaces-form', onsubmit: async event => {
      event.preventDefault();
      const title = name.value.trim();
      if (!title) { name.focus(); return; }
      await transition('createBrain', { name: title, visibility: 'invited' }, { container: form });
    } }, field('Navn', name), errorNode(), el('div', { class: 'modal-actions' }, btn('Bli med i en Brain', openJoin, 'button-secondary', 'link'), create));
    openModal('Ny Brain', 'Kun de du inviterer. Egne prosjekter i hver Brain.', form, 'brain-spaces-modal');
    name.focus();
  }
  function openJoin() {
    if (busy || window.SammenSharing?.isBusy?.()) return;
    const name = el('input', { id: 'brain-space-join-name', required: true, maxlength: 80, placeholder: 'F.eks. Studiegruppen', autocomplete: 'off' });
    const url = el('input', { id: 'brain-space-join-url', type: 'url', required: true, maxlength: 2000, placeholder: 'https://…', spellcheck: false, autocomplete: 'off' });
    const code = el('input', { id: 'brain-space-join-code', required: true, maxlength: 4000, placeholder: 'Invitasjonskode', spellcheck: false, autocomplete: 'off', autocapitalize: 'none' });
    const form = el('form', { class: 'brain-spaces-form', onsubmit: async event => {
      event.preventDefault();
      const address = httpsAddress(url.value.trim());
      if (!address) { report(form, 'Bruk en gyldig https-adresse fra invitasjonen.'); url.focus(); return; }
      await transition('joinBrain', { name: name.value.trim(), url: address, inviteCode: code.value.trim() }, { container: form });
    } }, field('Navn på Brain', name), field('Adresse fra invitasjonen', url), field('Invitasjonskode', code), errorNode(), el('div', { class: 'modal-actions' }, btn('Tilbake', openCreate, 'button-secondary'), el('button', { type: 'submit', class: 'button' }, icon('link', 14), 'Bli med')));
    openModal('Bli med i en Brain', 'Dine egne filer blir i Min Brain.', form, 'brain-spaces-modal');
    name.focus();
  }
  function openConnect() {
    if (busy || window.SammenSharing?.isBusy?.()) return;
    const brain = spaces().brains.find(item => isPublic(item));
    const summary = brain ? connection(brain) : {};
    const url = el('input', { id: 'brain-space-public-url', type: 'url', value: summary.url || '', required: true, maxlength: 2000, placeholder: 'https://…', spellcheck: false, autocomplete: 'off' });
    const form = el('form', { class: 'brain-spaces-form', onsubmit: async event => {
      event.preventDefault();
      const address = httpsAddress(url.value.trim());
      if (!address) { report(form, 'Bruk en gyldig https-serveradresse.'); url.focus(); return; }
      await transition('connectPublicBrain', { url: address }, { container: form });
    } }, field('Felles serveradresse', url), el('p', { class: 'brain-spaces-note' }, 'Serveren må være satt opp for Offentlig Brain.'), errorNode(), el('div', { class: 'modal-actions' }, btn('Avbryt', closeModal, 'button-secondary'), el('button', { type: 'submit', class: 'button' }, icon('globe', 14), 'Koble til')));
    openModal('Offentlig Brain', 'En felles Brain for alle som bruker Sammen.', form, 'brain-spaces-modal');
    url.focus();
  }
  window.SammenBrainSpaces = Object.freeze({ render, update, transition, openCreate, openJoin, openConnect, isBusy: () => busy });
})();
