import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DisplayScreen } from "./DisplayScreen";
import { buildSeedCampaign, enableCommercialOnProfile } from "../lib/demo";
import { defaultSettings } from "../lib/storage";
import type { DisplaySettings } from "../types";

const PAIR = "7K2M9Q";

/** A rear glass with one campaign assigned, lit, motion gate relaxed. */
function glass(mode: "regulated" | "unregulated", extra: Partial<DisplaySettings> = {}) {
  const campaign = buildSeedCampaign(Date.now(), mode);
  return {
    campaign,
    settings: {
      ...defaultSettings(),
      masterOn: true,
      motionSafetyGate: false,
      commercialCampaigns: [campaign],
      deviceProfiles: enableCommercialOnProfile([], { pairCode: PAIR, campaignId: campaign.id }),
      ...extra,
    } as DisplaySettings,
  };
}

describe("unregulated marker on the glass", () => {
  it("marks a display showing unregulated test content", async () => {
    const { settings } = glass("unregulated");
    render(<DisplayScreen pairCode={PAIR} position="rear" powered preview settings={settings} />);
    await waitFor(() => expect(document.body.textContent ?? "").toMatch(/NO LEGAL PACK/i), { timeout: 3000 });
  });

  it("marks the glass too when the pack is off, whatever the campaign says", async () => {
    const { settings } = glass("regulated", { legalPackEnabled: false });
    render(<DisplayScreen pairCode={PAIR} position="rear" powered preview settings={settings} />);
    await waitFor(() => expect(document.body.textContent ?? "").toMatch(/NO LEGAL PACK/i), { timeout: 3000 });
  });

  it("stays out of the way for a regulated playlist", async () => {
    const { settings } = glass("regulated", { legalPackEnabled: true });
    render(<DisplayScreen pairCode={PAIR} position="rear" powered preview settings={settings} />);
    await new Promise((r) => setTimeout(r, 500));
    expect(document.body.textContent ?? "").not.toMatch(/NO LEGAL PACK/i);
  });

  it("can be switched off for a client demo, as agreed", async () => {
    const { settings } = glass("unregulated", { unregulatedBadge: false });
    render(<DisplayScreen pairCode={PAIR} position="rear" powered preview settings={settings} />);
    await new Promise((r) => setTimeout(r, 500));
    expect(document.body.textContent ?? "").not.toMatch(/NO LEGAL PACK/i);
  });
});
