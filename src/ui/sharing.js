'use strict';

(() => {
  let active = null;
  let preference = 'local';
  let busy = false;
  function statusNow() { return ui.sync || state.sync || { mode: 'local' }; }
  function wholeBrain() { return activeBrain().visibility === 'invited'; }
  function cleanup() {
    active?.unsubscribe?.();
    active?.observer?.disconnect();
    active = null;
  }
  function protectDraft(action) {
    if (busy || window.SammenBrainSpaces?.isBusy?.()) return;
    if (!editor?.dirty) return action();
    confirmModal('Lagre notatet?', 'Du har ulagrede endringer.', 'Lagre og fortsett', async () => { if (await saveEditor()) await action(); });
  }
  function address(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && !url.hash ? url.href : null;
    } catch { return null; }
  }
  async function copy(value, button) {
    button.disabled = true;
    try { await invoke('copyText', value); toast('Kopiert.'); }
    catch (error) { showError(error); }
    finally { if (button.isConnected) button.disabled = false; }
  }
  function report(container, message) {
    const node = container.querySelector('.sharing-error');
    if (node) { node.textContent = message; node.hidden = !message; }
  }
  function lockModal(container, method) {
    const modal = container.closest('.modal');
    if (!modal) return () => {};
    const controls = [...modal.querySelectorAll('button,input,select,textarea')].map(node => ({ node, disabled: node.disabled }));
    controls.forEach(({ node }) => { node.disabled = true; });
    modal.setAttribute('aria-busy', 'true');
    const status = el('p', { class: 'sharing-busy', role: 'status', tabindex: -1 }, ['stopHosting', 'leaveGroup'].includes(method) ? 'Avslutter …' : 'Kobler til …');
    container.prepend(status);
    const keepFocus = event => { if (event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); status.focus({ preventScroll: true }); } };
    modal.addEventListener('keydown', keepFocus);
    status.focus({ preventScroll: true });
    return () => {
      controls.forEach(({ node, disabled }) => { if (node.isConnected) node.disabled = disabled; });
      modal.removeAttribute('aria-busy');
      modal.removeEventListener('keydown', keepFocus);
      status.remove();
    };
  }
  async function mutate(button, method, payload, projectId = null) {
    if (busy || window.SammenBrainSpaces?.isBusy?.()) return;
    let container = button.closest('.sharing-panel');
    if (!container?.isConnected) {
      cleanup();
      container = el('div', { class: 'sharing-panel' }, el('p', { class: 'sharing-error', role: 'alert', hidden: true }));
      openModal('Samarbeid', '', container, 'sharing-modal');
    }
    busy = true;
    report(container, '');
    const unlock = lockModal(container, method);
    let applied = false;
    try {
      const status = await invoke(method, payload);
      const latest = await invoke('getState');
      ui.sync = status.sync || status;
      window.SammenLiveFile?.detach?.();
      editor = null; ui.itemId = null; ui.brainMode = 'graph';
      ui.projectId = ui.sync.scope === 'brain' ? null : ui.sync.projectId || projectId;
      applyState(latest, { force: true });
      applied = true;
    } catch (error) {
      if (container?.isConnected) report(container, error.message || 'Kunne ikke koble til.');
      else showError(error);
    } finally {
      busy = false;
      unlock();
    }
    if (applied) await open();
  }
  function members(status) {
    const people = Array.isArray(status.members) ? status.members : Array.isArray(status.users) ? status.users : [];
    return el('div', { class: 'sharing-members' }, el('div', { class: 'sharing-members-title' }, icon('users', 14), `${status.memberCount ?? people.length} tilkoblet`), people.length ? el('ul', {}, people.map(person => el('li', {}, el('span', { class: 'sharing-avatar', 'aria-hidden': 'true' }, String(person.name || 'Elev').slice(0, 1).toUpperCase()), el('span', {}, person.name || 'Elev'), person.userId && person.userId === state.user.id ? el('span', { class: 'sharing-you' }, 'deg') : null, person.editingItemId ? el('span', { class: 'sharing-editing', title: state.items.find(item => item.id === person.editingItemId)?.title || 'Redigerer en fil' }, 'redigerer') : null))) : null);
  }
  function invitations(status) {
    const urls = status.urls || (status.url ? [status.url] : []);
    if (!urls.length || !status.inviteCode) return null;
    return el('section', { class: 'sharing-invitation' }, el('div', { class: 'sharing-section-head' }, el('h3', {}, 'Invitasjon'), btn('Kopier', event => copy(`Adresse: ${urls[0]}\nKode: ${status.inviteCode}`, event.currentTarget), 'button-secondary button-small', 'link', { 'aria-label': 'Kopier invitasjon' })), ...urls.map((url, index) => el('div', { class: 'sharing-copy-row' }, el('code', {}, url), btn('', event => copy(url, event.currentTarget), 'button-quiet button-small', 'link', { 'aria-label': `Kopier adresse ${index + 1}`, title: 'Kopier adresse' }))), el('div', { class: 'sharing-copy-row' }, el('code', { class: 'sharing-invite-code' }, status.inviteCode), btn('', event => copy(status.inviteCode, event.currentTarget), 'button-quiet button-small', 'link', { 'aria-label': 'Kopier invitasjonskode', title: 'Kopier kode' })));
  }
  function connected(status) {
    const internet = status.transport === 'internet';
    const hosting = status.mode === 'host';
    return el('div', { class: 'sharing-connected' }, el('div', { class: 'sharing-status' }, el('span', { class: `sharing-status-dot${status.error || status.connected === false ? ' offline' : ''}` }), el('div', {}, el('strong', {}, status.error || status.connected === false ? 'Frakoblet' : 'Tilkoblet'), el('small', {}, `${status.scope === 'brain' ? activeBrain().name : projectTitle(status.projectId)} · ${internet ? 'Internett' : 'Lokalt nettverk'}`))), invitations(status), members(status), el('p', { class: 'sharing-note' }, hosting ? 'Hold vertsappen åpen.' : internet ? 'Endringer sendes til rommet når forbindelsen er aktiv.' : 'Vertsappen må være åpen.'), btn(hosting ? 'Stopp deling' : 'Forlat rommet', event => { const button = event.currentTarget; protectDraft(() => mutate(button, hosting ? 'stopHosting' : 'leaveGroup')); }, 'button-secondary', null));
  }
  function localForm(container) {
    if (wholeBrain()) {
      const start = el('button', { type: 'button', class: 'button button-secondary', onclick: () => protectDraft(() => mutate(start, 'startBrainHosting', {})) }, icon('users', 14), 'Del Brain');
      return el('div', { class: 'sharing-create-form' }, start, el('p', { class: 'sharing-note' }, 'Alle prosjekter i denne Brainen deles. Gi invitasjonen bare til dem du vil ha med. PC-ene må være på samme nettverk.'));
    }
    const choice = projectField(ui.projectId || state.projects[0]?.id, 'Prosjekt');
    choice.input.id = 'sharing-project';
    choice.wrapper.querySelector('label').htmlFor = choice.input.id;
    const start = el('button', { type: 'submit', class: 'button button-secondary', disabled: !state.projects.length }, icon('users', 14), 'Del prosjekt');
    return el('form', { class: 'sharing-create-form', onsubmit: event => {
      event.preventDefault();
      const projectId = choice.input.value;
      if (!state.projects.some(project => project.id === projectId)) return report(container, 'Opprett et prosjekt først.');
      protectDraft(() => mutate(start, 'startHosting', { projectId }, projectId));
    } }, choice.wrapper, start, el('p', { class: 'sharing-note' }, 'Elevene må være på samme nettverk.'));
  }
  function internetForm(container) {
    const shareBrain = wholeBrain();
    const choice = projectField(ui.projectId || state.projects[0]?.id, 'Prosjekt');
    choice.input.id = 'sharing-internet-project';
    choice.wrapper.querySelector('label').htmlFor = choice.input.id;
    const url = el('input', { id: 'sharing-server', type: 'url', placeholder: 'https://serveradresse', maxlength: 2000, required: true, spellcheck: false });
    const key = el('input', { id: 'sharing-create-key', type: 'password', placeholder: 'Nøkkel fra serveransvarlig', maxlength: 2000, required: true, autocomplete: 'off' });
    const start = el('button', { type: 'submit', class: 'button button-secondary', disabled: !shareBrain && !state.projects.length }, icon('cloud', 14), 'Opprett rom');
    return el('form', { class: 'sharing-create-form', onsubmit: event => {
      event.preventDefault();
      const server = address(url.value.trim());
      const projectId = choice.input.value;
      if (!server) return report(container, 'Bruk en gyldig https-serveradresse.');
      if (!shareBrain && !state.projects.some(project => project.id === projectId)) return report(container, 'Velg et prosjekt.');
      const payload = { url: server, projectId, createKey: key.value.trim() };
      protectDraft(() => mutate(start, shareBrain ? 'startInternetBrain' : 'startInternetRoom', payload));
    } }, shareBrain ? null : choice.wrapper, field('Serveradresse', url), field('Opprettelsesnøkkel', key), el('p', { class: 'sharing-note' }, shareBrain ? 'Alle prosjekter i denne Brainen deles på serveren. Gi invitasjonen bare til dem du vil ha med.' : 'Krever egen server. Opprettelsesnøkkelen deles ikke med elevene.'), start);
  }
  function joinForm(container) {
    const url = el('input', { id: 'sharing-room-url', type: 'url', placeholder: 'https://…', maxlength: 2000, required: true, spellcheck: false });
    const code = el('input', { id: 'sharing-room-code', placeholder: 'Invitasjonskode', maxlength: 4000, required: true, autocomplete: 'off', spellcheck: false });
    const join = el('button', { type: 'submit', class: 'button' }, icon('link', 14), 'Bli med');
    return el('form', { class: 'sharing-join-form', onsubmit: event => {
      event.preventDefault();
      const room = address(url.value.trim());
      if (!room) return report(container, 'Bruk en gyldig https-adresse.');
      const payload = { url: room, inviteCode: code.value.trim() };
      protectDraft(() => mutate(join, 'joinGroup', payload));
    } }, el('h3', {}, 'Bli med i et rom'), field('Romadresse', url), field('Invitasjonskode', code), join);
  }
  function show(container, status) {
    const error = el('p', { class: 'sharing-error', role: 'alert', hidden: !status.error }, status.error || '');
    if (status.mode === 'host' || status.mode === 'client') {
      container.replaceChildren(connected(status), error);
      return;
    }
    if (state.brainSpace && activeBrain().isPersonal) {
      container.replaceChildren(el('p', { class: 'sharing-note' }, 'Min Brain er bare din. Opprett en egen Brain når dere vil jobbe sammen.'), btn('Ny delt Brain', () => window.SammenBrainSpaces.openCreate(), 'button', 'users'), btn('Bli med i en Brain', () => window.SammenBrainSpaces.openJoin(), 'button-secondary', 'link'), error);
      return;
    }
    if (state.brainSpace && activeBrain().isPublic) {
      container.replaceChildren(el('p', { class: 'sharing-note' }, 'Offentlig Brain er felles for alle som bruker Sammen.'), btn('Koble til', () => window.SammenBrainSpaces.openConnect(), 'button', 'globe'), error);
      return;
    }
    const body = el('div');
    const tabs = el('div', { class: 'sharing-tabs', role: 'tablist', 'aria-label': 'Hvor skal prosjektet deles?' });
    function select(mode) {
      preference = mode;
      for (const tab of tabs.children) {
        const selected = tab.dataset.mode === mode;
        tab.classList.toggle('active', selected); tab.setAttribute('aria-selected', String(selected));
      }
      body.replaceChildren(mode === 'internet' ? internetForm(container) : localForm(container));
      report(container, '');
    }
    [['local', 'Lokalt'], ['internet', 'Internett']].forEach(([mode, label]) => tabs.append(el('button', { type: 'button', role: 'tab', dataset: { mode }, 'aria-selected': preference === mode, onclick: () => select(mode) }, icon(mode === 'internet' ? 'cloud' : 'users', 14), label)));
    container.replaceChildren(tabs, body, state.brainSpace ? btn('Bli med i en annen Brain', () => window.SammenBrainSpaces.openJoin(), 'button-secondary', 'link') : joinForm(container), error);
    select(preference);
  }
  function signature(status) { return `${status.mode || 'local'}:${status.transport || ''}:${status.projectId || ''}`; }
  function update(status = statusNow()) {
    if (!active?.container.isConnected) return;
    ui.sync = status;
    if (busy) return;
    if (active.signature !== signature(status) || status.mode !== 'local') {
      show(active.container, status);
      active.signature = signature(status);
    }
  }
  async function open() {
    if (busy || window.SammenBrainSpaces?.isBusy?.()) return;
    cleanup();
    const container = el('div', { class: 'sharing-panel' });
    const status = statusNow();
    show(container, status);
    const sandbox = document.body.classList.contains('sandbox');
    openModal('Samarbeid', sandbox ? 'Sandbox · egne testdata' : '', container, 'sharing-modal');
    const context = { container, signature: signature(status), unsubscribe: null, observer: null };
    active = context;
    if (api?.onState) context.unsubscribe = api.onState(value => { if (container.isConnected && value.sync) update(value.sync); });
    context.observer = new MutationObserver(() => { if (!container.isConnected && active === context) cleanup(); });
    context.observer.observe(document.getElementById('modal-root'), { childList: true });
    try {
      const fresh = await invoke('getSyncStatus');
      if (active === context && container.isConnected) update(fresh);
    } catch (error) { if (container.isConnected) report(container, error.message || 'Status er utilgjengelig.'); }
  }
  window.Sharing = window.SammenSharing = { open, update, isBusy: () => busy };
})();
