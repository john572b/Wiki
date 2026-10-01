import type { Block, DocumentModel, ImageAsset } from '../../src/model/types';

export function makeDoc(blocks: Block[], images: ImageAsset[] = [], title: string | null = null): DocumentModel {
  return {
    schemaVersion: '1',
    metadata: {
      title,
      sourceFilename: 'test.docx',
      sourceKind: 'docx',
      pageCount: null,
      ocr: { used: false, pages: [] },
      language: null,
      warnings: [],
    },
    images,
    blocks,
  };
}

export function fakeImage(id: string, filename: string): ImageAsset {
  return { id, filename, mime: 'image/png', width: 10, height: 10, sha256: id, data: new Uint8Array([1, 2, 3]) };
}
