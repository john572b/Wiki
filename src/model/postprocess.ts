import type { Block } from './types';

const plain = (b: Block): string =>
  b.type === 'paragraph' || b.type === 'heading'
    ? b.inlines.map((i) => i.text ?? (i.type === 'link' ? (i.children ?? []).map((c) => c.text ?? '').join('') : '')).join('')
    : '';

/** Une suite d'au moins trois paragraphes courts sans ponctuation finale (compétences, contacts…) devient une liste. */
export function shortRunsToLists(blocks: Block[]): Block[] {
  const out: Block[] = [];
  let run: Block[] = [];
  const isShort = (b: Block) => {
    if (b.type !== 'paragraph' || b.inlines.some((i) => i.type === 'br')) return false;
    const t = plain(b);
    return t.length <= 45 && !/[.!?;:]$/.test(t) && t.trim().split(/\s+/).length <= 6;
  };
  const flush = () => {
    if (run.length >= 3) out.push({ type: 'list', ordered: false, items: run.map((b) => ({ blocks: [b] })) });
    else out.push(...run);
    run = [];
  };
  for (const b of blocks) {
    if (isShort(b)) run.push(b);
    else { flush(); out.push(b); }
  }
  flush();
  return out;
}

/** Fusionne deux titres consécutifs courts en majuscules (nom coupé sur deux lignes). */
export function mergeSplitHeadings(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    const last = out[out.length - 1];
    if (last && last.type === 'heading' && b.type === 'heading' && last.level === b.level) {
      const a = plain(last), c = plain(b);
      if (a.length <= 20 && c.length <= 20 && /^[A-ZÀ-Ý0-9 .'-]+$/.test(a) && /^[A-ZÀ-Ý0-9 .'-]+$/.test(c)) {
        last.inlines = [{ type: 'text', text: `${a} ${c}` }];
        last.level = Math.min(last.level, b.level);
        continue;
      }
    }
    out.push(b);
  }
  return out;
}
