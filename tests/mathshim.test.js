import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shimMath } from '../public/js/mathshim.js';

test('\\slashed becomes something MathJax can render', () => {
  // The `slashed` package is common in physics papers; MathJax lacks it.
  assert.equal(shimMath('(i\\slashed{\\partial})'), '(i{\\not{\\partial}})');
});

test('\\bm becomes \\boldsymbol', () => {
  assert.equal(shimMath('\\bm{b}^a'), '\\boldsymbol{b}^a');
});

test('nested braces in the argument survive', () => {
  assert.equal(shimMath('\\bm{x_{i}}'), '\\boldsymbol{x_{i}}');
});

test('old-style group font switches are normalised', () => {
  assert.equal(shimMath('{\\cal L}^{\\star}'), '\\mathcal{L}^{\\star}');
});

test('\\enspace becomes a MathJax space', () => {
  assert.equal(shimMath('a \\enspace b'), 'a \\; b');
});

test('untouched math is returned unchanged', () => {
  const body = '\\frac{1}{2}\\epsilon_{\\mu\\nu} W^{a}';
  assert.equal(shimMath(body), body);
});

test('unknown commands are reported but left in place', () => {
  const report = { unknown: new Set() };
  const out = shimMath('\\weirdmacro{x}', report);
  assert.match(out, /\\weirdmacro/);
  assert.ok(report.unknown.has('weirdmacro'));
});
