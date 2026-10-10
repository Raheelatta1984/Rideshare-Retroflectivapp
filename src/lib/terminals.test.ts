import { beforeEach, describe, expect, it } from "vitest";
import {
  defaultTerminalLabel,
  deviceHint,
  isCompletePairCode,
  normalizeTerminalBinding,
  parseTerminalRequest,
  readLocalBinding,
  sanitizePairInput,
  terminalBindingId,
  terminalConsentKey,
  terminalDeviceId,
  terminalQrUrl,
  terminalUrl,
  TERMINAL_BINDING_KEY,
  validateTerminalSignUp,
  writeLocalBinding,
} from "./terminals";
import type { TerminalBinding } from "../types";

beforeEach(() => {
  localStorage.clear();
});

/* ------------------------------------------------------------------ *
 * Routing — the QR has to survive scanners that mangle the URL
 * ------------------------------------------------------------------ */

describe("parseTerminalRequest", () => {
  it("opens on ?mode=terminal, the generic sign-up QR", () => {
    const request = parseTerminalRequest("?mode=terminal");
    expect(request.active).toBe(true);
    expect(request.code).toBeNull();
    expect(request.position).toBe("rear");
  });

  it("carries the code and position from a driver's coded QR", () => {
    const request = parseTerminalRequest("?mode=terminal&position=front&display=7k2m9q");
    expect(request).toMatchObject({ active: true, code: "7K2M9Q", position: "front" });
  });

  it("also opens from the #/terminal hash route", () => {
    expect(parseTerminalRequest("", "#/terminal").active).toBe(true);
    expect(parseTerminalRequest("", "#/terminal?display=ABC123").code).toBe("ABC123");
  });

  it("accepts `code` as an alias for `display`", () => {
    expect(parseTerminalRequest("?mode=terminal&code=ZZZ999").code).toBe("ZZZ999");
  });

  it("ignores an incomplete code rather than half-assigning a terminal", () => {
    expect(parseTerminalRequest("?mode=terminal&display=7K2").code).toBeNull();
  });

  it("leaves the existing tablet display route alone", () => {
    // ?mode=tablet&display=CODE is the armed-display path and must not become
    // the sign-up shell.
    expect(parseTerminalRequest("?mode=tablet&display=7K2M9Q").active).toBe(false);
    expect(parseTerminalRequest("").active).toBe(false);
    expect(parseTerminalRequest("", "#/login").active).toBe(false);
  });
});

describe("terminalUrl / terminalQrUrl", () => {
  it("builds the generic sign-up target with no code in it", () => {
    const url = terminalUrl("https://retroflex.app/");
    expect(url).toContain("mode=terminal");
    expect(url).toContain("position=rear");
    expect(url).not.toContain("display=");
  });

  it("adds the code only when it is a complete pair code", () => {
    expect(terminalUrl("https://retroflex.app/", { code: "7K2M9Q", position: "front" })).toContain("display=7K2M9Q");
    expect(terminalUrl("https://retroflex.app/", { code: "nope" })).not.toContain("display=");
  });

  it("drops any incoming query and hash so a scanned link cannot smuggle a route", () => {
    const url = terminalUrl("https://retroflex.app/?mode=reset&token=abc#/lab");
    expect(url).not.toContain("token=abc");
    expect(url).not.toContain("#/lab");
  });

  it("encodes the target inside the QR image URL", () => {
    const qr = terminalQrUrl("https://retroflex.app/?mode=terminal", 260);
    expect(qr).toContain("size=260x260");
    expect(decodeURIComponent(qr)).toContain("mode=terminal");
  });
});

/* ------------------------------------------------------------------ *
 * Keys and identity
 * ------------------------------------------------------------------ */

describe("terminal keys", () => {
  it("matches the display authorization key the router already used", () => {
    // App.tsx stored this string inline before the flow existed; changing the
    // shape would silently re-prompt every deployed terminal.
    expect(terminalConsentKey("rear", "7k2m9q")).toBe("rf:tablet-consent:rear:7K2M9Q");
    expect(terminalConsentKey("front", "ABC123")).toBe("rf:tablet-consent:front:ABC123");
  });

  it("gives one device one binding per position", () => {
    expect(terminalBindingId("tab_1", "rear")).toBe("term:tab_1:rear");
    expect(terminalBindingId("tab_1", "front")).toBe("term:tab_1:front");
  });

  it("mints the device id once and keeps it stable", () => {
    const first = terminalDeviceId();
    expect(first).toMatch(/^tab_/);
    expect(terminalDeviceId()).toBe(first);
    expect(localStorage.getItem("rf:tablet-device-id")).toBe(first);
  });
});

/* ------------------------------------------------------------------ *
 * Binding repair
 * ------------------------------------------------------------------ */

const binding = (overrides: Partial<TerminalBinding> = {}): TerminalBinding => ({
  id: "term:tab_1:rear",
  deviceId: "tab_1",
  deviceName: "Rear glass",
  pairCode: "7K2M9Q",
  position: "rear",
  accountId: null,
  origin: "pair-code",
  assignedAt: 1000,
  ...overrides,
});

describe("normalizeTerminalBinding", () => {
  it("passes a healthy binding through", () => {
    expect(normalizeTerminalBinding(binding())).toMatchObject({ pairCode: "7K2M9Q", position: "rear" });
  });

  it("repairs a record missing its name, origin and position", () => {
    const repaired = normalizeTerminalBinding({ deviceId: "tab_2", pairCode: "abc123" } as Partial<TerminalBinding>);
    expect(repaired).toMatchObject({
      id: "term:tab_2:rear",
      deviceName: "Rear glass",
      pairCode: "ABC123",
      position: "rear",
      origin: "url",
      accountId: null,
    });
  });

  it("rejects a binding that cannot address a display", () => {
    expect(normalizeTerminalBinding(null)).toBeNull();
    expect(normalizeTerminalBinding({ ...binding(), deviceId: "" })).toBeNull();
    expect(normalizeTerminalBinding({ ...binding(), pairCode: "7K2" })).toBeNull();
  });

  it("round-trips through device storage", () => {
    writeLocalBinding(binding());
    expect(readLocalBinding()).toMatchObject({ deviceId: "tab_1", pairCode: "7K2M9Q" });
    writeLocalBinding(null);
    expect(readLocalBinding()).toBeNull();
    expect(localStorage.getItem(TERMINAL_BINDING_KEY)).toBeNull();
  });

  it("survives corrupt storage instead of blanking the glass", () => {
    localStorage.setItem(TERMINAL_BINDING_KEY, "{not json");
    expect(readLocalBinding()).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Input handling
 * ------------------------------------------------------------------ */

describe("pair code input", () => {
  it("uppercases and strips separators as the driver types", () => {
    expect(sanitizePairInput("7k2-m9q")).toBe("7K2M9Q");
    expect(sanitizePairInput(" 7K2 M9Q ")).toBe("7K2M9Q");
  });

  it("caps at six characters", () => {
    expect(sanitizePairInput("ABCDEFGH")).toBe("ABCDEF");
    expect(isCompletePairCode("ABCDEFGH")).toBe(false);
    expect(isCompletePairCode("ABC123")).toBe(true);
  });
});

describe("validateTerminalSignUp", () => {
  const valid = { name: "Raheel", email: "driver@retroflex.app", password: "demo1234" };

  it("accepts a usable sign-up and normalises it", () => {
    const result = validateTerminalSignUp({ ...valid, email: "  Driver@Retroflex.APP ", phone: " 0400 000 000 " });
    expect(result.error).toBeNull();
    expect(result.value).toMatchObject({ email: "driver@retroflex.app", phone: "0400 000 000" });
  });

  it("rejects a missing name, a bad email and a short password", () => {
    expect(validateTerminalSignUp({ ...valid, name: "R" }).error).toMatch(/name/i);
    expect(validateTerminalSignUp({ ...valid, email: "driver@" }).error).toMatch(/email/i);
    expect(validateTerminalSignUp({ ...valid, password: "short" }).error).toMatch(/8 characters/i);
  });
});

describe("default labels", () => {
  it("names the glass by position", () => {
    expect(defaultTerminalLabel("rear")).toBe("Rear glass");
    expect(defaultTerminalLabel("front")).toBe("Front display");
    expect(defaultTerminalLabel("rear", "Android 14")).toBe("Rear glass · Android 14");
    expect(defaultTerminalLabel("rear", "   ")).toBe("Rear glass");
  });

  it("reads a device hint out of the user agent", () => {
    expect(deviceHint("Mozilla/5.0 (Linux; Android 14; Pixel 8)")).toBe("Pixel 8");
    expect(deviceHint("Mozilla/5.0 (Linux; Android 14)")).toBe("Android");
    expect(deviceHint("Mozilla/5.0 (iPad; CPU OS 17_0)")).toBe("iPad");
    expect(deviceHint("Mozilla/5.0 (Macintosh)")).toBeNull();
  });
});
