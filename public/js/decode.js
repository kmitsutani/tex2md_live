/**
 * Byte-level decoding of .tex files.
 *
 * Old Japanese LaTeX drafts are frequently Shift_JIS or EUC-JP rather than
 * UTF-8, so we probe encodings instead of assuming. TextDecoder is available
 * both in browsers and in Node, so this module stays environment-agnostic.
 */

/** Encodings tried in order. UTF-8 first: it fails loudly on invalid bytes. */
const CANDIDATES = ['utf-8', 'shift_jis', 'euc-jp'];

/**
 * Heuristic score for "this decode looks like real text".
 * U+FFFD is what a non-fatal decoder emits for bytes it cannot map.
 * @param {string} text
 * @returns {number} count of replacement characters
 */
function replacementCount(text) {
  let n = 0;
  for (const ch of text) if (ch === '�') n += 1;
  return n;
}

/**
 * Decode raw file bytes into a string, reporting which encoding won.
 * @param {ArrayBuffer|Uint8Array} bytes
 * @returns {{text: string, encoding: string, fallback: boolean}}
 */
export function decodeTex(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

  for (const encoding of CANDIDATES) {
    try {
      // fatal:true makes the decoder throw rather than silently mangle,
      // which is exactly the signal we want for "wrong encoding".
      const text = new TextDecoder(encoding, { fatal: true }).decode(buf);
      return { text: stripBom(text), encoding, fallback: encoding !== 'utf-8' };
    } catch {
      // try the next candidate
    }
  }

  // Nothing decoded cleanly. Take whichever candidate mangles the least.
  let best = { text: '', encoding: CANDIDATES[0], score: Infinity };
  for (const encoding of CANDIDATES) {
    const text = new TextDecoder(encoding).decode(buf);
    const score = replacementCount(text);
    if (score < best.score) best = { text, encoding, score };
  }
  return { text: stripBom(best.text), encoding: best.encoding, fallback: true };
}

/** @param {string} text */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Normalise line endings so downstream line-oriented passes see only "\n".
 * @param {string} text
 */
export function normaliseNewlines(text) {
  return text.replace(/\r\n?/g, '\n');
}
