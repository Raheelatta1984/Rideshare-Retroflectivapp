import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "./App";
import { db, defaultSettings } from "./lib/storage";
import { terminalConsentKey, terminalDeviceId, writeLocalBinding } from "./lib/terminals";
import type { Driver } from "./types";

/**
 * Routing for the scanned terminal.
 *
 * The generic QR (`?mode=terminal`) must land on the sign-up shell and nowhere
 * else, the existing armed-display QR (`?mode=tablet&display=CODE`) must keep
 * behaving exactly as before, and a terminal that is already assigned must go
 * straight back to the glass on reload.
 */

const BOOTH: Driver = {
  id: "drv_booth",
  name: "Raheel Atta",
  email: "driver@retroflex.app",
  phone: "",
  password: "demo1234",
  city: "Sydney",
  pairCode: "7K2M9Q",
  frontPairCode: "FR0NT1",
  createdAt: new Date().toISOString(),
  platforms: ["uber", "didi"],
  vehicle: { make: "", model: "", color: "", plate: "", year: "" },
  role: "driver",
};

function visit(target: string) {
  window.history.replaceState({}, "", target);
}

beforeEach(() => {
  localStorage.clear();
  visit("/");
  db.saveDriver(BOOTH);
});

afterEach(() => {
  visit("/");
});

describe("terminal routing", () => {
  it("opens the sign-up shell on the generic QR", () => {
    visit("/?mode=terminal");
    render(<App />);

    expect(screen.getByRole("button", { name: /I have a pair code/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Create a terminal account/i })).toBeInTheDocument();
  });

  it("shows none of the website inside the terminal flow", () => {
    visit("/?mode=terminal");
    render(<App />);
    const text = document.body.textContent ?? "";

    expect(text).not.toMatch(/One switch/i); // landing hero
    expect(text).not.toMatch(/Test the lab/i);
    expect(text).not.toMatch(/DRIVER BOOTH/i); // marketing auth panel
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("opens the shell from the #/terminal hash route too", () => {
    visit("/#/terminal");
    render(<App />);

    expect(screen.getByRole("button", { name: /I have a pair code/i })).toBeInTheDocument();
  });

  it("skips straight to Assign when the QR carried a code", () => {
    visit("/?mode=terminal&display=7K2M9Q");
    render(<App />);

    expect(screen.queryByRole("button", { name: /I have a pair code/i })).not.toBeInTheDocument();
    expect(document.body.textContent).toContain("7K2 M9Q");
  });

  it("leaves the armed-display QR on the display gate", () => {
    // Regression guard: this is the route the console's Glass tab already prints.
    visit("/?mode=tablet&display=7K2M9Q");
    render(<App />);

    expect(screen.getByRole("button", { name: /I authorize display control/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /I have a pair code/i })).not.toBeInTheDocument();
  });

  /** An assigned terminal: binding + the authorization the assign step wrote. */
  function assignedTerminal(settings = defaultSettings()) {
    const deviceId = terminalDeviceId();
    db.saveSettings(BOOTH.id, settings);
    writeLocalBinding({
      id: `term:${deviceId}:rear`,
      deviceId,
      deviceName: "Rear glass",
      pairCode: "7K2M9Q",
      position: "rear",
      accountId: BOOTH.id,
      accountEmail: BOOTH.email,
      origin: "pair-code",
      assignedAt: Date.now(),
    });
    localStorage.setItem(terminalConsentKey("rear", "7K2M9Q"), "yes");
    visit("/?mode=terminal");
    return render(<App />);
  }

  it("returns an assigned terminal to the glass without asking again", async () => {
    assignedTerminal({ ...defaultSettings(), masterOn: true, motionSafetyGate: false });

    expect(screen.queryByRole("button", { name: /I have a pair code/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Assign and start the display/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /I authorize display control/i })).not.toBeInTheDocument();
    // The booth's own platforms are on the glass, driven by the phone's settings.
    await waitFor(() => expect(document.body.textContent).toMatch(/UBER|DIDI/i), { timeout: 3000 });
  });

  it("keeps the glass black while the driver switch is OFF", () => {
    // OFF is a blank OLED screen with nothing on it — the product's core rule,
    // and the state a freshly assigned terminal is in until the phone says otherwise.
    assignedTerminal({ ...defaultSettings(), masterOn: false });

    expect(document.body.textContent).toBe("");
    expect(screen.queryByRole("button", { name: /Assign and start the display/i })).not.toBeInTheDocument();
  });

  it("re-assigns when the authorization was cleared but the binding remains", () => {
    const deviceId = terminalDeviceId();
    writeLocalBinding({
      id: `term:${deviceId}:rear`,
      deviceId,
      deviceName: "Rear glass",
      pairCode: "7K2M9Q",
      position: "rear",
      accountId: BOOTH.id,
      origin: "pair-code",
      assignedAt: Date.now(),
    });

    visit("/?mode=terminal");
    render(<App />);

    // The code is pre-filled from the binding, so it is one tap, not a re-signup.
    expect(screen.getByRole("button", { name: /Assign and start the display/i })).toBeInTheDocument();
    expect(document.body.textContent).toContain("7K2 M9Q");
  });
});
