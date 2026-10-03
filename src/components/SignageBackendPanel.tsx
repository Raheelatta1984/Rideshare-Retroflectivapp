import { useCallback, useEffect, useState } from "react";
import { Check, Cloud, HardDrive, RefreshCw, X } from "lucide-react";
import { getBackend } from "../lib/backend";
import { approvalLabel, campaignApprovalState } from "../lib/signage";
import type { CampaignEventRecord, CommercialCampaign } from "../types";

/**
 * Commercial signage backend panel (Phase 2).
 *
 * Shows which backend is live, lets an admin run the approval workflow, and
 * displays the proof-of-play feed coming back from the Event API. Everything
 * goes through the provider-agnostic `Backend` interface — switching from the
 * local adapter to Supabase changes nothing here.
 */
export function SignageBackendPanel({
  reviewer,
  onRefreshCampaigns,
}: {
  reviewer: string;
  onRefreshCampaigns?: () => void;
}) {
  const backend = getBackend();
  const info = backend.info();
  const [campaigns, setCampaigns] = useState<CommercialCampaign[]>([]);
  const [events, setEvents] = useState<CampaignEventRecord[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [manifestInfo, setManifestInfo] = useState<string>("");

  const load = useCallback(async () => {
    try {
      const [list, feed] = await Promise.all([backend.campaigns.list({ limit: 50 }), backend.events.list(40)]);
      setCampaigns(list);
      setEvents(feed);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [backend]);

  useEffect(() => {
    void load();
    return backend.subscribe(() => {
      void load();
    }, { pollMs: info.kind === "supabase" ? 15000 : 0 });
  }, [backend, info.kind, load]);

  const review = async (id: string, state: "approved" | "rejected") => {
    setBusy(id);
    try {
      await backend.campaigns.setApproval(id, state, reviewer || "unknown reviewer", note || undefined);
      setNote("");
      await load();
      onRefreshCampaigns?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const issueManifest = async () => {
    setBusy("manifest");
    try {
      const manifest = await backend.manifest.issue(campaigns);
      const verdict = await backend.manifest.verify(manifest);
      setManifestInfo(
        `v${manifest.version} · ${manifest.entries.length} entries · ${manifest.signature ? "signed" : "unsigned"} · verify: ${verdict.valid ? "valid" : verdict.reason}`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const pending = campaigns.filter((campaign) => campaignApprovalState(campaign) === "pending");
  const played = new Map<string, number>();
  events
    .filter((event) => event.kind === "proof-of-play")
    .forEach((event) => played.set(event.campaignId, (played.get(event.campaignId) ?? 0) + 1));

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-[11px] tracking-[0.32em] text-amber">Commercial backend</h2>
        <span className="flex items-center gap-2 rounded-full border border-line px-2.5 py-1 text-[10px] text-mist">
          {info.kind === "supabase" ? <Cloud className="h-3 w-3" /> : <HardDrive className="h-3 w-3" />}
          {info.label}
          <span className={info.configured ? "text-amber" : "text-mist"}>{info.configured ? "· live" : "· not configured"}</span>
        </span>
      </div>

      <p className="text-[11px] leading-relaxed text-mist">{info.detail}</p>

      {error && <p className="mt-3 rounded-xl border border-red-400/40 bg-red-400/10 px-3 py-2 text-xs text-red-200">{error}</p>}

      {/* Approval workflow */}
      <div className="mt-4 rounded-2xl border border-line bg-panel p-4">
        <p className="text-[10px] tracking-[0.28em] text-amber">APPROVAL QUEUE{pending.length ? ` · ${pending.length} WAITING` : ""}</p>
        {pending.length === 0 && <p className="mt-2 text-xs text-mist">No campaigns awaiting review.</p>}
        <p className="mt-1 text-[10px] leading-relaxed text-mist">
          With the legal &amp; approval pack off, a seeded or newly added campaign is normally recorded as a draft and
          stays exempt — review here is optional sign-off, not a gate.
        </p>
        <div className="mt-3 space-y-2">
          {pending.map((campaign) => (
            <div key={campaign.id} className="rounded-xl border border-line bg-ink px-3 py-3">
              <p className="truncate text-sm text-cream">
                {campaign.title}
                {campaign.complianceMode === "unregulated" && (
                  <span className="ml-2 rounded-full border border-amber/50 px-2 py-0.5 text-[9px] tracking-[0.14em] text-amber">
                    UNREGULATED
                  </span>
                )}
              </p>
              <p className="mt-0.5 text-[10px] text-mist">
                {campaign.mediaType} · {campaign.displaySeconds}s · {approvalLabel(campaign)}
              </p>
              <input
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Review note (optional)"
                className="mt-2 w-full rounded-lg border border-line bg-panel px-3 py-2 text-xs outline-none focus:border-amber"
              />
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => void review(campaign.id, "approved")}
                  disabled={busy === campaign.id}
                  className="flex items-center gap-1.5 rounded-lg bg-amber px-3 py-2 text-xs font-semibold text-ink disabled:opacity-50"
                >
                  <Check className="h-3.5 w-3.5" /> Approve
                </button>
                <button
                  onClick={() => void review(campaign.id, "rejected")}
                  disabled={busy === campaign.id}
                  className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-xs text-mist disabled:opacity-50"
                >
                  <X className="h-3.5 w-3.5" /> Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Signed manifest */}
      <div className="mt-3 rounded-2xl border border-line bg-panel p-4">
        <p className="text-[10px] tracking-[0.28em] text-amber">SIGNED PLAYLIST MANIFEST</p>
        <button
          onClick={() => void issueManifest()}
          disabled={busy === "manifest"}
          className="mt-3 flex items-center gap-2 rounded-xl border border-amber/40 px-3 py-2 text-xs text-amber disabled:opacity-50"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Issue + verify manifest
        </button>
        {manifestInfo && <p className="mt-2 text-[11px] text-mist">{manifestInfo}</p>}
        <p className="mt-2 text-[10px] leading-relaxed text-mist">
          Signing runs server-side in production (Supabase Edge Function); the browser only verifies.
        </p>
      </div>

      {/* Proof of play */}
      <div className="mt-3 rounded-2xl border border-line bg-panel p-4">
        <p className="text-[10px] tracking-[0.28em] text-amber">PROOF OF PLAY · EVENT API</p>
        {events.length === 0 && <p className="mt-2 text-xs text-mist">No events recorded yet.</p>}
        <div className="mt-3 space-y-1.5">
          {events.slice(0, 12).map((event) => (
            <div key={event.id} className="flex items-center justify-between gap-3 rounded-lg bg-ink px-3 py-2 text-[11px]">
              <span className="min-w-0 truncate text-cream">
                {String(event.meta?.title ?? event.campaignId)} <span className="text-mist">· {event.kind}</span>
              </span>
              <span className="shrink-0 text-mist">{new Date(event.at).toLocaleTimeString()}</span>
            </div>
          ))}
        </div>
        {played.size > 0 && (
          <p className="mt-3 text-[10px] text-mist">
            Plays by campaign: {[...played.entries()].map(([id, count]) => `${id} ×${count}`).join(" · ")}
          </p>
        )}
      </div>
    </section>
  );
}
