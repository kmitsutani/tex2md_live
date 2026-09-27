import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../public/js/parser.js';

test('sectioning commands capture their title', () => {
  const [n] = parse('\\section{Hello}');
  assert.equal(n.type, 'command');
  assert.equal(n.name, 'section');
  assert.deepEqual(n.args, ['Hello']);
});

test('starred sections are flagged', () => {
  assert.equal(parse('\\section*{X}')[0].star, true);
});

test('inline and display math are captured verbatim', () => {
  const nodes = parse('a $x^2$ b \\[y\\] c $$z$$');
  const math = nodes.filter((n) => n.type === 'math');
  assert.deepEqual(math.map((m) => [m.body, m.display]), [
    ['x^2', false], ['y', true], ['z', true],
  ]);
});

test('math environments keep their body and name', () => {
  const [n] = parse('\\begin{align}a &= b \\\\ c &= d\\end{align}');
  assert.equal(n.type, 'math');
  assert.equal(n.env, 'align');
  assert.equal(n.display, true);
  assert.equal(n.body, 'a &= b \\\\ c &= d');
});

test('starred math environments keep the star', () => {
  assert.equal(parse('\\begin{align*}a\\end{align*}')[0].env, 'align*');
});

test('nested environments of the same name are matched correctly', () => {
  const [outer] = parse('\\begin{itemize}\\item a\\begin{itemize}\\item b\\end{itemize}\\end{itemize}');
  assert.equal(outer.type, 'env');
  assert.equal(outer.name, 'itemize');
  assert.equal(outer.children.filter((c) => c.type === 'env').length, 1);
});

test('braces become groups so {\\Large\\bf x} keeps its content', () => {
  const [g] = parse('{\\Large\\bf Title}');
  assert.equal(g.type, 'group');
  assert.deepEqual(g.children.map((c) => c.name ?? c.value), ['Large', 'bf', ' Title']);
});

test('a bare glue assignment consumes its dimension', () => {
  const nodes = parse('\\baselineskip 18pt rest');
  assert.equal(nodes[0].name, 'baselineskip');
  assert.equal(nodes[1].value, ' rest');
});

test('a stray unknown control sequence does not throw', () => {
  // Drafts often carry a bare `\l` immediately after \begin{document}.
  const nodes = parse('\\l\ntext');
  assert.equal(nodes[0].name, 'l');
  assert.equal(nodes.at(-1).value, '\ntext');
});

test('an unterminated environment consumes the remainder instead of failing', () => {
  const [n] = parse('\\begin{center}never closed');
  assert.equal(n.type, 'env');
  assert.equal(n.name, 'center');
});

test('an unbalanced brace does not hang or throw', () => {
  assert.doesNotThrow(() => parse('{unclosed \\section{a}'));
});

test('a blank line becomes a paragraph break', () => {
  const nodes = parse('a\n\nb');
  assert.equal(nodes[1].type, 'par');
});

test('verbatim bodies are not parsed', () => {
  const [n] = parse('\\begin{verbatim}\n\\section{not a section}\n\\end{verbatim}');
  assert.equal(n.type, 'verbatim');
  assert.equal(n.body, '\\section{not a section}');
});
