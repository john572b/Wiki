import { zipSync, strToU8 } from 'fflate';
import type { Job } from '../pipeline/types';
import { getConverter } from '../converters/registry';

function jobFiles(job: Job, imagePrefix: string): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  const readme: string[] = [`${job.file.name}`, ''];
  for (const out of job.outputs) {
    files[out.result.mainFilename] = strToU8(out.result.main);
    for (const [name, content] of Object.entries(out.result.extraFiles)) files[name] = strToU8(content);
    readme.push(`== ${getConverter(out.formatId).label} ==`, `Fichier : ${out.result.mainFilename}`, ...out.result.notes.map((n) => `- ${n}`), '');
  }
  if (job.doc) {
    for (const im of job.doc.images) files[`images/${imagePrefix}${im.filename}`] = im.data;
    if (job.doc.metadata.warnings.length) readme.push('== Avertissements ==', ...job.doc.metadata.warnings.map((w) => `- ${w.message}`), '');
  }
  files['README.txt'] = strToU8(readme.join('\n'));
  return files;
}

export function zipJob(job: Job, imagePrefix: string): Uint8Array {
  return zipSync(jobFiles(job, imagePrefix), { level: 6 });
}

export function zipBatch(jobs: Job[], imagePrefixFor: (job: Job) => string): Uint8Array {
  const all: Record<string, Uint8Array> = {};
  for (const job of jobs) {
    if (job.status !== 'done') continue;
    for (const [name, data] of Object.entries(jobFiles(job, imagePrefixFor(job)))) all[`${job.slug}/${name}`] = data;
  }
  return zipSync(all, { level: 6 });
}

export function downloadBytes(bytes: Uint8Array, filename: string, mime = 'application/zip'): void {
  const blob = new Blob([bytes as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
