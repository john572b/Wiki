import { marked } from 'marked';
import type { DocumentModel } from '../model/types';
import { parseHtml } from './html';

/** Markdown (CommonMark + GFM : tableaux, listes de tâches, alertes) → HTML local → DocumentModel. */
export async function parseMarkdown(text: string, opts: { sourceFilename: string }): Promise<DocumentModel> {
  // Front matter YAML éventuel : ignoré.
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, '');
  const html = marked.parse(body, { gfm: true, breaks: false, async: false }) as string;
  const doc = await parseHtml(html, { sourceFilename: opts.sourceFilename, sourceKind: 'markdown' });
  doc.metadata.title = null;
  return doc;
}
