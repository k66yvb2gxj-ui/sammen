'use strict';

(() => {
  let latest = null;
  let panel = null;
  let busy = false;
  let subscribed = false;

  function running(status) {
    return Boolean(status?.running || ['starting', 'running', 'stopping'].includes(status?.state));
  }
  function label(status) {
    if (busy) return 'Venter …';
    if (!status) return 'Sjekker denne PC-en …';
    if (status.available === false) return status.error ? 'PC-tilkoblingen er utilgjengelig.' : 'Fjernkobling brukes i Windows-appen.';
    if (status.state === 'starting') return 'Starter agenten …';
    if (status.state === 'stopping') return 'Stopper agenten …';
    if (status.error || status.state === 'error') return 'Agenten kunne ikke kjøre.';
    return running(status) ? 'Agenten kjører' : 'Agenten er stoppet';
  }
  function safeHttps(value) {
    try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; }
    catch { return null; }
  }
  function logs(status) {
    const value = Array.isArray(status?.logs) ? status.logs.filter(line => typeof line === 'string').join('\n') : typeof status?.logs === 'string' ? status.logs : '';
    return value.slice(-12_000);
  }
  function externalButton(text, url, identifier) {
    const safe = safeHttps(url);
    return safe ? btn(text, () => invoke('openExternal', safe).catch(showError), 'button-quiet button-small', 'external', { id: identifier }) : null;
  }
  function render() {
    if (!panel?.isConnected) return;
    const focused = panel.contains(document.activeElement) ? document.activeElement.id : null;
    const previousLog = panel.querySelector('.device-log');
    const previousOutput = previousLog?.querySelector('pre');
    const followOutput = !previousOutput || previousOutput.scrollHeight - previousOutput.clientHeight - previousOutput.scrollTop < 8;
    const outputOffset = previousOutput?.scrollTop || 0;
    const status = latest;
    const active = running(status);
    const unavailable = !status || status.available === false;
    const actions = el('div', { class: 'device-actions' },
      btn('Koble denne PC-en', () => change('startRemoteDevice'), 'button', 'link', { id: 'device-start', disabled: busy || unavailable || active }),
      btn('Stopp agenten', () => change('stopRemoteDevice'), 'button-secondary', null, { id: 'device-stop', disabled: busy || unavailable || !active })
    );
    const logText = logs(status);
    const detail = logText ? el('details', { class: 'device-log', open: previousLog ? previousLog.open : true }, el('summary', { id: 'device-log-toggle' }, 'Innlogging og status'), el('pre', { id: 'device-log-output', tabindex: 0 }, logText)) : null;
    panel.replaceChildren(...[
      el('p', { class: 'device-status', role: 'status', 'aria-live': 'polite' }, label(status)),
      el('p', { class: 'device-consent' }, 'Remote Desktop Commander gir den tilkoblede AI-kontoen tilgang til filer og kommandoer på denne PC-en. Første gang bekrefter du paringskoden og velger konto i nettleseren.'),
      el('p', { class: 'device-note' }, 'Sammen har med egen kjøremotor. Agenten starter bare når du trykker Koble til, og stopper når du lukker appen.'),
      actions,
      status?.error ? el('p', { class: 'device-error', role: 'alert' }, String(status.error).slice(0, 1000)) : null,
      status?.verificationCode ? el('p', { class: 'device-code' }, 'Kode: ', el('code', {}, String(status.verificationCode).slice(0, 100))) : null,
      externalButton('Åpne innlogging', status?.verificationUrl, 'device-verification'),
      detail,
      el('div', { class: 'device-links' }, externalButton('Tilkoblede PC-er', status?.dashboardUrl, 'device-dashboard'), externalButton('Veiledning', status?.documentationUrl || status?.docsUrl, 'device-documentation')),
      el('p', { class: 'device-note' }, 'For OneNote og kalendernotater velger du sider under Importer → OneNote. Sidene kopieres til Brain; de synkroniseres ikke automatisk. Prosjektsamarbeid kobles til under Samarbeid.')
    ].filter(Boolean));
    const output = panel.querySelector('.device-log pre');
    if (output) output.scrollTop = followOutput ? output.scrollHeight : outputOffset;
    const target = focused && document.getElementById(focused);
    if (target && !target.disabled) target.focus({ preventScroll: true });
  }
  async function change(method) {
    if (busy || !panel?.isConnected) return;
    busy = true;
    render();
    try { latest = await invoke(method); }
    catch (error) { latest = { ...(latest || {}), error: error.message || 'Kunne ikke endre agenten.' }; }
    finally { busy = false; render(); }
  }
  async function open() {
    if (window.SammenSharing?.isBusy?.()) return;
    panel = el('div', { class: 'device-setup' });
    openModal('Denne PC-en', '', panel, 'device-modal');
    render();
    if (!subscribed && typeof api?.onRemoteDeviceStatus === 'function') {
      api.onRemoteDeviceStatus(value => { latest = value; render(); });
      subscribed = true;
    }
    try { latest = await invoke('getRemoteDeviceStatus'); }
    catch (error) { latest = { available: false, error: error.message || 'Kunne ikke hente agentstatus.' }; }
    render();
  }
  window.SammenDeviceSetup = { open };
})();
