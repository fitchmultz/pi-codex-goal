import { copyToClipboard } from "@earendil-works/pi-coding-agent";

export interface ClipboardCopyResult {
  ok: boolean;
  message?: string;
}

export async function copyTextToClipboard(text: string): Promise<ClipboardCopyResult> {
  try {
    await copyToClipboard(text);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
