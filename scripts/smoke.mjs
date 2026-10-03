/**
 * Build artifact checks.
 *
 * Runs against the real `dist/` output. These are the greps that would have
 * caught this app's last production bugs before deploy:
 *
 *   - `process.env.REACT_APP_*` in the bundle (Create-React-App habit; Vite
 *     only exposes import.meta.env, so the value was never configurable)
 *   - the dead relay host + the TURN password that shipped in the source
 *   - `\( {...} \)` placeholders from the mangled template literals
 *
 * The runtime boot check lives in src/app.boot.test.tsx (jsdom cannot execute
 * the ES-module bundle, so mounting the real React tree is the equivalent test).
 *
 * Usage: npm run build && npm run smoke
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = path.join(root, "dist", "index.html");
const zip = path.join(root, "dist", "Rideshare-Retroflectivapp.zip");

if (!fs.existsSync(bundle)) {
  console.error("smoke: dist/index.html not found — run `npm run build` first.");
  process.exit(1);
}

const html = fs.readFileSync(bundle, "utf8");
const sizeKb = Math.round(Buffer.byteLength(html) / 1024);

const checks = [
  ["bundle exists", html.length > 0, "dist/index.html is empty"],
  ["bundle is a full build", sizeKb > 150, `bundle looks truncated (${sizeKb} KB)`],
  ["no Create-React-App env reads", !/process\.env\.REACT_APP/.test(html), "process.env.REACT_APP_* leaked into the bundle"],
  ["no dead relay host", !/relay\.retroflex\.app/.test(html), "relay.retroflex.app still referenced"],
  ["no hard-coded TURN credential", !/beacon2024/.test(html), "TURN password is still in the bundle"],
  ["no mangled template placeholders", !/\\\(\s*\{/.test(html), "\\( {...} placeholder found in bundle"],
  ["app title present", /Retroflex/.test(html), "app title missing"],
  ["PWA manifest linked", /manifest\.json/.test(html), "manifest link missing"],
  ["source zip emitted by build", fs.existsSync(zip), "dist/Rideshare-Retroflectivapp.zip missing"],
];

let failed = false;
for (const [label, ok, detail] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failed = true;
}

if (failed) {
  console.error(`\nsmoke: FAILED (${sizeKb} KB bundle)`);
  process.exit(1);
}

console.log(`\nsmoke: PASSED — ${sizeKb} KB single-file bundle, artifact checks clean`);
