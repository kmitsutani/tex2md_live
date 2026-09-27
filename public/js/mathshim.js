/**
 * Rewrite math that LaTeX packages support but Obsidian's MathJax does not.
 *
 * Without this, `\slashed{\partial}` and `\bm{b}` render as errors in Obsidian
 * even though the surrounding equation is fine.
 */

import { readBalanced } from './lexer.js';

/** Commands taking one argument, rewritten as `name -> wrapper`. */
const ARG_REWRITES = {
  slashed: (arg) => `{\\not{${arg}}}`,   // `slashed` package (Feynman slash)
  bm: (arg) => `\\boldsymbol{${arg}}`,   // `bm` package
  bs: (arg) => `\\boldsymbol{${arg}}`,
  slash: (arg) => `{\\not{${arg}}}`,
};

/**
 * Plain textual substitutions with no argument.
 * @type {[RegExp, string][]}
 */
const SIMPLE_REWRITES = [
  [/\\enspace\b/g, '\\;'],
  [/\\thinspace\b/g, '\\,'],
  [/\\boldmath\b/g, ''],
  [/\\unboldmath\b/g, ''],
  [/\\nolimits\b/g, ''],
  [/\\displaystyle\b/g, ''],
];

/** Old-style font switches inside a group: `{\cal L}` -> `\mathcal{L}`. */
const FONT_SWITCHES = {
  cal: 'mathcal', bf: 'mathbf', it: 'mathit', rm: 'mathrm',
  sf: 'mathsf', tt: 'mathtt', frak: 'mathfrak', Bbb: 'mathbb',
};

/**
 * @param {string} body raw math source
 * @param {{unknown?: Set<string>}} [report] collects commands we left untouched
 * @returns {string}
 */
export function shimMath(body, report) {
  let out = body;

  for (const name of Object.keys(ARG_REWRITES)) {
    out = rewriteWithArg(out, name, ARG_REWRITES[name]);
  }

  out = rewriteGroupFontSwitches(out);

  for (const [re, to] of SIMPLE_REWRITES) out = out.replace(re, to);

  if (report?.unknown) {
    for (const m of out.matchAll(/\\([a-zA-Z]+)/g)) report.unknown.add(m[1]);
  }

  return out;
}

/**
 * Replace every `\name{arg}` using a brace-aware scan, so nested braces in the
 * argument survive (a regex cannot do this correctly).
 * @param {string} text
 * @param {string} name
 * @param {(arg: string) => string} build
 */
export function rewriteWithArg(text, name, build) {
  const marker = `\\${name}`;
  let out = '';
  let i = 0;

  while (i < text.length) {
    const at = text.indexOf(marker, i);
    if (at === -1) {
      out += text.slice(i);
      break;
    }
    // Guard against matching a longer command with the same prefix.
    const after = text[at + marker.length];
    if (after !== undefined && /[a-zA-Z]/.test(after)) {
      out += text.slice(i, at + marker.length);
      i = at + marker.length;
      continue;
    }

    out += text.slice(i, at);
    const braceAt = at + marker.length + (/^\s*/.exec(text.slice(at + marker.length))[0].length);
    const arg = readBalanced(text, braceAt);
    if (!arg) {
      out += marker;
      i = at + marker.length;
      continue;
    }
    out += build(arg.content);
    i = arg.end;
  }

  return out;
}

/**
 * `{\cal L}` -> `\mathcal{L}`. MathJax mostly tolerates the old switches, but
 * normalising them keeps the output predictable across renderers.
 * @param {string} text
 */
function rewriteGroupFontSwitches(text) {
  const names = Object.keys(FONT_SWITCHES).join('|');
  const re = new RegExp(`\\{\\s*\\\\(${names})\\b\\s*`, 'g');
  let out = '';
  let i = 0;
  let m;

  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    const group = readBalanced(text, m.index);
    if (!group) continue;
    const inner = group.content.replace(new RegExp(`^\\s*\\\\${m[1]}\\b\\s*`), '');
    out += text.slice(i, m.index) + `\\${FONT_SWITCHES[m[1]]}{${inner}}`;
    i = group.end;
    re.lastIndex = group.end;
  }
  out += text.slice(i);
  return out;
}
