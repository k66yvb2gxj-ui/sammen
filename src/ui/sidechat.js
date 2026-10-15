'use strict';

(() => {
  const sessions = new Map();
  let panel, toggle, nodes, open = false, projectId = null, lastMainProject;
  let settings = null, models = [], loading = false, accountBusy = false, modelBusy = false;
  let accountError = '', active = null, listSignature = '', contextSignature = '', messageSignature = '';
  const draftStoragePrefix = 'sammen.sidechat.drafts.v1:';

  function sandbox() { return document.body.classList.contains('sandbox'); }
  function project() { return state.projects.find(value => value.id === projectId); }
  function restoreSession(id) {
    const value = { chatId: null, drafts: new Map(), sources: new Set(), error: '', storageError: '' };
    if (!id) return value;
    try {
      const saved = JSON.parse(localStorage.getItem(draftStoragePrefix + encodeURIComponent(id)) || 'null');
      if (saved?.version !== 1 || !Array.isArray(saved.drafts)) return value;
      if (typeof saved.chatId === 'string') value.chatId = saved.chatId;
      for (const entry of saved.drafts) {
        if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string' && entry[1].length <= 12000) value.drafts.set(entry[0], entry[1]);
      }
    } catch { value.storageError = 'Kunne ikke hente utkastet fra denne PC-en.'; }
    return value;
  }
  function persistSession(id, value, strict = false) {
    if (!id) return;
    try {
      const drafts = new Map(value.drafts);
      // Keep an unanswered message recoverable if an update closes the app mid-response.
      if (active?.projectId === id && !drafts.get(active.chatId || 'new')) drafts.set(active.chatId || 'new', active.pending);
      const saved = { version: 1, chatId: value.chatId, drafts: [...drafts].filter(([, text]) => text) };
      const key = draftStoragePrefix + encodeURIComponent(id);
      if (saved.drafts.length) localStorage.setItem(key, JSON.stringify(saved));
      else localStorage.removeItem(key);
      value.storageError = '';
    } catch {
      value.storageError = 'Utkastet kunne ikke lagres på denne PC-en. Behold appen åpen og kopier teksten før du oppdaterer.';
      if (strict) throw new Error(value.storageError);
    }
  }
  function prepareForUpdate() {
    for (const [id, value] of sessions) persistSession(id, value, true);
  }
  function session() {
    if (!sessions.has(projectId)) sessions.set(projectId, restoreSession(projectId));
    return sessions.get(projectId);
  }
  function current() { return state.chats.find(chat => chat.id === session().chatId && chat.projectId === projectId); }
  function draftKey() { return session().chatId || 'new'; }
  function draft() { return session().drafts.get(draftKey()) || ''; }
  function ready() { return !sandbox() && settings?.provider === 'chatgpt' && settings.chatgpt?.connected && settings.chatgpt.enabled !== false && models.some(model => model.id === settings.model); }
  function errorText(error) { return error?.message || 'Kunne ikke fullføre handlingen. Prøv igjen.'; }
  function selectProject(next) {
    projectId = next;
    listSignature = contextSignature = messageSignature = '';
    update();
  }
  function setOpen(value) {
    open = Boolean(value);
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.title = open ? 'Skjul ChatGPT' : 'Åpne ChatGPT';
    document.body.classList.toggle('sidechat-open', open);
    if (open) {
      update();
      if (!settings && !loading && !sandbox()) refreshAccount();
      requestAnimationFrame(() => nodes.draft.focus({ preventScroll: true }));
    } else toggle.focus({ preventScroll: true });
  }
  function init() {
    if (panel) return;
    panel = document.getElementById('sidechat');
    toggle = document.getElementById('global-sidechat');
    if (!panel || !toggle) return;
    const heading = el('div', { class: 'sidechat-heading' }, el('h2', {}, icon('sparkle', 16), 'ChatGPT'), btn('', () => setOpen(false), 'button-quiet sidechat-icon', 'close', { 'aria-label': 'Skjul ChatGPT', title: 'Skjul ChatGPT' }));
    nodes = {};
    nodes.project = el('select', { id: 'sidechat-project', 'aria-label': 'Prosjekt for samtalen', onchange: event => selectProject(event.target.value || null) });
    nodes.history = el('select', { id: 'sidechat-history', 'aria-label': 'Velg samtale', onchange: event => {
      session().chatId = event.target.value || null;
      session().error = '';
      persistSession(projectId, session());
      messageSignature = '';
      update();
    } });
    nodes.newChat = btn('', () => {
      const value = session();
      if (!value.chatId) return nodes.draft.focus();
      value.chatId = null; value.error = '';
      persistSession(projectId, value);
      messageSignature = '';
      update(); nodes.draft.focus();
    }, 'button-quiet sidechat-icon', 'add', { title: 'Ny samtale', 'aria-label': 'Ny samtale' });
    const selectors = el('div', { class: 'sidechat-selectors' }, nodes.project, el('div', { class: 'sidechat-conversations' }, nodes.history, nodes.newChat));
    nodes.connection = el('span', { class: 'sidechat-connection' });
    nodes.connect = btn('Logg inn med ChatGPT', connect, 'button-secondary button-small', 'external');
    nodes.accountError = el('p', { class: 'sidechat-error', role: 'alert', hidden: true });
    nodes.model = el('select', { id: 'sidechat-model', 'aria-label': 'ChatGPT-modell', onchange: async event => {
      const chosen = event.target.value;
      if (!models.some(model => model.id === chosen) || modelBusy || active) {
        event.target.value = models.some(model => model.id === settings?.model) ? settings.model : '';
        return;
      }
      modelBusy = true; accountError = ''; renderAccount(); updateControls();
      try { settings = await invoke('updateAiSettings', { provider: 'chatgpt', model: chosen }); }
      catch (error) { accountError = errorText(error); }
      finally { modelBusy = false; nodes.model.dataset.signature = ''; update(); }
    } });
    nodes.refresh = btn('', () => refreshAccount(), 'button-quiet sidechat-icon', 'refresh', { title: 'Oppdater konto og modeller', 'aria-label': 'Oppdater konto og modeller' });
    nodes.disconnect = btn('Koble fra', disconnect, 'button-text button-small');
    nodes.accountDetails = el('details', { class: 'sidechat-account-details' }, el('summary', {}, 'Modell og konto'), el('div', { class: 'sidechat-model-row' }, nodes.model, nodes.refresh), el('p', { class: 'sidechat-help' }, 'Bruker kvoten i kontoen du logger inn med. Tidligere ChatGPT-samtaler hentes ikke.'), nodes.disconnect);
    nodes.sandboxNote = el('p', { class: 'sidechat-sandbox-note' }, 'Innlogging og KI-svar er tilgjengelig i Windows-appen.');
    nodes.loginNote = el('p', { class: 'sidechat-help' }, 'Innlogging åpner nettleseren og bruker abonnementskvoten din.');
    const account = el('div', { class: 'sidechat-account' }, el('div', { class: 'sidechat-account-row' }, nodes.connection, nodes.connect), nodes.sandboxNote, nodes.loginNote, nodes.accountDetails, nodes.accountError);
    nodes.messages = el('div', { class: 'sidechat-messages', tabindex: 0, 'aria-label': 'Meldinger i samtalen' });
    nodes.activity = el('div', { class: 'sidechat-activity', role: 'status', hidden: true });
    nodes.error = el('p', { class: 'sidechat-error', role: 'alert', hidden: true });
    nodes.sourceSummary = el('summary', {}, 'Fra Brain');
    nodes.sources = el('div', { class: 'sidechat-source-list' });
    const context = el('details', { class: 'sidechat-context' }, nodes.sourceSummary, el('p', { class: 'sidechat-help' }, 'Bare valgte filer sendes. Opptil 30 per melding.'), nodes.sources);
    nodes.draft = el('textarea', { id: 'sidechat-draft', rows: 3, maxlength: 12000, 'aria-label': 'Melding til ChatGPT', placeholder: 'Spør om noe …', oninput: event => {
      session().drafts.set(draftKey(), event.target.value);
      persistSession(projectId, session());
      updateControls();
    }, onkeydown: event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); }
    } });
    nodes.send = el('button', { type: 'submit', class: 'button sidechat-send', title: 'Send melding', 'aria-label': 'Send melding' }, icon('arrow', 15));
    nodes.stop = btn('Stopp', cancel, 'button-secondary button-small', null, { hidden: true });
    nodes.status = el('span', { class: 'sidechat-composer-status', role: 'status', 'aria-live': 'polite' });
    const form = el('form', { class: 'sidechat-composer', onsubmit: event => { event.preventDefault(); send(); } }, nodes.draft, el('div', { class: 'sidechat-composer-tools' }, nodes.status, nodes.stop, nodes.send));
    const footer = el('div', { class: 'sidechat-footer' }, nodes.activity, nodes.error, context, form, el('p', { class: 'sidechat-footnote' }, 'Svar lagres i Brain som KI-utkast.'));
    panel.append(heading, selectors, account, nodes.messages, footer);
    toggle.addEventListener('click', () => setOpen(!open));
    panel.addEventListener('keydown', event => { if (event.key === 'Escape' && !document.getElementById('modal-root')?.childElementCount) { event.preventDefault(); setOpen(false); } });
    if (typeof api?.onChatDelta === 'function') api.onChatDelta(payload => {
      if (!active || payload?.chatId !== active.chatId || typeof payload.delta !== 'string') return;
      active.text += payload.delta;
      if (open && current()?.id === active.chatId) renderMessages();
    });
  }

  function renderAccount() {
    if (!nodes) return;
    const connected = settings?.chatgpt?.connected;
    const usesChatGPT = settings?.provider === 'chatgpt';
    nodes.connection.textContent = sandbox() ? 'Forhåndsvisning' : loading ? 'Henter konto …' : accountBusy ? 'Venter på nettleseren …' : connected ? (settings.chatgpt.email || 'Tilkoblet') : 'Ditt abonnement';
    nodes.connection.title = nodes.connection.textContent;
    nodes.sandboxNote.hidden = !sandbox();
    nodes.loginNote.hidden = sandbox() || Boolean(connected);
    nodes.connect.hidden = !sandbox() && connected && usesChatGPT && settings.chatgpt.enabled !== false;
    nodes.connect.textContent = connected && !usesChatGPT ? 'Bruk ChatGPT' : 'Logg inn med ChatGPT';
    nodes.connect.disabled = sandbox() || loading || accountBusy || modelBusy || Boolean(active);
    nodes.accountDetails.hidden = sandbox() || !connected;
    if (connected && usesChatGPT && models.length && !models.some(model => model.id === settings.model)) nodes.accountDetails.open = true;
    nodes.disconnect.disabled = loading || accountBusy || modelBusy || Boolean(active);
    nodes.refresh.disabled = loading || accountBusy || modelBusy || Boolean(active);
    const signature = JSON.stringify([models, settings?.model, loading]);
    if (nodes.model.dataset.signature !== signature) {
      nodes.model.dataset.signature = signature;
      nodes.model.replaceChildren(el('option', { value: '' }, loading ? 'Henter modeller …' : models.length ? 'Velg modell' : 'Ingen modeller hentet'), ...models.map(model => el('option', { value: model.id }, model.name || model.id)));
      nodes.model.value = models.some(model => model.id === settings?.model) ? settings.model : '';
    }
    nodes.model.disabled = !usesChatGPT || !models.length || loading || accountBusy || modelBusy || Boolean(active);
    nodes.accountError.textContent = accountError || (connected && settings.chatgpt.enabled === false ? 'Kontoen ga ikke tilgang til abonnementskvoten. Logg inn på nytt for å gi tilgang.' : '');
    nodes.accountError.hidden = !nodes.accountError.textContent;
  }

  async function refreshAccount() {
    if (sandbox() || loading || accountBusy || active) return;
    loading = true; accountError = ''; renderAccount(); updateControls();
    try {
      settings = await invoke('getAiSettings');
      models = settings.provider === 'chatgpt' && settings.chatgpt?.connected && settings.chatgpt.enabled !== false ? await invoke('listModels') : [];
      models = Array.isArray(models) ? models.filter(model => typeof model?.id === 'string') : [];
      if (settings.provider === 'chatgpt' && settings.chatgpt?.enabled && !models.length) accountError = 'Ingen modeller ble returnert for kontoen. Prøv å oppdatere listen.';
    } catch (error) { accountError = errorText(error); models = []; }
    finally { loading = false; update(); }
  }
  async function connect() {
    if (sandbox() || accountBusy || loading || active) return;
    accountBusy = true; accountError = ''; renderAccount(); updateControls();
    try {
      settings = await invoke('updateAiSettings', { provider: 'chatgpt' });
      if (!settings.chatgpt?.connected || settings.chatgpt.enabled === false) settings = await invoke('connectChatGPT');
    } catch (error) { accountError = errorText(error); }
    finally {
      accountBusy = false;
      if (!accountError) await refreshAccount();
      update();
    }
  }
  async function disconnect() {
    if (accountBusy || active) return;
    accountBusy = true; accountError = ''; renderAccount(); updateControls();
    try { settings = await invoke('disconnectChatGPT'); models = []; }
    catch (error) { accountError = errorText(error); }
    finally { accountBusy = false; update(); }
  }

  function renderSelectors() {
    const chats = state.chats.filter(chat => chat.projectId === projectId).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const value = session();
    if (value.chatId && !chats.some(chat => chat.id === value.chatId)) value.chatId = null;
    const signature = JSON.stringify([projectId, state.projects.map(item => [item.id, item.title]), chats.map(chat => [chat.id, chat.title]), value.chatId]);
    if (signature === listSignature) return;
    listSignature = signature;
    nodes.project.replaceChildren(...(state.projects.length ? state.projects.map(item => el('option', { value: item.id }, item.title)) : [el('option', { value: '' }, 'Ingen prosjekter')]));
    nodes.project.value = projectId || '';
    nodes.project.disabled = !state.projects.length;
    nodes.history.replaceChildren(el('option', { value: '' }, 'Ny samtale'), ...chats.map(chat => el('option', { value: chat.id }, chat.title || 'Samtale')));
    nodes.history.value = value.chatId || '';
    nodes.history.disabled = !project();
  }
  function renderSources() {
    const value = session();
    const items = state.items.filter(item => item.projectId === projectId);
    const allowed = new Set(items.map(item => item.id));
    for (const selected of value.sources) if (!allowed.has(selected)) value.sources.delete(selected);
    nodes.sourceSummary.textContent = value.sources.size ? `Fra Brain · ${value.sources.size} valgt` : 'Fra Brain';
    const signature = JSON.stringify([projectId, items.map(item => [item.id, item.title, item.origin]), [...value.sources], Boolean(active)]);
    if (signature === contextSignature) return;
    contextSignature = signature;
    nodes.sources.replaceChildren(...(items.length ? items.map(item => el('label', { class: 'sidechat-source' }, el('input', { type: 'checkbox', checked: value.sources.has(item.id), disabled: Boolean(active), onchange: event => {
      if (event.target.checked && value.sources.size >= 30) { event.target.checked = false; return toast('Velg opptil 30 filer per melding.'); }
      event.target.checked ? value.sources.add(item.id) : value.sources.delete(item.id);
      nodes.sourceSummary.textContent = value.sources.size ? `Fra Brain · ${value.sources.size} valgt` : 'Fra Brain';
      contextSignature = JSON.stringify([projectId, items.map(entry => [entry.id, entry.title, entry.origin]), [...value.sources], Boolean(active)]);
    } }), el('span', {}, item.title, item.origin === 'ai' ? el('small', {}, 'KI-utkast') : null))) : [el('p', { class: 'sidechat-help' }, 'Ingen filer i dette prosjektet ennå.')]));
  }
  function messageNode(message, streaming = false) {
    const user = message.role === 'user';
    const node = el('article', { class: `sidechat-message ${user ? 'is-user' : 'is-assistant'}` }, el('div', { class: 'sidechat-message-label' }, user ? (message.author || 'Du') : streaming ? 'ChatGPT · skriver …' : 'ChatGPT · KI-utkast'), el('div', { class: 'sidechat-message-content' }, message.content || (streaming ? '…' : '')));
    if (message.citations?.length) node.append(el('div', { class: 'sidechat-citations' }, message.citations.map((citation, index) => {
      const source = state.items.find(item => item.id === citation.sourceId);
      const url = safeUrl(citation.url || citation.sourceUrl || source?.sourceUrl);
      const title = `${citation.label || citation.id || `K${index + 1}`} · ${citation.title || source?.title || 'Kilde'}`;
      return url ? externalLink(title, url, 'sidechat-citation') : btn(title, () => source && go('brain', source.projectId, source.id), 'button-text sidechat-citation', null, { disabled: !source });
    })));
    return node;
  }
  function renderMessages() {
    const chat = current();
    const job = active?.chatId && active.chatId === chat?.id ? active : null;
    const saved = chat?.messages || [];
    const signature = JSON.stringify([projectId, chat?.id, saved.map(message => [message.id, message.content, message.citations]), job?.text, job?.pending, job?.starting]);
    if (signature === messageSignature) return;
    messageSignature = signature;
    const nearEnd = nodes.messages.scrollHeight - nodes.messages.scrollTop - nodes.messages.clientHeight < 90;
    const changedChat = nodes.messages.dataset.chat !== (chat?.id || `${projectId}:new`);
    nodes.messages.dataset.chat = chat?.id || `${projectId}:new`;
    const content = saved.map(message => messageNode(message));
    if (job && !saved.some(message => message.role === 'user' && message.content === job.pending && !job.savedIds?.has(message.id))) content.push(messageNode({ role: 'user', content: job.pending }));
    if (job && !saved.some(message => message.role === 'assistant' && !job.savedIds?.has(message.id))) content.push(messageNode({ role: 'assistant', content: job.text }, true));
    if (!content.length) content.push(el('div', { class: 'sidechat-welcome' }, icon('sparkle', 27), el('h3', {}, project() ? 'Hva vil du utforske?' : 'Velg et prosjekt'), el('p', {}, project() ? 'Start en samtale. Velg filer fra Brain når du vil bruke dem som kilder.' : 'Samtaler lagres sammen med prosjektet ditt.')));
    nodes.messages.replaceChildren(...content);
    if (nearEnd || changedChat) nodes.messages.scrollTop = nodes.messages.scrollHeight;
  }
  function updateControls() {
    if (!nodes) return;
    const pendingHere = active && active.projectId === projectId;
    const text = draft();
    if (nodes.draft.value !== text) nodes.draft.value = text;
    nodes.draft.disabled = !project();
    nodes.send.disabled = !project() || !ready() || !text.trim() || Boolean(active) || loading || accountBusy || modelBusy;
    nodes.newChat.disabled = !project();
    nodes.stop.hidden = !active;
    nodes.stop.disabled = Boolean(active?.cancelling || active?.starting);
    nodes.stop.textContent = active?.cancelling ? 'Stopper …' : 'Stopp';
    nodes.status.textContent = active ? (active.starting ? 'Åpner samtalen …' : active.cancelling ? 'Avbryter …' : pendingHere ? 'Skriver …' : 'Et svar pågår …') : sandbox() ? 'Windows-appen for KI-svar' : ready() ? '' : 'Logg inn og velg modell';
    nodes.activity.hidden = !active || pendingHere;
    if (active && !pendingHere) nodes.activity.replaceChildren(el('span', {}, `Svarer i ${projectTitle(active.projectId)}.`), btn('Vis', () => {
      const value = sessions.get(active.projectId);
      if (value) value.chatId = active.chatId;
      selectProject(active.projectId);
    }, 'button-text button-small'));
    nodes.error.textContent = session().error || session().storageError;
    nodes.error.hidden = !nodes.error.textContent;
  }
  async function send() {
    if (!project() || !draft().trim() || !ready() || active || accountBusy || loading || modelBusy) return;
    const originProject = projectId, value = session(), oldDraftKey = draftKey(), message = draft().trim();
    const sourceIds = [...value.sources];
    const job = { projectId: originProject, chatId: value.chatId, pending: message, text: '', starting: true, cancelling: false };
    value.drafts.set(oldDraftKey, '');
    active = job; value.error = ''; persistSession(originProject, value); update();
    try {
      if (!job.chatId) {
        const oldIds = new Set(state.chats.map(chat => chat.id));
        const response = await invoke('createChat', { projectId: originProject });
        const snapshot = normalizeState(response);
        const created = snapshot?.chats.find(chat => chat.projectId === originProject && !oldIds.has(chat.id));
        if (!created) throw new Error('Kunne ikke opprette samtalen.');
        job.chatId = created.id;
        // A project switch while creation is in flight must not select this chat elsewhere.
        if (value.chatId === null) value.chatId = created.id;
        value.drafts.set(created.id, value.drafts.get(oldDraftKey) || '');
        value.drafts.delete(oldDraftKey);
        persistSession(originProject, value);
        applyState(response);
      }
      const selected = state.chats.find(chat => chat.id === job.chatId && chat.projectId === originProject);
      if (!selected) throw new Error('Samtalen finnes ikke lenger.');
      job.savedIds = new Set(selected.messages.map(item => item.id));
      job.starting = false;
      update();
      const response = await invoke('chat', { chatId: job.chatId, message, sourceIds });
      active = null;
      applyState(response);
    } catch (error) {
      if (active === job) active = null;
      value.error = job.cancelling ? 'Svaret ble stoppet. Delvise svar lagres ikke.' : errorText(error);
      // Never replace text the user has begun writing while the answer was streaming.
      const key = job.chatId || oldDraftKey;
      if (!value.drafts.get(key)) value.drafts.set(key, message);
    } finally {
      if (active === job) active = null;
      persistSession(originProject, value);
      messageSignature = '';
      update();
    }
  }
  async function cancel() {
    const job = active;
    if (!job?.chatId || job.starting || job.cancelling) return;
    job.cancelling = true; updateControls();
    try { await invoke('cancelChat', { chatId: job.chatId }); }
    catch (error) { if (active === job) { job.cancelling = false; sessions.get(job.projectId).error = errorText(error); update(); } }
  }
  function update() {
    init();
    if (!panel) return;
    if (lastMainProject !== ui.projectId) {
      lastMainProject = ui.projectId;
      if (state.projects.some(item => item.id === ui.projectId)) projectId = ui.projectId;
    }
    if (!state.projects.some(item => item.id === projectId)) projectId = state.projects[0]?.id || null;
    if (!open) return;
    renderSelectors(); renderAccount(); renderSources(); renderMessages(); updateControls();
  }
  window.SammenSidechat = Object.freeze({ update, prepareForUpdate, open: () => { init(); setOpen(true); } });
})();
