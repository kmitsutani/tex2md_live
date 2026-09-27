/**
 * User macro collection and expansion.
 *
 * Obsidian has no preamble, so any `\newcommand` the author defined must be
 * expanded inline or the math will not render. Macros are read from the raw
 * preamble text rather than the node tree, because `\newcommand{\f}[2]{...}`
 * puts its optional arity argument *between* the mandatory ones, which the
 * generic argument reader does not model.
 */

import { readBalanced, readCommand } from './lexer.js';

/**
 * @typedef {object} Macro
 * @property {string} name
 * @property {number} argc
 * @property {string|null} optDefault
 * @property {string} body
 */

/**
 * @param {string} preamble raw LaTeX before \begin{document}
 * @returns {Map<string, Macro>}
 */
export function collectMacros(preamble) {
  /** @type {Map<string, Macro>} */
  const macros = new Map();
  const define = /\\(newcommand|renewcommand|providecommand|DeclareMathOperator|def)\*?/g;
  let m;

  while ((m = define.exec(preamble)) !== null) {
    const kind = m[1];
    let i = define.lastIndex;

    // The macro name, either `{\foo}` or a bare `\foo`.
    let name = null;
    if (preamble[i] === '{') {
      const g = readBalanced(preamble, i);
      name = g.content.trim().replace(/^\\/, '');
      i = g.end;
    } else {
      const skipped = /^\s*/.exec(preamble.slice(i))[0].length;
      if (preamble[i + skipped] === '\\') {
        const cmd = readCommand(preamble, i + skipped);
        name = cmd.name;
        i = cmd.end;
      }
    }
    if (!name) continue;

    if (kind === 'DeclareMathOperator') {
      const body = readBalanced(preamble, skipWs(preamble, i));
      if (body) {
        macros.set(name, {
          name, argc: 0, optDefault: null,
          body: `\\operatorname{${body.content}}`,
        });
      }
      continue;
    }

    let argc = 0;
    let optDefault = null;

    if (kind === 'def') {
      // \def\foo#1#2{...}: count the parameter tokens before the body.
      const params = /^((?:#\d)*)/.exec(preamble.slice(i));
      argc = params[1].length / 2;
      i += params[1].length;
    } else {
      const arity = readOptionalRaw(preamble, i);
      if (arity) {
        argc = Number.parseInt(arity.content, 10) || 0;
        i = arity.end;
        const def = readOptionalRaw(preamble, i);
        if (def) {
          optDefault = def.content;
          i = def.end;
        }
      }
    }

    const body = readBalanced(preamble, skipWs(preamble, i));
    if (!body) continue;
    macros.set(name, { name, argc, optDefault, body: body.content });
  }

  return macros;
}

/** @param {string} s @param {number} i */
function skipWs(s, i) {
  return i + /^\s*/.exec(s.slice(i))[0].length;
}

/** @param {string} s @param {number} i */
function readOptionalRaw(s, i) {
  const j = skipWs(s, i);
  if (s[j] !== '[') return null;
  return readBalanced(s, j, '[', ']');
}

/**
 * Expand user macros in a string, repeatedly until stable.
 *
 * Bounded by `maxPasses` so a self-referential definition cannot hang the tab.
 * @param {string} text
 * @param {Map<string, Macro>} macros
 * @param {number} maxPasses
 * @returns {string}
 */
export function expandMacros(text, macros, maxPasses = 8) {
  if (macros.size === 0) return text;

  let current = text;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const next = expandOnce(current, macros);
    if (next === current) return next;
    current = next;
  }
  return current;
}

/**
 * @param {string} text
 * @param {Map<string, Macro>} macros
 */
function expandOnce(text, macros) {
  let out = '';
  let i = 0;

  while (i < text.length) {
    if (text[i] !== '\\') {
      out += text[i];
      i += 1;
      continue;
    }

    const cmd = readCommand(text, i);
    const macro = macros.get(cmd.name);
    if (!macro) {
      out += text.slice(i, cmd.end);
      i = cmd.end;
      continue;
    }

    let j = cmd.end;
    /** @type {string[]} */
    const args = [];

    if (macro.optDefault !== null) {
      const opt = readOptionalRaw(text, j);
      args.push(opt ? opt.content : macro.optDefault);
      if (opt) j = opt.end;
    }

    while (args.length < macro.argc) {
      const arg = readBalanced(text, skipWs(text, j));
      if (!arg) break;
      args.push(arg.content);
      j = arg.end;
    }

    // Too few arguments present: leave the call alone rather than mangle it.
    if (args.length < macro.argc) {
      out += text.slice(i, cmd.end);
      i = cmd.end;
      continue;
    }

    out += macro.body.replace(/#(\d)/g, (_, d) => args[Number(d) - 1] ?? '');
    i = j;
  }

  return out;
}
