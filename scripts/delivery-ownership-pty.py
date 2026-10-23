"""Capture real native Goal queue/bubble/editor behavior without a model or private UI APIs."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import termios
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--host", type=Path, required=True, help="Exact pi-coding-agent package directory")
parser.add_argument("--node", type=Path, required=True)
parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parent.parent)
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--restore", action="store_true")
parser.add_argument("--tui-mode", choices=["regular", "fullscreen"], default="regular")
args = parser.parse_args()
out = args.output.resolve()
out.mkdir(parents=True, exist_ok=False)
for name in ["home", "project", "agent"]:
    (out / name).mkdir()
trace = out / "events.jsonl"
command = [str(args.node), str(args.host / "dist/bundle/cli.js"), "--offline", "--no-approve",
           "-ne", "-ns", "-np", "-nc", "--no-themes", "--no-mcp", "-nbt", "--tui-mode", args.tui_mode,
           "-e", str(Path(__file__).resolve().with_name("delivery-ownership-provider.ts")),
           "-e", str(args.source / "extensions/index.ts"), "--model", "goal-proof/offline",
           "--session-dir", str(out / "sessions")]
env = {"PATH": str(args.node.parent) + ":/usr/bin:/bin", "HOME": str(out / "home"),
       "PI_CODING_AGENT_DIR": str(out / "agent"), "PI_OFFLINE": "1", "PI_TELEMETRY": "0",
       "TERM": "xterm-256color", "GOAL_PROOF_TRACE": str(trace), "PI_PACKAGE_DIR": str(args.host)}
(out / "invocation.json").write_text(json.dumps({"argv": command, "env": env}, indent=2) + "\n")
pid, fd = pty.fork()
if pid == 0:
    os.chdir(out / "project")
    os.execve(command[0], command, env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 140, 0, 0))
raw = bytearray()
phase_start = 0


def pump(seconds):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        if select.select([fd], [], [], 0.05)[0]:
            try:
                data = os.read(fd, 65536)
            except OSError:
                return
            if not data:
                return
            raw.extend(data)
            # Respond only to terminal capability queries.
            if b"\x1b[6n" in data:
                os.write(fd, b"\x1b[1;1R")
            if b"\x1b[c" in data:
                os.write(fd, b"\x1b[?1;2c")


def capture(name):
    global phase_start
    (out / (name + ".ansi")).write_bytes(raw[phase_start:])
    phase_start = len(raw)


def events():
    return [json.loads(line) for line in trace.read_text().splitlines()] if trace.exists() else []


def wait_for(predicate, label):
    until = time.monotonic() + 30
    while time.monotonic() < until:
        pump(0.1)
        if predicate():
            return
    raise RuntimeError("Timed out waiting for " + label + "; inspect " + str(out))


def send(text):
    os.write(fd, text.encode() + b"\x1b[13u")
    pump(0.5)


try:
    wait_for(lambda: any(e["type"] == "ready" for e in events()), "native session_start")
    pump(0.5)
    capture("startup")
    send("/goal Verify native offline delivery ownership")
    wait_for(lambda: any(e.get("phase") == "held" for e in events()), "held provider request")
    capture("working")
    send("/goal pause")
    send("/goal resume")
    capture("queued-control")
    # Queue real input using native Alt+Enter. Goal controls must not share its row.
    os.write(fd, b"KEEP_QUEUED_NATIVE_USER\x1b[13;3u")
    wait_for(lambda: b"Follow-up: KEEP_QUEUED_NATIVE_USER" in raw, "native genuine follow-up row")
    capture("queued")
    if args.restore:
        os.write(fd, b"KEEP_EXISTING_EDITOR_DRAFT")
        pump(0.2)
        os.write(fd, b"\x1b[1;3A")  # native Alt+Up, not a call to a private restore method
        pump(0.5)
        os.write(fd, b"\x1b[121;6u")  # supported extension shortcut: ctrl+shift+y
        wait_for(lambda: any(e["type"] == "editor-snapshot" for e in events()), "editor snapshot")
        capture("restored-editor")
        os.write(fd, b"\x1b[13u")
        pump(0.5)
        capture("resubmitted")
    send("/proof-release")
    wait_for(lambda: any(e["type"] == "settled" for e in events()), "native final settlement")
    pump(0.5)
    capture("delivered")
    send("/quit")
finally:
    (out / "terminal.ansi").write_bytes(raw)
    ended, status = os.waitpid(pid, os.WNOHANG)
    if not ended:
        os.kill(pid, signal.SIGTERM)
        ended, status = os.waitpid(pid, 0)
    os.close(fd)
    (out / "process-result.json").write_text(json.dumps({"exitCode": os.waitstatus_to_exitcode(status)}) + "\n")

ansi = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))")
queued_control = ansi.sub("", (out / "queued-control.ansi").read_text())
queued = ansi.sub("", (out / "queued.ansi").read_text())
delivered = ansi.sub("", (out / "delivered.ansi").read_text())
editor = [e["text"] for e in events() if e["type"] == "editor-snapshot"]
providers = [e["messages"] for e in events() if e["type"] == "provider"]
provider_text = json.dumps(providers)
forbidden = re.compile(r"<pi_goal_(?:delivery|continuation)\b")
journals = [json.loads(line) for path in (out / "sessions").glob("*.jsonl") for line in path.read_text().splitlines()]
content = [entry.get("content", entry.get("message", {}).get("content")) for entry in journals if entry["type"] in ("message", "custom_message")]
report = {"automatedFollowUpRow": "Follow-up:" in queued_control,
          "genuineFollowUpRow": "Follow-up: KEEP_QUEUED_NATIVE_USER" in queued,
          "opaqueTerminalText": bool(forbidden.search(ansi.sub("", raw.decode(errors="replace")))),
          "opaqueProviderText": bool(forbidden.search(provider_text)),
          "opaqueSavedContent": bool(forbidden.search(json.dumps(content))),
          "genuineInputReachedProvider": "KEEP_QUEUED_NATIVE_USER" in provider_text,
          "restoredEditor": editor,
          "restorationAttempted": args.restore, "exitCode": os.waitstatus_to_exitcode(status)}
report["acceptancePassed"] = (not report["automatedFollowUpRow"] and report["genuineFollowUpRow"] and
    not report["opaqueTerminalText"] and not report["opaqueProviderText"] and not report["opaqueSavedContent"] and
    report["genuineInputReachedProvider"] and report["exitCode"] == 0 and
    (not args.restore or (len(editor) == 1 and "KEEP_QUEUED_NATIVE_USER" in editor[0] and
     "KEEP_EXISTING_EDITOR_DRAFT" in editor[0] and "untrusted_objective" not in editor[0])))
(out / "report.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
if not report["acceptancePassed"]:
    raise SystemExit(1)
