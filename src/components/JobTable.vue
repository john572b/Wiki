<script setup lang="ts">
import type { Job } from '../pipeline/types';
import { STATUS_LABELS } from '../pipeline/types';
import { getConverter } from '../converters/registry';

defineProps<{ jobs: Job[]; formats: string[] }>();

function kindLabel(j: Job): string {
  return { pdf: 'PDF', docx: 'DOCX', image: 'Image', doc: 'DOC', zip: 'ZIP', unknown: '?' }[j.kind];
}
function dotClass(j: Job): string {
  if (j.status === 'pending') return 'pending';
  if (j.status === 'done') return 'done';
  if (j.status === 'error') return 'error';
  return 'working';
}
function formatCell(j: Job, f: string): string {
  if (j.status === 'error') return '✗';
  if (j.status === 'done') return j.outputs.some((o) => o.formatId === f) ? '✓' : '—';
  return '◌';
}
function ocrCell(j: Job): string {
  if (j.ocrUsed === null || j.ocrUsed === undefined) return j.status === 'pending' ? '?' : '…';
  return j.ocrUsed ? '✓' : '—';
}
</script>

<template>
  <table class="jobs" aria-label="Traitements">
    <thead>
      <tr>
        <th>Fichier</th>
        <th>Type</th>
        <th>OCR</th>
        <th v-for="f in formats" :key="f">{{ getConverter(f).label }}</th>
        <th>Statut</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="j in jobs" :key="j.id" :data-job-status="j.status" :data-job-name="j.file.name">
        <td>{{ j.file.name }}</td>
        <td>{{ kindLabel(j) }}</td>
        <td>{{ ocrCell(j) }}</td>
        <td v-for="f in formats" :key="f">{{ formatCell(j, f) }}</td>
        <td>
          <span class="status"><span class="dot" :class="dotClass(j)"></span>{{ STATUS_LABELS[j.status] }}<span v-if="j.detail && j.status !== 'error'" class="muted"> ({{ j.detail }})</span></span>
          <div v-if="j.status === 'error'" class="err">{{ j.errorMessage }}</div>
        </td>
      </tr>
    </tbody>
  </table>
</template>
