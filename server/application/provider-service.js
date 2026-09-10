import { AppError } from '../domain/errors.js';

// Which backends this machine can actually reach.
//
// PROVIDER_UNAVAILABLE used to be the first news a user got that a CLI was
// missing, and it arrived only after a timeline had been drafted, reviewed, and
// a step started. The roster answers the same question before a project commits
// to a backend.
//
// Answering it costs one process per provider, so two rules hold throughout:
// the result is cached, and every probe is bounded and swallowed. A CLI that
// hangs, throws, or is not installed is reported as unreachable — it never
// propagates out of here, because the page asking this question must render
// whether or not six unrelated executables behave.

const PROBE_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 30_000;

// Resolve to a sentinel rather than rejecting: a probe timing out is an answer
// about the provider, not an error in the request that asked.
function withTimeout(promise, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve({ value });
      },
      (error) => {
        clearTimeout(timer);
        resolve({ error });
      }
    );
  });
}

export class ProviderService {
  #cache = null;

  constructor({ providers, timeoutMs = PROBE_TIMEOUT_MS, ttlMs = CACHE_TTL_MS, now = () => Date.now() }) {
    this.providers = providers;
    this.timeoutMs = timeoutMs;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  kinds() {
    return [...this.providers.keys()];
  }

  get(kind) {
    const provider = this.providers.get(kind);
    if (!provider) throw new AppError('UNKNOWN_PROVIDER', `No provider named ${kind}`, { status: 404 });
    return provider;
  }

  // Declared support, with no probing and no cost. The picker needs this even
  // when every CLI on the machine is unreachable.
  contract(kind) {
    const provider = this.get(kind);
    const capabilities = typeof provider.capabilities === 'function' ? provider.capabilities() : {};
    return {
      kind,
      streaming: Boolean(capabilities.streaming),
      structuredDrafts: Boolean(capabilities.structuredDrafts),
      canDraft: typeof provider.draftTimeline === 'function'
    };
  }

  async roster({ refresh = false } = {}) {
    if (!refresh && this.#cache && this.now() - this.#cache.at < this.ttlMs) return this.#cache.value;
    // All six at once: serially this would be six process spawns deep on a
    // request path, and they share nothing.
    const providers = await Promise.all(this.kinds().map((kind) => this.#probe(kind)));
    const value = { providers, checkedAt: new Date(this.now()).toISOString() };
    this.#cache = { at: this.now(), value };
    return value;
  }

  async #probe(kind) {
    const contract = this.contract(kind);
    const provider = this.providers.get(kind);
    if (typeof provider.listModels !== 'function') {
      return { ...contract, availability: 'unknown', models: 0, modelsComplete: false };
    }
    const probe = await withTimeout(Promise.resolve().then(() => provider.listModels()), this.timeoutMs);
    if (probe.timedOut || probe.error) {
      return { ...contract, availability: 'unknown', models: 0, modelsComplete: false };
    }
    const catalog = probe.value || {};
    return {
      ...contract,
      // The probes cannot tell a missing executable from a signed-out one — both
      // exit non-zero — so this says "unreachable", not "not installed".
      availability: catalog.authenticated ? 'ready' : 'unreachable',
      models: Array.isArray(catalog.models) ? catalog.models.length : 0,
      modelsComplete: catalog.complete !== false
    };
  }
}
