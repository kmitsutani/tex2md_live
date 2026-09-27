/**
 * Node tree -> Obsidian-flavoured Markdown.
 *
 * Two decisions drive most of this file:
 *
 *  - Typesetting is discarded, logical structure is kept. `\Large`, `\vspace`,
 *    `\baselineskip` and friends carry no information about what the paper
 *    says, so they go; sections, lists, floats and math stay.
 *  - Comments are preserved but classified, because a draft's `%` lines are a
 *    mix of decorative rules, disabled code and genuine co-author notes.
 *
 * Output targets stock Obsidian: MathJax for math, built-in callout types, and
 * `[^n]` footnotes. Obsidian's own `%%...%%` comment syntax is deliberately not
 * used — it hides content in reading view, which is the opposite of the goal.
 */

import { normaliseNewlines } from './decode.js';
import { extractComments } from './comments.js';
import { parse } from './parser.js';
import { collectMacros, expandMacros } from './macros.js';
import { shimMath } from './mathshim.js';
import { Diagnostics } from './diagnostics.js';

/** Private separators used while flattening a `tabular` body into cells. */
const ROW = '\u0001';
const CELL = '\u0002';

/** Heading depth per sectioning command. The paper title takes level 1. */
const HEADING_LEVEL = {
  part: 1, chapter: 1, section: 2, subsection: 3,
  subsubsection: 4, paragraph: 5, subparagraph: 6,
};

/**
 * Commands dropped outright, along with any arguments the parser attached.
 * These are typesetting instructions, not content.
 */
const DROP_COMMANDS = new Set([
  // size and family switches
  'Large', 'large', 'small', 'footnotesize', 'scriptsize', 'tiny', 'normalsize',
  'huge', 'Huge', 'bf', 'it', 'rm', 'sf', 'tt', 'sc', 'em', 'sl', 'normalfont',
  'bfseries', 'itshape', 'rmfamily', 'sffamily', 'ttfamily', 'scshape', 'upshape',
  'mdseries', 'boldmath', 'unboldmath',
  // spacing and page layout
  'baselineskip', 'vspace', 'hspace', 'hfill', 'vfill', 'hfil', 'vfil', 'smallskip',
  'medskip', 'bigskip', 'noindent', 'indent', 'setlength', 'addtolength',
  'thispagestyle', 'pagestyle', 'newpage', 'clearpage', 'cleardoublepage',
  'pagebreak', 'nopagebreak', 'linebreak', 'nolinebreak', 'centering',
  'raggedright', 'raggedleft', 'flushbottom', 'sloppy', 'protect', 'relax',
  'numberwithin', 'label', 'nonumber', 'notag', 'maketitle', 'tableofcontents',
  'listoffigures', 'listoftables', 'bibliographystyle', 'bibliography',
  // colour
  'color', 'textcolor', 'pagecolor', 'colorbox', 'definecolor',
  // table rules
  'hline', 'cline', 'toprule', 'midrule', 'bottomrule', 'rule', 'multicolumn',
  // preamble leftovers
  'documentclass', 'usepackage', 'newcommand', 'renewcommand', 'providecommand',
  'DeclareMathOperator', 'newtheorem', 'input', 'include', 'includeonly',
]);

/** Single-token substitutions in text mode. */
const SYMBOLS = {
  '%': '%', '&': '&', '#': '#', '{': '{', '}': '}',
  '_': '\\_', '$': '\\$',
  ' ': ' ', ',': ' ', ';': ' ', ':': ' ', '!': '',
  quad: ' ', qquad: '  ', enspace: ' ', thinspace: ' ',
  ldots: '…', dots: '…', cdots: '…', textellipsis: '…',
  TeX: 'TeX', LaTeX: 'LaTeX', LaTeXe: 'LaTeX2e',
  textbackslash: '\\', textasciitilde: '~', textasciicircum: '^',
  textbar: '|', textless: '<', textgreater: '>',
  copyright: '©', pounds: '£', dag: '†', ddag: '‡', S: '§', P: '¶',
};

/** Group-scoped font switches: `{\bf text}` bolds the rest of the group. */
const GROUP_SWITCHES = {
  bf: (s) => `**${s}**`, bfseries: (s) => `**${s}**`,
  it: (s) => `*${s}*`, itshape: (s) => `*${s}*`,
  em: (s) => `*${s}*`, sl: (s) => `*${s}*`,
  tt: (s) => `\`${s}\``, ttfamily: (s) => `\`${s}\``,
  // Size and family switches carry no meaning; pass the content through.
  Large: null, large: null, small: null, footnotesize: null, scriptsize: null,
  tiny: null, normalsize: null, huge: null, Huge: null, rm: null, sf: null,
  sc: null, rmfamily: null, sffamily: null, scshape: null, normalfont: null,
  boldmath: null, upshape: null, mdseries: null,
};

/** Environments contributing no structure: render their contents in place. */
const TRANSPARENT_ENVS = new Set([
  'center', 'flushleft', 'flushright', 'minipage', 'small', 'footnotesize',
  'large', 'Large', 'sloppypar', 'spacing', 'singlespace', 'doublespace',
  'subequations', 'samepage', 'em', 'normalsize',
]);

/** Theorem-like environments, mapped to an Obsidian callout type and label. */
const THEOREM_ENVS = {
  theorem: ['important', 'Theorem'],
  lemma: ['important', 'Lemma'],
  proposition: ['important', 'Proposition'],
  corollary: ['important', 'Corollary'],
  conjecture: ['important', 'Conjecture'],
  definition: ['info', 'Definition'],
  example: ['example', 'Example'],
  remark: ['note', 'Remark'],
  proof: ['quote', 'Proof'],
};

/** Math environments that must keep their own `\begin`/`\end` inside `$$`. */
const MULTILINE_MATH = new Set([
  'align', 'alignat', 'gather', 'multline', 'flalign', 'eqnarray',
  'split', 'cases', 'array', 'aligned', 'gathered',
]);

/**
 * @typedef {object} ConvertOptions
 * @property {'classified'|'notes'|'all'|'none'} [comments]
 * @property {boolean} [emphasis]
 * @property {boolean} [frontmatter]
 * @property {string} [filename]
 * @property {string} [encoding]
 * @property {boolean} [encodingFallback]
 */

/**
 * @param {string} source raw LaTeX
 * @param {ConvertOptions} [options]
 * @returns {{markdown: string, diagnostics: Diagnostics}}
 */
export function convert(source, options = {}) {
  const opts = /** @type {Required<ConvertOptions>} */ ({
    comments: 'classified',
    emphasis: true,
    frontmatter: true,
    filename: 'document.tex',
    ...options,
  });

  const diag = new Diagnostics();
  diag.encoding = opts.encoding ?? 'utf-8';
  diag.encodingFallback = Boolean(opts.encodingFallback);

  const text = normaliseNewlines(source);
  const { text: masked, comments } = extractComments(text);
  for (const c of comments) diag.commentCounts[c.kind] += 1;

  const docStart = masked.indexOf('\\begin{document}');
  const preamble = docStart === -1 ? '' : masked.slice(0, docStart);
  const body = docStart === -1 ? masked : masked.slice(docStart);
  const preambleLines = preamble.length === 0 ? 0 : preamble.split('\n').length;

  diag.packages = [...preamble.matchAll(/\\usepackage(?:\[[^\]]*\])?\{([^}]*)\}/g)]
    .flatMap((m) => m[1].split(',').map((s) => s.trim()))
    .filter(Boolean);

  const macros = collectMacros(preamble);

  // Expand user macros across the whole body, not just inside math. Papers
  // routinely define text macros for journal names (`\\newcommand{\\JPSJ}{J.
  // Phys. Soc. Jpn.\\ }`); leaving those to the command renderer would drop
  // them as unknown commands and silently lose the content.
  const nodes = parse(expandMacros(body, macros));

  // `\numberwithin{equation}{section}` is a preamble declaration, so it has to
  // be detected here rather than from the body node tree.
  const numberWithin = /\\numberwithin\s*\{\s*equation\s*\}\s*\{\s*section\s*\}/.test(preamble);

  const renderer = new Renderer(opts, diag, comments, macros);
  const markdown = renderer.run(nodes, { preambleLines, numberWithin });
  return { markdown, diagnostics: diag };
}

class Renderer {
  /**
   * @param {Required<ConvertOptions>} opts
   * @param {Diagnostics} diag
   * @param {import('./comments.js').TexComment[]} comments
   * @param {Map<string, import('./macros.js').Macro>} macros
   */
  constructor(opts, diag, comments, macros) {
    this.opts = opts;
    this.diag = diag;
    this.comments = comments;
    this.macros = macros;

    /** @type {Map<string, {kind: string, number: string|null}>} */
    this.labels = new Map();
    /** @type {Set<string>} */
    this.bibKeys = new Set();
    /** @type {string[]} */
    this.footnotes = [];
    /** @type {Set<object>} */
    this.consumed = new Set();
    /** @type {number[]} */
    this.pendingComments = [];

    this.section = 0;
    this.eqCounter = 0;
    this.numberWithinSection = false;
    this.pendingSectionLabel = null;
    this.title = null;
    this.authors = null;
  }

  /**
   * @param {import('./parser.js').Node[]} nodes
   * @param {{preambleLines: number, numberWithin?: boolean}} ctx
   */
  run(nodes, { preambleLines, numberWithin = false }) {
    this.numberWithinSection = numberWithin || hasNumberWithin(nodes);

    // Pass 1: number equations and collect labels and bibliography keys, so
    // that a \ref appearing before its \label still resolves.
    this.prescan(nodes);
    this.section = 0;
    this.eqCounter = 0;

    const documentNode = nodes.find(
      (n) => n.type === 'env' && n.name.replace(/\*$/, '') === 'document',
    );
    const top = documentNode ? documentNode.children : nodes;

    this.findTitleBlock(top);

    const blocks = this.renderBlocks(top);
    const out = [];

    if (this.opts.frontmatter) out.push(this.frontmatter());
    if (this.title) out.push(`# ${this.title}`);
    if (this.authors) out.push(`*${this.authors}*`);
    out.push(...blocks);

    if (this.footnotes.length > 0) {
      out.push('---');
      out.push(this.footnotes.map((t, i) => `[^${i + 1}]: ${t}`).join('\n'));
    }

    const preambleNotes = this.renderPreambleComments(preambleLines);
    if (preambleNotes) out.push(preambleNotes);

    return `${out.filter((b) => b && b.trim().length > 0).join('\n\n')}\n`;
  }

  frontmatter() {
    const lines = ['---'];
    if (this.title) lines.push(`title: ${yamlString(this.title)}`);
    if (this.authors) lines.push(`authors: ${yamlString(this.authors)}`);
    lines.push(`source: ${yamlString(this.opts.filename)}`);
    lines.push(`converted: ${new Date().toISOString().slice(0, 10)}`);
    if (this.diag.packages.length > 0) {
      lines.push(`tex_packages: [${this.diag.packages.join(', ')}]`);
    }
    lines.push('---');
    return lines.join('\n');
  }

  // ---------------------------------------------------------------- prescan

  /** @param {import('./parser.js').Node[]} nodes */
  prescan(nodes) {
    for (const n of nodes) {
      if (n.type === 'command') {
        if (HEADING_LEVEL[n.name] === 2 && !n.star) {
          this.section += 1;
          if (this.numberWithinSection) this.eqCounter = 0;
          this.pendingSectionLabel = String(this.section);
        } else if (n.name === 'label' && this.pendingSectionLabel) {
          this.labels.set(n.args[0]?.trim() ?? '', {
            kind: 'sec', number: this.pendingSectionLabel,
          });
          this.pendingSectionLabel = null;
        } else if (n.name === 'bibitem') {
          const key = n.args[0]?.trim();
          if (key) this.bibKeys.add(key);
        }
      } else if (n.type === 'math' && n.display) {
        this.numberMath(n);
      }
      if (n.children) this.prescan(n.children);
    }
  }

  /**
   * Emulate amsmath numbering closely enough for cross-references: every row of
   * a numbered multi-line environment that lacks `\nonumber` takes a number.
   * @param {import('./parser.js').Node} node
   */
  numberMath(node) {
    const numbered = Boolean(node.env) && !node.env.endsWith('*');
    const rows = node.body.split(/\\\\(?:\s*\[[^\]]*\])?/);

    for (const row of rows) {
      const labelsHere = [...row.matchAll(/\\label\{([^}]*)\}/g)].map((m) => m[1].trim());
      const skip = /\\(nonumber|notag)\b/.test(row) || !numbered;
      let number = null;
      if (!skip) {
        this.eqCounter += 1;
        number = this.numberWithinSection
          ? `${this.section}.${this.eqCounter}`
          : String(this.eqCounter);
      }
      for (const key of labelsHere) this.labels.set(key, { kind: 'eq', number });
    }
  }

  /**
   * Hand-rolled drafts often put the title in `\begin{center}{\Large\bf ...}`
   * rather than `\title`. Recover it so the document gets a real H1 instead of
   * burying the title in body text.
   * @param {import('./parser.js').Node[]} top
   */
  findTitleBlock(top) {
    const titleCmd = findCommand(top, 'title');
    if (titleCmd) {
      this.title = this.plainText(titleCmd.args[0] ?? '');
      const authorCmd = findCommand(top, 'author');
      if (authorCmd) this.authors = this.plainText(authorCmd.args[0] ?? '');
      return;
    }

    for (const n of top) {
      if (n.type === 'command' && HEADING_LEVEL[n.name]) return;
      if (n.type !== 'env' || n.name.replace(/\*$/, '') !== 'center') continue;

      const texts = n.children
        .filter((c) => c.type === 'group')
        .map((c) => this.plainNodes(c.children))
        .filter((s) => s.length > 0);
      if (texts.length === 0) continue;

      this.title = texts[0];
      this.authors = texts[1] ?? null;
      this.consumed.add(n);
      this.diag.note(
        '\\title が無いため \\begin{center} の先頭から題名と著者を推定しました。',
      );
      return;
    }
  }

  // ----------------------------------------------------------------- blocks

  /**
   * @param {import('./parser.js').Node[]} nodes
   * @returns {string[]}
   */
  renderBlocks(nodes) {
    /** @type {string[]} */
    const blocks = [];
    /** @type {import('./parser.js').Node[]} */
    let inline = [];

    const flush = () => {
      if (inline.length > 0) {
        const s = tidy(this.renderInline(inline));
        if (s.length > 0) blocks.push(s);
        inline = [];
      }
      for (const block of this.drainPendingComments()) blocks.push(block);
    };

    for (let i = 0; i < nodes.length; i += 1) {
      const n = nodes[i];
      if (this.consumed.has(n)) continue;

      if (n.type === 'par') {
        flush();
        continue;
      }

      if (n.type === 'math' && n.display) {
        flush();
        const { block, hoisted } = this.displayMath(n);
        blocks.push(block);
        this.pendingComments.push(...hoisted);
        for (const b of this.drainPendingComments()) blocks.push(b);
        continue;
      }

      if (n.type === 'verbatim') {
        flush();
        blocks.push(fence(n.body, ''));
        continue;
      }

      if (n.type === 'env') {
        flush();
        blocks.push(...this.renderEnv(n));
        continue;
      }

      if (n.type === 'command') {
        const level = HEADING_LEVEL[n.name];
        if (level) {
          flush();
          if (level === 2 && !n.star) this.section += 1;
          const title = this.renderInline(parse(n.args[0] ?? '')).trim();
          blocks.push(`${'#'.repeat(level)} ${title}`);
          continue;
        }

        if (n.name === 'TPC') {
          const comment = this.comments[Number(n.args[0])];
          if (comment && !comment.inline) {
            const run = this.collectCommentRun(nodes, i);
            flush();
            const block = this.renderCommentBlock(run.kind, run.lines);
            if (block) blocks.push(block);
            i = run.lastIndex;
            continue;
          }
        }
      }

      inline.push(n);
    }

    flush();
    return blocks;
  }

  /**
   * Gather a run of same-kind comments on consecutive lines so a commented-out
   * `figure` becomes one block instead of six.
   * @param {import('./parser.js').Node[]} nodes
   * @param {number} start
   */
  collectCommentRun(nodes, start) {
    const first = this.comments[Number(nodes[start].args[0])];
    const lines = [first.text];
    let lastLine = first.line;
    let lastIndex = start;

    for (let j = start + 1; j < nodes.length; j += 1) {
      const n = nodes[j];
      if (n.type === 'text' && /^\s*$/.test(n.value)) continue;
      if (n.type !== 'command' || n.name !== 'TPC') break;
      const c = this.comments[Number(n.args[0])];
      if (!c || c.inline || c.kind !== first.kind || c.line !== lastLine + 1) break;
      lines.push(c.text);
      lastLine = c.line;
      lastIndex = j;
    }

    return { kind: first.kind, lines, lastIndex };
  }

  /**
   * @param {string} kind
   * @param {string[]} lines
   * @returns {string}
   */
  renderCommentBlock(kind, lines) {
    const mode = this.opts.comments;
    if (mode === 'none') return '';
    if (mode === 'notes' && kind !== 'note') return '';
    if (mode === 'classified' && (kind === 'decoration' || kind === 'banner')) return '';

    const text = lines.join('\n').trim();
    if (text.length === 0) return '';

    if (kind === 'code') {
      return [
        '> [!example]- コメントアウトされた TeX',
        '> ```latex',
        ...lines.map((l) => `> ${l}`),
        '> ```',
      ].join('\n');
    }

    const label = kind === 'note' ? 'コメント'
      : kind === 'banner' ? 'バナー'
        : '飾り罫';
    return [`> [!note] ${label}`, ...lines.map((l) => `> ${l}`)].join('\n');
  }

  /** Comments hoisted out of math bodies, emitted after the equation. */
  drainPendingComments() {
    if (this.pendingComments.length === 0) return [];
    const ids = this.pendingComments;
    this.pendingComments = [];
    /** @type {string[]} */
    const out = [];
    let run = [];
    let kind = null;
    let lastLine = -2;

    for (const id of ids) {
      const c = this.comments[id];
      if (!c) continue;
      if (kind === c.kind && c.line === lastLine + 1) {
        run.push(c.text);
      } else {
        if (kind) {
          const b = this.renderCommentBlock(kind, run);
          if (b) out.push(b);
        }
        kind = c.kind;
        run = [c.text];
      }
      lastLine = c.line;
    }
    if (kind) {
      const b = this.renderCommentBlock(kind, run);
      if (b) out.push(b);
    }
    return out;
  }

  /** @param {number} preambleLines */
  renderPreambleComments(preambleLines) {
    if (this.opts.comments === 'none' || preambleLines === 0) return '';
    const relevant = this.comments.filter(
      (c) => c.line <= preambleLines &&
        (c.kind === 'note' || (c.kind === 'code' && this.opts.comments !== 'notes')),
    );
    if (relevant.length === 0) return '';

    const lines = relevant.map((c) => `> - L${c.line}: \`${c.text}\``);
    return [
      '> [!abstract]- プリアンブルのコメント（本文には現れません）',
      ...lines,
    ].join('\n');
  }

  // -------------------------------------------------------------- environments

  /**
   * @param {import('./parser.js').Node} n
   * @returns {string[]}
   */
  renderEnv(n) {
    const base = n.name.replace(/\*$/, '');

    switch (base) {
      case 'document':
        return this.renderBlocks(n.children);
      case 'abstract':
        return ['## Abstract', ...this.renderBlocks(n.children)];
      case 'itemize':
      case 'enumerate':
      case 'description':
        return [this.renderList(n, base)];
      case 'figure':
      case 'wrapfigure':
      case 'table':
        return [this.renderFloat(n, base === 'table' ? '表' : '図')];
      case 'tabular':
      case 'tabularx':
      case 'longtable':
        return [this.renderTable(n)];
      case 'thebibliography':
        return this.renderBibliography(n);
      case 'quote':
      case 'quotation':
      case 'verse':
        return [blockquote(this.renderBlocks(n.children).join('\n\n'))];
      default:
        break;
    }

    if (THEOREM_ENVS[base]) {
      const [type, label] = THEOREM_ENVS[base];
      const title = n.opt ? `${label} (${this.plainText(n.opt)})` : label;
      const body = this.renderBlocks(n.children).join('\n\n');
      return [[`> [!${type}] ${title}`, ...body.split('\n').map((l) => `> ${l}`)].join('\n')];
    }

    if (!TRANSPARENT_ENVS.has(base)) this.diag.droppedEnvironment(base);
    return this.renderBlocks(n.children);
  }

  /**
   * @param {import('./parser.js').Node} n
   * @param {string} base
   */
  renderList(n, base) {
    const items = splitOnCommand(n.children, 'item');
    const lines = [];

    items.forEach((item, idx) => {
      const bullet = base === 'enumerate' ? `${idx + 1}.` : '-';
      const label = base === 'description' && item.opt
        ? `**${this.renderInline(parse(item.opt)).trim()}**: `
        : '';
      const body = this.renderBlocks(item.nodes).join('\n\n');
      const indented = body
        .split('\n')
        .map((l, i) => (i === 0 ? l : `  ${l}`))
        .join('\n');
      const line = `${bullet} ${label}${indented}`.trimEnd();
      if (line !== bullet) lines.push(line);
    });

    return lines.join('\n');
  }

  /**
   * Figures cannot be reproduced, but the caption and the image filename are
   * exactly what a reader needs to know the figure exists and what it shows.
   * @param {import('./parser.js').Node} n
   * @param {string} kindLabel
   */
  renderFloat(n, kindLabel) {
    const caption = findCommand(n.children, 'caption');
    const graphics = collectCommands(n.children, 'includegraphics');
    const label = findCommand(n.children, 'label');

    const head = caption
      ? `> [!info] ${kindLabel}: ${this.renderInline(parse(caption.args[0] ?? '')).trim()}`
      : `> [!info] ${kindLabel}`;
    const lines = [head];

    for (const g of graphics) lines.push(`> ファイル: \`${(g.args[0] ?? '').trim()}\``);
    if (label) lines.push(`> ラベル: \`${(label.args[0] ?? '').trim()}\``);

    const rest = this.renderBlocks(
      n.children.filter(
        (c) => !(c.type === 'command' &&
          ['caption', 'includegraphics', 'label', 'centering'].includes(c.name)),
      ),
    ).join('\n\n');
    if (rest.trim().length > 0) {
      lines.push('>');
      lines.push(...rest.split('\n').map((l) => `> ${l}`));
    }

    return lines.join('\n');
  }

  /** @param {import('./parser.js').Node} n */
  renderTable(n) {
    const raw = this.renderInline(n.children, { table: true });
    const rows = raw
      .split(ROW)
      .map((r) => r.trim())
      .filter((r) => r.split(CELL).join('').trim().length > 0);
    if (rows.length === 0) return '';

    const cells = rows.map((r) =>
      r.split(CELL).map((c) => c.trim().replace(/\|/g, '\\|')),
    );
    const width = Math.max(...cells.map((r) => r.length));
    const pad = (r) => [...r, ...Array(width - r.length).fill('')];

    const [header, ...body] = cells;
    return [
      `| ${pad(header).join(' | ')} |`,
      `| ${Array(width).fill('---').join(' | ')} |`,
      ...body.map((r) => `| ${pad(r).join(' | ')} |`),
    ].join('\n');
  }

  /** @param {import('./parser.js').Node} n */
  renderBibliography(n) {
    const entries = splitOnCommand(n.children, 'bibitem');
    const lines = [];

    for (const entry of entries) {
      const key = (entry.arg ?? '').trim();
      if (!key) continue;
      const text = tidy(
        this.renderInline(entry.nodes).replace(/\s+/g, ' '),
      );
      lines.push(`- **[${key}]** ${text}`);
    }

    if (lines.length === 0) return [];
    return ['## References', lines.join('\n')];
  }

  // ------------------------------------------------------------------ inline

  /**
   * @param {import('./parser.js').Node[]} nodes
   * @param {{table?: boolean, plain?: boolean}} [ctx]
   * @returns {string}
   */
  renderInline(nodes, ctx = {}) {
    let out = '';
    for (const n of nodes) {
      if (this.consumed.has(n)) continue;
      switch (n.type) {
        case 'text':
          out += this.renderText(n.value, ctx);
          break;
        case 'par':
          out += '\n\n';
          break;
        case 'group':
          out += this.renderGroup(n.children, ctx);
          break;
        case 'math':
          out += this.inlineMath(n);
          break;
        case 'verbatim':
          out += `\`${n.body.replace(/\s+/g, ' ').trim()}\``;
          break;
        case 'env':
          out += this.renderEnv(n).join('\n\n');
          break;
        case 'command':
          out += this.renderCommand(n, ctx);
          break;
        default:
          break;
      }
    }
    return out;
  }

  /**
   * A font switch applies to the remainder of its enclosing group, which is how
   * `{\bf Author Name}` works. Switches outside a group are ignored rather than
   * applied to the rest of the document — drafts often carry a stray
   * `\Large\bf` immediately after `\begin{document}`.
   * @param {import('./parser.js').Node[]} children
   * @param {{table?: boolean, plain?: boolean}} ctx
   */
  renderGroup(children, ctx) {
    let out = '';
    for (let i = 0; i < children.length; i += 1) {
      const n = children[i];
      if (n.type === 'command' && Object.hasOwn(GROUP_SWITCHES, n.name)) {
        const wrap = GROUP_SWITCHES[n.name];
        const rest = this.renderGroup(children.slice(i + 1), ctx);
        if (!wrap || !this.opts.emphasis || ctx.plain || rest.trim().length === 0) {
          return out + rest;
        }
        // Keep surrounding whitespace outside the emphasis markers.
        const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(rest);
        return `${out}${m[1]}${wrap(m[2])}${m[3]}`;
      }
      out += this.renderInline([n], ctx);
    }
    return out;
  }

  /**
   * @param {string} value
   * @param {{table?: boolean, plain?: boolean}} ctx
   */
  renderText(value, ctx) {
    let s = value;

    // The author's hard wrapping is not meaningful; collapse it so paragraphs
    // reflow. Real line breaks arrive as `\\` command nodes instead.
    s = s.replace(/[ \t]*\n[ \t]*/g, ' ');

    s = s.replace(/``/g, '“').replace(/''/g, '”');
    s = s.replace(/---/g, '—').replace(/--/g, '–');
    s = s.replace(/~/g, ' ');

    // Escape the few characters that would otherwise be Markdown syntax.
    s = s.replace(/([*`<>])/g, '\\$1');

    if (ctx.table) s = s.replace(/&/g, CELL);
    return s;
  }

  /** @param {import('./parser.js').Node} n */
  inlineMath(n) {
    let body = expandMacros(n.body, this.macros);
    body = body.replace(/\\TPC\{(\d+)\}/g, (_, id) => {
      this.pendingComments.push(Number(id));
      return '';
    });
    body = body.replace(/\\label\{[^}]*\}/g, '');
    body = shimMath(body).replace(/\s+/g, ' ').trim();
    if (body.length === 0) return '';
    return `$${body}$`;
  }

  /**
   * @param {import('./parser.js').Node} n
   * @returns {{block: string, hoisted: number[]}}
   */
  displayMath(n) {
    /** @type {number[]} */
    const hoisted = [];
    let body = expandMacros(n.body, this.macros);

    body = body.replace(/\\TPC\{(\d+)\}/g, (_, id) => {
      hoisted.push(Number(id));
      return '';
    });

    // A label becomes a \tag so the number the text refers to is visible.
    body = body.replace(/\\label\{([^}]*)\}/g, (_, key) => {
      const number = this.labels.get(key.trim())?.number;
      return number ? `\\tag{${number}}` : '';
    });

    body = shimMath(body).replace(/[ \t]+$/gm, '').trim();

    let env = n.env;
    if (env === 'eqnarray' || env === 'eqnarray*') {
      this.diag.note('eqnarray は MathJax 互換のため align に置き換えました。');
      env = env.endsWith('*') ? 'align*' : 'align';
    }

    const base = env ? env.replace(/\*$/, '') : null;
    const inner = base && MULTILINE_MATH.has(base)
      ? `\\begin{${env}}\n${body}\n\\end{${env}}`
      : body;

    return { block: `$$\n${inner}\n$$`, hoisted };
  }

  /**
   * @param {import('./parser.js').Node} n
   * @param {{table?: boolean, plain?: boolean}} ctx
   */
  renderCommand(n, ctx) {
    const name = n.name;

    if (name === 'TPC') {
      const c = this.comments[Number(n.args[0])];
      if (!c) return '';
      if (!c.inline) {
        // A block comment reached inline context (inside a paragraph); keep it
        // by deferring it to just after this paragraph.
        this.pendingComments.push(c.id);
        return '';
      }
      if (this.opts.comments === 'none') return '';
      if (this.opts.comments === 'notes' && c.kind !== 'note') return '';
      if (this.opts.comments === 'classified' &&
          (c.kind === 'decoration' || c.kind === 'banner')) return '';
      return ` \`% ${c.text}\``;
    }

    if (name === '\\') return ctx.table ? ROW : '  \n';
    if (Object.hasOwn(SYMBOLS, name)) return SYMBOLS[name];
    if (DROP_COMMANDS.has(name)) return '';

    switch (name) {
      case 'emph':
      case 'textit':
      case 'textsl':
        return this.wrap(n.args[0], (s) => `*${s}*`, ctx);
      case 'textbf':
        return this.wrap(n.args[0], (s) => `**${s}**`, ctx);
      case 'underline':
      case 'uline':
        return this.wrap(n.args[0], (s) => `==${s}==`, ctx);
      case 'sout':
        return this.wrap(n.args[0], (s) => `~~${s}~~`, ctx);
      case 'texttt':
        return `\`${this.plainText(n.args[0] ?? '')}\``;
      case 'text':
      case 'mbox':
      case 'hbox':
      case 'fbox':
      case 'textnormal':
      case 'textrm':
      case 'textsf':
      case 'textsc':
      case 'textup':
        return this.renderInline(parse(n.args[0] ?? ''), ctx);

      case 'title':
      case 'author':
      case 'date':
      case 'thanks':
        return '';

      case 'footnote':
      case 'footnotetext': {
        const text = this.renderInline(parse(n.args[0] ?? ''), ctx)
          .replace(/\s*\n\s*/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        this.footnotes.push(text);
        return `[^${this.footnotes.length}]`;
      }

      case 'cite':
      case 'citep':
      case 'citet': {
        const keys = (n.args[0] ?? '').split(',').map((k) => k.trim()).filter(Boolean);
        for (const k of keys) {
          if (this.bibKeys.size > 0 && !this.bibKeys.has(k)) {
            this.diag.unresolvedCites.add(k);
          }
        }
        return keys.length > 0 ? `[${keys.join(', ')}]` : '';
      }

      case 'ref':
      case 'eqref':
      case 'pageref':
      case 'autoref':
      case 'cref':
      case 'Cref': {
        const key = (n.args[0] ?? '').trim();
        const found = this.labels.get(key);
        if (!found || !found.number) {
          this.diag.unresolvedRefs.add(key);
          return `(?${key})`;
        }
        // Follow LaTeX: \\ref yields a bare number because the author supplies
        // any surrounding parentheses, while \\eqref supplies its own. Emitting
        // parentheses from \\ref turns the common `(\\ref{x})` into `((3.5))`.
        if (name === 'eqref') return `(${found.number})`;
        if (name === 'ref' || name === 'pageref') return found.number;
        return found.kind === 'sec' ? `§${found.number}` : `式 (${found.number})`;
      }

      case 'url':
        return `<${(n.args[0] ?? '').trim()}>`;
      case 'href':
        return `[${this.renderInline(parse(n.args[1] ?? ''), ctx)}](${(n.args[0] ?? '').trim()})`;

      case 'scalebox':
      case 'rotatebox':
      case 'raisebox':
        return this.renderInline(parse(n.args[1] ?? ''), ctx);
      case 'resizebox':
        return this.renderInline(parse(n.args[2] ?? ''), ctx);
      case 'reflectbox':
        return this.renderInline(parse(n.args[0] ?? ''), ctx);

      case 'includegraphics':
        return `（図: \`${(n.args[0] ?? '').trim()}\`）`;
      case 'caption':
        return this.renderInline(parse(n.args[0] ?? ''), ctx);

      case 'item':
      case 'bibitem':
        return '';

      case 'today':
        return new Date().toISOString().slice(0, 10);

      default:
        if (/^[a-zA-Z]+$/.test(name)) this.diag.unknownCommand(name);
        return '';
    }
  }

  /**
   * @param {string|undefined} raw
   * @param {(s: string) => string} wrapper
   * @param {{table?: boolean, plain?: boolean}} ctx
   */
  wrap(raw, wrapper, ctx) {
    const inner = this.renderInline(parse(raw ?? ''), ctx);
    if (inner.trim().length === 0) return '';
    if (!this.opts.emphasis || ctx.plain) return inner;
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
    return `${m[1]}${wrapper(m[2])}${m[3]}`;
  }

  /** @param {string} raw */
  plainText(raw) {
    return this.plainNodes(parse(raw));
  }

  /** @param {import('./parser.js').Node[]} nodes */
  plainNodes(nodes) {
    return this.renderInline(nodes, { plain: true })
      .replace(/\\([*`<>_$])/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  }
}

// ------------------------------------------------------------------ helpers

/** @param {import('./parser.js').Node[]} nodes */
function hasNumberWithin(nodes) {
  for (const n of nodes) {
    if (n.type === 'command' && n.name === 'numberwithin') return true;
    if (n.children && hasNumberWithin(n.children)) return true;
  }
  return false;
}

/**
 * Shallow search for a command among a node list.
 * @param {import('./parser.js').Node[]} nodes
 * @param {string} name
 */
function findCommand(nodes, name) {
  for (const n of nodes) {
    if (n.type === 'command' && n.name === name) return n;
    if (n.type === 'group' || n.type === 'env') {
      const found = findCommand(n.children, name);
      if (found) return found;
    }
  }
  return null;
}

/**
 * @param {import('./parser.js').Node[]} nodes
 * @param {string} name
 */
function collectCommands(nodes, name) {
  const out = [];
  for (const n of nodes) {
    if (n.type === 'command' && n.name === name) out.push(n);
    if (n.type === 'group' || n.type === 'env') out.push(...collectCommands(n.children, name));
  }
  return out;
}

/**
 * Split a node list at each occurrence of a delimiting command, keeping that
 * command's optional and first mandatory argument with the chunk it opens.
 * @param {import('./parser.js').Node[]} nodes
 * @param {string} name
 * @returns {{opt: string|null, arg: string|null, nodes: import('./parser.js').Node[]}[]}
 */
function splitOnCommand(nodes, name) {
  const out = [];
  let current = null;
  for (const n of nodes) {
    if (n.type === 'command' && n.name === name) {
      current = { opt: n.opt, arg: n.args[0] ?? null, nodes: [] };
      out.push(current);
      continue;
    }
    if (current) current.nodes.push(n);
  }
  return out;
}

/** @param {string} body @param {string} lang */
function fence(body, lang) {
  return `\`\`\`${lang}\n${body}\n\`\`\``;
}

/** @param {string} text */
function blockquote(text) {
  return text.split('\n').map((l) => `> ${l}`).join('\n');
}

/**
 * Final cosmetic pass over a rendered paragraph.
 *
 * `\\` emits a two-space hard break, which must survive; what should not
 * survive is the indentation the source had after it, or the gap a trailing
 * space inside `{\it text }` leaves between the emphasis marker and the comma
 * that follows it.
 * @param {string} s
 */
function tidy(s) {
  return s
    .replace(/ {2}\n[ \t]+/g, '  \n')
    .replace(/ +(`% )/g, ' $1')
    .replace(/(\*{1,2}|==|~~) +([,.;:!?)\]])/g, '$1$2')
    .replace(/([([\u201c"]) +(\*{1,2}|==|~~)/g, '$1$2')
    .trim();
}

/** @param {string} s */
function yamlString(s) {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
