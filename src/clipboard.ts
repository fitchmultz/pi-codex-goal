import { spawn } from "node:child_process";

export interface ClipboardCopyResult {
  ok: boolean;
  message?: string;
}

interface ClipboardCommand {
  command: string;
  args: string[];
}

const CLIPBOARD_TIMEOUT_MS = 5_000;

function clipboardCommandsForPlatform(platform: NodeJS.Platform): ClipboardCommand[] {
  if (platform === "darwin") {
    return [{ command: "pbcopy", args: [] }];
  }

  if (platform === "win32") {
    return [
      { command: "clip.exe", args: [] },
      {
        command: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Set-Clipboard -Value ([Console]::In.ReadToEnd())",
        ],
      },
    ];
  }

  return [
    { command: "wl-copy", args: [] },
    { command: "xclip", args: ["-selection", "clipboard"] },
    { command: "xsel", args: ["--clipboard", "--input"] },
  ];
}

function runClipboardCommand(
  { command, args }: ClipboardCommand,
  text: string,
): Promise<ClipboardCopyResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "pipe"] });
    let settled = false;
    let stderr = "";

    const finish = (result: ClipboardCopyResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    const timeout = setTimeout(() => {
      child.kill();
      finish({ ok: false, message: `${command} timed out` });
    }, CLIPBOARD_TIMEOUT_MS);

    child.on("error", (error) => {
      finish({ ok: false, message: error.message });
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.stdin.on("error", () => {
      // Some clipboard commands close stdin early after accepting input. The
      // process exit code decides success.
    });

    child.on("close", (code) => {
      if (code === 0) {
        finish({ ok: true });
        return;
      }
      const detail = stderr.trim();
      finish({
        ok: false,
        message:
          detail.length > 0
            ? `${command}: ${detail}`
            : `${command} exited with code ${code ?? "unknown"}`,
      });
    });

    child.stdin.end(text);
  });
}

export async function copyTextToClipboard(text: string): Promise<ClipboardCopyResult> {
  const commands = clipboardCommandsForPlatform(process.platform);
  const failures: string[] = [];

  for (const command of commands) {
    const result = await runClipboardCommand(command, text);
    if (result.ok) {
      return result;
    }
    failures.push(
      `${command.command}${result.message !== undefined && result.message.length > 0 ? ` (${result.message})` : ""}`,
    );
  }

  return {
    ok: false,
    message: `No clipboard command succeeded. Tried: ${failures.join(", ")}`,
  };
}
