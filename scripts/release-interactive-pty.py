#!/usr/bin/env python3
"""Exercise the packaged /goal command in an isolated real Pi terminal and retain evidence."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import tarfile
import termios

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--node", type=Path, required=True)
parser.add_argument("--host", type=Path, required=True, help="Exact installed pi-coding-agent package directory")
parser.add_argument("--candidate", type=Path, required=True, help="Candidate npm tarball")
parser.add_argument("--output", type=Path, required=True, help="New private evidence directory")
parser.add_argument("--model", default="openrouter/openrouter/auto")
args = parser.parse_args()
node = args.node.resolve()
host = args.host.resolve()
candidate = args.candidate.resolve()
out = args.output.resolve()
cli = host / "dist/bundle/cli.js"
if not os.environ.get("OPENROUTER_API_KEY"):
    raise SystemExit("OPENROUTER_API_KEY is required for the live model proof")
with tarfile.open(candidate, "r:gz") as archive:
    package = json.load(archive.extractfile("package/package.json"))
if package["name"] != "pi-codex-goal":
    raise SystemExit("Candidate is not pi-codex-goal")

out.mkdir(parents=True, exist_ok=False, mode=0o700)
for name in ("home", "agent", "project", "sessions", "tmp", "cache"):
    (out / name).mkdir()
for name in ("user.npmrc", "global.npmrc"):
    (out / name).touch()
env = {
    "HOME": str(out / "home"),
    "TMPDIR": str(out / "tmp"),
    "PATH": str(node.parent) + os.pathsep + os.environ.get("PATH", "/usr/bin:/bin"),
    "LANG": "C.UTF-8",
    "TERM": "xterm-256color",
    "PI_CODING_AGENT_DIR": str(out / "agent"),
    "PI_OFFLINE": "1",
    "PI_TELEMETRY": "0",
    "OPENROUTER_API_KEY": os.environ["OPENROUTER_API_KEY"],
    "NPM_CONFIG_USERCONFIG": str(out / "user.npmrc"),
    "NPM_CONFIG_GLOBALCONFIG": str(out / "global.npmrc"),
    "NPM_CONFIG_REGISTRY": "https://registry.npmjs.org/",
    "NPM_CONFIG_CACHE": str(out / "cache"),
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_NOSYSTEM": "1",
}
install = [str(node), str(cli), "install", "-l", "--approve", f"npm:pi-codex-goal@file:{candidate}"]
result = subprocess.run(install, cwd=out / "project", env=env, text=True, capture_output=True)
(out / "install.log").write_text(result.stdout + result.stderr)
if result.returncode:
    raise SystemExit(f"Candidate install failed; inspect {out / 'install.log'}")
installed = out / "project/.pi/npm/node_modules/pi-codex-goal/package.json"
if json.loads(installed.read_text())["version"] != package["version"]:
    raise SystemExit("Installed version differs from the candidate")

file = out / "goal-smoke.txt"
prompt = (
    f"/goal Create {file} containing PI_GOAL_RELEASE_OK. Verify its content using the read tool, "
    "inspect the current goal, then mark the goal complete using update_goal. Your final reply "
    "must state the verified path, verified content, and final goal status."
)
command = [str(node), str(cli), "--model", args.model, "--thinking", "low", "--tui-mode", "regular",
           "--approve", "--no-mcp", "--no-context-files", "--no-skills",
           "--tools", "read,write,get_goal,create_goal,update_goal", "--session-dir", str(out / "sessions")]
(out / "submitted-command.txt").write_text(prompt + "\n")
(out / "invocation.json").write_text(json.dumps({
    "argv": command,
    "hostVersion": json.loads((host / "package.json").read_text())["version"],
    "hostCliSha256": hashlib.sha256(cli.read_bytes()).hexdigest(),
    "candidateVersion": package["version"],
    "candidateSha256": hashlib.sha256(candidate.read_bytes()).hexdigest(),
    "model": args.model,
}, indent=2) + "\n")

pid, fd = pty.fork()
if pid == 0:
    os.chdir(out / "project")
    os.execve(str(node), command, env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
raw = bytearray()
child_status = None


def pump():
    if select.select([fd], [], [], 0.1)[0]:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            return
        raw.extend(chunk)
        if b"\x1b[6n" in chunk:
            os.write(fd, b"\x1b[1;1R")
        if b"\x1b[c" in chunk:
            os.write(fd, b"\x1b[?1;2c")


def rows():
    sessions = list((out / "sessions").glob("*.jsonl"))
    if len(sessions) != 1:
        return []
    try:
        return [json.loads(line) for line in sessions[0].read_text().splitlines() if line]
    except (OSError, json.JSONDecodeError):
        return []


def finished():
    entries = rows()
    completed = any(entry.get("type") == "custom" and entry.get("customType") == "pi-codex-goal"
                    and entry.get("data", {}).get("source") == "tool"
                    and entry.get("data", {}).get("goal", {}).get("status") == "complete" for entry in entries)
    messages = [entry["message"] for entry in entries if entry.get("type") == "message"]
    assistants = [message for message in messages if message.get("role") == "assistant"]
    if not completed or not assistants:
        return False
    last = assistants[-1]
    return last.get("stopReason") == "stop"


def wait_for(predicate, label):
    global child_status
    while True:
        pump()
        if predicate():
            return
        ended, status = os.waitpid(pid, os.WNOHANG)
        if ended:
            child_status = status
            raise RuntimeError(f"Pi exited before {label}; inspect {out}")


passed = False
try:
    wait_for(lambda: b"pi-codex-goal@file:" in raw, "the installed extension to load")
    os.write(fd, prompt.encode() + b"\x1b[13u")
    wait_for(finished, "the live interactive goal to complete")
    entries = rows()
    messages = [entry["message"] for entry in entries if entry.get("type") == "message"]
    assert any(entry.get("type") == "custom" and entry.get("customType") == "pi-codex-goal"
               and entry.get("data", {}).get("source") == "command"
               and entry.get("data", {}).get("goal", {}).get("objective") == prompt.removeprefix("/goal ")
               for entry in entries), "the /goal command was not recorded"
    assert any(entry.get("type") == "custom_message" and entry.get("customType") == "pi-codex-goal"
               and entry.get("details", {}).get("kind") == "command_start"
               for entry in entries), "the hidden command continuation was not delivered"
    calls = [(index, part) for index, entry in enumerate(entries) if entry.get("type") == "message"
             and entry["message"].get("role") == "assistant"
             for part in entry["message"].get("content", []) if part.get("type") == "toolCall"]
    results = {entry["message"].get("toolCallId"): (index, entry["message"])
               for index, entry in enumerate(entries) if entry.get("type") == "message"
               and entry["message"].get("role") == "toolResult"}

    def successful(name, predicate):
        for call_index, call in calls:
            result_index, result = results.get(call.get("id"), (-1, {}))
            if (call.get("name") == name and result.get("toolName") == name and result_index > call_index
                    and predicate(call.get("arguments", {}), result) and not result.get("isError")):
                return call_index, result_index, result
        raise AssertionError(f"Missing successful {name} evidence")

    _, read_index, _ = successful("read", lambda arguments, result: arguments.get("path") == str(file)
                                  and any(part.get("text", "").strip() == "PI_GOAL_RELEASE_OK"
                                          for part in result.get("content", [])))
    _, goal_index, goal = successful("get_goal", lambda _arguments, result: bool(result.get("content")))
    update_index, _, update = successful("update_goal", lambda arguments, result: arguments.get("status") == "complete"
                                         and bool(result.get("content")))
    assert read_index < update_index, "completion was requested before filesystem verification"
    assert goal_index < update_index, "completion was requested before inspecting the current goal"
    assert json.loads(goal["content"][0]["text"])["goal"]["status"] == "active"
    assert json.loads(update["content"][0]["text"])["goal"]["status"] == "complete"
    observed_content = file.read_text()
    assert observed_content.strip() == "PI_GOAL_RELEASE_OK", "filesystem content did not match"
    last = [message for message in messages if message.get("role") == "assistant"][-1]
    assert last.get("provider") == "openrouter", "the requested live provider was not used"
    final = "\n".join(part.get("text", "") for part in last.get("content", []) if part.get("type") == "text")
    assert str(file) in final and "PI_GOAL_RELEASE_OK" in final and "complet" in final.lower()
    session = next((out / "sessions").glob("*.jsonl"))
    report = {"candidateSha256": hashlib.sha256(candidate.read_bytes()).hexdigest(),
              "candidateVersion": package["version"], "model": args.model, "provider": last.get("provider"),
              "observedModel": last.get("model"),
              "responseModels": sorted({message["responseModel"] for message in messages
                                        if message.get("role") == "assistant" and message.get("responseModel")}),
              "command": prompt, "session": str(session),
              "verifiedFile": str(file), "content": observed_content, "goalStatus": "complete", "final": final}
    (out / "verification.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    passed = True
finally:
    if child_status is None:
        ended, status = os.waitpid(pid, os.WNOHANG)
        if ended:
            child_status = status
        elif passed:
            try:
                os.write(fd, b"/quit\x1b[13u")
            except OSError:
                pass
            while not ended:
                pump()
                ended, status = os.waitpid(pid, os.WNOHANG)
            child_status = status
        else:
            os.kill(pid, signal.SIGTERM)
            _, child_status = os.waitpid(pid, 0)
    os.close(fd)
    (out / "terminal.ansi").write_bytes(raw)
    (out / "process-result.json").write_text(json.dumps({"exitCode": os.waitstatus_to_exitcode(child_status)}) + "\n")
if os.waitstatus_to_exitcode(child_status) != 0:
    raise RuntimeError(f"Pi did not exit cleanly; inspect {out / 'process-result.json'}")
