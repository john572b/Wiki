<script setup lang="ts">
import type { Job, JobOutput } from '../pipeline/types';
import { getConverter } from '../converters/registry';
import { copyToClipboard } from '../util/clipboard';
import { downloadBytes, zipImages, zipJob } from '../export/zip';
import { imageBaseNameFrom } from '../model/normalize';

const props = defineProps<{ job: Job; imagePrefix: string }>();
const emit = defineEmits<{ preview: [output: JobOutput]; toast: [msg: string] }>();

async function copy(o: JobOutput) {
  const mode = await copyToClipboard(o.result.clipboard);
  const n = props.job.doc?.images.length ?? 0;
  emit('toast', (mode === 'rich' ? 'Copié (HTML riche)' : 'Copié') + (n ? ` — ${n} image(s) à téléverser` : ''));
}
function download() {
  downloadBytes(zipJob(props.job, props.imagePrefix), `${props.job.slug}.zip`);
}
function downloadImages() {
  downloadBytes(zipImages(props.job, props.imagePrefix), `${imageBaseNameFrom(props.job.file.name)} - images.zip`);
}
function downloadOne(o: JobOutput) {
  downloadBytes(new TextEncoder().encode(o.result.main), `${props.job.slug}-${o.result.mainFilename}`, o.result.mimeType);
}
</script>

<template>
  <div class="result" :data-result-name="job.file.name">
    <div class="title">
      {{ job.file.name }}
      <span class="muted" style="font-weight: normal">
        · {{ { pdf: 'PDF', docx: 'DOCX', image: 'Image' }[job.kind as 'pdf' | 'docx' | 'image'] }}
        <template v-if="job.doc?.metadata.pageCount"> · {{ job.doc.metadata.pageCount }} page(s)</template>
        <template v-if="job.doc?.metadata.ocr.used"> · OCR sur {{ job.doc.metadata.ocr.pages.length }} page(s)</template>
        <template v-if="job.doc?.images.length"> · {{ job.doc.images.length }} image(s)</template>
      </span>
    </div>
    <div v-for="o in job.outputs" :key="o.formatId" class="fmt">
      <span>✓ {{ getConverter(o.formatId).label }}</span>
      <button class="small" @click="emit('preview', o)">Prévisualiser</button>
      <button class="small primary" @click="copy(o)">Copier</button>
      <button class="small" @click="downloadOne(o)">{{ o.result.mainFilename }}</button>
    </div>
    <ul v-if="job.doc?.metadata.warnings.length" class="notes warn">
      <li v-for="(w, i) in job.doc.metadata.warnings" :key="i">⚠ {{ w.message }}</li>
    </ul>
    <div v-if="job.doc?.images.length" class="notes">
      Images à téléverser dans le wiki, déjà nommées comme dans le texte : {{ job.doc.images.map((im) => imagePrefix + im.filename).join(', ') }}
    </div>
    <div class="fmt" style="margin-top: 6px">
      <button v-if="job.doc?.images.length" class="small primary" @click="downloadImages">Pack d’images ({{ job.doc.images.length }})</button>
      <button class="small" @click="download">Tout ({{ job.slug }}.zip)</button>
    </div>
  </div>
</template>
