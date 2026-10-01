import type { DocumentModel } from '../model/types';
import type { ConfluenceOptions } from '../converters/confluence';
import { previewShell, escape } from './shell';

const PANEL_LABELS: Record<string, string> = { info: 'Info', note: 'Note', warning: 'Attention', tip: 'Astuce' };

/** Transforme le Storage Format en HTML d'aperçu imitant Confluence. */
export function renderConfluencePreview(storage: string, doc: DocumentModel, _options: ConfluenceOptions): string {
  const html = storageToHtml(storage);
  const css = `
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,sans-serif;color:#172b4d;font-size:14px}
h1{font-size:24px;font-weight:500;margin:30px 0 8px}h2{font-size:20px;font-weight:500;margin:28px 0 8px}h3{font-size:16px;font-weight:600;margin:24px 0 8px}
h4,h5,h6{font-size:14px;font-weight:600;margin:20px 0 6px}
table{border:1px solid #c1c7d0;width:auto}th,td{border:1px solid #c1c7d0;padding:7px 10px;vertical-align:top;min-width:40px}th{background:#f4f5f7;font-weight:600;text-align:left}
pre.code{background:#f4f5f7;border-radius:3px;padding:12px;font-family:SFMono-Medium,'SF Mono',Menlo,Consolas,monospace;font-size:12px;white-space:pre-wrap}
code{background:#f4f5f7;border-radius:3px;padding:1px 4px;font-family:Menlo,Consolas,monospace;font-size:12px}
.panel{border-radius:3px;padding:12px 16px 12px 44px;margin:12px 0;position:relative}
.panel::before{position:absolute;left:14px;top:12px;font-weight:700}
.panel.info{background:#deebff}.panel.info::before{content:'ⓘ';color:#0052cc}
.panel.note{background:#eae6ff}.panel.note::before{content:'✎';color:#403294}
.panel.warning{background:#ffebe6}.panel.warning::before{content:'⚠';color:#de350b}
.panel.tip{background:#e3fcef}.panel.tip::before{content:'✔';color:#006644}
.panel-title{font-weight:600;margin-bottom:4px}
.toc{border:1px solid #dfe1e6;padding:8px 12px;background:#fafbfc;margin-bottom:12px;color:#5e6c84}
img{max-width:100%;border:1px solid #dfe1e6;border-radius:3px}
a{color:#0052cc}
blockquote{border-left:2px solid #dfe1e6;margin:0;padding-left:16px;color:#5e6c84}
`;
  return previewShell(doc.metadata.title ?? doc.metadata.sourceFilename, css, html);
}

export function storageToHtml(storage: string): string {
  let s = storage;
  s = s.replace(/<ac:structured-macro ac:name="toc"\s*\/>/g, '<div class="toc">Table des matières (macro)</div>');
  // Blocs de code
  s = s.replace(
    /<ac:structured-macro ac:name="code">(?:<ac:parameter ac:name="language">([^<]*)<\/ac:parameter>)?<ac:plain-text-body><!\[CDATA\[([\s\S]*?)\]\]><\/ac:plain-text-body><\/ac:structured-macro>/g,
    (_m, lang: string | undefined, body: string) => `<pre class="code" data-lang="${escape(lang ?? '')}">${escape(body.replace(/\]\]\]\]><!\[CDATA\[>/g, ']]>'))}</pre>`,
  );
  // Panneaux
  s = s.replace(
    /<ac:structured-macro ac:name="(info|note|warning|tip)">(?:<ac:parameter ac:name="title">([^<]*)<\/ac:parameter>)?<ac:rich-text-body>([\s\S]*?)<\/ac:rich-text-body><\/ac:structured-macro>/g,
    (_m, kind: string, title: string | undefined, body: string) =>
      `<div class="panel ${kind}"><div class="panel-title">${title ?? PANEL_LABELS[kind]}</div>${body}</div>`,
  );
  // Images
  s = s.replace(
    /<ac:image([^>]*)><ri:attachment ri:filename="([^"]+)"\s*\/><\/ac:image>/g,
    (_m, attrs: string, name: string) => {
      const alt = /ac:alt="([^"]*)"/.exec(attrs)?.[1] ?? name;
      const width = /ac:width="(\d+)"/.exec(attrs)?.[1];
      return `<img src="images/${encodeURIComponent(name)}" alt="${alt}"${width ? ` width="${width}"` : ''}>`;
    },
  );
  return s;
}
