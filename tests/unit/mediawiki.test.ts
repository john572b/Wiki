import { describe, expect, it } from 'vitest';
import { MediaWikiConverter, escapeWiki } from '../../src/converters/mediawiki';
import { text } from '../../src/model/types';
import { makeDoc, fakeImage } from './helpers';

const conv = new MediaWikiConverter();
const opts = conv.defaultOptions();

describe('MediaWiki converter', () => {
  it('rend titres, paragraphes, gras et italique', () => {
    const doc = makeDoc([
      { type: 'heading', level: 1, inlines: [text('Configuration réseau')] },
      { type: 'paragraph', inlines: [text('Cliquez sur '), text('Configuration', { bold: true }), text(' puis '), text('Réseau', { italic: true }), text('.')] },
      { type: 'heading', level: 2, inlines: [text('Sous-section')] },
    ]);
    const out = conv.convert(doc, opts).main;
    expect(out).toContain('== Configuration réseau ==');
    expect(out).toContain("Cliquez sur '''Configuration''' puis ''Réseau''.");
    expect(out).toContain('=== Sous-section ===');
  });

  it('rend des listes imbriquées ordonnées et non ordonnées', () => {
    const doc = makeDoc([
      {
        type: 'list',
        ordered: true,
        items: [
          { blocks: [{ type: 'paragraph', inlines: [text('Un')] }, { type: 'list', ordered: false, items: [{ blocks: [{ type: 'paragraph', inlines: [text('Sous')] }] }] }] },
          { blocks: [{ type: 'paragraph', inlines: [text('Deux')] }] },
        ],
      },
    ]);
    expect(conv.convert(doc, opts).main.trim()).toBe('# Un\n#* Sous\n# Deux');
  });

  it('rend un tableau avec en-têtes et fusions', () => {
    const doc = makeDoc([
      {
        type: 'table',
        rows: [
          { cells: [{ blocks: [{ type: 'paragraph', inlines: [text('A')] }], header: true, colspan: 1, rowspan: 1 }, { blocks: [{ type: 'paragraph', inlines: [text('B')] }], header: true, colspan: 1, rowspan: 1 }] },
          { cells: [{ blocks: [{ type: 'paragraph', inlines: [text('fusion')] }], header: false, colspan: 2, rowspan: 1 }] },
        ],
      },
    ]);
    const out = conv.convert(doc, opts).main;
    expect(out).toBe('{| class="wikitable"\n|-\n! A\n! B\n|-\n|colspan="2" | fusion\n|}\n');
  });

  it('référence les images avec le préfixe et liste les fichiers à téléverser', () => {
    const doc = makeDoc([{ type: 'image', imageId: 'a', alt: 'Écran', caption: [text('Légende')] }], [fakeImage('a', 'image-001.png')]);
    const res = conv.convert(doc, { ...opts, imagePrefix: 'proc-01-', fileNamespace: 'Fichier' });
    expect(res.main).toContain('[[Fichier:proc-01-image-001.png|thumb|Légende]]');
    expect(res.notes[0]).toContain('proc-01-image-001.png');
  });

  it('rend le code avec syntaxhighlight ou pre', () => {
    const doc = makeDoc([{ type: 'code', language: 'bash', text: 'ls -la\necho "<b>"' }]);
    expect(conv.convert(doc, opts).main).toContain('<syntaxhighlight lang="bash">\nls -la\necho "<b>"\n</syntaxhighlight>');
    expect(conv.convert(doc, { ...opts, syntaxHighlight: false }).main).toContain('<pre>\nls -la\necho "&lt;b&gt;"\n</pre>');
  });

  it('rend les admonitions et les liens', () => {
    const doc = makeDoc([
      { type: 'admonition', kind: 'warning', title: 'Attention', blocks: [{ type: 'paragraph', inlines: [text('Ne pas redémarrer.')] }] },
      { type: 'paragraph', inlines: [{ type: 'link', href: 'https://example.org/a b', children: [text('Site')] }] },
    ]);
    const out = conv.convert(doc, opts).main;
    expect(out).toContain("'''Attention'''");
    expect(out).toContain('Ne pas redémarrer.');
    expect(out).toContain('[https://example.org/a%20b Site]');
    const tpl = conv.convert(doc, { ...opts, admonitionStyle: 'template' }).main;
    expect(tpl).toContain('{{Warning|Ne pas redémarrer.}}');
  });

  it('échappe la syntaxe wiki présente dans le texte', () => {
    expect(escapeWiki("a '' b [[c]] {{d}} ~~~~ __TOC__ <x> http://e.org/f")).toBe(
      "a <nowiki>''</nowiki> b <nowiki>[[</nowiki>c<nowiki>]]</nowiki> <nowiki>{{</nowiki>d<nowiki>}}</nowiki> <nowiki>~~~~</nowiki> <nowiki>__TOC__</nowiki> &lt;x&gt; <nowiki>http://e.org/f</nowiki>",
    );
    const doc = makeDoc([{ type: 'paragraph', inlines: [text('* pas une liste')] }, { type: 'paragraph', inlines: [text('= pas un titre')] }]);
    const out = conv.convert(doc, opts).main;
    expect(out).toContain('<nowiki/>* pas une liste');
    expect(out).toContain('<nowiki/>= pas un titre');
  });

  it('ajoute les catégories', () => {
    const doc = makeDoc([{ type: 'paragraph', inlines: [text('x')] }]);
    expect(conv.convert(doc, { ...opts, categories: ['Procédures'] }).main).toContain('[[Category:Procédures]]');
  });

  it('produit un aperçu HTML contenant les éléments', () => {
    const doc = makeDoc([
      { type: 'heading', level: 1, inlines: [text('Titre')] },
      { type: 'list', ordered: false, items: [{ blocks: [{ type: 'paragraph', inlines: [text('item')] }] }] },
      { type: 'image', imageId: 'a', alt: 'img' },
    ], [fakeImage('a', 'image-001.png')]);
    const html = conv.convert(doc, opts).previewHtml;
    expect(html).toContain('<h2>Titre</h2>');
    expect(html).toContain('<ul><li>item</li></ul>');
    expect(html).toContain('images/image-001.png');
    expect(html).not.toContain('<script');
  });
});
