/**
 * LaTeX -> node tree.
 *
 * Deliberately permissive: a working draft contains stray and malformed
 * control sequences (a bare `\l` right after `\begin{document}`, say), and the
 * job is to extract what content we can, never to validate. Anything
 * unrecognised degrades to a node the renderer can ignore.
 *
 * Math and verbatim bodies are captured as raw strings rather than parsed, so
 * what reaches MathJax is what the author actually wrote.
 */

import {
  MATH_ENVS, VERBATIM_ENVS, readCommand, readBalanced, readArg, readOptional,
  findEnvEnd,
} from './lexer.js';

/**
 * How many brace groups each command genuinely owns. Commands absent from this
 * table take none, so a following `{...}` parses as an ordinary group — which
 * is the right reading of TeX's `{\Large\bf text}` idiom.
 */
/**
 * Glue/length registers assigned with a bare dimension rather than a brace
 * group: `\baselineskip 18pt`. Without consuming the dimension, the `18pt`
 * leaks into the text as content.
 */
export const DIMEN_COMMANDS = new Set([
  'baselineskip', 'parindent', 'parskip', 'lineskip', 'topmargin', 'footskip',
  'textwidth', 'textheight', 'oddsidemargin', 'evensidemargin', 'columnsep',
  'tabcolsep', 'arraycolsep', 'unitlength', 'abovedisplayskip',
  'belowdisplayskip', 'medskipamount', 'smallskipamount', 'bigskipamount',
]);

const DIMEN_RE = /^\s*=?\s*[-+]?[0-9]*\.?[0-9]+\s*(?:pt|mm|cm|in|ex|em|bp|pc|dd|cc|sp|mu)\b(?:\s*(?:plus|minus)\s*[-+]?[0-9]*\.?[0-9]+\s*(?:pt|mm|cm|in|ex|em|bp|pc|dd|cc|sp|mu)\b)*/;

export const ARITY = {
  // sectioning
  part: 1, chapter: 1, section: 1, subsection: 1, subsubsection: 1,
  paragraph: 1, subparagraph: 1,
  // font / emphasis commands that take an argument
  textbf: 1, textit: 1, textsl: 1, textsc: 1, texttt: 1, textrm: 1, textsf: 1,
  textnormal: 1, emph: 1, underline: 1, uline: 1, sout: 1, textsuperscript: 1,
  textsubscript: 1, mbox: 1, hbox: 1, fbox: 1, text: 1,
  // structure and references
  label: 1, ref: 1, eqref: 1, pageref: 1, autoref: 1, cref: 1, Cref: 1,
  cite: 1, citep: 1, citet: 1, footnote: 1, footnotetext: 1, caption: 1,
  includegraphics: 1, bibitem: 1, bibliography: 1, bibliographystyle: 1,
  title: 1, author: 1, date: 1, thanks: 1, url: 1, href: 2, texorpdfstring: 2,
  // layout commands we drop, listed so their argument is consumed with them
  vspace: 1, hspace: 1, thispagestyle: 1, pagestyle: 1, setlength: 2,
  addtolength: 2, textcolor: 2, color: 1, pagecolor: 1, numberwithin: 2,
  baselineskip: 0, input: 1, include: 1, usepackage: 1, documentclass: 1,
  // graphics package boxes: the content is the LAST argument, the others are
  // a scale factor or an angle and must not reach the output
  scalebox: 2, rotatebox: 2, raisebox: 2, resizebox: 3, reflectbox: 1,
  // macro definition
  newcommand: 2, renewcommand: 2, providecommand: 2, DeclareMathOperator: 2,
  newtheorem: 2,
  // sentinel injected by the comment pass
  TPC: 1,
};

/**
 * A parsed node. Which fields are populated depends on `type`:
 *
 *   text      value
 *   group     children
 *   command   name, star, opt, args
 *   env       name, opt, args, children
 *   math      display, env, body
 *   verbatim  name, body
 *   par       (none)
 *
 * Modelled as one permissive shape rather than a discriminated union: the
 * renderer walks mixed node lists and probes for `children` generically, which
 * a union would require narrowing at every access for no real safety gain.
 *
 * @typedef {object} Node
 * @property {'text'|'group'|'command'|'env'|'math'|'verbatim'|'par'} type
 * @property {string} [value]
 * @property {Node[]} [children]
 * @property {string} [name]
 * @property {boolean} [star]
 * @property {string|null} [opt]
 * @property {string[]} [args]
 * @property {boolean} [display]
 * @property {string|null} [env]
 * @property {string} [body]
 */

const SPECIAL = new Set(['\\', '{', '}', '$']);

/**
 * @param {string} src
 * @returns {Node[]}
 */
export function parse(src) {
  /** @type {Node[]} */
  const nodes = [];
  let i = 0;
  let text = '';

  const flush = () => {
    if (text.length > 0) {
      nodes.push({ type: 'text', value: text });
      text = '';
    }
  };

  while (i < src.length) {
    const ch = src[i];

    // Paragraph break: a blank line.
    if (ch === '\n') {
      const blank = /^\n[ \t]*\n\s*/.exec(src.slice(i));
      if (blank) {
        flush();
        nodes.push({ type: 'par' });
        i += blank[0].length;
        continue;
      }
      text += '\n';
      i += 1;
      continue;
    }

    if (ch === '$') {
      flush();
      const display = src[i + 1] === '$';
      const close = display ? '$$' : '$';
      const start = i + close.length;
      const end = findUnescaped(src, start, close);
      nodes.push({
        type: 'math',
        display,
        env: null,
        body: src.slice(start, end === -1 ? src.length : end),
      });
      i = end === -1 ? src.length : end + close.length;
      continue;
    }

    if (ch === '{') {
      flush();
      const g = readBalanced(src, i);
      nodes.push({ type: 'group', children: parse(g.content) });
      i = g.end;
      continue;
    }

    if (ch === '}') {
      // Stray closing brace in the source; ignore it.
      i += 1;
      continue;
    }

    if (ch === '\\') {
      // \[ ... \] and \( ... \) math delimiters.
      if (src[i + 1] === '[' || src[i + 1] === '(') {
        const display = src[i + 1] === '[';
        const closer = display ? '\\]' : '\\)';
        const start = i + 2;
        const end = src.indexOf(closer, start);
        flush();
        nodes.push({
          type: 'math',
          display,
          env: null,
          body: src.slice(start, end === -1 ? src.length : end),
        });
        i = end === -1 ? src.length : end + closer.length;
        continue;
      }

      const cmd = readCommand(src, i);

      if (cmd.name === 'begin') {
        const nameArg = readArg(src, cmd.end);
        if (!nameArg) {
          i = cmd.end;
          continue;
        }
        const envName = nameArg.content.trim().replace(/\*$/, '');
        const starred = nameArg.content.trim().endsWith('*');
        flush();
        i = consumeEnvironment(src, nameArg.end, envName, starred, nodes);
        continue;
      }

      if (cmd.name === 'end') {
        // Unmatched \end: the body extractor already handled the matched ones.
        const nameArg = readArg(src, cmd.end);
        i = nameArg ? nameArg.end : cmd.end;
        continue;
      }

      flush();
      let j = cmd.end;

      if (DIMEN_COMMANDS.has(cmd.name)) {
        const dimen = DIMEN_RE.exec(src.slice(j));
        if (dimen) j += dimen[0].length;
        nodes.push({ type: 'command', name: cmd.name, star: false, opt: null, args: [] });
        i = j;
        continue;
      }

      const opt = readOptional(src, j);
      if (opt) j = opt.end;

      const arity = ARITY[cmd.name] ?? 0;
      /** @type {string[]} */
      const args = [];
      for (let k = 0; k < arity; k += 1) {
        const arg = readArg(src, j);
        if (!arg) break;
        args.push(arg.content);
        j = arg.end;
      }

      nodes.push({
        type: 'command',
        name: cmd.name,
        star: cmd.star,
        opt: opt ? opt.content : null,
        args,
      });
      i = j;
      continue;
    }

    text += ch;
    i += 1;
  }

  flush();
  return nodes;
}

/**
 * @param {string} src
 * @param {number} from index just past `\begin{name}`
 * @param {string} envName
 * @param {boolean} starred
 * @param {Node[]} out
 * @returns {number} index just past the matching `\end`
 */
function consumeEnvironment(src, from, envName, starred, out) {
  if (VERBATIM_ENVS.has(envName)) {
    const { body, end } = findEnvEnd(src, from, envName);
    out.push({ type: 'verbatim', name: envName, body: trimBlankEdges(body) });
    return end;
  }

  if (MATH_ENVS.has(envName)) {
    const { body, end } = findEnvEnd(src, from, envName);
    out.push({
      type: 'math',
      display: true,
      env: starred ? `${envName}*` : envName,
      body: trimBlankEdges(body),
    });
    return end;
  }

  // Ordinary environment: capture its own optional/mandatory arguments, then
  // recurse into the body.
  let j = from;
  const opt = readOptional(src, j);
  if (opt) j = opt.end;
  /** @type {string[]} */
  const args = [];
  if (envName === 'tabular' || envName === 'thebibliography' || envName === 'minipage') {
    const arg = readArg(src, j);
    if (arg) {
      args.push(arg.content);
      j = arg.end;
    }
  }

  const { body, end } = findEnvEnd(src, j, envName);
  out.push({
    type: 'env',
    name: starred ? `${envName}*` : envName,
    opt: opt ? opt.content : null,
    args,
    children: parse(body),
  });
  return end;
}

/**
 * Find `needle` at a position not preceded by a backslash escape.
 * @param {string} src
 * @param {number} from
 * @param {string} needle
 */
function findUnescaped(src, from, needle) {
  for (let i = from; i < src.length; i += 1) {
    if (src[i] === '\\') {
      i += 1;
      continue;
    }
    if (src.startsWith(needle, i)) return i;
  }
  return -1;
}

/** @param {string} s */
function trimBlankEdges(s) {
  return s.replace(/^[ \t]*\n/, '').replace(/\n[ \t]*$/, '');
}
