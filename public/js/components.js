export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

export function providerName(kind) {
  return ({ claude: 'Claude Code', opencode: 'OpenCode' })[kind] || kind || 'Provider';
}

export function providerModelDefault(kind) {
  return { claude: '', opencode: 'opencode/big-pickle' }[kind] || '';
}

export function emptyState(mark, title, description, action = '') {
  return `<div class="empty-state"><div><div class="empty-state-mark" aria-hidden="true">${escapeHtml(mark)}</div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p>${action ? `<div class="button-row empty-actions">${action}</div>` : ''}</div></div>`;
}

export function showToast(message, tone = 'neutral') {
  let region = document.querySelector('.toast-region');
  if (!region) {
    region = document.createElement('div');
    region.className = 'toast-region';
    region.setAttribute('role', 'status');
    document.body.appendChild(region);
  }
  const toast = document.createElement('div');
  toast.className = `toast ${tone}`;
  toast.textContent = message;
  region.appendChild(toast);
  setTimeout(() => toast.remove(), 4500);
}

export function openDialog({ label, content, className = '', onMount }) {
  const dialog = document.createElement('dialog');
  dialog.className = className;
  dialog.setAttribute('aria-label', label);
  dialog.innerHTML = content;
  document.body.appendChild(dialog);
  dialog.addEventListener('cancel', () => dialog.remove(), { once: true });
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.showModal();
  onMount?.(dialog);
  return dialog;
}

// Model ids are typed nowhere in Gate: each adapter reports what its harness
// can actually reach, and the user picks from that. A hand-typed id only fails
// ~30s later at draft time, with an error that names nothing useful.
export function modelSelectOptions(catalog, selected) {
  const options = [`<option value="" ${selected ? '' : 'selected'}>Provider default</option>`];
  for (const model of catalog.models) {
    options.push(
      `<option value="${escapeHtml(model.id)}" ${model.id === selected ? 'selected' : ''}>${escapeHtml(model.label || model.id)}</option>`
    );
  }
  // Never silently drop a configured value we no longer recognise — show it,
  // marked, so the user can see what is set and why it may be failing.
  if (selected && !catalog.models.some((model) => model.id === selected)) {
    options.push(`<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} — unavailable</option>`);
  }
  return options.join('');
}
