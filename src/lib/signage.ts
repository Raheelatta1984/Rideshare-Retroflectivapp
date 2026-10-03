import type {
  CampaignApprovalState,
  CampaignGeoRule,
  CampaignMediaType,
  CommercialCampaign,
  DeviceProfile,
  GeoPoint,
} from "../types";

export type { CampaignMediaType };

/**
 * Commercial signage engine — implements the playlist and safety rules from
 * COMMERCIAL-SIGNAGE-PLAN.md as pure functions.
 *
 * Everything the display and the driver console need to decide "may this
 * campaign be shown, for how long, at what brightness" lives here so it can be
 * unit-tested without a browser or a tablet.
 *
 * This is a guardrail, not legal approval. See the plan's Safety And Legal Rules.
 */

/* ------------------------------------------------------------------ *
 * NSW guidance constants
 * ------------------------------------------------------------------ */

/** Minimum static dwell (seconds) below the high-speed threshold. */
export const NSW_MIN_DWELL_SECONDS = 10;
/** Minimum static dwell (seconds) at or above the high-speed threshold. */
export const NSW_MIN_DWELL_HIGH_SPEED_SECONDS = 25;
/** Speed (km/h) at which the longer minimum dwell applies. */
export const NSW_HIGH_SPEED_KPH = 80;
/** Brightness ceiling (percent) applied to advertising after dark. */
export const NSW_NIGHT_BRIGHTNESS_CAP = 62;
/** Absolute display floor so a capped frame is never unreadable. */
export const MIN_DISPLAY_BRIGHTNESS = 18;

/* ------------------------------------------------------------------ *
 * Dwell
 * ------------------------------------------------------------------ */

/**
 * Minimum static dwell for the current speed.
 * Plan: "minimum static dwell guidance of 10 seconds below 80 km/h and
 * 25 seconds at 80 km/h or above".
 */
export function minDwellSeconds(speedKph?: number): number {
  return (speedKph ?? 0) >= NSW_HIGH_SPEED_KPH
    ? NSW_MIN_DWELL_HIGH_SPEED_SECONDS
    : NSW_MIN_DWELL_SECONDS;
}

/**
 * How long a campaign slide stays up.
 * Safety mode raises the author's value to the legal floor; outside safety mode
 * the author's value wins but never drops below a half-second.
 */
export function campaignDwellSeconds(
  campaign: Pick<CommercialCampaign, "displaySeconds">,
  options: { nswSafetyMode: boolean; speedKph?: number },
): number {
  const authored = campaign.displaySeconds > 0 ? campaign.displaySeconds : 0.5;
  if (!options.nswSafetyMode) return Math.max(0.5, authored);
  return Math.max(minDwellSeconds(options.speedKph), authored);
}

/* ------------------------------------------------------------------ *
 * Schedule window
 * ------------------------------------------------------------------ */

export type CampaignScheduleState = "unscheduled" | "scheduled" | "live" | "expired";

/**
 * Where the campaign sits in its own start/end window.
 * `unscheduled` means the campaign has no window and is always eligible.
 */
export function campaignScheduleState(
  campaign: Pick<CommercialCampaign, "startAt" | "endAt">,
  now: number = Date.now(),
): CampaignScheduleState {
  const { startAt, endAt } = campaign;
  if (startAt === undefined && endAt === undefined) return "unscheduled";
  if (startAt !== undefined && now < startAt) return "scheduled";
  if (endAt !== undefined && now > endAt) return "expired";
  return "live";
}

/* ------------------------------------------------------------------ *
 * Media
 * ------------------------------------------------------------------ */

export type CampaignMedia = "image" | "gif" | "video";

/** Resolved asset source: an approved remote asset wins over the cached copy. */
export function campaignAssetSrc(
  campaign: Pick<CommercialCampaign, "assetUrl" | "assetDataUrl">,
): string | undefined {
  const src = campaign.assetUrl?.trim() || campaign.assetDataUrl;
  return src ? src : undefined;
}

/** Media actually usable on a screen — safety mode downgrades everything to static. */
export function effectiveMediaType(
  campaign: Pick<CommercialCampaign, "mediaType">,
  nswSafetyMode: boolean,
): CampaignMedia {
  return nswSafetyMode ? "image" : campaign.mediaType;
}

/**
 * A signed remote asset is only trusted when it is an http(s) URL or a data URI.
 * Anything else (javascript:, blob:, garbage) is rejected outright.
 */
export function isSafeAssetUrl(value: string | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  return (
    trimmed.startsWith("data:image/") ||
    trimmed.startsWith("data:video/") ||
    /^https?:\/\//i.test(trimmed)
  );
}

/* ------------------------------------------------------------------ *
 * Compliance + eligibility
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Approval workflow (plan: admin approval + client portal)
 * ------------------------------------------------------------------ */

/**
 * Resolve the approval state. Campaigns created before Phase 2 only carry the
 * legacy `approved` boolean, so that stays authoritative when no workflow
 * state has been recorded.
 */
export function campaignApprovalState(campaign: CommercialCampaign): CampaignApprovalState {
  if (campaign.approval?.state) return campaign.approval.state;
  return campaign.approved ? "approved" : "draft";
}

export function campaignIsApproved(campaign: CommercialCampaign): boolean {
  return campaignApprovalState(campaign) === "approved";
}

/** Human label for the console / client portal. */
export function approvalLabel(campaign: CommercialCampaign): string {
  const state = campaignApprovalState(campaign);
  const approval = campaign.approval;
  if (!approval?.reviewedAt) return state;
  const when = new Date(approval.reviewedAt).toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${state} · ${approval.reviewer ?? "unknown"} · ${when}`;
}

/* ------------------------------------------------------------------ *
 * Geographic rules
 * ------------------------------------------------------------------ */

/** Great-circle distance in km between two points (haversine). */
export function distanceKm(a: GeoPoint, b: GeoPoint): number {
  const R = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type GeoDecision = "inside" | "outside" | "unknown";

/**
 * Is the device inside the campaign's permitted area?
 * "unknown" means we have no fix — the caller decides whether to allow it.
 */
export function geoDecision(rule: CampaignGeoRule | undefined, at: GeoPoint | undefined): GeoDecision {
  if (!rule) return "inside";
  if (!at) return "unknown";
  return distanceKm(rule, at) <= rule.radiusKm ? "inside" : "outside";
}

export type CampaignBlockReason =
  | "disabled"
  | "not-approved"
  | "wrong-position"
  | "not-scheduled"
  | "expired"
  | "legal-incomplete"
  | "parked-confirmation-missing"
  | "media-not-static"
  | "asset-missing"
  | "referral-incomplete"
  | "outside-geo";

export interface CampaignContext {
  now?: number;
  nswSafetyMode: boolean;
  /** Position of the screen being driven. */
  position: "rear" | "front";
  /** NSW mode requires an explicit parked confirmation on the device profile. */
  parkedConfirmed?: boolean;
  /** Current speed, used for the dwell floor. */
  speedKph?: number;
  /** Device position for geographic rules; omit when no fix is available. */
  location?: GeoPoint;
  /** Treat a missing fix as outside the area (default true for safety). */
  requireLocation?: boolean;
  /**
   * Legal & approval pack master switch (separate from the safety mode).
   * Defaults to true: consents, approval, referral terms and geography apply.
   */
  legalPackEnabled?: boolean;
}

/** Legal terms a referral/discount campaign must carry (plan: "Make QR/referral terms clear"). */
export function campaignReferralIssues(campaign: CommercialCampaign): string[] {
  const needsTerms = Boolean(campaign.referralCode || campaign.discountText);
  if (!needsTerms) return [];
  const legal = campaign.legal;
  if (!legal) return ["Referral campaigns need merchant, expiry, privacy policy and consent terms."];
  const missing = [
    ["merchant name", Boolean((legal.merchantName ?? "").trim())],
    ["offer expiry", Boolean(legal.offerExpiry)],
    ["privacy policy URL", Boolean(legal.privacyPolicyUrl)],
    ["QR/terms confirmation", Boolean(legal.qrTermsConfirmed)],
    ["rider-data consent confirmation", Boolean(legal.noRiderDataWithoutConsent)],
  ].filter(([, present]) => !present);
  return missing.map(([label]) => `Referral campaign missing ${label}.`);
}

/** The six consent records the plan requires before any campaign is displayed. */
export const REQUIRED_CONSENTS = [
  ["appOwner", "App owner / driver / display car agreement"],
  ["driver", "Driver display consent"],
  ["vehicleOwner", "Display car owner consent"],
  ["campaignOwner", "Campaign company / agency agreement"],
  ["trademarkAuthorization", "Trademark/logo authorization"],
  ["safetyAssessment", "NSW/site-specific safety assessment"],
] as const;

export function campaignConsentIssues(campaign: CommercialCampaign): string[] {
  const legal = campaign.legal;
  if (!legal) return ["No legal consent block recorded for this campaign."];
  const issues: string[] = [];
  for (const [key, label] of REQUIRED_CONSENTS) {
    const consent = legal[key];
    if (!consent?.confirmed || !consent.signerName.trim() || !consent.agreementReference.trim()) {
      issues.push(`Missing signed ${label}.`);
    }
  }
  return issues;
}

/** Full compliance check used by both the display and the console. */
export function campaignComplianceIssues(campaign: CommercialCampaign): string[] {
  return [...campaignConsentIssues(campaign), ...campaignReferralIssues(campaign)];
}

export function campaignIsComplianceReady(campaign: CommercialCampaign): boolean {
  return campaignComplianceIssues(campaign).length === 0;
}

/**
 * Why a campaign may not be shown right now. Empty array = it is eligible.
 */
export function campaignBlockReasons(
  campaign: CommercialCampaign,
  context: CampaignContext,
): CampaignBlockReason[] {
  const reasons: CampaignBlockReason[] = [];
  const now = context.now ?? Date.now();

  if (!campaign.enabled) reasons.push("disabled");

  // The legal & approval pack is a separate switch from NSW Safety Mode. When
  // it is off — or when the campaign was created while it was off — consents,
  // approval, referral terms and geographic gating do not block the display.
  // Such a campaign stays stamped "unregulated" so the glass and the console
  // can mark it as test content.
  const unregulated = campaignRunsUnregulated(campaign, { legalPackEnabled: context.legalPackEnabled });

  if (!unregulated && !campaignIsApproved(campaign)) reasons.push("not-approved");

  // A campaign targeting "both" shows everywhere; otherwise it must match this screen.
  const target = campaign.target ?? "both";
  if (target !== "both" && target !== context.position) reasons.push("wrong-position");

  const schedule = campaignScheduleState(campaign, now);
  if (schedule === "scheduled") reasons.push("not-scheduled");
  if (schedule === "expired") reasons.push("expired");

  if (!unregulated && !campaignIsComplianceReady(campaign)) reasons.push("legal-incomplete");

  if (context.nswSafetyMode && !context.parkedConfirmed) reasons.push("parked-confirmation-missing");
  if (context.nswSafetyMode && campaign.mediaType !== "image") reasons.push("media-not-static");

  const src = campaignAssetSrc(campaign);
  if (!src || !isSafeAssetUrl(src)) reasons.push("asset-missing");

  if (!unregulated && campaignReferralIssues(campaign).length > 0) reasons.push("referral-incomplete");

  // Geographic rule: a missing fix blocks by default (fail closed). Geography
  // is part of the legal pack, so an unregulated campaign ignores it.
  if (!unregulated) {
    const geo = geoDecision(campaign.geoRule, context.location);
    if (geo === "outside" || (geo === "unknown" && (context.requireLocation ?? true))) {
      reasons.push("outside-geo");
    }
  }

  return [...new Set(reasons)];
}

/**
 * True when a campaign runs outside the legal pack: either the pack is switched
 * off right now, or the campaign was created while it was off. The second case
 * is deliberate — an unregulated campaign keeps displaying after the pack goes
 * back on (test content), and stays flagged so nothing pretends it is approved.
 */
export function campaignRunsUnregulated(
  campaign: CommercialCampaign,
  options: { legalPackEnabled?: boolean } = {},
): boolean {
  if (!(options.legalPackEnabled ?? true)) return true;
  return campaign.complianceMode === "unregulated";
}

/** Legal pack state for a settings object, defaulting to on. */
export function legalPackIsEnabled(settings: { legalPackEnabled?: boolean } | null | undefined): boolean {
  return settings?.legalPackEnabled ?? true;
}

export function campaignIsEligible(campaign: CommercialCampaign, context: CampaignContext): boolean {
  return campaignBlockReasons(campaign, context).length === 0;
}

/** Filter a campaign list down to what this screen may show right now. */
export function selectCampaigns(
  campaigns: CommercialCampaign[] | undefined,
  context: CampaignContext,
): CommercialCampaign[] {
  return (campaigns ?? []).filter((campaign) => campaignIsEligible(campaign, context));
}

/* ------------------------------------------------------------------ *
 * Playlist
 * ------------------------------------------------------------------ */

export type PlaylistSlide<P> =
  | { kind: "platform"; platform: P }
  | { kind: "campaign"; campaign: CommercialCampaign }
  | { kind: "blank" };

export interface PlaylistOptions<P> {
  platforms: P[];
  campaigns: CommercialCampaign[];
  commercialEnabled: boolean;
  nswSafetyMode: boolean;
  includeBlank: boolean;
}

/**
 * Build the slide order from the plan:
 *
 *   platform logo → blank → campaign → blank
 *
 * Blank items are the OLED-black low-power intervals and only appear when the
 * device profile asks for them. Consecutive blanks collapse, so a profile with
 * no campaigns keeps its single trailing blank.
 */
export function buildPlaylist<P>(options: PlaylistOptions<P>): Array<PlaylistSlide<P>> {
  const platformSlides: Array<PlaylistSlide<P>> = options.platforms.map((platform) => ({
    kind: "platform",
    platform,
  }));

  const campaignSlides: Array<PlaylistSlide<P>> = options.commercialEnabled
    ? options.campaigns.map((campaign) => ({ kind: "campaign", campaign }))
    : [];

  const blank: PlaylistSlide<P> = { kind: "blank" };
  const items: Array<PlaylistSlide<P>> = [
    ...platformSlides,
    ...(options.includeBlank ? [blank] : []),
    ...campaignSlides,
    ...(options.includeBlank ? [blank] : []),
  ];

  return collapseConsecutiveBlanks(items);
}

export function collapseConsecutiveBlanks<P>(slides: Array<PlaylistSlide<P>>): Array<PlaylistSlide<P>> {
  return slides.filter((slide, index) => {
    if (slide.kind !== "blank") return true;
    const previous = slides[index - 1];
    return previous?.kind !== "blank";
  });
}

/** How long a slide holds the screen, in seconds. */
export function slideDurationSeconds<P>(
  slide: PlaylistSlide<P> | undefined,
  options: {
    platformSeconds: number;
    blankSeconds: number;
    nswSafetyMode: boolean;
    speedKph?: number;
  },
): number {
  if (!slide || slide.kind === "blank") return Math.max(0.5, options.blankSeconds);
  if (slide.kind === "platform") return Math.max(0.5, options.platformSeconds);
  return campaignDwellSeconds(slide.campaign, {
    nswSafetyMode: options.nswSafetyMode,
    speedKph: options.speedKph,
  });
}

/* ------------------------------------------------------------------ *
 * Brightness
 * ------------------------------------------------------------------ */

/**
 * Screen brightness after applying the campaign's own cap and the day/night rule.
 * The cap can only ever reduce brightness, never raise it.
 */
export function campaignBrightness(
  baseBrightness: number,
  options: { campaign?: Pick<CommercialCampaign, "brightnessCap"> | null; isNight?: boolean },
): number {
  const cap = options.campaign?.brightnessCap ?? 100;
  const nightCap = options.isNight ? NSW_NIGHT_BRIGHTNESS_CAP : 100;
  const limited = Math.min(baseBrightness, cap, nightCap);
  return Math.max(MIN_DISPLAY_BRIGHTNESS, Math.round(limited));
}

/* ------------------------------------------------------------------ *
 * Console helpers
 * ------------------------------------------------------------------ */

export function campaignScheduleLabel(
  campaign: Pick<CommercialCampaign, "startAt" | "endAt">,
  now: number = Date.now(),
): string {
  const state = campaignScheduleState(campaign, now);
  if (state === "unscheduled") return "Always eligible";
  const format = (value: number) =>
    new Date(value).toLocaleString(undefined, {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  if (state === "live") {
    return campaign.endAt ? `Live until ${format(campaign.endAt)}` : "Live";
  }
  if (state === "scheduled") return `Scheduled from ${format(campaign.startAt!)}`;
  return `Expired ${format(campaign.endAt!)}`;
}

/** Validate the console's campaign draft before it is saved. */
export function campaignDraftIssues(input: {
  title: string;
  assetDataUrl?: string;
  assetUrl?: string;
  landingUrl?: string;
  startAt?: number;
  endAt?: number;
  brightnessCap?: number;
  mediaType: CampaignMedia;
  nswSafetyMode: boolean;
}): string[] {
  const issues: string[] = [];
  if (!input.title.trim()) issues.push("Add a campaign title.");

  const src = input.assetUrl?.trim() || input.assetDataUrl;
  if (!src) issues.push("Add a campaign asset (upload a file or paste an approved asset URL).");
  else if (input.assetUrl?.trim() && !isSafeAssetUrl(input.assetUrl)) {
    issues.push("Asset URL must be an https:// link or an uploaded file.");
  }

  if (input.landingUrl?.trim() && !/^https?:\/\//i.test(input.landingUrl.trim())) {
    issues.push("Landing URL must start with http:// or https://.");
  }

  if (input.startAt !== undefined && input.endAt !== undefined && input.endAt <= input.startAt) {
    issues.push("Campaign end time must be after the start time.");
  }

  if (
    input.brightnessCap !== undefined &&
    (input.brightnessCap < MIN_DISPLAY_BRIGHTNESS || input.brightnessCap > 100)
  ) {
    issues.push(`Brightness cap must be between ${MIN_DISPLAY_BRIGHTNESS}% and 100%.`);
  }

  if (input.nswSafetyMode && input.mediaType !== "image") {
    issues.push("NSW Safety Mode accepts static image files only. GIF and video are not approved.");
  }

  return issues;
}

/** Profile fields the signage playlist reads. */
export function profileHasCommercialAccess(profile: DeviceProfile | null | undefined): boolean {
  return Boolean(profile?.commercialEnabled);
}
