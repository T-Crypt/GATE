import path from 'node:path';

const EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
const IDENTIFIER_START = /[A-Za-z_$]/;
const IDENTIFIER_PART = /[A-Za-z0-9_$]/;

function canStartRegex(tokens) {
  const previous = tokens.at(-1)?.value;
  return previous === undefined || ['=', '(', '[', '{', ',', ':', ';', '!', '?', '=>', 'return', 'case'].includes(previous);
}

function tokenize(content) {
  const tokens = [];
  let index = 0;
  let line = 1;
  const advance = () => {
    if (content[index] === '\n') line += 1;
    index += 1;
  };
  const skipQuoted = (quote, capture) => {
    const startLine = line;
    let value = '';
    advance();
    while (index < content.length) {
      if (content[index] === '\\') {
        advance();
        if (index < content.length) {
          if (capture) value += content[index];
          advance();
        }
      } else if (content[index] === quote) {
        advance();
        return { type: 'string', value, line: startLine };
      } else {
        if (capture) value += content[index];
        advance();
      }
    }
    return capture ? { type: 'string', value, line: startLine } : null;
  };

  while (index < content.length) {
    const character = content[index];
    if (/\s/.test(character)) {
      advance();
      continue;
    }
    if (character === '/' && content[index + 1] === '/') {
      while (index < content.length && content[index] !== '\n') advance();
      continue;
    }
    if (character === '/' && content[index + 1] === '*') {
      advance();
      advance();
      while (index < content.length && !(content[index] === '*' && content[index + 1] === '/')) advance();
      if (index < content.length) {
        advance();
        advance();
      }
      continue;
    }
    if (character === '\'' || character === '"') {
      tokens.push(skipQuoted(character, true));
      continue;
    }
    if (character === '`') {
      skipQuoted(character, false);
      continue;
    }
    if (character === '/' && canStartRegex(tokens)) {
      advance();
      let inClass = false;
      while (index < content.length) {
        if (content[index] === '\\') {
          advance();
          if (index < content.length) advance();
        } else if (content[index] === '[') {
          inClass = true;
          advance();
        } else if (content[index] === ']') {
          inClass = false;
          advance();
        } else if (content[index] === '/' && !inClass) {
          advance();
          while (/[A-Za-z]/.test(content[index] || '')) advance();
          break;
        } else {
          advance();
        }
      }
      continue;
    }
    if (IDENTIFIER_START.test(character)) {
      const start = index;
      const startLine = line;
      advance();
      while (index < content.length && IDENTIFIER_PART.test(content[index])) advance();
      tokens.push({ type: 'identifier', value: content.slice(start, index), line: startLine });
      continue;
    }
    const pair = content.slice(index, index + 2);
    if (['=>', '?.', '??', '&&', '||', '==', '!=', '>=', '<='].includes(pair)) {
      tokens.push({ type: 'punctuation', value: pair, line });
      advance();
      advance();
      continue;
    }
    tokens.push({ type: 'punctuation', value: character, line });
    advance();
  }
  return tokens;
}

function exportedDeclaration(tokens, index) {
  for (let cursor = index - 1, inspected = 0; cursor >= 0 && inspected < 3; cursor -= 1, inspected += 1) {
    const value = tokens[cursor].value;
    if (value === 'export') return true;
    if (!['default', 'async'].includes(value)) return false;
  }
  return false;
}

function variableSymbols(tokens, start, exported) {
  const symbols = [];
  let expectName = true;
  let depth = 0;
  for (let index = start + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.value === ';' && depth === 0) break;
    if (['(', '[', '{'].includes(token.value)) depth += 1;
    if ([')', ']', '}'].includes(token.value)) depth = Math.max(0, depth - 1);
    if (token.value === ',' && depth === 0) {
      expectName = true;
      continue;
    }
    if (expectName && depth === 0 && token.type === 'identifier') {
      symbols.push({ name: token.value, kind: 'variable', line: token.line, exported });
      expectName = false;
    }
  }
  return symbols;
}

function importBindings(tokens, start, end) {
  const names = [];
  let index = start;
  if (tokens[index]?.type === 'identifier' && !['from', 'type'].includes(tokens[index].value)) {
    names.push({ imported: 'default', local: tokens[index].value });
    index += 1;
    if (tokens[index]?.value === ',') index += 1;
  }
  if (tokens[index]?.value === '*') {
    const local = tokens[index + 2]?.value;
    if (tokens[index + 1]?.value === 'as' && local) names.push({ imported: '*', local });
    return names;
  }
  const open = tokens.findIndex((token, tokenIndex) => tokenIndex >= index && tokenIndex < end && token.value === '{');
  if (open === -1) return names;
  for (let cursor = open + 1; cursor < end && tokens[cursor].value !== '}'; cursor += 1) {
    const imported = tokens[cursor];
    if (imported.type !== 'identifier' || imported.value === 'type') continue;
    let local = imported.value;
    if (tokens[cursor + 1]?.value === 'as' && tokens[cursor + 2]?.type === 'identifier') {
      local = tokens[cursor + 2].value;
      cursor += 2;
    }
    names.push({ imported: imported.value, local });
  }
  return names;
}

function importsFrom(tokens) {
  const imports = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.value === 'import' && tokens[index + 1]?.value !== '(') {
      if (tokens[index + 1]?.type === 'string') {
        imports.push({ specifier: tokens[index + 1].value, kind: 'esm', line: token.line, names: [] });
        continue;
      }
      let from = index + 1;
      while (from < tokens.length && tokens[from].value !== 'from' && tokens[from].value !== ';') from += 1;
      if (tokens[from]?.value === 'from' && tokens[from + 1]?.type === 'string') {
        imports.push({
          specifier: tokens[from + 1].value,
          kind: 'esm',
          line: token.line,
          names: importBindings(tokens, index + 1, from)
        });
      }
    }
    if (token.value === 'require' && tokens[index + 1]?.value === '(' && tokens[index + 2]?.type === 'string') {
      const local = tokens[index - 1]?.value === '=' && tokens[index - 2]?.type === 'identifier'
        ? tokens[index - 2].value
        : null;
      imports.push({
        specifier: tokens[index + 2].value,
        kind: 'commonjs',
        line: token.line,
        names: local ? [{ imported: 'default', local }] : []
      });
    }
  }
  return imports;
}

function symbolsFrom(tokens) {
  const symbols = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const exported = exportedDeclaration(tokens, index);
    if (token.value === 'function') {
      const name = tokens[index + (tokens[index + 1]?.value === '*' ? 2 : 1)];
      if (name?.type === 'identifier') symbols.push({ name: name.value, kind: 'function', line: token.line, exported });
    } else if (token.value === 'class') {
      const name = tokens[index + 1];
      if (name?.type === 'identifier') symbols.push({ name: name.value, kind: 'class', line: token.line, exported });
    } else if (['const', 'let', 'var'].includes(token.value)) {
      symbols.push(...variableSymbols(tokens, index, exported));
    }
  }
  return symbols;
}

export class JavaScriptLanguageIndexer {
  supports(relativePath) {
    return EXTENSIONS.has(path.extname(relativePath).toLowerCase());
  }

  parse({ content }) {
    const tokens = tokenize(String(content || ''));
    return {
      symbols: symbolsFrom(tokens),
      imports: importsFrom(tokens)
    };
  }
}
