import { writeFileSync, mkdirSync } from 'node:fs';
import { makeDocx, makeTextPdf } from '../fixtures/generate.ts';
mkdirSync('tests/fixtures/generated', { recursive: true });
writeFileSync('tests/fixtures/generated/proc.docx', await makeDocx());
writeFileSync('tests/fixtures/generated/text.pdf', await makeTextPdf('ALPHA'));
console.log('ok');
