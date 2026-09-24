import errno
import fcntl
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time


SOURCE = Path(sys.argv[1]).resolve()
PATH = "/usr/bin:/bin"
assert shutil.which("bun", path=PATH) is None, "Smoke-test PATH must not contain Bun"


def trial(binary, project, mode):
    master, slave = pty.openpty()
    original = termios.tcgetattr(slave)
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
    child = subprocess.Popen(
        [str(binary)],
        cwd=project,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        env={"HOME": str(project), "PATH": PATH, "TERM": "xterm-256color", "CMDZ_TELEMETRY": "false"},
        start_new_session=True,
    )
    output = bytearray()
    owned_pid = None
    owned_group = None

    def plain_output():
        return re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", bytes(output))

    def wait_for(predicate, label):
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            if select.select([master], [], [], 0.05)[0]:
                try:
                    output.extend(os.read(master, 65536))
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
            if predicate():
                return
            if child.poll() is not None:
                break
        raise AssertionError(f"{mode}: missing {label}; exit={child.poll()}\n{plain_output()[-3000:]!r}")

    def text(value):
        wait_for(lambda: value.replace(b" ", b"") in plain_output().replace(b" ", b""), value)

    def child_pid():
        try:
            return int((project / "app" / "child.pid").read_text().strip())
        except ValueError:
            return None

    try:
        text(b"READY:standalone")
        wait_for(lambda: child_pid() is not None, "child process")
        owned_pid = child_pid()
        assert owned_pid is not None
        owned_group = os.getpgid(owned_pid)
        os.write(master, b"\r")
        text(b"INPUT")
        os.write(master, b"hello\r")
        text(b"ECHO:hello")
        text(b"DIMS:26 71")
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 34, 110, 0, 0))
        child.send_signal(signal.SIGWINCH)
        text(b"RESIZED:30 81")
        os.write(master, b"resize\r")
        text(b"ECHO:resize")
        os.write(master, b"\x1ah")
        text(b"RESIZED:30 108")
        os.write(master, b"\r")
        del output[:]
        text(b"INPUT")
        os.write(master, b"wide\r")
        text(b"ECHO:wide")
        if mode == "quit":
            del output[:]
            os.write(master, b"\x1a")
            text(b"cmdz.ts")
            del output[:]
            os.write(master, b"x")
            wait_for(
                lambda: not Path(f"/proc/{owned_pid}").exists()
                if sys.platform.startswith("linux")
                else not process_exists(owned_pid),
                "stopped process",
            )
            previous_pid = owned_pid
            del output[:]
            os.write(master, b"r")
            wait_for(
                lambda: (pid := child_pid()) is not None and pid != previous_pid,
                "new process",
            )
            owned_pid = child_pid()
            assert owned_pid is not None
            owned_group = os.getpgid(owned_pid)
            assert owned_pid != previous_pid, "Restart reused the previous process"
            os.write(master, b"\r")
            text(b"INPUT")
            os.write(master, b"\x1aq")
        else:
            child.send_signal(signal.SIGTERM)
        wait_for(lambda: child.poll() is not None, "shutdown")
        assert child.returncode == 0, child.returncode
        assert termios.tcgetattr(slave) == original, "Terminal settings were not restored"
        try:
            os.kill(owned_pid, 0)
        except ProcessLookupError:
            pass
        else:
            raise AssertionError(f"Owned child {owned_pid} survived shutdown")
        print(f"PASS standalone {mode}: config imports, native terminal, input, resize, cleanup, restoration")
    finally:
        if child.poll() is None:
            child.send_signal(signal.SIGTERM)
            try:
                wait_for(lambda: child.poll() is not None, "cleanup")
            except AssertionError:
                child.kill()
                child.wait()
                if owned_group is not None:
                    try:
                        os.killpg(owned_group, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
        os.close(master)
        os.close(slave)


def process_exists(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


with tempfile.TemporaryDirectory(prefix="cmdz-standalone-") as directory:
    project = Path(directory)
    binary = project / "cmdz"
    shutil.copy2(SOURCE, binary)
    (project / "app").mkdir()
    (project / "cmdz.ts").write_text("import { commands } from './commands'; export default commands;\n")
    (project / "commands.ts").write_text(
        "import { Command, type CommandOptions } from 'cmdz';\n"
        "const options = { command: 'sh probe.sh', cwd: 'app', env: { PROBE: 'standalone' } } satisfies CommandOptions;\n"
        "export const commands = [Command('Shell', options)];\n"
    )
    (project / "app" / "probe.sh").write_text(
        "printf '%s' \"$$\" > child.pid\n"
        "printf 'READY:%s\\n' \"$PROBE\"\n"
        "trap 'printf \"RESIZED:%s\\n\" \"$(stty size)\"' WINCH\n"
        "while true; do\n"
        "  IFS= read -r line || continue\n"
        "  printf 'ECHO:%s\\n' \"$line\"\n"
        "  printf 'DIMS:%s\\n' \"$(stty size)\"\n"
        "done\n"
    )
    for mode in ("quit", "sigterm"):
        trial(binary, project, mode)
