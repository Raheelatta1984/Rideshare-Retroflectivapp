import type { TerminalBinding, TerminalPosition } from "../types";
import { normalizePairCode, uid } from "./id";

/**
 * Terminal sign-up — the scan-the-QR onboarding path.
 *
 * One generic QR (`?mode=terminal`) is printed on/with every terminal. Scanning
 * it opens a bare shell: pair-code login, or sign-up, then a single Assign step.
 * No landing page, no marketing, no console — the terminal is a display, and
 * everything about it is managed from the driver's phone afterwards.
 *
 * This module is pure (no React, no network) so the routing, key and validation
 * rules are unit-testable and shared by the UI, the storage adapters and the
 * console that prints the QR.
 */

/** Query value that opens the terminal shell: `?mode=terminal`. */
export const TERMINAL_MODE = "terminal";

/**
 * Device-local pointer to "what this terminal is assigned to".
 *
 * Written by whichever backend adapter performs the bind, read synchronously by
 * the display so a reload goes straight back to the glass without re-assigning
 * and without waiting on a provider round-trip.
 */
export const TERMINAL_BINDING_KEY = "rf:terminal-binding";

/** Per-browser identity of the physical terminal. */
export const TERMINAL_DEVICE_ID_KEY = "rf:tablet-device-id";

export interface TerminalRequest {
  /** True when this document should render the terminal shell. */
  active: boolean;
  /** Pair code carried by the URL (a driver's coded QR), when present. */
  code: string | null;
  position: TerminalPosition;
}

/**
 * Read the terminal request out of the URL.
 *
 * Both the query string and the hash are consulted: QR scanners and in-app
 * browsers routinely drop one or the other, and this flow has to survive that.
 */
export function parseTerminalRequest(search: string, hash = ""): TerminalRequest {
  const pageQuery = new URLSearchParams(search);
  const [hashPath, hashQuery = ""] = hash.replace(/^#/, "").split("?");
  const routeQuery = new URLSearchParams(hashQuery);

  const active = pageQuery.get("mode") === TERMINAL_MODE || hashPath === "/terminal";
  const rawCode = pageQuery.get("display") ?? pageQuery.get("code") ?? routeQuery.get("display") ?? routeQuery.get("code");
  const code = normalizePairCode(rawCode ?? "");
  const rawPosition = pageQuery.get("position") ?? routeQuery.get("position");

  return {
    active,
    code: code.length === 6 ? code : null,
    position: rawPosition === "front" ? "front" : "rear",
  };
}

/** Build a terminal URL. Without `code` it is the generic sign-up QR target. */
export function terminalUrl(base: string, options: { code?: string | null; position?: TerminalPosition } = {}): string {
  const url = new URL(base, typeof window === "undefined" ? "https://retroflex.app/" : window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("mode", TERMINAL_MODE);
  url.searchParams.set("position", options.position === "front" ? "front" : "rear");
  const code = normalizePairCode(options.code ?? "");
  if (code.length === 6) url.searchParams.set("display", code);
  return url.toString();
}

/**
 * QR image for a terminal URL.
 *
 * Same generator the console already uses for pairing QRs, so a printed
 * terminal sticker and the in-console QR behave identically.
 */
export function terminalQrUrl(target: string, size = 220): string {
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&bgcolor=050505&color=E8A317&data=${encodeURIComponent(target)}`;
}

/** Storage key of the display authorization flag for a code + position. */
export function terminalConsentKey(position: TerminalPosition, code: string): string {
  return `rf:tablet-consent:${position}:${normalizePairCode(code)}`;
}

/** Stable binding id: one binding per physical device per position. */
export function terminalBindingId(deviceId: string, position: TerminalPosition): string {
  return `term:${deviceId}:${position}`;
}

/** Get (or mint) this browser's terminal device id. */
export function terminalDeviceId(): string {
  if (typeof localStorage === "undefined") return "tab_unknown";
  const existing = localStorage.getItem(TERMINAL_DEVICE_ID_KEY);
  if (existing) return existing;
  const next = uid("tab");
  localStorage.setItem(TERMINAL_DEVICE_ID_KEY, next);
  return next;
}

/**
 * Repair a stored binding.
 *
 * Records can come from an older build, from a provider payload, or from a
 * browser where storage was partly cleared. Anything unusable degrades to a
 * valid default instead of blanking the display.
 */
export function normalizeTerminalBinding(raw: Partial<TerminalBinding> | null | undefined): TerminalBinding | null {
  if (!raw) return null;
  const deviceId = typeof raw.deviceId === "string" ? raw.deviceId.trim() : "";
  const pairCode = normalizePairCode(raw.pairCode);
  if (!deviceId || pairCode.length !== 6) return null;
  const position: TerminalPosition = raw.position === "front" ? "front" : "rear";
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : terminalBindingId(deviceId, position),
    deviceId,
    deviceName: typeof raw.deviceName === "string" && raw.deviceName.trim() ? raw.deviceName.trim() : defaultTerminalLabel(position),
    pairCode,
    position,
    accountId: typeof raw.accountId === "string" && raw.accountId ? raw.accountId : null,
    accountEmail: typeof raw.accountEmail === "string" && raw.accountEmail ? raw.accountEmail : undefined,
    origin: raw.origin === "signup" || raw.origin === "pair-code" || raw.origin === "email" || raw.origin === "console" || raw.origin === "url" ? raw.origin : "url",
    assignedAt: typeof raw.assignedAt === "number" && Number.isFinite(raw.assignedAt) ? raw.assignedAt : Date.now(),
    lastSeen: typeof raw.lastSeen === "number" && Number.isFinite(raw.lastSeen) ? raw.lastSeen : undefined,
  };
}

/** The binding this terminal already has, read straight off the device. */
export function readLocalBinding(): TerminalBinding | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return normalizeTerminalBinding(JSON.parse(localStorage.getItem(TERMINAL_BINDING_KEY) ?? "null") as Partial<TerminalBinding>);
  } catch {
    return null;
  }
}

export function writeLocalBinding(binding: TerminalBinding | null): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (!binding) localStorage.removeItem(TERMINAL_BINDING_KEY);
    else localStorage.setItem(TERMINAL_BINDING_KEY, JSON.stringify(binding));
  } catch {
    // Storage full or blocked — the flow still works, it just re-assigns next time.
  }
}

/** Default label offered in the Assign step, e.g. "Rear glass · Android 14". */
export function defaultTerminalLabel(position: TerminalPosition, deviceName?: string | null): string {
  const base = position === "front" ? "Front display" : "Rear glass";
  const detail = typeof deviceName === "string" ? deviceName.trim() : "";
  return detail ? `${base} · ${detail}` : base;
}

/**
 * Guess a human device detail from the UA, for the default label only.
 *
 * Returns the model ("Pixel 8"), not the OS version: a driver with two tablets
 * in one car tells them apart by hardware, and the position already says which
 * glass it is.
 */
export function deviceHint(userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent): string | null {
  const model = /Android[^;]*;\s*([^;)]+)/i.exec(userAgent)?.[1]?.trim();
  if (model) return model;
  if (/iPad/i.test(userAgent)) return "iPad";
  if (/iPhone/i.test(userAgent)) return "iPhone";
  if (/Android/i.test(userAgent)) return "Android";
  if (/Windows NT/i.test(userAgent)) return "Windows tablet";
  return null;
}

/** Keyboard input → pair code: uppercase, alphanumerics only, max six. */
export function sanitizePairInput(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 6);
}

export function isCompletePairCode(value: string): boolean {
  return normalizePairCode(value).length === 6;
}

export interface SignUpValidation {
  error: string | null;
  value: { name: string; email: string; password: string; phone: string; city: string };
}

/**
 * Validate the terminal sign-up form.
 *
 * Kept deliberately small — a driver is standing at a car with a tablet, not
 * filling in a profile. Rules match the booth sign-up so one account works in
 * both places.
 */
export function validateTerminalSignUp(input: {
  name: string;
  email: string;
  password: string;
  phone?: string;
  city?: string;
}): SignUpValidation {
  const value = {
    name: (input.name ?? "").trim(),
    email: (input.email ?? "").trim().toLowerCase(),
    password: input.password ?? "",
    phone: (input.phone ?? "").trim(),
    city: (input.city ?? "").trim(),
  };
  if (value.name.length < 2) return { error: "Enter the name the booth should show.", value };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.email)) return { error: "Enter a valid email address.", value };
  if (value.password.length < 8) return { error: "Use at least 8 characters for the password.", value };
  return { error: null, value };
}
