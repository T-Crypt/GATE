export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

export function providerName(kind) {
  return ({
    claude: 'Claude Code',
    opencode: 'OpenCode',
    codex: 'Codex',
    gemini: 'Gemini CLI',
    cursor: 'Cursor Agent',
    copilot: 'Copilot CLI'
  })[kind] || kind || 'Provider';
}

// What a blank model resolves to, phrased for the hint under the model field.
// Most CLIs pick their own default from their own config; only OpenCode and
// Gemini have one Gate can name.
// One roster entry as a badge. `unreachable` deliberately does not claim the CLI
// is missing: the probe cannot tell a missing executable from a signed-out one.
export function providerAvailability(entry) {
  const label = {
    ready: 'signed in',
    unreachable: 'not detected',
    unknown: 'probe failed'
  }[entry.availability] || 'unknown';
  return `<span class="badge provider-availability is-${escapeHtml(entry.availability)}" title="${escapeHtml(
    entry.structuredDrafts ? 'Drafts against a JSON schema' : 'Drafts against the prose contract'
  )}">${escapeHtml(providerName(entry.kind))} · ${escapeHtml(label)}</span>`;
}

export function providerModelDefault(kind) {
  return (
    {
      opencode: 'opencode/big-pickle',
      gemini: 'auto',
      codex: 'the model in ~/.codex/config.toml'
    }[kind] || 'the CLI default'
  );
}

// A provider that can enumerate its models gets a closed <select>. One that
// cannot reports `complete: false`, and gets a combobox instead: the suggestions
// still show, but a model Gate has never heard of can be typed in rather than
// being unreachable because the adapter could not list it.
export function modelField(id, catalog, selected) {
  if (catalog.complete !== false) {
    return `<select id="${escapeHtml(id)}">${modelSelectOptions(catalog, selected)}</select>`;
  }
  const options = catalog.models
    .map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.label || model.id)}</option>`)
    .join('');
  return `<input id="${escapeHtml(id)}" list="${escapeHtml(id)}Options" value="${escapeHtml(selected || '')}" placeholder="Provider default" autocomplete="off" spellcheck="false"><datalist id="${escapeHtml(id)}Options">${options}</datalist>`;
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
