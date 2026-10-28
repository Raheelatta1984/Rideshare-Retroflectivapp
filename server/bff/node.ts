/**
 * Node HTTP adapter for the BFF router, plus static hosting for the built SPA.
 *
 * Serving `dist/` from the same origin as `/bff` is not a convenience: a
 * same-origin BFF is what makes the session cookie `SameSite=Lax` +
 * `__Host-` meaningful and removes CORS from the threat model entirely. A
 * deployment that splits the SPA and the BFF across origins re-introduces both.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { promises as fs, createReadStream } from "node:fs";
import path from "node:path";
import type { BffHandler } from "./router";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff2": "font/woff2",
  ".zip": "application/zip",
  ".pdf": "application/pdf",
};

const SECURITY_HEADERS: Record<string, string> = {
  // Directives a <meta> policy cannot carry. The meta CSP (built by
  // vite.config.ts) still supplies script-src/style-src.
  "Content-Security-Policy": "frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(self), payment=()",
};

export interface NodeServerOptions {
  handler: BffHandler;
  /** Directory of the built SPA. Omit to serve only the BFF. */
  staticDir?: string;
  /** Max bytes read from a request body before the connection is dropped. */
  maxBodyBytes?: number;
  onError?: (error: unknown) => void;
}

function securityHeadersFor(config?: { secureCookies?: boolean }): Record<string, string> {
  const headers = { ...SECURITY_HEADERS };
  if (config?.secureCookies) headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  return headers;
}

export function toWebRequest(req: IncomingMessage, maxBodyBytes: number): Promise<Request> {
  const host = req.headers.host ?? "localhost";
  const url = new URL(req.url ?? "/", `http://${host}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach((entry) => headers.append(key, entry));
    else headers.set(key, value);
  }

  const method = (req.method ?? "GET").toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";

  return (async () => {
    if (!hasBody) return new Request(url, { method, headers });
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += buffer.byteLength;
      if (total > maxBodyBytes) {
        // Stop reading; the router will answer 413 for an oversized body anyway.
        chunks.length = 0;
        break;
      }
      chunks.push(buffer);
    }
    return new Request(url, { method, headers, body: Buffer.concat(chunks) });
  })();
}

export async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  for (const [key, value] of response.headers.entries()) {
    if (key.toLowerCase() === "set-cookie") continue;
    res.setHeader(key, value);
  }
  const cookies = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : response.headers.get("set-cookie")
      ? [response.headers.get("set-cookie") as string]
      : [];
  if (cookies.length > 0) res.setHeader("Set-Cookie", cookies);

  const body = Buffer.from(await response.arrayBuffer());
  if (body.byteLength > 0) res.setHeader("Content-Length", String(body.byteLength));
  res.end(body);
}

/** Resolve a URL path inside `root`, or null when it escapes or is missing. */
export async function resolveStaticFile(root: string, pathname: string): Promise<string | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const relative = path.normalize(decoded).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
  const candidate = path.resolve(root, relative);
  const rootResolved = path.resolve(root);
  if (candidate !== rootResolved && !candidate.startsWith(`${rootResolved}${path.sep}`)) return null;
  try {
    const stat = await fs.stat(candidate);
    if (stat.isDirectory()) return null;
    return candidate;
  } catch {
    return null;
  }
}

function contentTypeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

export function createBffServer(options: NodeServerOptions): Server {
  const staticDir = options.staticDir;
  const maxBodyBytes = options.maxBodyBytes ?? 8 * 1024 * 1024;

  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      // The BFF owns its mount point; static hosting owns everything else.
      if (url.pathname === "/bff" || url.pathname.startsWith("/bff/")) {
        const request = await toWebRequest(req, maxBodyBytes);
        await sendWebResponse(res, await options.handler(request));
        return;
      }

      if (!staticDir || (req.method ?? "GET").toUpperCase() !== "GET") {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }

      let file = await resolveStaticFile(staticDir, url.pathname);
      const isDocumentRequest = url.pathname === "/" || url.pathname.endsWith("/") || !path.extname(url.pathname);
      if (!file && isDocumentRequest) {
        // Hash routing: every unknown path is the same document.
        file = await resolveStaticFile(staticDir, "/index.html");
      }
      if (!file) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }

      const isHtml = path.extname(file).toLowerCase() === ".html";
      res.writeHead(200, {
        ...securityHeadersFor(),
        "Content-Type": contentTypeFor(file),
        "Cache-Control": isHtml ? "no-cache" : "public, max-age=3600",
      });
      createReadStream(file).pipe(res);
    })().catch((error) => {
      options.onError?.(error);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      }
      res.end(JSON.stringify({ error: "Internal error" }));
    });
  });
}
