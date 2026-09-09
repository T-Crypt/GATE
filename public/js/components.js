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
