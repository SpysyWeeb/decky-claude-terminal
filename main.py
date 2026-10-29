import asyncio
import codecs
import fcntl
import os
import re
import signal
import struct

import decky

# Same tmux session the "Claude Code" Steam shortcut (~/.local/bin/claude-gamemode) uses,
# so the QAM and the fullscreen Konsole share one Claude conversation.
SESSION = "claude"
CLAUDE_CMD = "{home}/.local/bin/claude --remote-control Ally"

# Local speech-to-text: PipeWire records the mic, whisper.cpp (Homebrew) transcribes.
PW_RECORD = "/usr/bin/pw-record"
WHISPER_CLI = "/home/linuxbrew/.linuxbrew/bin/whisper-cli"
WHISPER_MODEL = "{home}/.local/share/whisper/ggml-base.en.bin"
# Whisper labels non-speech like "[BLANK_AUDIO]" or "(dramatic music)".
NON_SPEECH = re.compile(r"\[[^\]]*\]|\([^)]*\)")

TIOCSCTTY = 0x540E
TIOCSWINSZ = 0x5414
FLUSH_INTERVAL = 0.02


def _set_winsize(fd: int, cols: int, rows: int):
    fcntl.ioctl(fd, TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


class Plugin:
    proc = None
    master = None
    decoder = None
    pending = ""
    flush_task = None
    # Bumped on every start() so a stale stop() from an unmounting view
    # (e.g. the QAM closing as the fullscreen page opens) can't kill the new client.
    client_id = 0
    size = (80, 24)
    recorder = None

    async def start(self, cols: int, rows: int) -> int:
        """Attach a new tmux client in a PTY, creating the Claude session if needed."""
        await self._detach()
        self.client_id += 1
        client_id = self.client_id
        home = decky.DECKY_USER_HOME
        user_uid = os.stat(home).st_uid
        user_gid = os.stat(home).st_gid

        env = {
            "HOME": home,
            "USER": decky.DECKY_USER,
            "LOGNAME": decky.DECKY_USER,
            "SHELL": "/bin/bash",
            "PATH": f"{home}/.local/bin:/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin",
            "LANG": "en_US.UTF-8",
            "LC_ALL": "en_US.UTF-8",
            "TERM": "xterm-256color",
            "COLORTERM": "truecolor",
            "XDG_RUNTIME_DIR": f"/run/user/{user_uid}",
        }

        master, slave = os.openpty()
        _set_winsize(slave, cols, rows)
        self.size = (cols, rows)
        os.set_blocking(master, False)

        def preexec():
            # Make the PTY our controlling terminal so tmux gets SIGWINCH on resize.
            fcntl.ioctl(0, TIOCSCTTY, 0)
            if os.getuid() == 0:
                os.setgroups([])
                os.setgid(user_gid)
                os.setuid(user_uid)

        self.proc = await asyncio.create_subprocess_exec(
            "/usr/bin/tmux", "-u", "new-session", "-A", "-s", SESSION,
            CLAUDE_CMD.format(home=home),
            stdin=slave, stdout=slave, stderr=slave,
            env=env, cwd=home, start_new_session=True, preexec_fn=preexec,
        )
        os.close(slave)
        self.master = master
        self.decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        self.pending = ""
        asyncio.get_running_loop().add_reader(master, self._on_readable)
        decky.logger.info(f"Attached tmux client #{client_id} pid={self.proc.pid} size={cols}x{rows}")
        return client_id

    def _on_readable(self):
        try:
            data = os.read(self.master, 65536)
        except BlockingIOError:
            return
        except OSError:
            data = b""
        if not data:
            asyncio.get_running_loop().create_task(self._on_exit())
            return
        self.pending += self.decoder.decode(data)
        # Batch output so a full-screen redraw is a handful of events, not hundreds.
        if self.flush_task is None:
            self.flush_task = asyncio.get_running_loop().create_task(self._flush())

    async def _flush(self):
        await asyncio.sleep(FLUSH_INTERVAL)
        data, self.pending = self.pending, ""
        self.flush_task = None
        if data:
            await decky.emit("claude_output", data)

    async def _on_exit(self):
        await self._detach()
        await decky.emit("claude_exit")

    async def write(self, data: str):
        if self.master is not None:
            os.write(self.master, data.encode())

    async def resize(self, cols: int, rows: int):
        if self.master is None:
            return
        _set_winsize(self.master, cols, rows)
        self.size = (cols, rows)
        if self.proc and self.proc.returncode is None:
            self.proc.send_signal(signal.SIGWINCH)

    async def scroll(self, ticks: int):
        """Send mouse-wheel ticks (positive = older output). tmux forwards them to
        Claude Code's own full-screen scroller, or uses copy mode for programs
        without mouse support (mouse is on in ~/.tmux.conf)."""
        if self.master is None or ticks == 0:
            return
        button = 64 if ticks > 0 else 65
        cols, rows = self.size
        event = f"\x1b[<{button};{max(1, cols // 2)};{max(1, rows // 2)}M"
        os.write(self.master, (event * abs(ticks)).encode())

    async def exit_scroll(self):
        """Leave copy mode so typed input reaches Claude instead of tmux."""
        await self._tmux("if-shell", "-F", "-t", SESSION, "#{pane_in_mode}",
                         f"send-keys -t {SESSION} -X cancel")

    async def _tmux(self, *args: str):
        proc = await asyncio.create_subprocess_exec(
            "/usr/bin/tmux", *args,
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
        )
        await proc.wait()

    def _recording_path(self) -> str:
        return f"/run/user/{os.getuid()}/claude-terminal-dictation.wav"

    async def start_dictation(self):
        """Start recording the default microphone."""
        await self.cancel_dictation()
        self.recorder = await asyncio.create_subprocess_exec(
            PW_RECORD, "--rate", "16000", "--channels", "1", "--format", "s16",
            self._recording_path(),
            env={"HOME": decky.DECKY_USER_HOME, "XDG_RUNTIME_DIR": f"/run/user/{os.getuid()}"},
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
        )

    async def stop_dictation(self) -> str:
        """Stop recording and return the transcribed text."""
        if not await self._stop_recorder():
            return ""
        proc = await asyncio.create_subprocess_exec(
            WHISPER_CLI, "-m", WHISPER_MODEL.format(home=decky.DECKY_USER_HOME),
            "-f", self._recording_path(), "-nt", "-np", "-t", "8",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        out, err = await proc.communicate()
        if proc.returncode != 0:
            decky.logger.error(f"whisper-cli failed: {err.decode(errors='replace')[-500:]}")
        return " ".join(NON_SPEECH.sub("", out.decode(errors="replace")).split())

    async def cancel_dictation(self):
        await self._stop_recorder()

    async def _stop_recorder(self) -> bool:
        recorder, self.recorder = self.recorder, None
        if recorder is None:
            return False
        if recorder.returncode is None:
            # SIGINT lets pw-record finish writing the WAV header.
            recorder.send_signal(signal.SIGINT)
            try:
                await asyncio.wait_for(recorder.wait(), 2)
            except asyncio.TimeoutError:
                recorder.kill()
        return True

    async def stop(self, client_id: int):
        """Detach the given client if it is still the current one. Claude keeps running."""
        if client_id == self.client_id:
            await self._detach()

    async def _detach(self):
        if self.master is not None:
            asyncio.get_running_loop().remove_reader(self.master)
            os.close(self.master)
            self.master = None
        if self.proc and self.proc.returncode is None:
            self.proc.terminate()
            try:
                await asyncio.wait_for(self.proc.wait(), 2)
            except asyncio.TimeoutError:
                self.proc.kill()
        self.proc = None

    async def _main(self):
        decky.logger.info(f"Claude Terminal loaded (uid={os.getuid()})")

    async def _unload(self):
        await self.cancel_dictation()
        await self._detach()
