import { JavaScriptLanguageIndexer } from './javascript.js';

export class LanguageIndexerRegistry {
  constructor(indexers = [new JavaScriptLanguageIndexer()]) {
    this.indexers = indexers;
  }

  supports(relativePath) {
    return this.indexers.some((indexer) => indexer.supports(relativePath));
  }

  parse(input) {
    const indexer = this.indexers.find((candidate) => candidate.supports(input.path));
    if (!indexer) return { symbols: [], imports: [], language: null };
    try {
      return { ...indexer.parse(input), language: 'javascript' };
    } catch {
      return { symbols: [], imports: [], language: 'javascript' };
    }
  }
}
