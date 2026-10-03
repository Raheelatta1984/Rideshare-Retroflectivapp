import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

/**
 * Boot test — the white-screen catcher.
 *
 * Imports the real App (and therefore every module, including the sync layer)
 * and mounts it in jsdom. If any module-scope code throws — a bad env reference,
 * a broken template literal, a missing export — this fails where a passing
 * `vite build` would not.
 */
describe("App boot", () => {
  const consoleErrors: string[] = [];
  const originalError = console.error;

  beforeEach(() => {
    consoleErrors.length = 0;
    window.location.hash = "";
    localStorage.clear();
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(" "));
      originalError(...(args as []));
    };
  });

  afterEach(() => {
    console.error = originalError;
    vi.restoreAllMocks();
  });

  it("mounts the landing route without crashing", () => {
    render(<App />);
    expect(document.body.textContent ?? "").toMatch(/Retroflex/i);
    expect(consoleErrors.filter((line) => !/act\(/.test(line))).toEqual([]);
  });

  it("boots the driver booth route without crashing", () => {
    window.location.hash = "/login";
    render(<App />);
    // Login screen renders whether or not a session exists; the point is that
    // the router, store, storage layer and sync imports all initialise.
    expect(document.body.innerHTML.length).toBeGreaterThan(200);
    expect(consoleErrors.filter((line) => !/act\(/.test(line))).toEqual([]);
  });

  it("creates unique ids for storage records it writes on boot", () => {
    render(<App />);
    const drivers = JSON.parse(localStorage.getItem("rf:drivers") ?? "[]") as Array<{ id: string; email: string }>;
    const ids = drivers.map((driver) => driver.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^drv_/);
      expect(id).not.toContain("{");
    }
  });
});
