import deckyPlugin from "@decky/rollup";
import { readFileSync } from "fs";

// Exposes xterm.js's stylesheet as a string so the frontend can inject it.
const xtermCss = {
  name: "xterm-css",
  resolveId: (id) => (id === "virtual:xterm-css" ? id : null),
  load: (id) =>
    id === "virtual:xterm-css"
      ? `export default ${JSON.stringify(readFileSync("node_modules/@xterm/xterm/css/xterm.css", "utf-8"))};`
      : null,
};

export default deckyPlugin({
  plugins: [xtermCss],
});
