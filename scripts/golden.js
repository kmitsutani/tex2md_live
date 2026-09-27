/** Regenerate the golden snapshot used by tests/markdown.test.js. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeTex } from '../public/js/decode.js';
import { convert } from '../public/js/markdown.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = decodeTex(fs.readFileSync(path.join(root, 'tests/data/sample.tex'))).text;
const { markdown } = convert(source, { filename: 'sample.tex', frontmatter: false });
fs.writeFileSync(path.join(root, 'tests/data/sample.expected.md'), markdown);
console.log('wrote tests/data/sample.expected.md');
