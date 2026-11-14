export interface ClipboardCopyResult {
  ok: boolean;
  message?: string;
}

let copyToClipboardPromise: Promise<(text: string) => Promise<void>> | undefined;

function loadCopyToClipboard(): Promise<(text: string) => Promise<void>> {
  copyToClipboardPromise ??= import("@earendil-works/pi-coding-agent").then(
    (mod) => mod.copyToClipboard,
    (error: unknown) => {
      copyToClipboardPromise = undefined;
      throw error;
    },
  );
  return copyToClipboardPromise;
}

export async function copyTextToClipboard(text: string): Promise<ClipboardCopyResult> {
  try {
    const copyToClipboard = await loadCopyToClipboard();
    await copyToClipboard(text);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
