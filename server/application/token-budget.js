// Every payload Gate hands to a model is budgeted the same way: estimate, then
// give up the least valuable content until it fits. Keeping the loop here means
// the context compiler and Memory query answer to one definition of "too big".

export function estimateTokens(value) {
  return Math.ceil(JSON.stringify(value).length / 4);
}

// `reducers` run in priority order; each returns true when it managed to shrink
// the payload. When none can give anything up, `onExhausted` decides whether
// that is an error or an acceptable floor.
export function trimToBudget(payload, tokenBudget, reducers, onExhausted) {
  while (estimateTokens(payload) > tokenBudget) {
    if (!reducers.some((reduce) => reduce(payload))) return onExhausted(payload);
  }
  return payload;
}
