import { describe, expect, it } from "vitest";
import { buildSeedCampaign } from "./demo";
import {
  approvalLabel,
  campaignApprovalState,
  distanceKm,
  geoDecision,
  buildPlaylist,
  campaignBlockReasons,
  campaignBrightness,
  campaignDraftIssues,
  campaignDwellSeconds,
  campaignAssetSrc,
  campaignIsEligible,
  campaignScheduleLabel,
  campaignScheduleState,
  collapseConsecutiveBlanks,
  effectiveMediaType,
  isSafeAssetUrl,
  minDwellSeconds,
  selectCampaigns,
  slideDurationSeconds,
  NSW_HIGH_SPEED_KPH,
  NSW_MIN_DWELL_HIGH_SPEED_SECONDS,
  NSW_MIN_DWELL_SECONDS,
  NSW_NIGHT_BRIGHTNESS_CAP,
  type CampaignContext,
  campaignRunsUnregulated,
  legalPackIsEnabled,
} from "./signage";
import { blankLegalFixture } from "../test/fixtures";
import type { CommercialCampaign } from "../types";

const DAY = 24 * 60 * 60 * 1000;

/** A campaign that satisfies every rule, so tests can break exactly one thing. */
function approvedCampaign(overrides: Partial<CommercialCampaign> = {}): CommercialCampaign {
  const legal = blankLegalFixture();
  const signed = (name: string) => ({
    confirmed: true,
    signerName: name,
    agreementReference: `REF-${name}`,
    email: `${name.toLowerCase()}@example.com`,
  });
  return {
    id: "cmp_1",
    title: "Bondi Coffee",
    enabled: true,
    approved: true,
    assetDataUrl: "data:image/png;base64,AAAA",
    mediaType: "image",
    displaySeconds: 10,
    legal: {
      ...legal,
      appOwner: signed("Owner"),
      driver: signed("Driver"),
      vehicleOwner: signed("CarOwner"),
      campaignOwner: signed("Agency"),
      trademarkAuthorization: signed("Legal"),
      safetyAssessment: signed("Safety"),
    },
    ...overrides,
  };
}

const SAFE_CONTEXT: CampaignContext = { nswSafetyMode: true, position: "rear", parkedConfirmed: true };

describe("dwell floors (plan: 10s below 80 km/h, 25s at or above)", () => {
  it("uses 10s at low speed and 25s at the threshold", () => {
    expect(minDwellSeconds(0)).toBe(NSW_MIN_DWELL_SECONDS);
    expect(minDwellSeconds(79.9)).toBe(NSW_MIN_DWELL_SECONDS);
    expect(minDwellSeconds(NSW_HIGH_SPEED_KPH)).toBe(NSW_MIN_DWELL_HIGH_SPEED_SECONDS);
    expect(minDwellSeconds(110)).toBe(NSW_MIN_DWELL_HIGH_SPEED_SECONDS);
  });

  it("raises a short authored dwell to the legal floor in safety mode", () => {
    expect(campaignDwellSeconds({ displaySeconds: 3 }, { nswSafetyMode: true })).toBe(10);
    expect(campaignDwellSeconds({ displaySeconds: 3 }, { nswSafetyMode: true, speedKph: 90 })).toBe(25);
  });

  it("never shortens a longer authored dwell", () => {
    expect(campaignDwellSeconds({ displaySeconds: 45 }, { nswSafetyMode: true })).toBe(45);
  });

  it("respects the author outside safety mode, with a half-second floor", () => {
    expect(campaignDwellSeconds({ displaySeconds: 2 }, { nswSafetyMode: false })).toBe(2);
    expect(campaignDwellSeconds({ displaySeconds: 0 }, { nswSafetyMode: false })).toBe(0.5);
  });
});

describe("schedule window", () => {
  const now = 1_700_000_000_000;

  it("reports unscheduled campaigns as always eligible", () => {
    expect(campaignScheduleState({}, now)).toBe("unscheduled");
  });

  it("walks the window states", () => {
    expect(campaignScheduleState({ startAt: now + DAY }, now)).toBe("scheduled");
    expect(campaignScheduleState({ startAt: now - DAY, endAt: now + DAY }, now)).toBe("live");
    expect(campaignScheduleState({ endAt: now - DAY }, now)).toBe("expired");
  });

  it("treats the exact boundaries as live", () => {
    expect(campaignScheduleState({ startAt: now, endAt: now }, now)).toBe("live");
  });

  it("blocks campaigns outside their window", () => {
    expect(campaignBlockReasons(approvedCampaign({ startAt: now + DAY }), { ...SAFE_CONTEXT, now })).toContain("not-scheduled");
    expect(campaignBlockReasons(approvedCampaign({ endAt: now - DAY }), { ...SAFE_CONTEXT, now })).toContain("expired");
  });

  it("writes a human label for the console", () => {
    expect(campaignScheduleLabel({}, now)).toBe("Always eligible");
    expect(campaignScheduleLabel({ startAt: now - DAY, endAt: now + DAY }, now)).toContain("Live until");
    expect(campaignScheduleLabel({ endAt: now - DAY }, now)).toContain("Expired");
  });
});

describe("eligibility gating", () => {
  it("passes a fully compliant campaign", () => {
    expect(campaignIsEligible(approvedCampaign(), SAFE_CONTEXT)).toBe(true);
    expect(campaignBlockReasons(approvedCampaign(), SAFE_CONTEXT)).toEqual([]);
  });

  it("blocks disabled and unapproved campaigns", () => {
    expect(campaignBlockReasons(approvedCampaign({ enabled: false }), SAFE_CONTEXT)).toContain("disabled");
    expect(campaignBlockReasons(approvedCampaign({ approved: false }), SAFE_CONTEXT)).toContain("not-approved");
  });

  it("blocks a front-targeted campaign on the rear screen and vice versa", () => {
    expect(campaignBlockReasons(approvedCampaign({ target: "front" }), SAFE_CONTEXT)).toContain("wrong-position");
    expect(campaignIsEligible(approvedCampaign({ target: "front" }), { ...SAFE_CONTEXT, position: "front" })).toBe(true);
    expect(campaignIsEligible(approvedCampaign({ target: "both" }), { ...SAFE_CONTEXT, position: "front" })).toBe(true);
  });

  it("blocks every campaign without the six signed consents", () => {
    const legal = blankLegalFixture();
    const campaign = approvedCampaign({ legal });
    expect(campaignBlockReasons(campaign, SAFE_CONTEXT)).toContain("legal-incomplete");
  });

  it("requires the parked confirmation in NSW safety mode only", () => {
    const campaign = approvedCampaign();
    expect(campaignBlockReasons(campaign, { ...SAFE_CONTEXT, parkedConfirmed: false })).toContain("parked-confirmation-missing");
    expect(campaignIsEligible(campaign, { nswSafetyMode: false, position: "rear", parkedConfirmed: false })).toBe(true);
  });

  // Plan: "GIF, video, animation ... are not part of the NSW Safety Mode playlist."
  it("blocks non-static media under safety mode", () => {
    const gif = approvedCampaign({ mediaType: "gif" });
    expect(campaignBlockReasons(gif, SAFE_CONTEXT)).toContain("media-not-static");
    expect(campaignIsEligible(gif, { nswSafetyMode: false, position: "rear" })).toBe(true);
  });

  it("blocks campaigns with no usable asset", () => {
    expect(campaignBlockReasons(approvedCampaign({ assetDataUrl: undefined }), SAFE_CONTEXT)).toContain("asset-missing");
    expect(campaignBlockReasons(approvedCampaign({ assetDataUrl: undefined, assetUrl: "javascript:alert(1)" }), SAFE_CONTEXT)).toContain("asset-missing");
    expect(campaignIsEligible(approvedCampaign({ assetDataUrl: undefined, assetUrl: "https://cdn.example.com/a.png" }), SAFE_CONTEXT)).toBe(true);
  });

  it("blocks referral campaigns without clear offer terms", () => {
    const legal = blankLegalFixture();
    const referral = approvedCampaign({ referralCode: "SAVE10", legal: { ...legal } });
    expect(campaignBlockReasons(referral, SAFE_CONTEXT)).toContain("referral-incomplete");
  });

  it("reports every reason at once, without duplicates", () => {
    const reasons = campaignBlockReasons(
      approvedCampaign({ enabled: false, approved: false, target: "front", mediaType: "video" }),
      { ...SAFE_CONTEXT, parkedConfirmed: false },
    );
    expect(reasons).toEqual(expect.arrayContaining(["disabled", "not-approved", "wrong-position", "media-not-static", "parked-confirmation-missing"]));
    expect(new Set(reasons).size).toBe(reasons.length);
  });
});

describe("selectCampaigns", () => {
  it("keeps only eligible campaigns", () => {
    const good = approvedCampaign({ id: "cmp_good" });
    const bad = approvedCampaign({ id: "cmp_bad", approved: false });
    const selected = selectCampaigns([good, bad], SAFE_CONTEXT);
    expect(selected.map((campaign) => campaign.id)).toEqual(["cmp_good"]);
  });

  it("handles an undefined campaign list", () => {
    expect(selectCampaigns(undefined, SAFE_CONTEXT)).toEqual([]);
  });
});

describe("asset resolution", () => {
  it("prefers the approved remote asset over the cached file", () => {
    expect(campaignAssetSrc({ assetUrl: "https://cdn.example.com/a.png", assetDataUrl: "data:image/png;base64,AAAA" }))
      .toBe("https://cdn.example.com/a.png");
  });

  it("falls back to the cached asset", () => {
    expect(campaignAssetSrc({ assetDataUrl: "data:image/png;base64,AAAA" })).toBe("data:image/png;base64,AAAA");
    expect(campaignAssetSrc({})).toBeUndefined();
    expect(campaignAssetSrc({ assetUrl: "   " })).toBeUndefined();
  });

  it("only trusts http(s) and image/video data URIs", () => {
    expect(isSafeAssetUrl("https://cdn.example.com/a.png")).toBe(true);
    expect(isSafeAssetUrl("data:image/png;base64,AAAA")).toBe(true);
    expect(isSafeAssetUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeAssetUrl("blob:https://x/y")).toBe(false);
    expect(isSafeAssetUrl(undefined)).toBe(false);
  });

  it("downgrades any media to static under safety mode", () => {
    expect(effectiveMediaType({ mediaType: "video" }, true)).toBe("image");
    expect(effectiveMediaType({ mediaType: "video" }, false)).toBe("video");
  });
});

describe("playlist (plan order: logo → blank → campaign → blank)", () => {
  const platforms = [{ id: "uber" }, { id: "didi" }];

  it("interleaves a blank between the logo group and the campaign group", () => {
    const playlist = buildPlaylist({
      platforms,
      campaigns: [approvedCampaign()],
      commercialEnabled: true,
      nswSafetyMode: true,
      includeBlank: true,
    });
    expect(playlist.map((slide) => slide.kind)).toEqual(["platform", "platform", "blank", "campaign", "blank"]);
  });

  it("collapses the trailing blank when there are no campaigns", () => {
    const playlist = buildPlaylist({
      platforms,
      campaigns: [],
      commercialEnabled: true,
      nswSafetyMode: true,
      includeBlank: true,
    });
    expect(playlist.map((slide) => slide.kind)).toEqual(["platform", "platform", "blank"]);
  });

  it("omits blanks entirely when the profile asks for none", () => {
    const playlist = buildPlaylist({
      platforms,
      campaigns: [approvedCampaign()],
      commercialEnabled: true,
      nswSafetyMode: true,
      includeBlank: false,
    });
    expect(playlist.map((slide) => slide.kind)).toEqual(["platform", "platform", "campaign"]);
  });

  // The device profile is the switch: no commercial access, no campaign slides.
  it("drops campaign slides when commercial mode is off for the device", () => {
    const playlist = buildPlaylist({
      platforms,
      campaigns: [approvedCampaign()],
      commercialEnabled: false,
      nswSafetyMode: true,
      includeBlank: true,
    });
    expect(playlist.some((slide) => slide.kind === "campaign")).toBe(false);
  });

  it("collapses runs of blanks but keeps single ones", () => {
    expect(collapseConsecutiveBlanks([{ kind: "blank" }, { kind: "blank" }, { kind: "platform", platform: platforms[0] }]))
      .toEqual([{ kind: "blank" }, { kind: "platform", platform: platforms[0] }]);
  });
});

describe("slide durations", () => {
  const options = { platformSeconds: 4.5, blankSeconds: 1.5, nswSafetyMode: true, speedKph: 0 };

  it("uses the profile timings for logo and blank slides", () => {
    expect(slideDurationSeconds({ kind: "platform", platform: { id: "uber" } }, options)).toBe(4.5);
    expect(slideDurationSeconds({ kind: "blank" }, options)).toBe(1.5);
    expect(slideDurationSeconds(undefined, options)).toBe(1.5);
  });

  it("applies the campaign dwell rules to campaign slides", () => {
    expect(slideDurationSeconds({ kind: "campaign", campaign: approvedCampaign({ displaySeconds: 3 }) }, options)).toBe(10);
    expect(slideDurationSeconds({ kind: "campaign", campaign: approvedCampaign({ displaySeconds: 3 }) }, { ...options, speedKph: 85 })).toBe(25);
  });
});

describe("brightness caps", () => {
  it("applies the campaign cap when it is lower than the screen setting", () => {
    expect(campaignBrightness(90, { campaign: { brightnessCap: 40 } })).toBe(40);
  });

  it("never raises brightness above the screen setting", () => {
    expect(campaignBrightness(50, { campaign: { brightnessCap: 100 } })).toBe(50);
  });

  it("caps night brightness even without a campaign cap", () => {
    expect(campaignBrightness(95, { isNight: true })).toBe(NSW_NIGHT_BRIGHTNESS_CAP);
    expect(campaignBrightness(95, { isNight: false })).toBe(95);
  });

  it("never drops below the readable floor", () => {
    expect(campaignBrightness(30, { campaign: { brightnessCap: 5 } })).toBe(18);
  });

  it("behaves with no campaign on screen", () => {
    expect(campaignBrightness(70, {})).toBe(70);
    expect(campaignBrightness(70, { campaign: null })).toBe(70);
  });
});

describe("console draft validation", () => {
  const base = { title: "Bondi Coffee", assetDataUrl: "data:image/png;base64,AAAA", mediaType: "image" as const, nswSafetyMode: true };

  it("accepts a complete draft", () => {
    expect(campaignDraftIssues(base)).toEqual([]);
  });

  it("requires a title and an asset", () => {
    expect(campaignDraftIssues({ ...base, title: "  " }).join(" ")).toContain("title");
    expect(campaignDraftIssues({ ...base, assetDataUrl: undefined }).join(" ")).toContain("asset");
  });

  it("rejects unsafe asset and landing URLs", () => {
    expect(campaignDraftIssues({ ...base, assetUrl: "javascript:x" }).join(" ")).toContain("https://");
    expect(campaignDraftIssues({ ...base, landingUrl: "ftp://x" }).join(" ")).toContain("Landing URL");
    expect(campaignDraftIssues({ ...base, landingUrl: "https://offer.example.com" })).toEqual([]);
  });

  it("rejects an end time before the start time", () => {
    expect(campaignDraftIssues({ ...base, startAt: 200, endAt: 100 }).join(" ")).toContain("after the start");
  });

  it("bounds the brightness cap", () => {
    expect(campaignDraftIssues({ ...base, brightnessCap: 5 }).join(" ")).toContain("Brightness cap");
    expect(campaignDraftIssues({ ...base, brightnessCap: 45 })).toEqual([]);
  });

  it("blocks non-static media under safety mode", () => {
    expect(campaignDraftIssues({ ...base, mediaType: "video" }).join(" ")).toContain("static image");
    expect(campaignDraftIssues({ ...base, mediaType: "video", nswSafetyMode: false })).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Phase 2 — approval workflow
 * ------------------------------------------------------------------ */

describe("approval workflow", () => {
  it("falls back to the legacy approved flag when no workflow state exists", () => {
    expect(campaignApprovalState(approvedCampaign({ approval: undefined }))).toBe("approved");
    expect(campaignApprovalState(approvedCampaign({ approved: false, approval: undefined }))).toBe("draft");
  });

  it("prefers the workflow state once a review has happened", () => {
    expect(campaignApprovalState(approvedCampaign({ approval: { state: "pending" } }))).toBe("pending");
    expect(campaignApprovalState(approvedCampaign({ approved: true, approval: { state: "rejected" } }))).toBe("rejected");
  });

  it("gates eligibility on the approval state, not the boolean", () => {
    expect(campaignIsEligible(approvedCampaign({ approval: { state: "pending" } }), SAFE_CONTEXT)).toBe(false);
    expect(campaignBlockReasons(approvedCampaign({ approval: { state: "pending" } }), SAFE_CONTEXT)).toContain("not-approved");
    expect(campaignIsEligible(approvedCampaign({ approval: { state: "approved" } }), SAFE_CONTEXT)).toBe(true);
  });

  it("labels the review for the console and client portal", () => {
    expect(approvalLabel(approvedCampaign({ approval: { state: "pending" } }))).toBe("pending");
    expect(approvalLabel(approvedCampaign({ approval: { state: "approved", reviewer: "Raheel", reviewedAt: Date.now() } })))
      .toContain("approved · Raheel");
  });
});

/* ------------------------------------------------------------------ *
 * Phase 2 — geographic rules
 * ------------------------------------------------------------------ */

describe("geographic rules", () => {
  const sydney = { latitude: -33.8688, longitude: 151.2093 };

  it("measures distance", () => {
    expect(distanceKm(sydney, sydney)).toBe(0);
    // Sydney -> Melbourne is ~714 km.
    const melbourne = { latitude: -37.8136, longitude: 144.9631 };
    expect(distanceKm(sydney, melbourne)).toBeGreaterThan(700);
    expect(distanceKm(sydney, melbourne)).toBeLessThan(730);
  });

  it("decides inside / outside / unknown", () => {
    const rule = { ...sydney, radiusKm: 5 };
    expect(geoDecision(rule, sydney)).toBe("inside");
    // ~1.6 km from the centre: inside a 5 km radius.
    expect(geoDecision(rule, { latitude: -33.88, longitude: 151.22 })).toBe("inside");
    expect(geoDecision(rule, { latitude: -33.95, longitude: 151.3 })).toBe("outside");
    expect(geoDecision(rule, undefined)).toBe("unknown");
    expect(geoDecision(undefined, sydney)).toBe("inside");
  });

  it("blocks a campaign outside its area", () => {
    const campaign = approvedCampaign({ geoRule: { ...sydney, radiusKm: 3 } });
    const melbourne = { latitude: -37.8136, longitude: 144.9631 };
    expect(campaignBlockReasons(campaign, { ...SAFE_CONTEXT, location: melbourne })).toContain("outside-geo");
    expect(campaignIsEligible(campaign, { ...SAFE_CONTEXT, location: sydney })).toBe(true);
  });

  // Fail closed: no GPS fix must not mean "show the advert anyway".
  it("blocks when there is no fix, and allows it only when explicitly permitted", () => {
    const campaign = approvedCampaign({ geoRule: { ...sydney, radiusKm: 3 } });
    expect(campaignBlockReasons(campaign, { ...SAFE_CONTEXT, location: undefined })).toContain("outside-geo");
    expect(campaignIsEligible(campaign, { ...SAFE_CONTEXT, location: undefined, requireLocation: false })).toBe(true);
  });

  it("leaves campaigns without a geo rule unaffected", () => {
    expect(campaignIsEligible(approvedCampaign({ geoRule: undefined }), { ...SAFE_CONTEXT, location: undefined })).toBe(true);
  });
});

describe("legal & approval pack master switch", () => {
  /** A campaign with no consents, no approval and a referral code — i.e. the worst case. */
  const bare: CommercialCampaign = {
    id: "cmp_bare",
    title: "Bare campaign",
    mediaType: "image",
    assetDataUrl: "data:image/png;base64,AAAA",
    displaySeconds: 12,
    enabled: true,
    approved: false,
    discountText: "20% off",
    referralCode: "RIDE20",
  };

  const rearNsw = {
    nswSafetyMode: true,
    position: "rear" as const,
    parkedConfirmed: true,
    now: Date.now(),
  };

  it("blocks an unsigned, unapproved campaign while the pack is on", () => {
    const reasons = campaignBlockReasons(bare, { ...rearNsw, legalPackEnabled: true });
    expect(reasons).toContain("legal-incomplete");
    expect(reasons).toContain("not-approved");
    expect(reasons).toContain("referral-incomplete");
  });

  it("defaults to the pack being ON when the caller says nothing", () => {
    expect(campaignBlockReasons(bare, rearNsw)).toContain("not-approved");
  });

  it("lets it straight through when the pack is off", () => {
    expect(campaignBlockReasons(bare, { ...rearNsw, legalPackEnabled: false })).toEqual([]);
  });

  it("ignores geographic rules while the pack is off", () => {
    const geo = { latitude: -33.8688, longitude: 151.2093, radiusKm: 5 };
    const signedRegulated: CommercialCampaign = {
      ...bare,
      approval: { state: "approved" },
      approved: true,
      referralCode: undefined,
      discountText: undefined,
      legal: buildSeedCampaign().legal,
      geoRule: geo,
    };
    // No fix at all: fail-closed for a regulated campaign, irrelevant once the
    // pack is off — or once the campaign is stamped unregulated.
    expect(campaignBlockReasons(signedRegulated, { ...rearNsw, legalPackEnabled: true })).toContain("outside-geo");
    expect(campaignBlockReasons(signedRegulated, { ...rearNsw, legalPackEnabled: false })).toEqual([]);
    expect(
      campaignBlockReasons({ ...signedRegulated, complianceMode: "unregulated" }, { ...rearNsw, legalPackEnabled: true })
    ).toEqual([]);
  });

  it("keeps an unregulated campaign displaying after the pack is switched back on", () => {
    const stamped: CommercialCampaign = { ...bare, complianceMode: "unregulated" };
    expect(campaignBlockReasons(stamped, { ...rearNsw, legalPackEnabled: true })).toEqual([]);
    expect(campaignRunsUnregulated(stamped, { legalPackEnabled: true })).toBe(true);
  });

  it("still enforces the safety rules separately", () => {
    const stamped: CommercialCampaign = { ...bare, complianceMode: "unregulated" };
    // NSW Safety Mode is a different switch and still applies to test content.
    expect(campaignBlockReasons(stamped, { ...rearNsw, parkedConfirmed: false, legalPackEnabled: true })).toContain(
      "parked-confirmation-missing"
    );
    expect(
      campaignBlockReasons({ ...stamped, mediaType: "video" }, { ...rearNsw, legalPackEnabled: true })
    ).toContain("media-not-static");
  });

  it("never exempts a regulated campaign just because the pack was off earlier", () => {
    const regulated: CommercialCampaign = { ...bare, complianceMode: "regulated" };
    expect(campaignRunsUnregulated(regulated, { legalPackEnabled: true })).toBe(false);
    expect(campaignBlockReasons(regulated, { ...rearNsw, legalPackEnabled: true })).not.toEqual([]);
  });

  it("reads the pack state from settings with a safe default", () => {
    expect(legalPackIsEnabled(undefined)).toBe(true);
    expect(legalPackIsEnabled({})).toBe(true);
    expect(legalPackIsEnabled({ legalPackEnabled: false })).toBe(false);
    expect(campaignRunsUnregulated(bare, { legalPackEnabled: false })).toBe(true);
  });
});
