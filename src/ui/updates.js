'use strict';

(() => {
  const releases = 'https://github.com/k66yvb2gxj-ui/sammen/releases';
  let latest = null, panel = null, badge = null, checking = false, installing = false;
  const working = () => checking || installing || ['checking', 'downloading', 'installing'].includes(latest?.status);

  function releaseUrl() {
    try {
      const url = new URL(latest?.releaseUrl || releases);
      return url.origin === 'https://github.com' && !url.username && !url.password &&
        (url.pathname === '/k66yvb2gxj-ui/sammen/releases' || url.pathname.startsWith('/k66yvb2gxj-ui/sammen/releases/tag/')) ? url.href : releases;
    } catch { return releases; }
  }

  function message() {
    if (installing || latest?.status === 'installing') return 'Starter oppdateringen …';
    if (checking || latest?.status === 'checking') return 'Ser etter oppdateringer …';
    if (latest?.status === 'downloading') return `Laster ned Sammen ${latest.latestVersion || ''} …`;
    if (latest?.status === 'downloaded') return `Sammen ${latest.latestVersion} er klar til å installeres.`;
    if (latest?.status === 'available') return `Sammen ${latest.latestVersion} er klar.`;
    if (latest?.status === 'current') return 'Du har nyeste publiserte versjon.';
    if (latest?.status === 'unpublished') return 'Ingen versjon er publisert ennå.';
    if (latest?.status === 'error') return latest.error || 'Kunne ikke sjekke oppdateringer.';
    return latest?.automatic ? 'Oppdateringer installeres automatisk når du lukker appen.' : 'Hent nye versjoner fra GitHub.';
  }

  function help() {
    if (latest?.automatic) return latest.status === 'downloaded'
      ? 'Installeres når du lukker appen. Du kan også starte på nytt nå.'
      : 'Nye versjoner lastes ned i bakgrunnen og installeres når du lukker appen.';
    return latest?.reason || latest?.automaticReason || 'Installer Windows-appen fra .exe-filen for automatiske oppdateringer.';
  }

  async function install() {
    if (working() || !latest?.automatic || latest.status !== 'downloaded') return;
    installing = true; render();
    try { accept(await invoke('installUpdate')); }
    catch (error) { latest = { ...(latest || {}), status: 'error', error: error.message || 'Kunne ikke starte oppdateringen.' }; }
    finally { installing = false; render(); }
  }

  function render() {
    if (badge) {
      badge.hidden = !['available', 'downloading', 'downloaded'].includes(latest?.status);
      badge.title = latest?.status === 'downloaded' ? 'Oppdateringen er klar til installasjon' : latest?.latestVersion ? `Sammen ${latest.latestVersion} er tilgjengelig` : 'Oppdateringer';
    }
    if (!panel?.isConnected) return;
    panel.replaceChildren(...[
      el('p', { class: 'updates-version' }, `Denne versjonen: ${latest?.currentVersion || '…'}`),
      el('p', { class: 'updates-status', role: 'status', 'aria-live': 'polite' }, message()),
      latest?.status === 'downloading' ? el('div', { class: 'updates-download' },
        el('progress', { class: 'updates-progress', max: 100, ...(Number.isFinite(latest.progress) ? { value: Math.max(0, Math.min(100, latest.progress)) } : {}), 'aria-label': 'Nedlasting av oppdatering' }),
        Number.isFinite(latest.progress) ? el('span', { class: 'updates-percent' }, `${Math.floor(Math.max(0, Math.min(100, latest.progress)))} %`) : null) : null,
      el('p', { class: 'updates-help' }, help()),
      el('div', { class: 'modal-actions' },
        btn('Lukk', closeModal, 'button-secondary'),
        btn('Sjekk på nytt', check, 'button-secondary', 'refresh', { disabled: working() || latest?.status === 'downloaded' }),
        latest?.automatic && latest?.status === 'downloaded'
          ? btn('Start på nytt og oppdater', install, '', 'refresh', { disabled: working() })
          : !latest?.automatic ? btn('Åpne nedlastinger', () => invoke('openExternal', releaseUrl()).catch(showError), '', 'external', { disabled: installing }) : null)
    ].filter(value => value !== null));
  }

  function accept(value) { latest = value; render(); }
  async function check() {
    if (working() || latest?.status === 'downloaded') return;
    checking = true; render();
    try { accept(await invoke('checkForUpdates')); }
    catch (error) { latest = { ...(latest || {}), status: 'error', error: error.message || 'Kunne ikke sjekke oppdateringer.' }; }
    finally { checking = false; render(); }
  }
  async function open() {
    panel = el('div', { class: 'updates-panel' });
    openModal('Oppdateringer', null, panel);
    render();
    try { accept(await invoke('getUpdateStatus')); }
    catch (error) { latest = { status: 'error', error: error.message }; render(); }
    if (!latest || latest.status === 'idle') await check();
  }
  async function initialize() {
    badge = btn('Oppdater', open, 'button button-quiet updates-badge', 'refresh', { id: 'updates-notification', hidden: true });
    document.querySelector('.topbar-actions')?.append(badge);
    window.sammen?.onUpdateStatus?.(accept);
    try { accept(await invoke('getUpdateStatus')); } catch {}
  }
  window.SammenUpdates = { open };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else queueMicrotask(initialize);
})();
