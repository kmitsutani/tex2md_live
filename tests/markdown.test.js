import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeTex } from '../public/js/decode.js';
import { convert } from '../public/js/markdown.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const texPath = path.join(here, 'data', 'sample.tex');
const goldenPath = path.join(here, 'data', 'sample.expected.md');

const source = decodeTex(fs.readFileSync(texPath)).text;
const run = (opts = {}) => convert(source, { filename: 'sample.tex', ...opts });

// ------------------------------------------------------------- noise removal

test('decorative %%%% rules never reach the output', () => {
  const { markdown } = run();
  assert.ok(!markdown.includes('%%%'), 'found a %%% run in the output');
});

test('typesetting commands and their dimensions are dropped', () => {
  // Checked with comments off: the commented-out TeX callouts quote the
  // original source verbatim, so they legitimately contain these strings.
  const { markdown } = run({ comments: 'none' });
  for (const leak of ['\\Large', '\\baselineskip', '18pt', '16pt', '\\vspace', '\\thispagestyle']) {
    assert.ok(!markdown.includes(leak), `leaked ${leak}`);
  }
});

test('no comment sentinel survives into the output', () => {
  assert.ok(!run().markdown.includes('TPC'));
});

// ------------------------------------------------------------------ structure

test('the title is recovered from \\begin{center} and becomes an H1', () => {
  const { markdown, diagnostics } = run();
  assert.match(markdown, /^# ダミー理論の基礎と応用（サンプル版）$/m);
  assert.ok(diagnostics.notes.some((n) => n.includes('推定')));
});

test('the author line is recovered', () => {
  assert.match(run().markdown, /名無しの権兵衛（サンプル大学）/);
});

test('the abstract becomes its own section', () => {
  assert.match(run().markdown, /^## Abstract$/m);
});

test('sections and subsections map to H2 and H3', () => {
  const { markdown } = run();
  assert.equal((markdown.match(/^## (?!Abstract|References)/gm) ?? []).length, 4);
  assert.equal((markdown.match(/^### /gm) ?? []).length, 2);
});

test('frontmatter carries the title, source and packages', () => {
  const { markdown } = run();
  assert.match(markdown, /^title: "ダミー理論の基礎と応用（サンプル版）"$/m);
  assert.match(markdown, /^source: "sample\.tex"$/m);
  assert.match(markdown, /^tex_packages: \[.*slashed.*\]$/m);
});

test('frontmatter can be turned off', () => {
  assert.ok(!run({ frontmatter: false }).markdown.startsWith('---'));
});

// ----------------------------------------------------------------------- math

test('align bodies keep their environment inside $$ on their own lines', () => {
  const { markdown } = run();
  assert.match(markdown, /\$\$\n\\begin\{align\}\n[\s\S]*?\n\\end\{align\}\n\$\$/);
});

test('display math delimiters sit on their own lines', () => {
  for (const line of run().markdown.split('\n')) {
    if (line.includes('$$')) assert.equal(line.trim(), '$$', `bad $$ line: ${line}`);
  }
});

test('equation numbering respects \\numberwithin{equation}{section}', () => {
  const tags = [...run().markdown.matchAll(/\\tag\{([^}]*)\}/g)].map((m) => m[1]);
  assert.deepEqual(tags, ['2.1']);
});

test('cross-references resolve to the equation number', () => {
  const { markdown, diagnostics } = run();
  assert.match(markdown, /式 \(2\.1\) を用いると/);
  assert.equal(diagnostics.unresolvedRefs.size, 0);
});

test('\\slashed and \\bm are rewritten for MathJax', () => {
  const { markdown } = run();
  assert.ok(markdown.includes('{\\not{\\partial}}'), 'slashed not shimmed');
  assert.ok(markdown.includes('\\boldsymbol{E}'), 'bm not shimmed');
  assert.ok(!markdown.includes('\\slashed'), '\\slashed survived');
});

test('inline math has no space just inside the delimiters', () => {
  // Obsidian does not render `$ x $` as math.
  const body = run().markdown
    .split('\n')
    .filter((l) => l.trim() !== '$$')
    .join('\n');
  for (const m of body.matchAll(/\$([^$\n]+)\$/g)) {
    assert.equal(m[1], m[1].trim(), `padded inline math: ${JSON.stringify(m[0])}`);
  }
});

// ------------------------------------------------------------------- comments

test('commented-out LaTeX becomes one collapsed example callout', () => {
  const { markdown } = run();
  assert.match(markdown, /> \[!example\]- コメントアウトされた TeX/);
  assert.match(markdown, /> \\includegraphics\[width=100mm,clip\]\{Fig_dummy\.eps\}/);
});

test('preamble comments are collected in their own appendix', () => {
  assert.match(run().markdown, /> \[!abstract\]- プリアンブルのコメント/);
});

test('comments: none removes every comment block', () => {
  const { markdown } = run({ comments: 'none' });
  assert.ok(!markdown.includes('[!example]'));
  assert.ok(!markdown.includes('[!abstract]'));
  assert.ok(!markdown.includes('[!note]'));
  // The verbatim block legitimately contains the word "コメント" as literal
  // text, so check for the callout markers rather than the word itself.
  assert.ok(!markdown.includes('ここは後で書き直す'));
  assert.ok(!markdown.includes('`% 行末コメント'));
});

test('comments: notes keeps prose notes and drops commented-out code', () => {
  const { markdown } = run({ comments: 'notes' });
  assert.ok(!markdown.includes('[!example]'));
});

test('comments: all keeps the decorative rules too', () => {
  assert.ok(run({ comments: 'all' }).markdown.includes('飾り罫'));
});

// ------------------------------------------------------------------ emphasis

test('emphasis is preserved by default', () => {
  const { markdown } = run();
  assert.match(markdown, /\*in voluptate\*/);
  assert.match(markdown, /==下線部はハイライトになる==/);
});

test('emphasis: false flattens all of it', () => {
  const { markdown } = run({ emphasis: false });
  assert.match(markdown, /reprehenderit in voluptate velit/);
  assert.ok(!markdown.includes('=='));
  assert.match(markdown, /下線部はハイライトになる/);
  // Bold from the source (`{\bf 99}` in a bibitem) is flattened, while the
  // `**[key]**` label this converter generates is its own structure and stays.
  assert.match(markdown, /J\. Phys\. Soc\. Jpn\. 99 \(2020\) 012345/);
  assert.match(markdown, /^- \*\*\[Dummy-1\]\*\*/m);
});

// ------------------------------------------- citations, footnotes, references

test('the bibliography becomes a References list', () => {
  const { markdown } = run();
  assert.match(markdown, /^## References$/m);
  assert.match(markdown, /^- \*\*\[Dummy-1\]\*\* 名無しの権兵衛/m);
  assert.equal((markdown.match(/^- \*\*\[/gm) ?? []).length, 3);
});

test('citations render as bracketed keys', () => {
  assert.match(run().markdown, /\[Dummy-2\] および \[Missing-Key\]/);
});

test('citations with no matching \\bibitem are reported', () => {
  const { diagnostics } = run();
  assert.deepEqual([...diagnostics.unresolvedCites].sort(), ['Missing-Key']);
});

test('the footnote becomes a Markdown footnote with a definition', () => {
  const { markdown } = run();
  assert.match(markdown, /\[\^1\]/);
  assert.match(markdown, /^\[\^1\]: 脚注の中にも数式を置く/m);
});

// ----------------------------------------------------------------- robustness

test('the stray \\l is reported rather than crashing', () => {
  assert.ok(run().diagnostics.unknownCommands.has('l'));
});

test('an empty document converts without throwing', () => {
  assert.doesNotThrow(() => convert(''));
});

test('a document with no \\begin{document} still converts', () => {
  const { markdown } = convert('\\section{Bare}\ntext');
  assert.match(markdown, /^## Bare$/m);
});

// ----------------------------------------- constructs absent from the fixture

test('a tabular becomes a Markdown table', () => {
  const { markdown } = convert(
    '\\begin{tabular}{ll}\\hline a & b \\\\ \\hline 1 & 2 \\\\ \\hline\\end{tabular}',
    { frontmatter: false },
  );
  assert.match(markdown, /\| a \| b \|/);
  assert.match(markdown, /\| --- \| --- \|/);
  assert.match(markdown, /\| 1 \| 2 \|/);
});

test('a figure becomes a callout naming its caption and file', () => {
  const { markdown } = convert(
    '\\begin{figure}\\includegraphics{plot.pdf}\\caption{A plot}\\label{fig:p}\\end{figure}',
    { frontmatter: false },
  );
  assert.match(markdown, /> \[!info\] 図: A plot/);
  assert.match(markdown, /> ファイル: `plot\.pdf`/);
});

test('lists become Markdown lists', () => {
  const { markdown } = convert(
    '\\begin{itemize}\\item one\\item two\\end{itemize}',
    { frontmatter: false },
  );
  assert.match(markdown, /^- one$/m);
  assert.match(markdown, /^- two$/m);
});

test('enumerate is numbered', () => {
  const { markdown } = convert(
    '\\begin{enumerate}\\item a\\item b\\end{enumerate}',
    { frontmatter: false },
  );
  assert.match(markdown, /^1\. a$/m);
  assert.match(markdown, /^2\. b$/m);
});

test('a theorem environment becomes a callout', () => {
  const { markdown } = convert(
    '\\begin{theorem}[Noether]All good.\\end{theorem}',
    { frontmatter: false },
  );
  assert.match(markdown, /> \[!important\] Theorem \(Noether\)/);
});

test('an escaped percent survives as a literal', () => {
  assert.match(convert('90\\% sure', { frontmatter: false }).markdown, /90% sure/);
});

// -------------------------------------------------------------------- golden

test('full conversion matches the golden snapshot', () => {
  // Regenerate with: npm run golden
  const actual = run({ frontmatter: false }).markdown;
  if (!fs.existsSync(goldenPath)) {
    assert.fail(`golden file missing: run \`npm run golden\``);
  }
  assert.equal(actual, fs.readFileSync(goldenPath, 'utf8'));
});

test('\\ref yields a bare number so the author\'s own parentheses are not doubled', () => {
  const { markdown } = convert(
    '\\begin{document}\\section{S}\\begin{align}x\\label{e}\\end{align}See (\\ref{e}) and \\eqref{e}.\\end{document}',
    { frontmatter: false },
  );
  assert.match(markdown, /See \(1\) and \(1\)\./);
  assert.ok(!markdown.includes('(('), 'parentheses were doubled');
});
