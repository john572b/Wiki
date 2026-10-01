import type { DocumentModel } from '../model/types';
import type { MediaWikiOptions } from '../converters/mediawiki';
import { previewShell } from './shell';

/**
 * Rendu HTML approximatif du wikitext produit par le convertisseur MediaWiki.
 * Il ne couvre que le sous-ensemble de syntaxe que nous émettons (c'est un aperçu, pas un parseur complet).
 */
export function renderMediaWikiPreview(wikitext: string, doc: DocumentModel, options: MediaWikiOptions): string {
  const html = wikitextToHtml(wikitext, { fileNamespace: options.fileNamespace, imagePrefix: options.imagePrefix });
  const css = `
body{font-family:sans-serif;color:#202122}
h1,h2,h3,h4,h5,h6{font-family:'Linux Libertine','Georgia','Times',serif;font-weight:normal;margin:1em 0 .25em;border-bottom:1px solid #a2a9b1;padding-bottom:2px}
h3,h4,h5,h6{font-family:sans-serif;font-weight:bold;border-bottom:none}
.wikitable{background:#f8f9fa;border:1px solid #a2a9b1;color:#202122}
.wikitable th,.wikitable td{border:1px solid #a2a9b1;padding:.2em .4em}
.wikitable th{background:#eaecf0;text-align:center}
.thumb{float:right;clear:right;margin:.5em 0 1.3em 1.4em;border:1px solid #c8ccd1;background:#f8f9fa;padding:3px;max-width:300px;font-size:88%}
.thumb img{display:block;max-width:100%}
.thumbcaption{padding:3px}
pre,.mw-code{background:#f8f9fa;border:1px solid #eaecf0;padding:1em;font-family:monospace;white-space:pre-wrap}
code{background:#f8f9fa;border:1px solid #eaecf0;padding:1px 4px;font-family:monospace}
a{color:#36c;text-decoration:none}
blockquote{border-left:4px solid #eaecf0;margin:1em 0;padding:0 1em;color:#54595d}
.catlinks{border:1px solid #a2a9b1;background:#f8f9fa;padding:5px;margin-top:1em;clear:both;font-size:90%}
.wc-admonition{clear:both}
`;
  const cats = options.categories.length ? `<div class="catlinks">Catégories : ${options.categories.map(escapeHtml).join(' | ')}</div>` : '';
  return previewShell(doc.metadata.title ?? doc.metadata.sourceFilename, css, `<div class="mw-parser-output">${html}</div>${cats}`);
}

interface Ctx { fileNamespace: string; imagePrefix: string }

export function wikitextToHtml(src: string, ctx: Ctx): string {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join('\n'), ctx)}</p>`);
      para = [];
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    if (/^__(NO)?TOC__$/.test(line.trim())) { i++; continue; }
    if (/^\[\[Category:/.test(line)) { i++; continue; }
    const h = /^(={2,6})\s*(.*?)\s*\1\s*$/.exec(line);
    if (h) {
      flushPara();
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2], ctx)}</h${level}>`);
      i++;
      continue;
    }
    if (/^----\s*$/.test(line)) { flushPara(); out.push('<hr>'); i++; continue; }
    if (/^\{\|/.test(line)) {
      flushPara();
      const tbl: string[] = [];
      while (i < lines.length && !/^\|\}/.test(lines[i])) tbl.push(lines[i++]);
      i++;
      out.push(table(tbl, ctx));
      continue;
    }
    const sh = /^<(syntaxhighlight|pre)([^>]*)>(.*)$/.exec(line);
    if (sh) {
      flushPara();
      const buf: string[] = [];
      let rest = sh[3];
      const closeRe = new RegExp(`</${sh[1]}>`);
      if (closeRe.test(rest)) {
        buf.push(rest.replace(closeRe, ''));
      } else {
        if (rest) buf.push(rest);
        i++;
        while (i < lines.length && !closeRe.test(lines[i])) buf.push(lines[i++]);
        if (i < lines.length) buf.push(lines[i].replace(closeRe, ''));
      }
      i++;
      const code = sh[1] === 'pre' ? buf.join('\n') : escapeHtml(buf.join('\n'));
      out.push(`<pre class="mw-code">${code.replace(/^\n/, '')}</pre>`);
      continue;
    }
    if (/^[*#]/.test(line)) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length && /^[*#:]/.test(lines[i])) items.push(lines[i++]);
      out.push(list(items, ctx));
      continue;
    }
    if (/^\[\[(File|Fichier|Image):/i.test(line)) {
      flushPara();
      out.push(inline(line, ctx));
      i++;
      continue;
    }
    if (/^<(div|blockquote)[^>]*>/.test(line) || /^<\/(div|blockquote)>/.test(line)) {
      flushPara();
      out.push(line);
      i++;
      continue;
    }
    if (line.trim() === '') { flushPara(); i++; continue; }
    para.push(line);
    i++;
  }
  flushPara();
  return out.join('\n');
}

function list(items: string[], ctx: Ctx): string {
  // Construit un arbre à partir des préfixes *, #, : .
  let html = '';
  const stack: string[] = [];
  for (const raw of items) {
    const m = /^([*#:]+)\s?(.*)$/.exec(raw)!;
    const prefix = m[1];
    const content = m[2];
    let common = 0;
    while (common < stack.length && common < prefix.length && stack[common] === prefix[common]) common++;
    while (stack.length > common) {
      const c = stack.pop()!;
      html += c === '#' ? '</li></ol>' : c === '*' ? '</li></ul>' : '</dd></dl>';
    }
    for (let k = common; k < prefix.length; k++) {
      const c = prefix[k];
      if (k < prefix.length - 1) {
        html += c === '#' ? '<ol><li>' : c === '*' ? '<ul><li>' : '<dl><dd>';
      } else {
        html += c === '#' ? '<ol>' : c === '*' ? '<ul>' : '<dl>';
      }
      stack.push(c);
    }
    if (common === prefix.length && stack.length) {
      const c = stack[stack.length - 1];
      html += c === ':' ? '</dd>' : '</li>';
    }
    const c = prefix[prefix.length - 1];
    html += (c === ':' ? '<dd>' : '<li>') + inline(content, ctx);
  }
  while (stack.length) {
    const c = stack.pop()!;
    html += c === '#' ? '</li></ol>' : c === '*' ? '</li></ul>' : '</dd></dl>';
  }
  return html;
}

function table(lines: string[], ctx: Ctx): string {
  let html = '<table class="wikitable">';
  let rowOpen = false;
  for (const l of lines.slice(1)) {
    if (/^\|\+/.test(l)) { html += `<caption>${inline(l.slice(2).trim(), ctx)}</caption>`; continue; }
    if (/^\|-/.test(l)) { if (rowOpen) html += '</tr>'; html += '<tr>'; rowOpen = true; continue; }
    const m = /^([!|])\s?(?:([^|]*?)\s\|\s?)?(.*)$/.exec(l);
    if (!m) continue;
    if (!rowOpen) { html += '<tr>'; rowOpen = true; }
    const tag = m[1] === '!' ? 'th' : 'td';
    const attrs = m[2] ? ' ' + m[2].trim() : '';
    html += `<${tag}${attrs}>${inline(m[3].replace(/^<nowiki\/>/, ''), ctx)}</${tag}>`;
  }
  if (rowOpen) html += '</tr>';
  return html + '</table>';
}

function inline(s: string, ctx: Ctx): string {
  const nowikis: string[] = [];
  s = s.replace(/<nowiki>([\s\S]*?)<\/nowiki>/g, (_m, c) => { nowikis.push(c); return `\u0000${nowikis.length - 1}\u0000`; });
  s = s.replace(/<nowiki\s*\/>/g, '');
  // Images
  const fileRe = new RegExp(`\\[\\[(?:${ctx.fileNamespace}|File|Fichier|Image):([^|\\]]+)((?:\\|[^\\]]*)*)\\]\\]`, 'g');
  s = s.replace(fileRe, (_m, name: string, rest: string) => {
    const parts = rest.split('|').slice(1);
    const caption = parts.filter((p) => !/^(thumb|frame|frameless|border|left|right|center|none|\d+px)$/.test(p)).join('|');
    const file = name.trim();
    return `<div class="thumb"><img src="images/${encodeURIComponent(file)}" alt="${escapeHtml(caption)}"><div class="thumbcaption">${caption}</div></div>`;
  });
  s = s.replace(/\[((?:https?|ftp|mailto):[^\s\]]+)(?:\s+([^\]]*))?\]/g, (_m, href: string, label?: string) => `<a href="${escapeHtml(href)}">${label ?? href}</a>`);
  s = s.replace(/'''([\s\S]+?)'''/g, '<b>$1</b>').replace(/''([\s\S]+?)''/g, '<i>$1</i>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, idx) => nowikis[Number(idx)]);
  return s.replace(/\n/g, ' ');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
