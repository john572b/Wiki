import type { DocumentModel } from '../model/types';
import type { OcrEngine } from '../ocr/engine';
import { preprocessForOcr } from '../ocr/engine';
import { ocrPagesToBlocks } from '../ocr/structure';
import { recognizeWithLayout } from '../ocr/layout';
import { decodeImage, makeImageAsset } from '../util/image';

export interface ImageParseOptions {
  sourceFilename: string;
  mime: string;
  ocr: OcrEngine | null;
  /** Placer l'image avant le texte OCR (défaut) ou après. */
  imageFirst?: boolean;
  langs: string[];
  onStage?: (stage: 'ocr') => void;
}

export async function parseImage(buffer: ArrayBuffer, opts: ImageParseOptions): Promise<DocumentModel> {
  const data = new Uint8Array(buffer);
  const asset = await makeImageAsset('img-1', data, opts.mime, { index: 1 });
  if (!asset) throw new Error('IMAGE_UNREADABLE');
  const doc: DocumentModel = {
    schemaVersion: '1',
    metadata: {
      title: null,
      sourceFilename: opts.sourceFilename,
      sourceKind: 'image',
      pageCount: 1,
      ocr: { used: false, pages: [] },
      language: null,
      warnings: [],
    },
    images: [asset],
    blocks: [],
  };
  const imageBlock = { type: 'image' as const, imageId: asset.id, alt: opts.sourceFilename };
  let textBlocks: DocumentModel['blocks'] = [];
  if (opts.ocr) {
    opts.onStage?.('ocr');
    const dec = await decodeImage(asset.data, asset.mime);
    if (dec) {
      try {
        const canvas = preprocessForOcr(dec.bitmap);
        const pages = await recognizeWithLayout(opts.ocr, canvas);
        textBlocks = ocrPagesToBlocks(pages);
        const conf = pages.length ? pages.reduce((s, p) => s + p.meanConfidence, 0) / pages.length : 0;
        doc.metadata.ocr = { used: true, pages: [1], engine: opts.ocr.id, langs: opts.langs, meanConfidence: conf };
        if (conf < 50) doc.metadata.warnings.push({ code: 'OCR_LOW_CONFIDENCE', message: `Confiance OCR faible (${Math.round(conf)} %). Vérifiez le texte.` });
      } finally {
        dec.bitmap.close();
      }
    }
  }
  doc.blocks = opts.imageFirst === false ? [...textBlocks, imageBlock] : [imageBlock, ...textBlocks];
  return doc;
}
