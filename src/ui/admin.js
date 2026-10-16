'use strict';

(() => {
  const tabs = [['overview', 'Oversikt'], ['users', 'Brukere'], ['brains', 'Brains'], ['activity', 'Aktivitet']];
  const eventLabels = { 'room.created': 'Opprettet Brain', 'member.joined': 'Ble med', 'member.left': 'Forlot Brain', 'profile.updated': 'Oppdaterte profil', 'project.created': 'Opprettet prosjekt', 'project.updated': 'Oppdaterte prosjekt', 'file.created': 'La til fil', 'file.updated': 'Endret fil', 'file.deleted': 'Slettet fil' };
  let active = null;
  function sandbox() { return document.body.classList.contains('sandbox'); }
  function serverAddress(value) {
    try {
      const url = new URL(value.trim());
      const local = sandbox() && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
      return (url.protocol === 'https:' || local) && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/' ? url.origin : null;
    } catch { return null; }
  }
  function live(context) { return active === context && context.container.isConnected; }
  function dateText(value, withTime = false) {
    const date = new Date(value);
    return value && Number.isFinite(date.getTime()) ? date.toLocaleString('nb-NO', { day: 'numeric', month: 'short', year: 'numeric', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}) }) : '—';
  }
  function number(value) { return Number.isSafeInteger(value) && value >= 0 ? value : '—'; }
  function snapshot(context, value) {
    const status = value?.status || {};
    context.status = { configured: Boolean(status.configured), connected: Boolean(status.connected), url: typeof status.url === 'string' ? status.url : '', remembered: Boolean(status.remembered), canRemember: Boolean(status.canRemember) && !sandbox(), checkedAt: status.checkedAt || null };
    context.overview = value?.overview || null;
    context.activity = value?.activity || null;
  }
  function clearKey(context) { if (context?.keyInput) context.keyInput.value = ''; }
  function cleanup() {
    if (!active) return;
    clearKey(active);
    active.observer?.disconnect();
    active = null;
  }
  function avatar(person, size = 30) {
    return window.SammenPeople ? window.SammenPeople.avatar(person, { size, decorative: true }) : icon('profile', size);
  }
  function stack(people, size = 24) {
    return window.SammenPeople ? window.SammenPeople.stack(people, { size, max: 3, decorative: true }) : icon('users', 17);
  }
  function empty(message, image = 'users') { return el('div', { class: 'admin-empty' }, icon(image, 28), el('p', {}, message)); }
  function errorText(context) { return el('p', { class: 'admin-error', role: 'alert', hidden: !context.error }, context.error || ''); }
  async function connect(context, event) {
    event.preventDefault();
    if (!live(context) || context.busy) return;
    const url = serverAddress(context.urlInput.value);
    if (!url) { context.error = sandbox() ? 'Bruk en https-adresse, eller en lokal testserver.' : 'Bruk serverens https-hovedadresse.'; render(context); context.urlInput.focus(); return; }
    if (!context.keyInput.value.trim()) { context.error = 'Skriv inn adminnøkkelen.'; render(context); context.keyInput.focus(); return; }
    const payload = { url, key: context.keyInput.value, remember: !sandbox() && context.status.canRemember && context.rememberInput.checked };
    context.busy = true; context.error = ''; render(context);
    try {
      const result = await invoke('connectAdmin', payload);
      if (!live(context)) return;
      snapshot(context, result);
      if (context.status.connected) clearKey(context);
      else context.error = 'Tilgangen kunne ikke bekreftes. Kontroller adressen og adminnøkkelen.';
    } catch {
      if (live(context)) {
        try {
          const latest = await invoke('getAdminState');
          if (live(context)) snapshot(context, latest);
        } catch { /* The connection form remains usable if status is unavailable. */ }
        if (live(context)) {
          // A failed new connection must not reveal the previous server's cache.
          context.status.connected = false;
          context.overview = null; context.activity = null;
          context.error = payload.remember && !context.status.canRemember
            ? 'Denne PC-en kan ikke huske adminnøkkelen. Prøv igjen uten «Husk på denne PC-en».'
            : 'Kunne ikke koble til. Kontroller adressen og adminnøkkelen.';
        }
      }
    } finally {
      payload.key = '';
      if (live(context)) {
        context.busy = false; render(context);
        const modal = context.container.closest?.('.modal');
        if (context.status.connected && modal) modal.scrollTop = 0;
      }
    }
  }
  async function disconnect(context) {
    if (!live(context) || context.busy) return;
    context.busy = true; context.error = ''; render(context);
    try {
      const result = await invoke('disconnectAdmin');
      if (!live(context)) return;
      clearKey(context);
      snapshot(context, result);
      context.overview = null; context.activity = null; context.rememberInput && (context.rememberInput.checked = false);
    } catch { if (live(context)) context.error = 'Kunne ikke koble fra. Prøv igjen.'; }
    finally { if (live(context)) { context.busy = false; render(context); } }
  }
  async function refresh(context) {
    if (!live(context) || context.busy) return;
    context.busy = true; context.error = ''; render(context);
    try {
      const results = await Promise.allSettled([invoke('getAdminOverview'), invoke('getAdminActivity', { limit: 50 })]);
      if (!live(context)) return;
      const latest = await invoke('getAdminState');
      if (!live(context)) return;
      snapshot(context, latest);
      if (results[0].status === 'fulfilled') context.overview = results[0].value;
      if (results[1].status === 'fulfilled') context.activity = results[1].value;
      if (results.some(result => result.status === 'rejected') || !context.status.connected) context.error = 'Oversikten kunne ikke hentes. Kontroller tilkoblingen og prøv igjen.';
    } catch { if (live(context)) { context.status.connected = false; context.error = 'Serveren kunne ikke nås. Prøv igjen.'; } }
    finally { if (live(context)) { context.busy = false; render(context); } }
  }
  function connectionForm(context) {
    if (!context.formView) {
      context.urlInput = el('input', { id: 'admin-server-address', type: 'url', required: true, maxlength: 2000, placeholder: 'https://…', autocomplete: 'off', spellcheck: false });
      context.keyInput = el('input', { id: 'admin-server-key', type: 'password', required: true, maxlength: 4000, autocomplete: 'off', spellcheck: false, autocapitalize: 'none', 'aria-label': 'Adminnøkkel' });
      context.rememberInput = el('input', { id: 'admin-remember', type: 'checkbox', checked: false });
      context.formError = errorText(context);
      context.submit = el('button', { type: 'submit', class: 'button' }, icon('lock', 14), 'Koble til');
      context.retry = btn('Prøv lagret tilkobling', () => refresh(context), 'button-secondary');
      context.forget = btn('Koble fra', () => disconnect(context), 'button-text');
      context.formView = el('div', { class: 'admin-connect-view' }, el('div', { class: 'admin-lock' }, icon('lock', 29)), el('h3', {}, 'Koble til serveren'), el('p', { class: 'admin-connect-copy' }, 'En egen adminnøkkel gir tilgang til serveroversikten.'), el('form', { class: 'admin-connect-form', onsubmit: event => connect(context, event) }, field('Serveradresse', context.urlInput), field('Adminnøkkel', context.keyInput), el('label', { class: 'admin-remember', for: context.rememberInput.id }, context.rememberInput, el('span', {}, 'Husk på denne PC-en')), el('small', { class: 'admin-session-note', hidden: !sandbox() }, 'Bare denne økten i sandboxen.'), context.formError, el('div', { class: 'admin-connect-actions' }, context.submit, context.retry, context.forget)));
      context.urlInput.value = context.status.url || '';
    }
    context.formError.textContent = context.error || '';
    context.formError.hidden = !context.error;
    for (const input of [context.urlInput, context.keyInput]) input.disabled = context.busy;
    context.rememberInput.disabled = context.busy || !context.status.canRemember || sandbox();
    if (context.rememberInput.disabled && !context.busy) context.rememberInput.checked = false;
    context.submit.disabled = context.busy;
    context.submit.replaceChildren(icon(context.busy ? 'clock' : 'lock', 14), context.busy ? 'Kobler til …' : 'Koble til');
    context.retry.hidden = !context.status.configured; context.retry.disabled = context.busy;
    context.forget.hidden = !context.status.configured; context.forget.disabled = context.busy;
    return context.formView;
  }
  function activityRows(context, events) {
    const brains = context.overview?.brains || [];
    if (!events.length) return empty('Ingen registrert aktivitet.', 'clock');
    return el('ol', { class: 'admin-activity' }, events.map(event => {
      const brain = brains.find(value => value.id === event.brainId);
      const description = eventLabels[event.type] || 'Aktivitet';
      return el('li', {}, avatar(event.actor || {}), el('div', { class: 'admin-activity-person' }, el('p', {}, el('strong', {}, event.actor?.name || 'Ukjent'), el('span', {}, description)), event.target?.title ? el('span', { class: 'admin-target', title: event.target.title }, event.target.title) : null, el('small', {}, brain?.name || (brain?.visibility === 'public' ? 'Offentlig Brain' : 'Brain'))), el('time', { datetime: event.at || '', title: dateText(event.at, true) }, dateText(event.at, true)));
    }));
  }
  function userTable(users) {
    if (!users.length) return empty('Ingen brukere å vise.');
    return el('div', { class: 'admin-table-scroll' }, el('table', { class: 'admin-table' }, el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, 'Bruker'), el('th', { scope: 'col' }, 'Brains'), el('th', { scope: 'col' }, 'Sist sett'))), el('tbody', {}, users.map(person => el('tr', {}, el('td', {}, el('span', { class: 'admin-person-cell' }, avatar(person, 34), el('span', {}, person.name || 'Ukjent'))), el('td', {}, number(person.brainIds?.length)), el('td', {}, el('time', { datetime: person.lastSeen || '' }, dateText(person.lastSeen))))))));
  }
  function brainCards(brains) {
    if (!brains.length) return empty('Ingen Brains å vise.', 'brain');
    return el('div', { class: 'admin-brain-grid' }, brains.map(brain => {
      const members = Array.isArray(brain.members) ? brain.members : [];
      return el('article', { class: 'admin-brain-card' }, el('div', { class: 'admin-brain-heading' }, el('strong', {}, brain.name || (brain.visibility === 'public' ? 'Offentlig Brain' : 'Delt Brain')), el('span', { class: `admin-visibility ${brain.visibility === 'public' ? 'public' : ''}` }, brain.visibility === 'public' ? 'Offentlig' : 'Invitert')), el('p', { class: 'admin-brain-counts' }, `${number(brain.projectCount)} prosjekter · ${number(brain.fileCount)} filer`), el('details', { class: 'admin-brain-members' }, el('summary', {}, stack(members), el('span', {}, `${number(brain.memberCount)} medlemmer`)), el('ul', {}, members.map(person => el('li', {}, avatar(person, 24), el('span', {}, person.name || 'Ukjent'))))), el('small', { class: 'admin-brain-date' }, `Sist aktiv ${dateText(brain.lastActiveAt)}`));
    }));
  }
  function overview(context) {
    const counts = context.overview?.counts || {};
    const stats = [['users', 'Brukere', 'users'], ['brains', 'Brains', 'brain'], ['projects', 'Prosjekter', 'map'], ['files', 'Filer', 'file']];
    return el('div', { class: 'admin-overview' }, el('div', { class: 'admin-stats' }, stats.map(([key, label, image]) => el('div', { class: 'admin-stat' }, icon(image, 19), el('strong', {}, number(counts[key])), el('span', {}, label)))), el('div', { class: 'admin-section-heading' }, el('h3', {}, 'Siste aktivitet'), btn('Vis alle', () => selectTab(context, 'activity'), 'button-text')), activityRows(context, (context.activity?.events || []).slice(0, 5)));
  }
  function body(context) {
    if (context.tab === 'overview') return overview(context);
    const query = context.filters[context.tab]?.trim().toLocaleLowerCase('nb-NO') || '';
    if (context.tab === 'users') return userTable((context.overview?.users || []).filter(person => !query || String(person.name || '').toLocaleLowerCase('nb-NO').includes(query)));
    if (context.tab === 'brains') return brainCards((context.overview?.brains || []).filter(brain => !query || String(brain.name || '').toLocaleLowerCase('nb-NO').includes(query)));
    return activityRows(context, (context.activity?.events || []).filter(event => !query || [event.actor?.name, event.target?.title, eventLabels[event.type], context.overview?.brains?.find(brain => brain.id === event.brainId)?.name].filter(Boolean).join(' ').toLocaleLowerCase('nb-NO').includes(query)));
  }
  function selectTab(context, key, focus = false) {
    context.tab = key;
    render(context);
    if (focus) document.getElementById(`admin-tab-${key}`)?.focus();
  }
  function workspace(context) {
    const tablist = el('div', { class: 'admin-tabs', role: 'tablist', 'aria-label': 'Serveroversikt' });
    tabs.forEach(([key, label], index) => tablist.append(el('button', { type: 'button', id: `admin-tab-${key}`, role: 'tab', 'aria-selected': context.tab === key, 'aria-controls': 'admin-tab-panel', tabindex: context.tab === key ? 0 : -1, onclick: () => selectTab(context, key), onkeydown: event => {
      const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
      if (next === null) return;
      event.preventDefault(); selectTab(context, tabs[next][0], true);
    } }, label)));
    const content = el('section', { class: 'admin-tab-panel', id: 'admin-tab-panel', role: 'tabpanel', 'aria-labelledby': `admin-tab-${context.tab}`, tabindex: 0 }, body(context));
    const search = context.tab !== 'overview' ? el('label', { class: 'admin-search' }, icon('search', 14), el('input', { type: 'search', value: context.filters[context.tab] || '', placeholder: 'Søk', 'aria-label': `Søk i ${tabs.find(([key]) => key === context.tab)?.[1] || 'oversikten'}`, oninput: event => { context.filters[context.tab] = event.target.value; content.replaceChildren(body(context)); } })) : null;
    return el('div', { class: 'admin-workspace' }, el('div', { class: 'admin-server-line' }, el('span', { class: 'admin-server' }, icon('globe', 14), el('span', {}, context.status.url)), el('span', { class: 'admin-connected', role: 'status' }, context.busy ? 'Henter …' : 'Tilkoblet'), btn('', () => refresh(context), 'button-quiet admin-refresh', 'refresh', { title: 'Oppdater oversikten', 'aria-label': 'Oppdater oversikten', disabled: context.busy }), btn('Koble fra', () => disconnect(context), 'button-text', null, { disabled: context.busy })), el('div', { class: 'admin-tab-row' }, tablist, search), errorText(context), content, el('p', { class: 'admin-checked' }, context.status.checkedAt ? `Hentet ${dateText(context.status.checkedAt, true)}` : ''));
  }
  function render(context) {
    if (!live(context)) return;
    context.container.setAttribute('aria-busy', String(context.busy));
    context.container.replaceChildren(context.status.connected ? workspace(context) : connectionForm(context));
  }
  async function open() {
    if (window.SammenBrainSpaces?.isBusy?.() || window.SammenSharing?.isBusy?.()) return;
    cleanup();
    const container = el('div', { class: 'admin-panel' }, el('p', { class: 'admin-loading', role: 'status' }, 'Henter tilkobling …'));
    const context = { container, status: { configured: false, connected: false, url: '', remembered: false, canRemember: false }, overview: null, activity: null, tab: 'overview', filters: {}, error: '', busy: true, observer: null };
    openModal('Administrasjon', '', container, 'admin-modal');
    active = context;
    context.observer = new MutationObserver(() => { if (!container.isConnected && active === context) cleanup(); });
    context.observer.observe(document.getElementById('modal-root'), { childList: true });
    try {
      const value = await invoke('getAdminState');
      if (!live(context)) return;
      snapshot(context, value);
      context.busy = false;
      if (context.status.configured) await refresh(context);
      else render(context);
    } catch { if (live(context)) { context.busy = false; context.error = 'Administrasjon er ikke tilgjengelig akkurat nå.'; render(context); } }
  }
  window.SammenAdmin = Object.freeze({ open, isBusy: () => Boolean(active?.busy) });
})();
