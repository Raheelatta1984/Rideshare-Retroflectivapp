import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StoreProvider } from "../store";
import { TerminalSetup } from "./TerminalSetup";
import { db } from "../lib/storage";
import { readLocalBinding, terminalConsentKey } from "../lib/terminals";
import type { Driver, TerminalBinding } from "../types";

/**
 * The scanned-terminal flow.
 *
 * What matters here is the shape of the experience: nothing from the website is
 * reachable, a pair code is enough to get a terminal onto the glass, sign-up
 * mints a code, and assigning writes the authorization the display needs.
 */

const BOOTH: Driver = {
  id: "drv_booth",
  name: "Raheel Atta",
  email: "driver@retroflex.app",
  phone: "0400 111 222",
  password: "demo1234",
  city: "Sydney",
  pairCode: "7K2M9Q",
  frontPairCode: "FR0NT1",
  createdAt: new Date().toISOString(),
  platforms: ["uber", "didi"],
  vehicle: { make: "Toyota", model: "Prius V", color: "White", plate: "CIW37G", year: "2012" },
  role: "driver",
};

function setup(props: Partial<React.ComponentProps<typeof TerminalSetup>> = {}) {
  const onAssigned = vi.fn();
  render(
    <StoreProvider>
      <TerminalSetup code={null} position="rear" onAssigned={onAssigned} {...props} />
    </StoreProvider>,
  );
  return { onAssigned };
}

function enterCode(value: string) {
  fireEvent.change(screen.getByLabelText("Pair code"), { target: { value } });
}

async function assignStep() {
  return screen.findByRole("heading", { name: /Assign this terminal/i });
}

beforeEach(() => {
  localStorage.clear();
  db.saveDriver(BOOTH);
});

describe("terminal gate", () => {
  it("offers a code login and a sign-up, and nothing else", () => {
    setup();

    expect(screen.getByRole("button", { name: /I have a pair code/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Create a terminal account/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Log in with email instead/i })).toBeInTheDocument();
  });

  it("shows no part of the website", () => {
    setup();
    const text = document.body.textContent ?? "";

    // The terminal is a display, not a browsing device: no landing, no lab, no
    // demo, no review guide, no source vault.
    for (const forbidden of [/Test the lab/i, /Live preview/i, /Review the pair lab/i, /One switch/i, /Arm a tablet/i, /Owner Source Vault/i]) {
      expect(text).not.toMatch(forbidden);
    }
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  it("skips the gate when the QR already carried a code", async () => {
    setup({ code: "7K2M9Q" });

    await assignStep();
    expect(screen.queryByRole("button", { name: /I have a pair code/i })).not.toBeInTheDocument();
    expect(document.body.textContent).toContain("7K2 M9Q");
  });
});

describe("pair-code login", () => {
  it("confirms a known code and assigns the terminal to the rear glass", async () => {
    const { onAssigned } = setup();

    fireEvent.click(screen.getByRole("button", { name: /I have a pair code/i }));
    enterCode("7k2m9q");

    // A complete code submits itself — scan, type, done.
    await assignStep();
    expect(document.body.textContent).toMatch(/Confirmed · booth of Raheel Atta/i);

    fireEvent.click(screen.getByRole("button", { name: /Assign and start the display/i }));

    await waitFor(() => expect(onAssigned).toHaveBeenCalledTimes(1));
    const binding = onAssigned.mock.calls[0][0] as TerminalBinding;
    expect(binding).toMatchObject({ pairCode: "7K2M9Q", position: "rear", origin: "pair-code", accountId: BOOTH.id });

    // Assigning is the authorization: the display gate must not ask again.
    expect(localStorage.getItem(terminalConsentKey("rear", "7K2M9Q"))).toBe("yes");
    expect(readLocalBinding()?.deviceId).toBe(binding.deviceId);

    // The booth now knows the terminal by the name chosen on the tablet, so the
    // phone console lists it instead of a generated label.
    const profiles = db.getSettings(BOOTH.id).deviceProfiles ?? [];
    expect(profiles.some((profile) => profile.deviceId === binding.deviceId && profile.label === "Rear glass")).toBe(true);
  });

  it("does not open a console session on the terminal", async () => {
    const { onAssigned } = setup();

    fireEvent.click(screen.getByRole("button", { name: /I have a pair code/i }));
    enterCode("7K2M9Q");
    await assignStep();
    fireEvent.click(screen.getByRole("button", { name: /Assign and start the display/i }));
    await waitFor(() => expect(onAssigned).toHaveBeenCalled());

    // A pair code arms a display. It is not a password: the booth stays locked.
    expect(db.getSession()).toBeNull();
  });

  it("switches the assignment to the front glass", async () => {
    const { onAssigned } = setup({ position: "rear", code: "FR0NT1" });

    await assignStep();
    fireEvent.click(screen.getByRole("button", { name: /Front display/i }));
    fireEvent.click(screen.getByRole("button", { name: /Assign and start the display/i }));

    await waitFor(() => expect(onAssigned).toHaveBeenCalledTimes(1));
    expect(onAssigned.mock.calls[0][0]).toMatchObject({ position: "front", pairCode: "FR0NT1" });
    expect(localStorage.getItem(terminalConsentKey("front", "FR0NT1"))).toBe("yes");
  });

  it("keeps the terminal name the driver typed", async () => {
    const { onAssigned } = setup({ code: "7K2M9Q" });

    await assignStep();
    fireEvent.change(screen.getByLabelText(/Terminal name/i), { target: { value: "Prius rear window" } });
    fireEvent.click(screen.getByRole("button", { name: /Assign and start the display/i }));

    await waitFor(() => expect(onAssigned).toHaveBeenCalledTimes(1));
    expect(onAssigned.mock.calls[0][0].deviceName).toBe("Prius rear window");
  });

  it("says honestly when a code cannot be confirmed on this device", async () => {
    const { onAssigned } = setup();

    fireEvent.click(screen.getByRole("button", { name: /I have a pair code/i }));
    enterCode("QQQ999");

    await assignStep();
    expect(document.body.textContent).toMatch(/cannot be confirmed here/i);

    fireEvent.click(screen.getByRole("button", { name: /Assign and start the display/i }));
    await waitFor(() => expect(onAssigned).toHaveBeenCalledTimes(1));
    // Still assigned: pairing rides the pair-code channel, not the account.
    expect(onAssigned.mock.calls[0][0]).toMatchObject({ pairCode: "QQQ999", accountId: null });
  });

  it("will not continue on an incomplete code", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /I have a pair code/i }));
    enterCode("7K2");

    expect(screen.getByRole("button", { name: /Continue/i })).toBeDisabled();
    expect(screen.queryByRole("heading", { name: /Assign this terminal/i })).not.toBeInTheDocument();

    // Forced submit (Enter on a hardware keyboard) is caught by the same guard.
    fireEvent.submit(screen.getByLabelText("Pair code").closest("form")!);
    expect(await screen.findByText(/six characters/i)).toBeInTheDocument();
  });
});

describe("terminal sign-up", () => {
  async function signUp(email = "newdriver@retroflex.app") {
    fireEvent.click(screen.getByRole("button", { name: /Create a terminal account/i }));
    fireEvent.change(screen.getByLabelText(/Full name/i), { target: { value: "New Driver" } });
    fireEvent.change(screen.getByLabelText(/^Email/i), { target: { value: email } });
    fireEvent.change(screen.getByLabelText(/Password/i), { target: { value: "terminal123" } });
    fireEvent.change(screen.getByLabelText(/City/i), { target: { value: "Sydney" } });
    fireEvent.click(screen.getByRole("button", { name: /Create account/i }));
  }

  it("creates the account, mints a code and lights the new beacon", async () => {
    const { onAssigned } = setup();
    await signUp();

    await assignStep();
    const account = db.findByEmail("newdriver@retroflex.app");
    expect(account).toBeTruthy();
    expect(account?.pairCode).toMatch(/^[A-Z0-9]{6}$/);
    expect(document.body.textContent).toContain(account!.pairCode.slice(0, 3));
    expect(document.body.textContent).toMatch(/Confirmed/i);

    fireEvent.click(screen.getByRole("button", { name: /Assign and start the display/i }));
    await waitFor(() => expect(onAssigned).toHaveBeenCalledTimes(1));
    expect(onAssigned.mock.calls[0][0]).toMatchObject({ pairCode: account!.pairCode, origin: "signup" });

    // No phone is paired yet, so the beacon comes on by itself.
    expect(db.getSettings(account!.id).masterOn).toBe(true);
    // Sign-up is a real credential check, so this browser is signed in to the
    // booth it just created — unlike the pair-code path above.
    expect(db.getSession()?.driverId).toBe(account!.id);
  });

  it("reports an email that is already registered", async () => {
    setup();
    await signUp(BOOTH.email);
    expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
  });

  it("reports a weak password before it reaches storage", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /Create a terminal account/i }));
    fireEvent.change(screen.getByLabelText(/Full name/i), { target: { value: "New Driver" } });
    fireEvent.change(screen.getByLabelText(/^Email/i), { target: { value: "weak@retroflex.app" } });
    fireEvent.change(screen.getByLabelText(/Password/i), { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: /Create account/i }));

    expect(await screen.findByText("Use at least 8 characters for the password.")).toBeInTheDocument();
    expect(db.findByEmail("weak@retroflex.app")).toBeUndefined();
  });
});

describe("email login on a terminal", () => {
  it("logs in and offers the booth's own code", async () => {
    const { onAssigned } = setup();

    fireEvent.click(screen.getByRole("button", { name: /Log in with email instead/i }));
    fireEvent.change(screen.getByLabelText(/^Email/i), { target: { value: BOOTH.email } });
    fireEvent.change(screen.getByLabelText(/Password/i), { target: { value: "demo1234" } });
    fireEvent.click(screen.getByRole("button", { name: /Log in$/i }));

    await assignStep();
    expect(document.body.textContent).toContain("7K2 M9Q");

    fireEvent.click(screen.getByRole("button", { name: /Assign and start the display/i }));
    await waitFor(() => expect(onAssigned).toHaveBeenCalledTimes(1));
    expect(onAssigned.mock.calls[0][0]).toMatchObject({ pairCode: "7K2M9Q", origin: "email", accountId: BOOTH.id });
  });

  it("rejects the wrong password without assigning anything", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /Log in with email instead/i }));
    fireEvent.change(screen.getByLabelText(/^Email/i), { target: { value: BOOTH.email } });
    fireEvent.change(screen.getByLabelText(/Password/i), { target: { value: "not-it" } });
    fireEvent.click(screen.getByRole("button", { name: /Log in$/i }));

    expect(await screen.findByText(/wrong/i)).toBeInTheDocument();
    expect(readLocalBinding()).toBeNull();
  });
});
