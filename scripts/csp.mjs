/**
 * Build-time CSP helpers.
 *
 * `vite-plugin-singlefile` inlines the whole application into one `<script>`
 * element, so the only strict script policy a static host can serve is a hash
 * of that exact script. These helpers compute the hashes from the emitted
 * document and inject the `<meta http-equiv="Content-Security-Policy">` that
 * every static host (Vercel, GitHub Pages) will honour.
 *
 * `npm run smoke` re-computes the hashes from `dist/index.html` and compares
 * them with the injected policy, so a silently mismatched hash — which would
 * block the app in production — fails the build instead.
 */
import crypto from "node:crypto";

const TAG_RE = /<(script|style)\b([^>]*)>/gi;
const SCRIPT_SRC_ATTR = /\bsrc\s*=/i;
// The policy itself contains single quotes, so the attribute delimiter is
// captured and matched back rather than crossed.
const META_RE =
  /<meta\s+http-equiv=["']Content-Security-Policy["']\s+content=(["'])(.*?)\1[^>]*>/i;

/** `sha256-<base64>` of the exact text the browser will hash. */
export function sha256Source(text) {
  return `sha256-${crypto.createHash("sha256").update(text, "utf8").digest("base64")}`;
}

/**
 * Every inline `<script>` in the document that has no `src`, as a CSP hash.
 *
 * The scan steps over each element's body, so a `<script` that appears inside
 * the inlined JavaScript (a template string, for example) is not mistaken for
 * a second element.
 */
export function inlineScriptHashes(html) {
  const hashes = [];
  let index = 0;
  while (index < html.length) {
    TAG_RE.lastIndex = index;
    const match = TAG_RE.exec(html);
    if (!match) break;

    const tag = match[1].toLowerCase();
    const close = html.toLowerCase().indexOf(`</${tag}>`, match.index + match[0].length);
    if (close === -1) break;

    const body = html.slice(match.index + match[0].length, close);
    const attrs = match[2] ?? "";
    if (tag === "script" && !SCRIPT_SRC_ATTR.test(attrs)) hashes.push(sha256Source(body));

    index = close + tag.length + 3; // past "</tag>"
  }
  return hashes;
}

/**
 * Insert the policy as the first child of `<head>` so it is parsed before the
 * inlined bundle runs. Idempotent: an existing CSP meta is replaced.
 */
export function injectCspMeta(html, policy) {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policy.replace(/"/g, "&quot;")}" />`;
  if (META_RE.test(html)) return html.replace(META_RE, meta);
  const head = html.indexOf("<head>");
  if (head === -1) throw new Error("injectCspMeta: document has no <head>");
  return `${html.slice(0, head + "<head>".length)}${meta}${html.slice(head + "<head>".length)}`;
}

/**
 * Check a built document against its own policy.
 *
 * Returns `{ present, hashes, declared, ok }`; `ok` is false when the policy is
 * missing, has no hash, or lists a different hash than the script it must run.
 */
export function verifyCspMeta(html) {
  const match = html.match(META_RE);
  if (!match) return { present: false, hashes: [], declared: [], ok: false };

  const policy = match[2];
  const declared = [...policy.matchAll(/sha256-[A-Za-z0-9+/=]+/g)].map((entry) => entry[0]);
  const hashes = inlineScriptHashes(html);
  return {
    present: true,
    policy,
    hashes,
    declared,
    ok: hashes.length > 0 && hashes.every((hash) => declared.includes(hash)),
  };
}
