/**
 * UI wiring for tex2md_live.
 *
 * Everything runs in the browser: a dropped .tex is read with FileReader,
 * converted in-process, and never uploaded. That matters because the intended
 * input is an unpublished collaborative draft.
 */

import { decodeTex, normaliseNewlines } from './decode.js';
import { splitLine, classify } from './comments.js';
import { convert } from './markdown.js';
import { copyText, downloadText } from './clipboard.js';

const el = {
  texPane: document.getElementById('tex-pane'),
  out: /** @type {HTMLTextAreaElement} */ (document.getElementById('md-out')),
  sourceMeta: document.getElementById('source-meta'),
  copy: /** @type {HTMLButtonElement} */ (document.getElementById('copy')),
  copyStatus: document.getElementById('copy-status'),
  download: /** @type {HTMLButtonElement} */ (document.getElementById('download')),
  pick: document.getElementById('pick'),
  file: /** @type {HTMLInputElement} */ (document.getElementById('file')),
  dropzone: document.getElementById('dropzone'),
  diag: /** @type {HTMLDetailsElement} */ (document.getElementById('diag')),
  diagBody: document.getElementById('diag-body'),
  diagBadge: document.getElementById('diag-badge'),
  notice: document.getElementById('notice'),
  noticeText: document.getElementById('notice-text'),
  noticeOk: document.getElementById('notice-ok'),
  noticeCancel: document.getElementById('notice-cancel'),
  optComments: /** @type {HTMLSelectElement} */ (document.getElementById('opt-comments')),
  optEmphasis: /** @type {HTMLInputElement} */ (document.getElementById('opt-emphasis')),
  optFrontmatter: /** @type {HTMLInputElement} */ (document.getElementById('opt-frontmatter')),
};

/** Current document state. */
const state = {
  /** @type {string|null} */ source: null,
  filename: 'document.tex',
  encoding: 'utf-8',
  encodingFallback: false,
  /** Set once the user types in the output pane. */
  dirty: false,
};

// --------------------------------------------------------------- conversion

function currentOptions() {
  return {
    comments: /** @type {'classified'|'notes'|'all'|'none'} */ (el.optComments.value),
    emphasis: el.optEmphasis.checked,
    frontmatter: el.optFrontmatter.checked,
    filename: state.filename,
    encoding: state.encoding,
    encodingFallback: state.encodingFallback,
  };
}

/** Convert the loaded source and replace the output pane. */
function render() {
  if (state.source === null) return;

  const { markdown, diagnostics } = convert(state.source, currentOptions());
  el.out.value = markdown;
  state.dirty = false;

  el.copy.disabled = false;
  el.download.disabled = false;
  showDiagnostics(diagnostics);
  setCopyStatus('');
}

/**
 * Load a new source document. A new file is an unambiguous replacement, so it
 * overwrites any edits without prompting.
 * @param {ArrayBuffer} bytes
 * @param {string} filename
 */
function loadSource(bytes, filename) {
  const { text, encoding, fallback } = decodeTex(bytes);
  state.source = text;
  state.filename = filename;
  state.encoding = encoding;
  state.encodingFallback = fallback;

  renderSourcePane(text);
  hideNotice();
  render();
}

// -------------------------------------------------------------- source pane

/**
 * Show the original TeX with line numbers, tinting comments by the class the
 * converter assigned them. Seeing which `%` lines counted as prose notes versus
 * decoration is the fastest way to tell whether the output dropped anything.
 * @param {string} text
 */
function renderSourcePane(text) {
  const lines = normaliseNewlines(text).split('\n');
  const frag = document.createDocumentFragment();

  for (const line of lines) {
    const row = document.createElement('div');
    row.className = 'tex-line';

    const { code, comment } = splitLine(line);
    const codeSpan = document.createElement('span');
    codeSpan.textContent = code;
    row.append(codeSpan);

    if (comment !== null) {
      const span = document.createElement('span');
      span.className = `c-${classify(comment).kind}`;
      span.textContent = `%${comment}`;
      row.append(span);
    }

    frag.append(row);
  }

  el.texPane.replaceChildren(frag);

  const note = state.encodingFallback ? ` · ${state.encoding} と判定` : '';
  el.sourceMeta.textContent = `${state.filename} · ${lines.length} 行${note}`;
}

// -------------------------------------------------------------- diagnostics

/** @param {import('./diagnostics.js').Diagnostics} diagnostics */
function showDiagnostics(diagnostics) {
  const sections = diagnostics.sections();
  el.diag.hidden = sections.length === 0;

  const dl = document.createElement('dl');
  for (const section of sections) {
    const row = document.createElement('div');
    row.className = 'diag-row';
    const dt = document.createElement('dt');
    dt.textContent = section.label;
    const dd = document.createElement('dd');
    dd.textContent = section.items.join(' · ');
    row.append(dt, dd);
    dl.append(row);
  }
  el.diagBody.replaceChildren(dl);

  const problems =
    diagnostics.unresolvedCites.size +
    diagnostics.unresolvedRefs.size +
    diagnostics.unknownCommands.size;
  el.diagBadge.textContent = problems > 0 ? `要確認 ${problems}` : '';
  el.diagBadge.hidden = problems === 0;
}

// -------------------------------------------------------------------- notice

/** @type {(() => void)|null} */
let pendingAction = null;

/**
 * @param {string} message
 * @param {() => void} action
 */
function askBeforeDiscarding(message, action) {
  // Deliberately not window.confirm: a modal dialog blocks the page and is
  // hostile to both automation and quick keyboard use.
  pendingAction = action;
  el.noticeText.textContent = message;
  el.notice.hidden = false;
}

function hideNotice() {
  el.notice.hidden = true;
  pendingAction = null;
}

el.noticeOk.addEventListener('click', () => {
  const action = pendingAction;
  hideNotice();
  action?.();
});

el.noticeCancel.addEventListener('click', hideNotice);

// ------------------------------------------------------------------- options

for (const control of [el.optComments, el.optEmphasis, el.optFrontmatter]) {
  control.addEventListener('change', () => {
    if (state.source === null) return;
    if (!state.dirty) {
      render();
      return;
    }
    askBeforeDiscarding(
      'Markdown を手で編集しています。設定を変えて再変換すると編集内容は失われます。',
      render,
    );
  });
}

el.out.addEventListener('input', () => {
  state.dirty = true;
  setCopyStatus('');
});

// --------------------------------------------------------------- file input

el.pick.addEventListener('click', () => el.file.click());

el.file.addEventListener('change', async () => {
  const file = el.file.files?.[0];
  if (file) loadSource(await file.arrayBuffer(), file.name);
  el.file.value = '';
});

// ---------------------------------------------------------------- drag/drop

let dragDepth = 0;

window.addEventListener('dragenter', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth += 1;
  el.dropzone.hidden = false;
});

window.addEventListener('dragover', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
});

window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) el.dropzone.hidden = true;
});

window.addEventListener('drop', async (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  el.dropzone.hidden = true;

  const file = pickTexFile([...(event.dataTransfer?.files ?? [])]);
  if (!file) return;
  loadSource(await file.arrayBuffer(), file.name);
});

/** @param {DragEvent} event */
function hasFiles(event) {
  return [...(event.dataTransfer?.types ?? [])].includes('Files');
}

/**
 * Prefer an actual .tex when several files are dropped; a paper directory often
 * contains figures and a .bbl alongside the source.
 * @param {File[]} files
 */
function pickTexFile(files) {
  return files.find((f) => /\.(tex|latex)$/i.test(f.name)) ?? files[0] ?? null;
}

// --------------------------------------------------------------------- paste

window.addEventListener('paste', (event) => {
  // Only treat a paste as a new document when the output pane is not focused,
  // so editing the Markdown by hand still works normally.
  if (document.activeElement === el.out) return;
  const text = event.clipboardData?.getData('text/plain');
  if (!text || !/\\(documentclass|begin|section|usepackage)\b/.test(text)) return;

  event.preventDefault();
  state.source = text;
  state.filename = 'pasted.tex';
  state.encoding = 'utf-8';
  state.encodingFallback = false;
  renderSourcePane(text);
  hideNotice();
  render();
});

// ------------------------------------------------------------ copy/download

el.copy.addEventListener('click', async () => {
  const result = await copyText(el.out.value, el.out);
  if (result.ok) {
    setCopyStatus(
      result.method === 'clipboard-api' ? 'コピーしました' : 'コピーしました',
    );
  } else {
    setCopyStatus('全選択しました。Ctrl+C を押してください', true);
  }
});

el.download.addEventListener('click', () => {
  const base = state.filename.replace(/\.(tex|latex)$/i, '') || 'document';
  downloadText(el.out.value, `${base}.md`);
});

/**
 * @param {string} message
 * @param {boolean} [manual]
 */
function setCopyStatus(message, manual = false) {
  el.copyStatus.textContent = message;
  el.copyStatus.classList.toggle('manual', manual);
  if (message && !manual) {
    setTimeout(() => {
      if (el.copyStatus.textContent === message) el.copyStatus.textContent = '';
    }, 2500);
  }
}
