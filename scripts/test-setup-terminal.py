#!/usr/bin/env python3
"""Owned PTYs, temporary homes, no network, browsers or real-user configuration."""
import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parents[1]
ENGINE = os.environ["SLURP_TEST_DUCKDB"]
BINARY = str(ROOT / "target/debug/slurp")

class Session:
    def __init__(self, root, args, term="dumb", width=100):
        self.text = b""
        self.position = 0
        self.closed = False
        self.pid, self.fd = pty.fork()
        if not self.pid:
            env = {k: v for k, v in os.environ.items() if not k.startswith("SLURP_")}
            env.update(HOME=str(root / "user"), SLURP_HOME=str(root / "home"),
                       TERM=term, NO_COLOR="1")
            os.chdir(root)
            options = [] if (root / "home/config.toml").exists() else ["--duckdb", ENGINE, "--no-connect"]
            os.execve(BINARY, [BINARY, "setup", *options, "--no-open", *args], env)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, width, 0, 0))
    def read(self):
        if select.select([self.fd], [], [], .05)[0]:
            try:
                self.text += os.read(self.fd, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
    def wait(self, text):
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            found = self.text.find(text.encode(), self.position)
            if found >= 0:
                self.position = found + len(text)
                return
            self.read()
        raise AssertionError(f"Missing {text}: {self.text[-5000:]!r}")
    def send(self, text):
        os.write(self.fd, text)
    def finish(self, expected=0):
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            pid, status = os.waitpid(self.pid, os.WNOHANG)
            if pid:
                self.closed = True
                for _ in range(3):
                    self.read()
                assert os.waitstatus_to_exitcode(status) == expected, self.text[-5000:]
                # Control sequences for cursor positioning are allowed; colour is not.
                import re
                assert not re.search(rb"\x1b\[(?:\d+;)*(?:3\d|4\d|9[0-7]|10[0-7])(?:;\d+)*m", self.text)
                return
            self.read()
        raise AssertionError(f"Timed out: {self.text[-5000:]!r}")
    def close(self):
        if not self.closed:
            os.kill(self.pid, signal.SIGKILL)
            os.waitpid(self.pid, 0)
        os.close(self.fd)

with tempfile.TemporaryDirectory(prefix="slurp-pty-") as temp:
    for case in ("cancel", "plain", "narrow", "fancy-cancel", "json"):
        root = Path(temp) / case
        (root / "user").mkdir(parents=True)
        args = ["--json", "--library", str(root / "library")] if case == "json" else []
        session = Session(root, args, term="xterm-256color" if case in ("fancy-cancel", "narrow") else "dumb",
                          width=32 if case == "narrow" else 100)
        try:
            if case == "json":
                session.finish()
                assert json.loads(session.text)["local_ready"]
                assert b"Choose a number" not in session.text
            elif case == "fancy-cancel":
                session.wait("Where should your event library live?")
                session.send(b"\x1b")
                session.finish(1)
            else:
                session.wait("Choose a number:")
                session.send(b"2\n")  # Internal disk, regardless of real drive inventory.
                session.wait("Prepare this computer?")
                session.send(b"n\n" if case == "cancel" else b"y\n")
                session.finish(1 if case == "cancel" else 0)
            if case == "narrow":
                assert b"/ ___//" not in session.text
            config = root / "home/config.toml"
            if case in ("cancel", "fancy-cancel"):
                assert not config.exists()
                assert not (root / "user/SlurpLibrary").exists()
            else:
                before = config.read_bytes()
                modified = config.stat().st_mtime_ns
                saved = Session(root, [])
                try:
                    saved.wait("Choose a number:")
                    saved.send(b"1\n")  # Done.
                    saved.finish()
                    assert config.read_bytes() == before
                    assert config.stat().st_mtime_ns == modified
                finally:
                    saved.close()
            assert not (root / "slurp").exists()
            print("PASS:", case)
        finally:
            session.close()
