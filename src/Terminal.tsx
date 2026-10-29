import { DialogButton, Focusable, TextField } from "@decky/ui";
import { addEventListener, callable, removeEventListener } from "@decky/api";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import xtermCss from "virtual:xterm-css";
import { CSSProperties, useEffect, useRef, useState } from "react";
import { FaMicrophone, FaStop } from "react-icons/fa";

const start = callable<[cols: number, rows: number], number>("start");
const write = callable<[data: string], void>("write");
const resize = callable<[cols: number, rows: number], void>("resize");
const stop = callable<[clientId: number], void>("stop");
const scroll = callable<[ticks: number], void>("scroll");
const exitScroll = callable<[], void>("exit_scroll");
const startDictation = callable<[], void>("start_dictation");
const stopDictation = callable<[], string>("stop_dictation");
const cancelDictation = callable<[], void>("cancel_dictation");

const QUICK_KEYS: [label: string, seq: string][] = [
  ["Enter", "\r"],
  ["Esc", "\x1b"],
  ["↑", "\x1b[A"],
  ["↓", "\x1b[B"],
  ["Tab", "\t"],
  ["⇧Tab", "\x1b[Z"],
  ["^C", "\x03"],
  // Last, so it sits at the right end under the mic and Send buttons.
  ["⌫", "\x7f"],
];

const keyButton: CSSProperties = {
  minWidth: 0,
  width: "auto",
  flex: "1 0 auto",
  padding: "4px 8px",
  fontSize: "12px",
};

const KEYBOARD_GAP = 6;

interface SteamSubscribable<T> {
  Value: T;
  Subscribe(cb: (value: T) => void): { Unsubscribe?: () => void } | undefined;
}

// Steam UI internals (undocumented): the main Big Picture window and its keyboard manager.
function getMainWindow(): any {
  try {
    return (window as any).SteamUIStore?.WindowStore?.SteamUIWindows?.[0];
  } catch {
    return undefined;
  }
}

function getVirtualKeyboardShowing(): SteamSubscribable<boolean> | undefined {
  const showing = getMainWindow()?.m_VirtualKeyboardManager?.IsShowingVirtualKeyboard;
  return typeof showing?.Subscribe === "function" ? showing : undefined;
}

// The keyboard's layout element has a class like "Layout_qwerty".
function findKeyboard(doc: Document | undefined): Element | undefined {
  if (!doc) return undefined;
  return [...doc.querySelectorAll('[class*="Layout_"]')].find((e) => e.getBoundingClientRect().height > 50);
}

// Roughly how many lines one mouse-wheel tick scrolls, so a drag tracks the finger.
const LINES_PER_WHEEL_TICK = 3;

const MIN_FONT = 6;
const MAX_FONT = 32;

// Pinched sizes are remembered per view (QAM vs fullscreen). Storage can be
// unavailable, in which case the default size is used.
function loadFontSize(key: string): number | undefined {
  try {
    const size = Number(localStorage.getItem(key));
    return size >= MIN_FONT && size <= MAX_FONT ? size : undefined;
  } catch {
    return undefined;
  }
}

function saveFontSize(key: string, size: number) {
  try {
    localStorage.setItem(key, String(size));
  } catch {}
}

export function ClaudeTerminal({ fontSize, compact }: { fontSize: number; compact?: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLDivElement>(null);
  const liftRef = useRef(0);
  const [text, setText] = useState("");
  const [dictation, setDictation] = useState<"idle" | "recording" | "transcribing">("idle");

  // Don't leave the mic recording if the view closes mid-dictation.
  useEffect(() => () => void cancelDictation(), []);

  const toggleDictation = async () => {
    if (dictation === "idle") {
      setDictation("recording");
      await startDictation();
    } else if (dictation === "recording") {
      setDictation("transcribing");
      try {
        const heard = await stopDictation();
        // Fill the input rather than sending, so it can be checked first.
        if (heard) setText((prev) => (prev ? `${prev} ${heard}` : heard));
      } finally {
        setDictation("idle");
      }
    }
  };
  const [keyboardLift, setKeyboardLift] = useState(0);

  // While Steam's on-screen keyboard is open over the fullscreen page, slide the
  // terminal and input bar up together so the input bar sits just above it.
  useEffect(() => {
    const showing = getVirtualKeyboardShowing();
    if (!showing) return;
    let timers: number[] = [];
    const measure = () => {
      const input = inputRef.current;
      if (!input) return;
      const win = input.ownerDocument.defaultView!;
      // Only lift when the keyboard is drawn over our own window (fullscreen).
      // Over the QAM, Steam shrinks the QAM window above the keyboard and scrolls
      // the input into view itself, so lifting as well pushes everything off-screen.
      const keyboard = findKeyboard(input.ownerDocument);
      if (!keyboard) {
        liftRef.current = 0;
        setKeyboardLift(0);
        return;
      }
      // The keyboard slides up from the bottom, so its height (unlike its top
      // edge) is already final mid-animation.
      const keyboardTop = win.innerHeight - keyboard.getBoundingClientRect().height;
      // Undo the current lift to get the input bar's resting position.
      const inputBottom = input.getBoundingClientRect().bottom + liftRef.current;
      liftRef.current = Math.max(0, Math.round(inputBottom - keyboardTop + KEYBOARD_GAP));
      setKeyboardLift(liftRef.current);
    };
    const onChange = (open: boolean) => {
      timers.forEach((t) => window.clearTimeout(t));
      timers = [];
      if (!open) {
        liftRef.current = 0;
        setKeyboardLift(0);
        return;
      }
      // The keyboard's element can show up a little after the flag flips.
      timers = [0, 150, 400].map((ms) => window.setTimeout(measure, ms));
    };
    onChange(showing.Value);
    const sub = showing.Subscribe(onChange);
    return () => {
      timers.forEach((t) => window.clearTimeout(t));
      sub?.Unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    const host = hostRef.current!;
    const sizeKey = `claude-terminal-font-${compact ? "qam" : "full"}`;
    const term = new Terminal({
      fontSize: loadFontSize(sizeKey) ?? fontSize,
      fontFamily: "'DejaVu Sans Mono', 'Noto Sans Mono', 'Liberation Mono', monospace",
      cursorBlink: true,
      scrollback: 2000,
      theme: { background: "#1e1e1e" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    // One-finger drag sends mouse-wheel scrolling; two-finger pinch changes the font
    // size (fit() then recomputes cols/rows, which onResize forwards to tmux).
    let pinch: { dist: number; size: number } | null = null;
    let drag: { y: number } | null = null;
    // Scroll requests are coalesced and sent one at a time so they stay in order.
    let pendingTicks = 0;
    let scrolling = false;
    const flushScroll = async () => {
      if (scrolling) return;
      scrolling = true;
      while (pendingTicks !== 0) {
        const ticks = pendingTicks;
        pendingTicks = 0;
        await scroll(ticks);
      }
      scrolling = false;
    };
    const touchDist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        drag = { y: e.touches[0].clientY };
      } else if (e.touches.length === 2) {
        e.preventDefault();
        drag = null;
        pinch = { dist: touchDist(e.touches), size: term.options.fontSize! };
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (pinch && e.touches.length === 2) {
        e.preventDefault();
        const size = Math.round(pinch.size * (touchDist(e.touches) / pinch.dist));
        const clamped = Math.min(MAX_FONT, Math.max(MIN_FONT, size));
        if (clamped !== term.options.fontSize) {
          term.options.fontSize = clamped;
          fit.fit();
        }
      } else if (drag && e.touches.length === 1) {
        e.preventDefault();
        const tickHeight = (host.clientHeight / term.rows) * LINES_PER_WHEEL_TICK;
        const ticks = Math.trunc((e.touches[0].clientY - drag.y) / tickHeight);
        if (ticks !== 0) {
          // Dragging down reveals older output, like scrolling a phone.
          drag.y += ticks * tickHeight;
          pendingTicks += ticks;
          flushScroll();
        }
      }
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length === 0) drag = null;
      if (!pinch || e.touches.length >= 2) return;
      pinch = null;
      saveFontSize(sizeKey, term.options.fontSize!);
    };
    const touchOpts = { capture: true, passive: false };
    host.addEventListener("touchstart", onTouchStart, touchOpts);
    host.addEventListener("touchmove", onTouchMove, touchOpts);
    host.addEventListener("touchend", onTouchEnd, touchOpts);
    host.addEventListener("touchcancel", onTouchEnd, touchOpts);

    const onOutput = addEventListener<[data: string]>("claude_output", (data) => term.write(data));
    const onExit = addEventListener("claude_exit", () =>
      term.write("\r\n\x1b[2m[tmux client exited — reopen to reattach]\x1b[0m\r\n"),
    );
    // A physical/Bluetooth keyboard can type straight into the terminal.
    const dataSub = term.onData((d) => write(d));
    const resizeSub = term.onResize(({ cols, rows }) => resize(cols, rows));
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(host);

    const clientId = start(term.cols, term.rows);

    return () => {
      observer.disconnect();
      host.removeEventListener("touchstart", onTouchStart, touchOpts);
      host.removeEventListener("touchmove", onTouchMove, touchOpts);
      host.removeEventListener("touchend", onTouchEnd, touchOpts);
      host.removeEventListener("touchcancel", onTouchEnd, touchOpts);
      dataSub.dispose();
      resizeSub.dispose();
      removeEventListener("claude_output", onOutput);
      removeEventListener("claude_exit", onExit);
      clientId.then((id) => stop(id));
      term.dispose();
    };
  }, [fontSize, compact]);

  const send = async () => {
    if (!text) return;
    const toSend = text;
    setText("");
    // If scrolled back, tmux's copy mode would swallow the text.
    await exitScroll();
    await write(toSend);
    // Sent separately so Claude Code treats it as Enter, not part of a paste.
    setTimeout(() => write("\r"), 80);
  };

  const inputBar = (
    <div ref={inputRef}>
      <Focusable style={{ display: "flex", gap: "6px", alignItems: "center" }}>
        <div style={{ flex: 1 }}>
          <TextField
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                send();
              }
            }}
          />
        </div>
        <DialogButton
          style={{
            ...keyButton,
            flex: "0 0 auto",
            padding: "8px 12px",
            ...(dictation === "recording" ? { background: "#c0392b", color: "white" } : {}),
          }}
          onClick={toggleDictation}
          disabled={dictation === "transcribing"}
        >
          {dictation === "recording" ? <FaStop /> : dictation === "transcribing" ? "…" : <FaMicrophone />}
        </DialogButton>
        <DialogButton style={{ ...keyButton, flex: "0 0 auto", padding: "8px 12px" }} onClick={send}>
          Send
        </DialogButton>
      </Focusable>
    </div>
  );

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        height: "100%",
        minHeight: 0,
        transform: `translateY(-${keyboardLift}px)`,
        transition: "transform 0.15s ease-out",
      }}
    >
      {/* Rendered inline: Decky plugin code runs in a different document than the
          one the UI is drawn in, so injecting into `document.head` misses it. */}
      <style>{xtermCss}</style>
      <div
        ref={hostRef}
        style={{
          flex: 1,
          minHeight: compact ? "340px" : 0,
          background: "#1e1e1e",
          padding: "4px",
          borderRadius: "4px",
          overflow: "hidden",
        }}
      />
      {inputBar}
      <Focusable style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
        {QUICK_KEYS.map(([label, seq]) => (
          <DialogButton key={label} style={keyButton} onClick={() => write(seq)}>
            {label}
          </DialogButton>
        ))}
      </Focusable>
    </div>
  );
}
