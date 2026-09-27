import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectMacros, expandMacros } from '../public/js/macros.js';

test('a zero-argument \\newcommand is expanded', () => {
  const m = collectMacros('\\newcommand{\\R}{\\mathbb{R}}');
  assert.equal(expandMacros('x \\in \\R', m), 'x \\in \\mathbb{R}');
});

test('argument substitution works', () => {
  const m = collectMacros('\\newcommand{\\pd}[2]{\\frac{\\partial #1}{\\partial #2}}');
  assert.equal(expandMacros('\\pd{f}{x}', m), '\\frac{\\partial f}{\\partial x}');
});

test('a default optional argument is honoured', () => {
  const m = collectMacros('\\newcommand{\\vec}[1][3]{R^{#1}}');
  assert.equal(expandMacros('\\vec', m), 'R^{3}');
  assert.equal(expandMacros('\\vec[n]', m), 'R^{n}');
});

test('\\DeclareMathOperator becomes \\operatorname', () => {
  const m = collectMacros('\\DeclareMathOperator{\\tr}{tr}');
  assert.equal(expandMacros('\\tr A', m), '\\operatorname{tr} A');
});

test('\\def with parameters is supported', () => {
  const m = collectMacros('\\def\\pair#1#2{(#1,#2)}');
  assert.equal(expandMacros('\\pair{a}{b}', m), '(a,b)');
});

test('bare \\newcommand\\name form is supported', () => {
  const m = collectMacros('\\newcommand\\Z{\\mathbb{Z}}');
  assert.equal(expandMacros('\\Z', m), '\\mathbb{Z}');
});

test('nested macros expand through several passes', () => {
  const m = collectMacros('\\newcommand{\\A}{\\B}\\newcommand{\\B}{done}');
  assert.equal(expandMacros('\\A', m), 'done');
});

test('a self-referential macro terminates instead of hanging', () => {
  const m = collectMacros('\\newcommand{\\loop}{\\loop}');
  assert.doesNotThrow(() => expandMacros('\\loop', m));
});

test('a command that merely shares a prefix is left alone', () => {
  const m = collectMacros('\\newcommand{\\R}{\\mathbb{R}}');
  assert.equal(expandMacros('\\Rho', m), '\\Rho');
});

test('a call with too few arguments is left untouched', () => {
  const m = collectMacros('\\newcommand{\\pd}[2]{\\frac{#1}{#2}}');
  assert.equal(expandMacros('\\pd{f}', m), '\\pd{f}');
});

test('no macros defined means the text is returned unchanged', () => {
  const text = '\\sum_{i} x_i';
  assert.equal(expandMacros(text, collectMacros('')), text);
});
