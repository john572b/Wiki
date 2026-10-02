import { describe, expect, it } from 'vitest';
import { detectDelimiter, parseCsv, parseCsvRows } from '../../src/parsers/csv';
import { parseText } from '../../src/parsers/text';
import { excelDate, refToRC } from '../../src/parsers/xlsx';
import { decodeText } from '../../src/util/text';
import { autolink } from '../../src/model/normalize';

describe('CSV', () => {
  it('détecte le séparateur et gère les guillemets', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(detectDelimiter('a,b\n1,2')).toBe(',');
    expect(parseCsvRows('a;"b;c";"d ""x"""\n"multi\nligne";2;3\n', ';')).toEqual([['a', 'b;c', 'd "x"'], ['multi\nligne', '2', '3']]);
  });
  it('produit un tableau avec en-tête', () => {
    const doc = parseCsv('Nom;Valeur\nPort;1194\n', { sourceFilename: 'x.csv' });
    const t = doc.blocks[0];
    expect(t.type).toBe('table');
    if (t.type === 'table') {
      expect(t.rows[0].cells.every((c) => c.header)).toBe(true);
      expect(t.rows[1].cells[1].blocks[0]).toEqual({ type: 'paragraph', inlines: [{ type: 'text', text: '1194' }] });
    }
  });
});

describe('Texte brut', () => {
  it('reconnaît titres soulignés, listes imbriquées, code indenté et paragraphes', () => {
    const doc = parseText('Titre\n=====\n\nIntro sur\ndeux lignes longues pour être jointes en un seul paragraphe ici.\n\n1. Un\n   - Sous\n2. Deux\n\n    ls -la\n', { sourceFilename: 'a.txt' });
    expect(doc.blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'list', 'code']);
    const list = doc.blocks[2];
    if (list.type === 'list') {
      expect(list.ordered).toBe(true);
      expect(list.items[0].blocks[1]).toMatchObject({ type: 'list', ordered: false });
    }
    expect(doc.blocks[3]).toEqual({ type: 'code', text: 'ls -la' });
  });
  it('garde les retours à la ligne des lignes courtes', () => {
    const doc = parseText('Serveur : vpn\nPort : 1194\n', { sourceFilename: 'a.txt' });
    expect(doc.blocks[0]).toMatchObject({ type: 'paragraph', inlines: [{ text: 'Serveur : vpn' }, { type: 'br' }, { text: 'Port : 1194' }] });
  });
});

describe('Utilitaires', () => {
  it('décode UTF-8 et repli Windows-1252', () => {
    expect(decodeText(new TextEncoder().encode('été').buffer as ArrayBuffer)).toBe('été');
    expect(decodeText(new Uint8Array([0x65, 0xe9]).buffer)).toBe('eé');
  });
  it('convertit les références et dates Excel', () => {
    expect(refToRC('B12')).toEqual([12, 2]);
    expect(refToRC('AA1')).toEqual([1, 27]);
    expect(excelDate(46037)).toBe('2026-01-15');
  });
  it('transforme les URL nues en liens', () => {
    expect(autolink([{ type: 'text', text: 'Voir https://a.lu/x. Merci' }])).toEqual([
      { type: 'text', text: 'Voir ' },
      { type: 'link', href: 'https://a.lu/x', children: [{ type: 'text', text: 'https://a.lu/x' }] },
      { type: 'text', text: '. Merci' },
    ]);
  });
});
