'use client';

/**
 * Share a document's PDF as an actual FILE (not a link) via the Web Share
 * API — on a phone this opens the native share sheet (WhatsApp, email, …)
 * with the PDF attached, named after the document (e.g. `ABN-000001.pdf`,
 * `EST0001.pdf`). Falls back to downloading the named file when file-level
 * sharing isn't supported (most desktop browsers), and to opening the PDF
 * if even that fails.
 *
 * `url` is the backend PDF endpoint; `docNumber` is the invoice/estimate
 * number used as the filename and share title.
 */
export async function sharePdfFile(
  url: string,
  docNumber: string,
  onError?: (message: string) => void,
): Promise<void> {
  const safe = (docNumber || 'document').replace(/[^\w.-]+/g, '-');
  const filename = `${safe}.pdf`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not fetch the PDF (${res.status}).`);
    const blob = await res.blob();
    const file = new File([blob], filename, { type: 'application/pdf' });

    const nav = navigator as Navigator & {
      canShare?: (data?: ShareData) => boolean;
      share?: (data?: ShareData) => Promise<void>;
    };

    // Preferred path — share the file itself through the OS share sheet.
    if (nav.canShare && nav.share && nav.canShare({ files: [file] })) {
      await nav.share({ files: [file], title: docNumber });
      return;
    }

    // Fallback — download the named file so the user can attach it manually.
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 5000);
  } catch (e: any) {
    // The user dismissing the share sheet throws AbortError — not an error.
    if (e?.name === 'AbortError') return;
    onError?.(e?.message || 'Could not share the file.');
    // Last resort so the operator can still get the document.
    window.open(url, '_blank');
  }
}
