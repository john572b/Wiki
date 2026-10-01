import { describe, expect, it } from 'vitest';
import { ConfluenceConverter } from '../../src/converters/confluence';
import { text } from '../../src/model/types';
import { makeDoc, fakeImage } from './helpers';

const conv = new ConfluenceConverter();
const opts = conv.defaultOptions();

function parseXml(s: string) {
  const wrapped = `<root xmlns:ac="urn:ac" xmlns:ri="urn:ri">${s}</root>`;
  const d = new DOMParser().parseFromString(wrapped, 'application/xml');
  const err = d.getElementsByTagName('parsererror');
  if (err.length) throw new Error('XML invalide : ' + err[0].textContent);
  return d;
}

describe('Confluence converter', () => {
  it('produit un storage format XML bien formé avec les éléments principaux', () => {
    const doc = makeDoc(
      [
        { type: 'heading', level: 1, inlines: [text('Titre & co')] },
        { type: 'paragraph', inlines: [text('a '), text('b', { bold: true }), { type: 'link', href: 'https://x.org/?a=1&b=2', children: [text('lien')] }] },
        { type: 'list', ordered: true, items: [{ blocks: [{ type: 'paragraph', inlines: [text('un')] }] }] },
        { type: 'table', rows: [{ cells: [{ blocks: [{ type: 'paragraph', inlines: [text('h')] }], header: true, colspan: 2, rowspan: 1 }] }] },
        { type: 'image', imageId: 'a', alt: 'Écran' },
        { type: 'code', language: 'bash', text: 'echo "]]>" && ls' },
        { type: 'admonition', kind: 'warning', title: 'Attention', blocks: [{ type: 'paragraph', inlines: [text('Prudence')] }] },
      ],
      [fakeImage('a', 'image-001.png')],
    );
    const res = conv.convert(doc, { ...opts, imagePrefix: 'p-' });
    const xml = res.main;
    parseXml(xml);
    expect(xml).toContain('<h1>Titre &amp; co</h1>');
    expect(xml).toContain('<p>a <strong>b</strong><a href="https://x.org/?a=1&amp;b=2">lien</a></p>');
    expect(xml).toContain('<ol>\n<li>un</li>\n</ol>');
    expect(xml).toContain('<table><tbody>\n<tr><th colspan="2"><p>h</p></th></tr>\n</tbody></table>');
    expect(xml).toContain('<ac:image ac:alt="Écran"><ri:attachment ri:filename="p-image-001.png" /></ac:image>');
    expect(xml).toContain('<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">bash</ac:parameter><ac:plain-text-body><![CDATA[echo "]]]]><![CDATA[>" && ls]]></ac:plain-text-body></ac:structured-macro>');
    expect(xml).toContain('<ac:structured-macro ac:name="warning"><ac:parameter ac:name="title">Attention</ac:parameter><ac:rich-text-body><p>Prudence</p></ac:rich-text-body></ac:structured-macro>');
  });

  it('produit un HTML collable sans balises ac:', () => {
    const doc = makeDoc([{ type: 'code', text: 'x < y' }, { type: 'image', imageId: 'a', alt: '' }], [fakeImage('a', 'image-001.png')]);
    const res = conv.convert(doc, opts);
    const paste = res.extraFiles['confluence.paste.html'];
    expect(paste).not.toContain('ac:');
    expect(paste).toContain('<pre><code>x &lt; y</code></pre>');
    expect(paste).toContain('<img src="images/image-001.png"');
    expect(res.clipboard['text/html']).toBe(paste);
    expect(res.clipboard['text/plain']).toBe(res.main);
  });

  it('produit un aperçu qui transforme macros et images', () => {
    const doc = makeDoc([
      { type: 'code', language: 'js', text: 'let a = 1;' },
      { type: 'admonition', kind: 'tip', blocks: [{ type: 'paragraph', inlines: [text('ok')] }] },
      { type: 'image', imageId: 'a', alt: 'img' },
    ], [fakeImage('a', 'image-001.png')]);
    const html = conv.convert(doc, opts).previewHtml;
    expect(html).toContain('<pre class="code" data-lang="js">let a = 1;</pre>');
    expect(html).toContain('<div class="panel tip"><div class="panel-title">Astuce</div><p>ok</p></div>');
    expect(html).toContain('<img src="images/image-001.png" alt="img">');
    expect(html).not.toContain('ac:');
  });
});
