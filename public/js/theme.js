const STORAGE_KEY = 'gate.accent';
const VALID = new Set(['cyan', 'blue', 'purple', 'green', 'orange', 'pink', 'red']);

export function getAccent() {
  const stored = localStorage.getItem(STORAGE_KEY);
  return VALID.has(stored) ? stored : 'cyan';
}

export function applyAccent(accent) {
  const value = VALID.has(accent) ? accent : 'cyan';
  if (value === 'cyan') document.documentElement.removeAttribute('data-accent');
  else document.documentElement.setAttribute('data-accent', value);
  localStorage.setItem(STORAGE_KEY, value);
}
