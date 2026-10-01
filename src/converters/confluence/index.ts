import type { Block, DocumentModel, ImageAsset, Inline } from '../../model/types';
import type { ConversionResult, Converter, ConverterOptions } from '../base';
import { escapeHtml } from '../base';
import { renderConfluencePreview } from '../../preview/confluence';

export interface ConfluenceOptions extends ConverterOptions {
  /** Ajouter une macro table des matières en tête. */
  toc: boolean;
  /** Largeur max des images (px, 0 = naturelle). */
  imageWidth: number;
}

type Flavor = 'storage' | 'paste';

export class ConfluenceConverter implements Converter<ConfluenceOptions> {
  readonly id = 'confluence';
  readonly label = 'Confluence';
  readonly extension = 'html';
  readonly description = 'Storage Format (XHTML) pour l’API ou l’éditeur de source, et HTML riche pour coller dans l’éditeur';
  readonly available = true;

  defaultOptions(): ConfluenceOptions {
    return { imagePrefix: '', toc: false, imageWidth: 0 };
  }

  convert(doc: DocumentModel, options: ConfluenceOptions): ConversionResult {
    const storage = new Renderer(doc, options, 'storage').render();
    const paste = new Renderer(doc, options, 'paste').render();
    const imageNames = doc.images.map((im) => options.imagePrefix + im.filename);
    const notes: string[] = [
      'Copier met du HTML riche dans le presse-papiers : collez-le directement dans l’éditeur Confluence (Cloud ou Server).',
      'Le fichier confluence.html est au Storage Format, pour l’API REST (body.storage) ou l’éditeur de source (Server/Data Center).',
    ];
    if (imageNames.length) {
      notes.push(`Joignez ${imageNames.length} image(s) à la page avec exactement ces noms : ${imageNames.join(', ')}`);
    }
    return {
      main: storage,
      mainFilename: 'confluence.html',
      mimeType: 'application/xhtml+xml; charset=utf-8',
      extraFiles: { 'confluence.paste.html': paste },
      clipboard: { 'text/plain': storage, 'text/html': paste },
      previewHtml: renderConfluencePreview(storage, doc, options),
      notes,
    };
  }
}

class Renderer {
  private imagesById: Map<string, ImageAsset>;

  constructor(private doc: DocumentModel, private o: ConfluenceOptions, private flavor: Flavor) {
    this.imagesById = new Map(doc.images.map((im) => [im.id, im]));
  }

  render(): string {
    const parts: string[] = [];
    if (this.o.toc && this.flavor === 'storage') parts.push('<ac:structured-macro ac:name="toc" />');
    for (const b of this.doc.blocks) parts.push(this.block(b));
    return parts.join('\n') + '\n';
  }

  block(b: Block): string {
    switch (b.type) {
      case 'heading':
        return `<h${Math.min(b.level, 6)}>${this.inlines(b.inlines)}</h${Math.min(b.level, 6)}>`;
      case 'paragraph':
        return `<p>${this.inlines(b.inlines)}</p>`;
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        const start = b.ordered && b.start && b.start !== 1 ? ` start="${b.start}"` : '';
        const items = b.items.map((it) => `<li>${this.listItem(it.blocks)}</li>`).join('\n');
        return `<${tag}${start}>\n${items}\n</${tag}>`;
      }
      case 'table': {
        const rows = b.rows
          .map((r) => {
            const cells = r.cells
              .map((c) => {
                const tag = c.header ? 'th' : 'td';
                const attrs = (c.colspan > 1 ? ` colspan="${c.colspan}"` : '') + (c.rowspan > 1 ? ` rowspan="${c.rowspan}"` : '');
                return `<${tag}${attrs}>${this.cellContent(c.blocks)}</${tag}>`;
              })
              .join('');
            return `<tr>${cells}</tr>`;
          })
          .join('\n');
        const caption = b.caption && b.caption.length ? `<caption>${this.inlines(b.caption)}</caption>` : '';
        return `<table>${caption}<tbody>\n${rows}\n</tbody></table>`;
      }
      case 'image':
        return this.image(b.imageId, b.alt, b.caption);
      case 'code': {
        if (this.flavor === 'paste') {
          return `<pre><code>${escapeHtml(b.text)}</code></pre>`;
        }
        const lang = b.language ? `<ac:parameter ac:name="language">${escapeHtml(b.language)}</ac:parameter>` : '';
        const body = b.text.replace(/\]\]>/g, ']]]]><![CDATA[>');
        return `<ac:structured-macro ac:name="code">${lang}<ac:plain-text-body><![CDATA[${body}]]></ac:plain-text-body></ac:structured-macro>`;
      }
      case 'admonition': {
        const inner = b.blocks.map((x) => this.block(x)).join('\n');
        if (this.flavor === 'paste') {
          return `<div data-kind="${b.kind}" style="border-left:4px solid #0052cc;padding:8px 12px;margin:8px 0;"><p><strong>${escapeHtml(b.title ?? b.kind)}</strong></p>${inner}</div>`;
        }
        const title = b.title ? `<ac:parameter ac:name="title">${escapeHtml(b.title)}</ac:parameter>` : '';
        return `<ac:structured-macro ac:name="${b.kind}">${title}<ac:rich-text-body>${inner}</ac:rich-text-body></ac:structured-macro>`;
      }
      case 'quote':
        return `<blockquote>${b.blocks.map((x) => this.block(x)).join('\n')}</blockquote>`;
      case 'hr':
        return '<hr />';
    }
  }

  listItem(blocks: Block[]): string {
    return blocks
      .map((x) => (x.type === 'paragraph' ? this.inlines(x.inlines) : this.block(x)))
      .join('');
  }

  cellContent(blocks: Block[]): string {
    if (blocks.length === 1 && blocks[0].type === 'paragraph') return `<p>${this.inlines(blocks[0].inlines)}</p>`;
    return blocks.map((x) => this.block(x)).join('');
  }

  image(imageId: string, alt: string, caption?: Inline[]): string {
    const im = this.imagesById.get(imageId);
    if (!im) return '';
    const name = this.o.imagePrefix + im.filename;
    const cap = caption && caption.length ? `<p><em>${this.inlines(caption)}</em></p>` : '';
    if (this.flavor === 'paste') {
      return `<p><img src="images/${escapeHtml(name)}" alt="${escapeHtml(alt || name)}" data-attachment="${escapeHtml(name)}" /></p>${cap}`;
    }
    const width = this.o.imageWidth > 0 ? ` ac:width="${this.o.imageWidth}"` : '';
    return `<p><ac:image ac:alt="${escapeHtml(alt || name)}"${width}><ri:attachment ri:filename="${escapeHtml(name)}" /></ac:image></p>${cap}`;
  }

  inlines(inlines: Inline[]): string {
    return inlines.map((i) => this.inline(i)).join('');
  }

  inline(i: Inline): string {
    if (i.type === 'br') return '<br />';
    if (i.type === 'link') {
      const href = (i.href ?? '').trim();
      const label = this.inlines(i.children ?? []);
      if (!href) return label;
      return `<a href="${escapeHtml(href)}">${label || escapeHtml(href)}</a>`;
    }
    let t = escapeHtml(i.text ?? '');
    if (i.code) t = `<code>${t}</code>`;
    if (i.bold) t = `<strong>${t}</strong>`;
    if (i.italic) t = `<em>${t}</em>`;
    if (i.underline) t = `<u>${t}</u>`;
    if (i.strike) t = `<s>${t}</s>`;
    return t;
  }
}
