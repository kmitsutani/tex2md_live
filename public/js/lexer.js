/**
 * Low-level scanning primitives shared by the parser.
 *
 * These all take the full source plus an index and return the index just past
 * whatever they consumed, so the parser can stay a simple loop.
 */

/** Math environments captured verbatim and handed to MathJax as-is. */
export const MATH_ENVS = new Set([
  'equation', 'align', 'aligned', 'alignat', 'gather', 'gathered', 'multline',
  'eqnarray', 'split', 'cases', 'array', 'displaymath', 'flalign',
]);

/** Environments whose body is literal text. */
export const VERBATIM_ENVS = new Set([
  'verbatim', 'Verbatim', 'lstlisting', 'minted', 'alltt',
]);

/**
 * Read a control sequence starting at `i`, which must point at a backslash.
 * Handles `\name` (letters, optionally followed by `*`) and `\@` single-char
 * control symbols such as `\\`, `\%`, `\,`.
 * @param {string} src
 * @param {number} i index of the backslash
 * @returns {{name: string, star: boolean, end: number}}
 */
export function readCommand(src, i) {
  const letters = /^[a-zA-Z]+/.exec(src.slice(i + 1));
  if (!letters) {
    // Control symbol: the single character after the backslash.
    return { name: src[i + 1] ?? '', star: false, end: i + 2 };
  }
  let end = i + 1 + letters[0].length;
  let star = false;
  if (src[end] === '*') {
    star = true;
    end += 1;
  }
  return { name: letters[0], star, end };
}

/**
 * Skip whitespace, but never cross a blank line (which is a paragraph break).
 * @param {string} src
 * @param {number} i
 */
export function skipSpacesWithinParagraph(src, i) {
  let j = i;
  let newlines = 0;
  while (j < src.length && /\s/.test(src[j])) {
    if (src[j] === '\n') {
      newlines += 1;
      if (newlines > 1) return i;
    }
    j += 1;
  }
  return j;
}

/**
 * Read a brace-balanced run starting at `i`, which must point at `open`.
 * Backslash-escaped delimiters do not count toward the balance.
 * @param {string} src
 * @param {number} i
 * @param {string} open
 * @param {string} close
 * @returns {{content: string, end: number}|null}
 */
export function readBalanced(src, i, open = '{', close = '}') {
  if (src[i] !== open) return null;
  let depth = 0;
  for (let j = i; j < src.length; j += 1) {
    if (src[j] === '\\') {
      j += 1; // skip the escaped character
      continue;
    }
    if (src[j] === open) depth += 1;
    else if (src[j] === close) {
      depth -= 1;
      if (depth === 0) return { content: src.slice(i + 1, j), end: j + 1 };
    }
  }
  // Unbalanced: treat the remainder as the content rather than failing.
  return { content: src.slice(i + 1), end: src.length };
}

/**
 * Read a `{...}` argument, tolerating whitespace before it.
 * @param {string} src
 * @param {number} i
 * @returns {{content: string, end: number}|null}
 */
export function readArg(src, i) {
  const j = skipSpacesWithinParagraph(src, i);
  return readBalanced(src, j, '{', '}');
}

/**
 * Read a `[...]` optional argument, tolerating whitespace before it.
 * @param {string} src
 * @param {number} i
 * @returns {{content: string, end: number}|null}
 */
export function readOptional(src, i) {
  const j = skipSpacesWithinParagraph(src, i);
  if (src[j] !== '[') return null;
  return readBalanced(src, j, '[', ']');
}

/**
 * Locate the matching `\end{env}`, honouring nesting of the same environment.
 * @param {string} src
 * @param {number} from index just past `\begin{env}`
 * @param {string} env
 * @returns {{body: string, end: number}}
 */
export function findEnvEnd(src, from, env) {
  const token = new RegExp(`\\\\(begin|end)\\s*\\{${escapeRe(env)}\\*?\\}`, 'g');
  token.lastIndex = from;
  let depth = 1;
  let m;
  while ((m = token.exec(src)) !== null) {
    depth += m[1] === 'begin' ? 1 : -1;
    if (depth === 0) {
      return { body: src.slice(from, m.index), end: token.lastIndex };
    }
  }
  // Never closed: consume the rest so a truncated draft still converts.
  return { body: src.slice(from), end: src.length };
}

/** @param {string} s */
export function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
