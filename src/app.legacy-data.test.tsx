import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";

/**
 * Regression: a device profile saved by an older build was missing `apps`, and
 * the console threw while rendering the Live tab. React unmounted the tree, so
 * the whole app went blank and no control responded — including "View live
 * screen mirror". These tests keep that from coming back.
 */
const LEGACY_SETTINGS = {
  deviceProfiles: [
    { id: "profile:7K2M9Q:rear", pairCode: "7K2M9Q", position: "rear", powered: true, brightness: 70 },
  ],
};

describe("data written by an older build", () => {
  const consoleErrors: string[] = [];
  const originalError = console.error;

  beforeEach(() => {
    localStorage.clear();
    window.location.hash = "";
    consoleErrors.length = 0;
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(" "));
      originalError(...(args as []));
    };
  });

  afterEach(() => {
    console.error = originalError;
  });

  it("still renders the console, and the mirror still opens", async () => {
    // Sign in as the seeded admin, then plant a partial profile on disk.
    window.location.hash = "/login";
    const first = render(<App />);
    await screen.findByRole("button", { name: /enter console/i });
    fireEvent.change(document.querySelector('input[type="email"]') as HTMLInputElement, { target: { value: "tic.raheel@gmail.com" } });
    fireEvent.change(document.querySelector('input[type="password"]') as HTMLInputElement, { target: { value: "Abc@123" } });
    fireEvent.click(screen.getByRole("button", { name: /enter console/i }));
    await waitFor(() => expect(document.body.textContent ?? "").toMatch(/Live/i), { timeout: 5000 });

    const driver = JSON.parse(localStorage.getItem("rf:drivers") ?? "[]").find((d: { email: string }) => d.email === "tic.raheel@gmail.com");
    const bucket = JSON.parse(localStorage.getItem("rf:settings") ?? "{}") as Record<string, unknown>;
    const saved = (bucket[driver.id] ?? {}) as Record<string, unknown>;
    bucket[driver.id] = { ...saved, ...LEGACY_SETTINGS, deviceProfiles: LEGACY_SETTINGS.deviceProfiles };
    localStorage.setItem("rf:settings", JSON.stringify(bucket));

    first.unmount();
    window.location.hash = "/app";
    render(<App />);
    await new Promise((r) => setTimeout(r, 300));

    // The boundary must not have fired, and nothing may have thrown.
    expect(document.body.textContent ?? "").not.toMatch(/SCREEN RECOVERED/i);
    expect(consoleErrors.filter((line) => /Cannot read properties of undefined/.test(line))).toEqual([]);

    // The rear device card is interactive again.
    const mirrors = screen.queryAllByRole("button", { name: /view live screen mirror/i });
    expect(mirrors.length).toBeGreaterThan(0);
    fireEvent.click(mirrors[0]);
    await new Promise((r) => setTimeout(r, 300));
    await waitFor(() => expect(document.body.textContent ?? "").toMatch(/LIVE DEVICE MIRROR/i), { timeout: 3000 });
    expect(document.body.textContent ?? "").not.toMatch(/SCREEN RECOVERED/i);

    // The repaired record drives the UI: a legacy profile with no dwell field
    // renders the library default rather than blanking.
    expect(document.body.textContent ?? "").toMatch(/Logo seconds · 30\.0/);
  });
});

describe("error boundary", () => {
  const Boom = () => {
    throw new Error("deliberate test failure");
  };

  it("shows a recovery screen instead of a blank app", () => {
    const originalError = console.error;
    console.error = () => undefined;
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );
    console.error = originalError;

    expect(document.body.textContent ?? "").toMatch(/This screen failed to render/i);
    expect(document.body.textContent ?? "").toMatch(/Clear local data/i);
    expect(document.body.textContent ?? "").toMatch(/deliberate test failure/i);
  });
});
