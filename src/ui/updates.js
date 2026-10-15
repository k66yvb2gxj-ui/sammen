'use strict';

(() => {
  const releases = 'https://github.com/k66yvb2gxj-ui/sammen/releases';
  let latest = null, panel = null, badge = null, busy = false;

  function releaseUrl() {
    try {
      const url = new URL(latest?.releaseUrl || releases);
      return url.origin === 'https://github.com' && !url.username && !url.password &&
        (url.pathname === '/k66yvb2gxj-ui/sammen/releases' || url.pathname.startsWith('/k66yvb2gxj-ui/sammen/releases/tag/')) ? url.href : releases;
    } catch { return releases; }
  }

  function message() {
    if (busy || latest?.status === 'checking') return 'Ser etter oppdateringer …';
    if (latest?.status === 'available') return `Sammen ${latest.latestVersion} er klar.`;
    if (latest?.status === 'current') return 'Du har nyeste publiserte versjon.';
    if (latest?.status === 'unpublished') return 'Ingen versjon er publisert ennå.';
    if (latest?.status === 'error') return latest.error || 'Kunne ikke sjekke oppdateringer.';
    return 'Hent nye versjoner fra GitHub.';
  }

  function render() {
    if (badge) {
      badge.hidden = latest?.status !== 'available';
      badge.title = latest?.latestVersion ? `Sammen ${latest.latestVersion} er tilgjengelig` : 'Oppdateringer';
    }
    if (!panel?.isConnected) return;
    panel.replaceChildren(
      el('p', { class: 'updates-version' }, `Denne versjonen: ${latest?.currentVersion || '…'}`),
      el('p', { class: 'updates-status', role: 'status', 'aria-live': 'polite' }, message()),
      el('p', { class: 'updates-help' }, 'Nye versjoner lastes ned fra GitHub. Installasjonen starter når du åpner den nedlastede filen.'),
      el('div', { class: 'modal-actions' },
        btn('Lukk', closeModal, 'button-secondary'),
        btn('Sjekk på nytt', check, 'button-secondary', 'refresh', { disabled: busy || latest?.status === 'checking' }),
        btn('Last ned', () => invoke('openExternal', releaseUrl()).catch(showError), '', 'external', { disabled: latest?.status !== 'available' }))
    );
  }

  function accept(value) { latest = value; render(); }
  async function check() {
    if (busy) return;
    busy = true; render();
    try { accept(await invoke('checkForUpdates')); }
    catch (error) { latest = { ...(latest || {}), status: 'error', error: error.message || 'Kunne ikke sjekke oppdateringer.' }; }
    finally { busy = false; render(); }
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
