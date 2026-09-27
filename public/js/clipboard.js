/**
 * Copying text to the clipboard, including on plain HTTP.
 *
 * `navigator.clipboard` exists only in a secure context. Served over plain
 * HTTP from anything other than localhost — a LAN host or an internal VPN
 * name, which is a common way to host this — the modern API is simply absent,
 * and the deprecated `execCommand('copy')` path is the one that actually runs.
 * Both are kept, in that order.
 *
 * Note that `localhost` and `127.0.0.1` count as secure contexts, so the first
 * tier succeeds in local development and the fallback only shows up once
 * deployed. Verify it against the real host, not localhost.
 */

/**
 * @typedef {'clipboard-api'|'exec-command'|'manual'} CopyMethod
 * @typedef {{ok: boolean, method: CopyMethod}} CopyResult
 */

/**
 * @param {string} text
 * @param {HTMLTextAreaElement} [textarea] element holding the text, reused for
 *   the selection-based fallback so the user can finish the copy by hand
 * @returns {Promise<CopyResult>}
 */
export async function copyText(text, textarea) {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return { ok: true, method: 'clipboard-api' };
    } catch {
      // Permission denied or the document is not focused; fall through.
    }
  }

  if (selectAndCopy(text, textarea)) {
    return { ok: true, method: 'exec-command' };
  }

  // Leave the text selected so Ctrl+C finishes the job.
  if (textarea) {
    textarea.focus();
    textarea.select();
  }
  return { ok: false, method: 'manual' };
}

/**
 * @param {string} text
 * @param {HTMLTextAreaElement} [textarea]
 * @returns {boolean}
 */
function selectAndCopy(text, textarea) {
  const target = textarea ?? offscreenTextarea(text);
  const restore = textarea
    ? { start: textarea.selectionStart, end: textarea.selectionEnd }
    : null;

  try {
    target.focus({ preventScroll: true });
    target.select();
    // Deprecated, but the only synchronous copy available outside a secure
    // context. Still implemented by every current browser.
    const ok = document.execCommand('copy');
    if (restore) target.setSelectionRange(restore.start, restore.end);
    return ok;
  } catch {
    return false;
  } finally {
    if (!textarea) target.remove();
  }
}

/** @param {string} text */
function offscreenTextarea(text) {
  const el = document.createElement('textarea');
  el.value = text;
  el.setAttribute('readonly', '');
  el.style.position = 'fixed';
  el.style.top = '-1000px';
  el.style.opacity = '0';
  document.body.append(el);
  return el;
}

/**
 * Hand the user a file. Used for the "save as .md" button.
 * @param {string} text
 * @param {string} filename
 */
export function downloadText(text, filename) {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  // Give the browser a moment to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
