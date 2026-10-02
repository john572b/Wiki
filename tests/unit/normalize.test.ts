import { describe, expect, it } from 'vitest';
import { normalizeDocument, mergeInlines, imageBaseNameFrom } from '../../src/model/normalize';
import { text } from '../../src/model/types';
import { makeDoc, fakeImage } from './helpers';

describe('normalize', () => {
  it('fusionne les inlines identiques et nettoie les espaces', () => {
    expect(mergeInlines([text('  a  '), text('b', { bold: true }), text('c', { bold: true }), text('  ')])).toEqual([
      text('a '),
      text('bc', { bold: true }),
    ]);
  });

  it('promeut le premier titre en titre de document et re-nivelle', () => {
    const doc = makeDoc([
      { type: 'heading', level: 1, inlines: [text('Mon doc')] },
      { type: 'heading', level: 3, inlines: [text('Section')] },
      { type: 'paragraph', inlines: [text('corps')] },
      { type: 'heading', level: 5, inlines: [text('Sous')] },
    ]);
    const kept = normalizeDocument(doc);
    expect(kept.metadata.title).toBe('Mon doc');
    expect(kept.blocks.map((b) => (b.type === 'heading' ? b.level : 0))).toEqual([1, 2, 0, 3]);
    const n = normalizeDocument(doc, { promoteFirstHeadingToTitle: true });
    expect(n.metadata.title).toBe('Mon doc');
    expect(n.blocks.map((b) => (b.type === 'heading' ? b.level : 0))).toEqual([1, 0, 2]);
  });

  it('ne retire pas le titre quand il y a plusieurs titres de niveau 1', () => {
    const doc = makeDoc([
      { type: 'heading', level: 1, inlines: [text('A')] },
      { type: 'heading', level: 1, inlines: [text('B')] },
    ]);
    const n = normalizeDocument(doc, { promoteFirstHeadingToTitle: true });
    expect(n.metadata.title).toBe('A');
    expect(n.blocks.length).toBe(2);
  });

  it('détecte les admonitions par mot-clé', () => {
    const doc = makeDoc([{ type: 'paragraph', inlines: [text('Attention : ne pas '), text('éteindre', { bold: true })] }]);
    const n = normalizeDocument(doc);
    expect(n.blocks[0].type).toBe('admonition');
    const adm = n.blocks[0] as Extract<(typeof n.blocks)[0], { type: 'admonition' }>;
    expect(adm.kind).toBe('warning');
    expect(adm.blocks[0]).toEqual({ type: 'paragraph', inlines: [text('ne pas '), text('éteindre', { bold: true })] });
  });

  it('supprime les paragraphes vides et renomme les images dans l’ordre', () => {
    const doc = makeDoc(
      [
        { type: 'paragraph', inlines: [text('   ')] },
        { type: 'image', imageId: 'b', alt: '' },
        { type: 'image', imageId: 'a', alt: '' },
        { type: 'image', imageId: 'zz', alt: '' },
      ],
      [fakeImage('a', 'x.png'), fakeImage('b', 'y.png'), { ...fakeImage('c', 'unused.png'), mime: 'image/jpeg' }],
    );
    const n = normalizeDocument(doc);
    expect(n.blocks.length).toBe(3);
    expect(n.images.map((i) => [i.id, i.filename])).toEqual([
      ['b', 'image-1.png'],
      ['a', 'image-2.png'],
    ]);
  });

  it('nomme les images d’après le document, numérotées 1, 2, 3…', () => {
    const doc = makeDoc(
      [{ type: 'image', imageId: 'a', alt: '' }, { type: 'image', imageId: 'b', alt: '' }],
      [fakeImage('a', 'x.png'), { ...fakeImage('b', 'y.png'), mime: 'image/jpeg' }],
    );
    const n = normalizeDocument(doc, { imageBaseName: imageBaseNameFrom('Procédure VPN v2.docx') });
    expect(n.images.map((i) => i.filename)).toEqual(['Procédure VPN v2-1.png', 'Procédure VPN v2-2.jpg']);
    expect(imageBaseNameFrom('a/b:c*?.pdf')).toBe('a b c');
  });
});
