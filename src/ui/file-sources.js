'use strict';

(() => {
  const limit = 30;
  const citationsFor = draft => Array.isArray(draft.citations) ? draft.citations : [];
  const sourceFor = (draft, citation) => state.items.find(item => item.id === citation.sourceId && item.projectId === draft.projectId);
  function webUrl(value) {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? safeUrl(url.href) : null;
    } catch { return null; }
  }
  function labelsFor(citations) {
    const used = new Set(citations.map(citation => citation.id).filter(value => /^K\d+$/.test(value)));
    const labels = new Map();
    let number = 1;
    for (const citation of citations) {
      if (/^K\d+$/.test(citation.id)) { labels.set(citation.id, citation.id); continue; }
      while (used.has(`K${number}`)) number++;
      const label = `K${number}`;
      used.add(label); labels.set(citation.id, label);
    }
    return labels;
  }
  function currentDraft(draft) {
    return editor?.id === draft.id && editor?.projectId === draft.projectId ? editor : null;
  }
  function change(draft, host, operation) {
    const active = currentDraft(draft);
    if (!active) return toast('Åpne filen på nytt før du endrer kildene.', true);
    if (operation(active) !== false) markDirty();
    refresh(active);
  }
  function editCitation(draft, host, citationId = null) {
    const active = currentDraft(draft);
    if (!active) return toast('Filen er ikke lenger åpen.', true);
    const existing = citationId === null ? null : citationsFor(active).find(citation => citation.id === citationId);
    if (citationId !== null && !existing) { refresh(active); return toast('Kilden er fjernet av en annen elev.', true); }
    if (!existing && citationsFor(active).length >= limit) return toast('Opptil 30 kilder per fil.', true);
    const linked = existing && sourceFor(draft, existing);
    const choices = state.items.filter(item => item.projectId === draft.projectId && item.id !== draft.id && (item.type === 'source' || item.id === linked?.id));
    let mode = linked ? 'project' : 'external';
    const form = el('form', { class: 'file-source-form' });
    const error = el('p', { class: 'file-source-error', role: 'alert', hidden: true });
    const title = el('input', { id: 'file-source-title', maxlength: 500, value: existing?.title || '', placeholder: 'Kildens tittel', required: true });
    const url = el('input', { id: 'file-source-url', type: 'url', maxlength: 2000, value: existing?.url || '', placeholder: 'https://…', required: true, spellcheck: false });
    const excerpt = el('textarea', { id: 'file-source-excerpt', rows: 3, maxlength: 4000, value: existing?.excerpt || '', placeholder: 'Valgfritt utdrag …' });
    const select = el('select', { id: 'file-source-project-item', required: true }, el('option', { value: '' }, 'Velg kilde …'), choices.map(item => el('option', { value: item.id }, item.title)));
    if (linked) select.value = linked.id;
    const fields = el('div');
    const tabs = el('div', { class: 'file-source-tabs', role: 'tablist', 'aria-label': 'Kildetype' });
    function showFields() {
      for (const tab of tabs.children) {
        const active = tab.dataset.mode === mode;
        tab.classList.toggle('active', active);
        tab.setAttribute('aria-selected', String(active));
      }
      title.required = mode === 'external';
      url.required = mode === 'external';
      select.required = mode === 'project';
      fields.replaceChildren(...(mode === 'external' ? [field('Tittel', title), field('Lenke', url)] : [field('Kilde i prosjektet', select)]), field('Utdrag', excerpt));
      error.hidden = true;
    }
    [['external', 'Lenke'], ['project', 'Fra Brain']].forEach(([value, label]) => tabs.append(el('button', { type: 'button', role: 'tab', 'aria-selected': mode === value, dataset: { mode: value }, disabled: value === 'project' && !choices.length, onclick: () => { mode = value; showFields(); } }, label)));
    form.append(tabs, fields, error, el('div', { class: 'modal-actions' }, btn('Avbryt', closeModal, 'button-secondary'), el('button', { type: 'submit', class: 'button' }, existing ? 'Lagre kilde' : 'Legg til')));
    form.addEventListener('submit', event => {
      event.preventDefault();
      let candidate;
      if (mode === 'project') {
        const source = state.items.find(item => item.id === select.value && item.projectId === draft.projectId && item.id !== draft.id && (item.type === 'source' || item.id === linked?.id));
        if (!source) { error.textContent = 'Velg en kilde i dette prosjektet.'; error.hidden = false; return; }
        const sameSource = existing?.sourceId === source.id;
        candidate = { ...(existing || {}), id: existing?.id || id(), sourceId: source.id, title: sameSource && existing.title ? existing.title : source.title, url: source.sourceUrl || '', excerpt: existing && excerpt.value === existing.excerpt ? existing.excerpt : excerpt.value.trim() };
      } else {
        const address = webUrl(url.value.trim());
        if (!title.value.trim() || !address) { error.textContent = 'Skriv en tittel og en gyldig http- eller https-lenke.'; error.hidden = false; return; }
        candidate = { ...(existing || {}), id: existing?.id || id(), sourceId: '', title: title.value.trim(), url: address, excerpt: existing && excerpt.value === existing.excerpt ? existing.excerpt : excerpt.value.trim() };
      }
      const latest = currentDraft(draft);
      if (!latest) { error.textContent = 'Filen er ikke lenger åpen.'; error.hidden = false; return; }
      if (citationId !== null && !citationsFor(latest).some(citation => citation.id === citationId)) { error.textContent = 'Kilden er fjernet av en annen elev.'; error.hidden = false; return; }
      if (citationId === null && citationsFor(latest).length >= limit) { error.textContent = 'Opptil 30 kilder per fil.'; error.hidden = false; return; }
      closeModal();
      change(draft, host, active => {
        const citations = [...citationsFor(active)];
        if (citationId === null) {
          if (citations.length >= limit) { toast('Opptil 30 kilder per fil.', true); return false; }
          citations.push(candidate);
        } else {
          const currentIndex = citations.findIndex(citation => citation.id === citationId);
          if (currentIndex === -1) { toast('Kilden er fjernet av en annen elev.', true); return false; }
          citations[currentIndex] = candidate;
        }
        active.citations = citations;
      });
    });
    showFields();
    openModal(existing ? 'Rediger kilde' : 'Legg til kilde', '', form, 'file-source-modal');
    (mode === 'project' ? select : title).focus();
  }
  function render(draft) {
    const map = draft.type === 'mindmap';
    const host = el('section', { class: `file-sources${map ? ' file-sources-map' : ''}`, 'aria-label': 'Kilder til filen', dataset: { fileId: draft.id, projectId: draft.projectId } });
    const citations = citationsFor(draft);
    const labels = labelsFor(citations);
    const content = map ? el('details', { class: 'file-sources-disclosure' }, el('summary', {}, el('span', {}, 'Kilder'), el('span', { class: 'file-sources-count' }, citations.length), icon('chevron', 12))) : host;
    if (map) host.append(content);
    content.append(el('div', { class: 'file-sources-head' }, map ? null : el('h4', {}, 'Kilder'), btn('Legg til', () => editCitation(draft, host), 'button-text button-small', 'add', { 'aria-label': 'Legg til kilde', disabled: citations.length >= limit })));
    if (citations.length) content.append(el('div', { class: 'file-sources-list' }, citations.map(citation => {
      const source = sourceFor(draft, citation);
      const label = labels.get(citation.id);
      const title = citation.title || source?.title || 'Kilde';
      const address = safeUrl(citation.url || source?.sourceUrl);
      const link = source ? el('button', { type: 'button', class: 'file-source-link', title, onclick: () => go('brain', draft.projectId, source.id) }, title, icon('file', 11)) : address ? externalLink(title, address, 'file-source-link') : el('span', { class: 'file-source-link' }, title);
      const row = el('div', { class: 'file-source-row', dataset: { citationId: citation.id } }, el('span', { class: 'file-source-label' }, label), el('div', { class: 'file-source-copy' }, link, citation.excerpt ? el('details', { class: 'file-source-excerpt' }, el('summary', {}, 'Utdrag'), el('p', {}, citation.excerpt)) : null), el('div', { class: 'file-source-actions' }, btn('', () => editCitation(draft, host, citation.id), 'button-quiet button-small', 'file', { 'aria-label': `Rediger kilde ${label}`, title: 'Rediger kilde', dataset: { action: 'edit' } }), btn('', () => change(draft, host, active => {
        if (!citationsFor(active).some(value => value.id === citation.id)) return false;
        active.citations = citationsFor(active).filter(value => value.id !== citation.id);
      }), 'button-quiet button-small', 'close', { 'aria-label': `Fjern kilde ${label}`, title: 'Fjern kilde', dataset: { action: 'remove' } })));
      return row;
    })));
    return host;
  }
  function refresh(draft) {
    const host = [...document.querySelectorAll('.file-sources')].find(node => node.dataset.fileId === draft.id && node.dataset.projectId === draft.projectId);
    if (!host) return false;
    const active = currentDraft(draft) || draft;
    const disclosureOpen = host.querySelector('.file-sources-disclosure')?.open;
    const openExcerpts = new Set([...host.querySelectorAll('.file-source-excerpt[open]')].map(node => node.closest('.file-source-row')?.dataset.citationId));
    const focusNode = document.activeElement;
    const focused = host.contains(focusNode) ? { citationId: focusNode.closest('.file-source-row')?.dataset.citationId, action: focusNode.dataset.action, summary: focusNode.matches('.file-sources-disclosure > summary'), excerpt: focusNode.matches('.file-source-excerpt > summary'), link: focusNode.matches('.file-source-link') } : null;
    const next = render(active);
    const disclosure = next.querySelector('.file-sources-disclosure');
    if (disclosure) disclosure.open = Boolean(disclosureOpen);
    for (const row of next.querySelectorAll('.file-source-row')) if (openExcerpts.has(row.dataset.citationId)) {
      const excerpt = row.querySelector('.file-source-excerpt');
      if (excerpt) excerpt.open = true;
    }
    host.replaceWith(next);
    if (focused) {
      const row = [...next.querySelectorAll('.file-source-row')].find(node => node.dataset.citationId === focused.citationId);
      const control = focused.summary ? next.querySelector('.file-sources-disclosure > summary') : row && focused.action ? row.querySelector(`[data-action="${focused.action}"]`) : row && focused.excerpt ? row.querySelector('.file-source-excerpt > summary') : row && focused.link ? row.querySelector('.file-source-link') : next.querySelector('[aria-label="Legg til kilde"]');
      (control || next.querySelector('summary,button'))?.focus({ preventScroll: true });
    }
    return true;
  }
  window.FileSources = window.SammenFileSources = { render, refresh };
})();
