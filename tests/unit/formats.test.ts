import { describe, expect, it } from 'vitest';
import { CONVERTERS, getConverter } from '../../src/converters/registry';
import { DokuWikiConverter } from '../../src/converters/dokuwiki';
import { MarkdownConverter } from '../../src/converters/markdown';
import { BookStackConverter } from '../../src/converters/bookstack';
import { ConfluenceWikiConverter } from '../../src/converters/confluence-wiki';
import { text, type DocumentModel } from '../../src/model/types';
import { makeDoc, fakeImage } from './helpers';

function sample(): DocumentModel {
  return makeDoc(
    [
      { type: 'heading', level: 1, inlines: [text('Configuration réseau')] },
      { type: 'paragraph', inlines: [text('Cliquez sur '), text('Configuration', { bold: true }), text(' puis '), text('Réseau', { italic: true }), text(' *ok* [x]')] },
      { type: 'heading', level: 2, inlines: [text('Étapes')] },
      { type: 'list', ordered: true, items: [{ blocks: [{ type: 'paragraph', inlines: [text('Un')] }, { type: 'list', ordered: false, items: [{ blocks: [{ type: 'paragraph', inlines: [text('Sous')] }] }] }] }, { blocks: [{ type: 'paragraph', inlines: [text('Deux')] }] }] },
      { type: 'table', rows: [
        { cells: [{ blocks: [{ type: 'paragraph', inlines: [text('A')] }], header: true, colspan: 1, rowspan: 1 }, { blocks: [{ type: 'paragraph', inlines: [text('B')] }], header: true, colspan: 1, rowspan: 1 }] },
        { cells: [{ blocks: [{ type: 'paragraph', inlines: [text('fusion')] }], header: false, colspan: 2, rowspan: 1 }] },
      ] },
      { type: 'image', imageId: 'a', alt: 'Écran', caption: [text('Légende')] },
      { type: 'code', language: 'bash', text: 'ls -la' },
      { type: 'admonition', kind: 'warning', title: 'Attention', blocks: [{ type: 'paragraph', inlines: [text('Prudence')] }] },
      { type: 'paragraph', inlines: [{ type: 'link', href: 'https://example.org', children: [text('Site')] }] },
    ],
    [fakeImage('a', 'image-001.png')],
  );
}

describe('registre', () => {
  it('expose six formats disponibles', () => {
    expect(CONVERTERS.filter((c) => c.available).map((c) => c.id)).toEqual(['mediawiki', 'confluence', 'confluence-wiki', 'dokuwiki', 'markdown', 'bookstack']);
    expect(() => getConverter('inconnu')).toThrow();
  });
  it('chaque format produit une sortie, un aperçu sans script et des notes', () => {
    for (const c of CONVERTERS) {
      const res = c.convert(sample(), { ...c.defaultOptions(), imagePrefix: 'p-' });
      expect(res.main.length).toBeGreaterThan(50);
      expect(res.previewHtml).not.toContain('<script');
      expect(res.previewHtml).toContain('images/p-image-001.png');
      expect(res.clipboard['text/plain'].length).toBeGreaterThan(0);
    }
  });
});

describe('DokuWiki', () => {
  const c = new DokuWikiConverter();
  it('rend la syntaxe DokuWiki', () => {
    const out = c.convert(sample(), { ...c.defaultOptions(), imagePrefix: 'p-', namespace: 'wiki:proc' }).main;
    expect(out).toContain('====== Configuration réseau ======');
    expect(out).toContain('===== Étapes =====');
    expect(out).toContain("Cliquez sur **Configuration** puis //Réseau// *ok* [x]");
    expect(out).toContain('  - Un\n    * Sous\n  - Deux');
    expect(out).toContain('^ A ^ B ^\n| fusion ||');
    expect(out).toContain('{{:wiki:proc:p-image-001.png|Légende}}');
    expect(out).toContain('<code bash>\nls -la\n</code>');
    expect(out).toContain('> **Attention** Prudence');
    expect(out).toContain('[[https://example.org|Site]]');
  });
  it('échappe la syntaxe présente dans le texte', () => {
    const out = c.convert(makeDoc([{ type: 'paragraph', inlines: [text("a **b** c //d// http://e.org")] }]), c.defaultOptions()).main;
    expect(out).toContain('a %%**%%b%%**%% c %%//%%d%%//%% %%http://e.org%%');
  });
  it('rend les avertissements avec le plugin note', () => {
    const out = c.convert(sample(), { ...c.defaultOptions(), admonitionStyle: 'note' }).main;
    expect(out).toContain('<note warning>\n**Attention** Prudence\n</note>');
  });
});

describe('Markdown', () => {
  const c = new MarkdownConverter();
  it('rend du Markdown GFM', () => {
    const res = c.convert(sample(), { ...c.defaultOptions(), imagePrefix: 'p-' });
    const out = res.main;
    expect(out).toContain('# Configuration réseau');
    expect(out).toContain('## Étapes');
    expect(out).toContain('Cliquez sur **Configuration** puis *Réseau* \\*ok\\* \\[x\\]');
    expect(out).toContain('1. Un\n    - Sous\n2. Deux');
    expect(out).toContain('| A | B |\n| --- | --- |\n| fusion |  |');
    expect(out).toContain('![Légende](images/p-image-001.png)\n\n*Légende*');
    expect(out).toContain('```bash\nls -la\n```');
    expect(out).toContain('> [!WARNING]\n> Prudence');
    expect(out).toContain('[Site](https://example.org)');
    expect(res.notes.some((n) => n.includes('fusionnées'))).toBe(true);
  });
  it('protège les débuts de ligne et le code inline', () => {
    const out = c.convert(makeDoc([{ type: 'paragraph', inlines: [text('- pas une liste')] }, { type: 'paragraph', inlines: [text('a`b', { code: true })] }]), c.defaultOptions()).main;
    expect(out).toContain('\\- pas une liste');
    expect(out).toContain('``a`b``');
  });
});

describe('BookStack', () => {
  const c = new BookStackConverter();
  it('rend du HTML avec encadrés natifs', () => {
    const res = c.convert(sample(), { ...c.defaultOptions(), imagePrefix: 'p-' });
    expect(res.main).toContain('<h1>Configuration réseau</h1>');
    expect(res.main).toContain('<ol><li>Un<ul><li>Sous</li></ul></li><li>Deux</li></ol>');
    expect(res.main).toContain('<td colspan="2">fusion</td>');
    expect(res.main).toContain('<img src="images/p-image-001.png" alt="Écran">');
    expect(res.main).toContain('<pre><code class="language-bash">ls -la</code></pre>');
    expect(res.main).toContain('<p class="callout warning"><strong>Attention</strong> Prudence</p>');
    expect(res.clipboard['text/html']).toBe(res.main);
  });
});

describe('Confluence wiki markup', () => {
  const c = new ConfluenceWikiConverter();
  it('rend le balisage wiki Server/DC', () => {
    const out = c.convert(sample(), { ...c.defaultOptions(), imagePrefix: 'p-' }).main;
    expect(out).toContain('h1. Configuration réseau');
    expect(out).toContain('Cliquez sur *Configuration* puis _Réseau_ \\*ok\\* \\[x\\]');
    expect(out).toContain('# Un\n#* Sous\n# Deux');
    expect(out).toContain('||A||B||\n|fusion| |');
    expect(out).toContain('!p-image-001.png|alt=Légende!');
    expect(out).toContain('{code:language=bash}\nls -la\n{code}');
    expect(out).toContain('{warning:title=Attention}\nPrudence\n{warning}');
    expect(out).toContain('[Site|https://example.org]');
  });
});
