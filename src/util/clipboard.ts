/** Copie texte (et HTML riche si fourni) dans le presse-papiers. Nécessite HTTPS et un geste utilisateur. */
export async function copyToClipboard(payload: { 'text/plain': string; 'text/html'?: string }): Promise<'rich' | 'plain'> {
  const html = payload['text/html'];
  if (html && typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([payload['text/plain']], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        }),
      ]);
      return 'rich';
    } catch {
      /* repli texte brut */
    }
  }
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(payload['text/plain']);
    return 'plain';
  }
  const ta = document.createElement('textarea');
  ta.value = payload['text/plain'];
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
  return 'plain';
}
