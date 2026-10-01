import type { DocumentModel } from '../../model/types';
import type { ConversionResult, Converter, ConverterOptions } from '../base';
import { escapeHtml } from '../base';
import { HtmlRenderer } from '../../preview/generic';
import { previewShell } from '../../preview/shell';

export type BookStackOptions = ConverterOptions;

/**
 * BookStack accepte du HTML : collage dans l'éditeur WYSIWYG, ou champ `html` de l'API (POST /api/pages).
 * Les encadrés utilisent les classes natives `callout info|success|warning|danger`.
 */
export class BookStackConverter implements Converter<BookStackOptions> {
  readonly id = 'bookstack';
  readonly label = 'BookStack';
  readonly extension = 'html';
  readonly description = 'HTML BookStack (éditeur WYSIWYG ou API), encadrés natifs';
  readonly available = true;

  defaultOptions(): BookStackOptions {
    return { imagePrefix: '' };
  }

  convert(doc: DocumentModel, options: BookStackOptions): ConversionResult {
    const r = new BookStackRenderer(doc, options.imagePrefix);
    const main = r.render() + '\n';
    const names = doc.images.map((im) => options.imagePrefix + im.filename);
    const notes = [
      'Copier place du HTML riche dans le presse-papiers : collez-le dans l’éditeur WYSIWYG de BookStack. Le fichier bookstack.html convient au champ « html » de l’API.',
    ];
    if (names.length) notes.push(`Glissez-déposez ensuite les images dans la page (ou via l’API /api/image-gallery) : ${names.join(', ')}`);
    const css = `body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#444;font-size:15px}h1{font-size:2em}h2{font-size:1.6em}h3{font-size:1.3em}
table{border-collapse:collapse}th,td{border:1px solid #ddd;padding:6px 10px}th{background:#f8f8f8}pre{background:#f8f8f8;border:1px solid #ddd;border-radius:4px;padding:10px;font-family:monospace}code{background:#f8f8f8;padding:1px 4px;border-radius:3px;font-family:monospace}a{color:#206ea7}
.callout{border-left:3px solid;padding:8px 12px 8px 36px;margin:12px 0;border-radius:3px;position:relative}.callout::before{position:absolute;left:12px;top:9px;font-weight:700}
.callout.info{border-color:#0288d1;background:#e3f2fd}.callout.info::before{content:'i'}.callout.success{border-color:#2e7d32;background:#e8f5e9}.callout.success::before{content:'✓'}
.callout.warning{border-color:#ef6c00;background:#fff3e0}.callout.warning::before{content:'!'}.callout.danger{border-color:#c62828;background:#ffebee}.callout.danger::before{content:'✕'}`;
    return {
      main,
      mainFilename: 'bookstack.html',
      mimeType: 'text/html; charset=utf-8',
      extraFiles: {},
      clipboard: { 'text/plain': main, 'text/html': main },
      previewHtml: previewShell(doc.metadata.title ?? doc.metadata.sourceFilename, css, main),
      notes,
    };
  }
}

const CALLOUT: Record<string, string> = { warning: 'warning', note: 'info', info: 'info', tip: 'success' };

class BookStackRenderer extends HtmlRenderer {
  constructor(doc: DocumentModel, imagePrefix: string) {
    super(doc, imagePrefix, { warning: 'Attention', note: 'Note', info: 'Info', tip: 'Astuce' });
  }
  override block(b: Parameters<HtmlRenderer['block']>[0]): string {
    if (b.type === 'admonition') {
      const inner = b.blocks.map((x) => (x.type === 'paragraph' ? this.inlines(x.inlines) : this.block(x))).join('<br>');
      return `<p class="callout ${CALLOUT[b.kind]}"><strong>${escapeHtml(b.title ?? '')}</strong>${b.title ? ' ' : ''}${inner}</p>`;
    }
    if (b.type === 'code') return `<pre><code class="language-${escapeHtml(b.language ?? '')}">${escapeHtml(b.text)}</code></pre>`;
    if (b.type === 'image') {
      const base = super.block(b);
      return base.replace(/^<figure>|<\/figure>$/g, '').replace(/<figcaption>(.*)<\/figcaption>$/, '<p><em>$1</em></p>').replace(/^<img/, '<p><img').replace(/>(<p>|$)/, '></p>$1');
    }
    return super.block(b);
  }
}
