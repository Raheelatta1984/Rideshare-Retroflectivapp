# Retroflex Commercial Signage Expansion

Retroflex can evolve from a rideshare identification display into an opt-in commercial signage platform, but it should keep the safety-first "rear logo" behavior as its default.

## Recommended Product Shape

Use one playlist model per rear tablet:

1. Platform logo item: Uber, DiDi, delivery partner, etc.
2. Blank item: OLED-black / low-power interval.
3. Campaign item: a static image or an approved web asset.
4. Blank item: OLED-black / low-power interval.

GIF, video, animation, moving light and driver-facing QR/referral overlays are not part of the NSW Safety Mode playlist.

The existing platform timing, blank-frame, brightness, per-device profile and device-control system is already the correct foundation for this playlist.

## Phase 1: Safe Local Pilot

Add campaign records to a device profile:

```text
campaignId
title
mediaType: image | gif | video
assetUrl
landingUrl
referralCode
startAt / endAt
displaySeconds
brightnessCap
enabled
```

Only show approved, cached static campaign assets. NSW Safety Mode in the app enforces static image-only media, a 10-second minimum dwell, no QR/referral overlay and a black blank/failure frame. This is a guardrail, not legal approval.

## Phase 2: Commercial Backend

For real campaigns, add a secure backend instead of storing marketing assets in browser cache:

- Object storage for images, GIFs and video.
- Campaign database with start/end dates, geographic rules and approval state.
- Signed asset URLs and a signed playlist manifest.
- Event API for proof-of-play, QR scans and referral conversions.
- Admin approval workflow and client campaign portal.
- Realtime messaging service for reliable mobile internet control.

Supabase Realtime, Firebase, Ably or a dedicated WebSocket service can replace the best-effort PeerJS channel when commercial reliability is required.

## Safety And Legal Rules

- Get written permission from every display owner/driver.
- Obtain written permission from every display owner/driver and campaign owner.
- Do not distract the driver: no audio, no strobing, no GIF/video/animation, no high-frequency effects and no full-brightness advertising at night.
- NSW mobile-advertising guidance says advertising units must not obscure mandatory vehicle lighting or restrict the driver field of view; it also warns that highly reflective/retro-reflective material must not be used in an advertising display.
- NSW guidance also states a visual display unit should not operate while a vehicle is moving, or stationary but not parked, if it is visible to the driver or likely to distract another driver. Assess the proposed vehicle, content, location and use with Transport for NSW/local council before any campaign deployment.
- NSW transport-corridor digital-sign guidance requires completely static content, prohibits video/animated movie-style content visible to drivers, calls for minimal text, and gives minimum static dwell guidance of 10 seconds below 80 km/h and 25 seconds at 80 km/h or above. It also requires a black default image on failure and near-instant transitions where message changes are approved.
- Do not treat the in-app "NSW Safety Mode" as legal advice, permit approval, or a substitute for a site-specific safety assessment.
- Get trademark permission before showing platform logos or commercial logos.
- Make QR/referral terms clear: discount amount, expiry, merchant and privacy policy.
- Do not collect rider identity or location unless the rider explicitly consents.
- Apply day/night brightness caps and battery/thermal throttling.

### Sources To Review

- Transport for NSW, *Vehicle Standards Information No. 35: Mobile advertising units* (NSW Government PDF): https://www.nsw.gov.au/sites/default/files/2021-02/RMS-12.045-Mobile-advertising-units-Vehicle-Standards-Information-No-35-September-2012.pdf
- NSW Department of Planning and Environment, *Transport Corridor Outdoor Advertising and Signage Guidelines* (NSW Government PDF): https://www.planning.nsw.gov.au/sites/default/files/2023-03/transport-corridor-outdoor-advertising-and-signage-guidelines.pdf

## Remote Monitoring Reality

A browser can report consented telemetry such as battery, screen dimensions, browser network hint, memory hint and display state. It cannot reliably read exact CPU load, device temperature or capture another device screen without explicit native permissions and a dedicated remote-assistance/WebRTC service.

The current driver mirror uses the same display renderer and current device profile, which is the privacy-preserving way to validate what should be visible on the rear screen.