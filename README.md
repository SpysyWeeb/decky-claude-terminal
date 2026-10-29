# Claude Terminal for Decky

A [Decky Loader](https://decky.xyz) plugin that puts a [Claude Code](https://claude.com/claude-code) terminal in the Steam Quick Access Menu, so you can ask Claude for help without leaving the game you're playing.

It attaches to a tmux session named `claude`, so the plugin, a desktop terminal and the Claude mobile app (via Remote Control) can all share the same conversation.

Built and tested on a ROG Xbox Ally X running Bazzite. It should also work on a Steam Deck or other SteamOS-style handhelds, but that hasn't been tested.

## Features

- **Quick Access Menu panel** with a compact terminal, plus an **Open fullscreen** view that sits over the running game.
- **Shared session:** runs `tmux new-session -A -s claude …`, joining the session if it exists and creating it if not. Closing the panel only detaches; Claude keeps running.
- **Input bar** that works with Steam's on-screen keyboard. In fullscreen, it slides up above the keyboard while you type.
- **Quick keys:** Enter, Esc, ↑, ↓, Tab, ⇧Tab, ^C, ⌫.
- **Touch:** pinch to change the text size (remembered separately for each view), drag to scroll.
- **Voice input (optional):** tap 🎤, speak, tap ⏹. Transcription runs locally with [whisper.cpp](https://github.com/ggml-org/whisper.cpp), and the text goes into the input bar for you to check before sending.
- A physical or Bluetooth keyboard types straight into the terminal.

## Requirements

- Decky Loader v3
- `tmux`
- Claude Code installed at `~/.local/bin/claude`
- For building: Node.js and pnpm (e.g. `brew install node pnpm`)
- For voice input (optional):
  - `pw-record` (PipeWire)
  - `whisper-cpp` from Homebrew
  - A Whisper model at `~/.local/share/whisper/ggml-base.en.bin`:

    ```sh
    brew install whisper-cpp
    mkdir -p ~/.local/share/whisper
    curl -L -o ~/.local/share/whisper/ggml-base.en.bin \
      https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
    ```

## Install

```sh
git clone https://github.com/SpysyWeeb/decky-claude-terminal
cd decky-claude-terminal
pnpm install
./install.sh   # builds, copies to ~/homebrew/plugins/claude-terminal (sudo), restarts Decky
```

`install.sh` needs sudo because Decky's plugin folder is owned by root. Run it from a real terminal; it won't work from a shell with no TTY.

## Configuration

These are constants at the top of `main.py`:

- `SESSION`: tmux session name (default `claude`).
- `CLAUDE_CMD`: the command a new session runs. The default is `claude --remote-control Ally`, which makes the session reachable from the Claude mobile app under the name "Ally". Change the name, or remove `--remote-control …` if you don't want that.
- `WHISPER_CLI` and `WHISPER_MODEL`: paths for voice input.

If you also launch Claude from a Steam shortcut (for example Konsole running `tmux -u new-session -A -s claude …`), use the same session name in both so they share one conversation.

## Notes and caveats

- **Steam internals:** keyboard detection uses Steam's undocumented `SteamUIStore` internals, so a Steam client update could break the keyboard lift. The terminal still works if that happens.
- **Mic gain:** on some AMD handhelds the mic input volume defaults to 100%, which maxes out the hardware boost and badly distorts the audio, making voice input inaccurate. Around 40% works well (`wpctl set-volume @DEFAULT_AUDIO_SOURCE@ 0.4`).
- **Game audio:** the mic also hears the speakers. Whisper's sound labels like "(music)" are filtered out, but loud in-game dialogue can sneak into the transcript.

## License

BSD-3-Clause, based on the [Decky plugin template](https://github.com/SteamDeckHomebrew/decky-plugin-template).
