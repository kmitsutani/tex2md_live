import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitLine, classify, extractComments, groupComments,
} from '../public/js/comments.js';

test('a bare % starts a comment', () => {
  assert.deepEqual(splitLine('text % note'), { code: 'text ', comment: ' note' });
});

test('an escaped \\% is a literal percent, not a comment', () => {
  assert.deepEqual(splitLine('50\\% done'), { code: '50\\% done', comment: null });
});

test('a double backslash before % still starts a comment', () => {
  // `\\` is a line break, so the % that follows is not escaped.
  assert.deepEqual(splitLine('a \\\\% note'), { code: 'a \\\\', comment: ' note' });
});

test('% inside \\verb is literal', () => {
  assert.deepEqual(splitLine('\\verb|100%| ok'), { code: '\\verb|100%| ok', comment: null });
});

test('decorative rules are classified as decoration', () => {
  for (const raw of ['%%%%%%%%%', '----------', '%%%%%---------', '', '   ']) {
    assert.equal(classify(raw).kind, 'decoration', `for ${JSON.stringify(raw)}`);
  }
});

test('a short label fenced by %%% is a banner', () => {
  const r = classify('%%%%          Abstract            %%%%%');
  assert.equal(r.kind, 'banner');
  assert.equal(r.text, 'Abstract');
});

test('commented-out LaTeX is classified as code', () => {
  for (const raw of [
    '\\usepackage{cite}', '\\begin{figure}[h]', '{\\begin{figure}[h]',
    '\\includegraphics[width=100mm]{a.eps}', '\\end{figure}}',
  ]) {
    assert.equal(classify(raw).kind, 'code', `for ${raw}`);
  }
});

test('prose is classified as a note', () => {
  const r = classify(' ここは要確認 TODO');
  assert.equal(r.kind, 'note');
  assert.equal(r.text, 'ここは要確認 TODO');
});

test('extraction replaces comments with sentinels and keeps line numbers', () => {
  const { text, comments } = extractComments('a\n% note here\nb % trailing\n');
  assert.match(text, /\\TPC\{0\}/);
  assert.match(text, /b \\TPC\{1\}/);
  assert.equal(comments[0].line, 2);
  assert.equal(comments[0].inline, false);
  assert.equal(comments[1].line, 3);
  assert.equal(comments[1].inline, true);
});

test('verbatim bodies keep their percent signs', () => {
  const src = '\\begin{verbatim}\n50% literal\n\\end{verbatim}\n';
  const { text, comments } = extractComments(src);
  assert.equal(comments.length, 0);
  assert.match(text, /50% literal/);
});

test('consecutive same-kind comments merge into one block', () => {
  const { comments } = extractComments('%\\a\n%\\b\n%\\c\ntext\n');
  const blocks = groupComments(comments);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].lines, ['\\a', '\\b', '\\c']);
});

test('a kind change breaks the block', () => {
  const { comments } = extractComments('%\\a\n% prose note\n');
  assert.equal(groupComments(comments).length, 2);
});
