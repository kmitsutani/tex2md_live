/**
 * Comment extraction and classification.
 *
 * This pass runs BEFORE tokenising, because `%` comments are a lexical feature
 * of TeX that can appear anywhere, including in the middle of a math body.
 *
 * Real drafts mix three very different things behind `%`:
 *   - decorative rules and banner boxes (`%%%%%%%%%%`) — pure noise
 *   - commented-out LaTeX (a disabled `figure`, an unused `\usepackage`)
 *   - prose notes written by a co-author — the whole reason we keep comments
 *
 * Emitting all three the same way makes the output unreadable, so each comment
 * is classified and the renderer decides what to do per class.
 *
 * Each extracted comment leaves a `\TPC{n}` sentinel behind in the source so
 * that the parser preserves its structural position; the renderer turns that
 * sentinel back into a callout (or drops it).
 */

/** Environments whose bodies are verbatim: `%` there is a literal character. */
const VERBATIM_ENVS = ['verbatim', 'Verbatim', 'lstlisting', 'minted', 'alltt'];

export const SENTINEL_COMMAND = 'TPC';

/**
 * @typedef {'decoration'|'banner'|'code'|'note'} CommentKind
 * @typedef {object} TexComment
 * @property {number} id     index into the returned table
 * @property {number} line   1-based source line
 * @property {CommentKind} kind
 * @property {string} text   comment content, stripped of `%` padding
 * @property {string} raw    comment content exactly as written
 * @property {boolean} inline true when code preceded it on the same line
 */

/**
 * Find the first `%` on a line that actually starts a comment.
 * A `%` is escaped when preceded by an odd number of backslashes (`\%`), and
 * is literal inside a `\verb` span.
 * @param {string} line
 * @returns {{code: string, comment: string|null}}
 */
export function splitLine(line) {
  let i = 0;
  while (i < line.length) {
    // Skip over \verb<delim>...<delim>, where % is literal.
    const verb = /^\\verb\*?(.)/.exec(line.slice(i));
    if (verb) {
      const delim = verb[1];
      const close = line.indexOf(delim, i + verb[0].length);
      i = close === -1 ? line.length : close + 1;
      continue;
    }

    if (line[i] === '%') {
      let backslashes = 0;
      for (let j = i - 1; j >= 0 && line[j] === '\\'; j -= 1) backslashes += 1;
      if (backslashes % 2 === 0) {
        return { code: line.slice(0, i), comment: line.slice(i + 1) };
      }
    }
    i += 1;
  }
  return { code: line, comment: null };
}

/**
 * Decide what sort of comment this is.
 * @param {string} raw text following the `%`, verbatim
 * @returns {{kind: CommentKind, text: string}}
 */
export function classify(raw) {
  const body = raw.replace(/^%+/, '').replace(/%+\s*$/, '').trim();

  // No letters and no digits at all: a rule, a box edge, or an empty `%`.
  if (!/[\p{L}\p{N}]/u.test(body)) return { kind: 'decoration', text: body };

  // A short label fenced by `%%%` on both sides is a banner box heading.
  // The real structure comes from the TeX itself, so these duplicate it.
  const banner = /^%*\s*([^%\s][^%]*?)\s*%{2,}\s*$/.exec(raw);
  if (banner && banner[1].trim().split(/\s+/).length <= 4) {
    return { kind: 'banner', text: banner[1].trim() };
  }

  if (looksLikeLatex(body)) return { kind: 'code', text: body };
  return { kind: 'note', text: body };
}

/** @param {string} body */
function looksLikeLatex(body) {
  return (
    body.startsWith('\\') ||
    body.startsWith('{\\') ||
    /^[{}]+$/.test(body) ||
    /\\(begin|end)\{/.test(body)
  );
}

/**
 * Strip comments out of a source, leaving `\TPC{n}` sentinels in their place.
 * @param {string} text source with normalised newlines
 * @returns {{text: string, comments: TexComment[]}}
 */
export function extractComments(text) {
  const lines = text.split('\n');
  /** @type {TexComment[]} */
  const comments = [];
  /** @type {string[]} */
  const out = [];

  let verbatimEnv = null;

  for (let n = 0; n < lines.length; n += 1) {
    const line = lines[n];

    if (verbatimEnv) {
      out.push(line);
      if (new RegExp(`\\\\end\\{${verbatimEnv}\\*?\\}`).test(line)) verbatimEnv = null;
      continue;
    }
    const opens = new RegExp(`\\\\begin\\{(${VERBATIM_ENVS.join('|')})\\*?\\}`).exec(line);
    if (opens) {
      verbatimEnv = opens[1];
      out.push(line);
      continue;
    }

    const { code, comment } = splitLine(line);
    if (comment === null) {
      out.push(line);
      continue;
    }

    const { kind, text: body } = classify(comment);
    const id = comments.length;
    comments.push({
      id,
      line: n + 1,
      kind,
      text: body,
      raw: comment,
      inline: code.trim().length > 0,
    });
    out.push(`${code}\\${SENTINEL_COMMAND}{${id}}`);
  }

  return { text: out.join('\n'), comments };
}

/**
 * Merge a run of comments of the same kind on consecutive lines into one block,
 * so a commented-out `figure` renders as a single code block rather than six.
 * @param {TexComment[]} comments
 * @returns {{kind: CommentKind, startLine: number, endLine: number, lines: string[], ids: number[]}[]}
 */
export function groupComments(comments) {
  const blocks = [];
  for (const c of comments) {
    const last = blocks[blocks.length - 1];
    if (last && last.kind === c.kind && c.line === last.endLine + 1 && !c.inline) {
      last.endLine = c.line;
      last.lines.push(c.text);
      last.ids.push(c.id);
      continue;
    }
    blocks.push({
      kind: c.kind,
      startLine: c.line,
      endLine: c.line,
      lines: [c.text],
      ids: [c.id],
    });
  }
  return blocks;
}
