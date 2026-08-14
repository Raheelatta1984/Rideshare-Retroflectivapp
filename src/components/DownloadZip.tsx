import { useMemo, useState } from "react";
import { ArrowLeft, Download, FolderArchive, Share2 } from "lucide-react";
import { Logo } from "./Logo";
import { ZIP_NAME, buildProjectZip, fileList, saveZip } from "../lib/projectFiles";

export function DownloadZip({ go }: { go: (p: string) => void }) {
  const files = useMemo(() => fileList(), []);
  const [state, setState] = useState<"idle" | "working" | "done" | "error">("idle");
  const [message, setMessage] = useState("");
  const [href, setHref] = useState<string | null>(null);

  const run = async (mode: "save" | "link") => {
    setState("working");
    setMessage("");
    try {
      const blob = await buildProjectZip();
      const url = URL.createObjectURL(blob);
      setHref((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });
      if (mode === "save") {
        const result = await saveZip(blob);
        if (result === "cancelled") {
          setState("idle");
          setMessage("Share sheet closed. Use the direct link below.");
          return;
        }
      }
      setState("done");
      setMessage(
        mode === "save"
          ? `${ZIP_NAME} is ready — ${files.length} files. Check Downloads, or tap the blue link if the browser blocked it.`
          : `${ZIP_NAME} is ready. Tap the blue link to save it.`,
      );
    } catch (err) {
      setState("error");
      setMessage(err instanceof Error ? err.message : "Could not build the zip.");
    }
  };

  return (
    <div className="min-h-dvh bg-ink px-5 py-8 text-cream">
      <div className="mx-auto max-w-xl">
        <button onClick={() => go("/")} className="inline-flex items-center gap-2 text-sm text-mist hover:text-cream">
          <ArrowLeft className="h-4 w-4" /> Home
        </button>
        <div className="mt-10">
          <Logo />
        </div>
        <p className="mt-10 text-[11px] tracking-[0.4em] text-amber">SOURCE ZIP</p>
        <h1 className="mt-3 font-display text-4xl md:text-5xl">Download the full repository.</h1>
        <p className="mt-4 text-mist">
          {files.length} files — every <span className="text-cream">src</span> module, Codespaces, Pages workflow, Termux script, and docs — packed as{" "}
          <span className="text-cream">{ZIP_NAME}</span>.
        </p>

        <div className="mt-8 flex flex-wrap gap-3">
          <button onClick={() => void run("save")} className="inline-flex items-center gap-2 rounded-full bg-amber px-6 py-3 font-semibold text-ink">
            <Download className="h-4 w-4" />
            {state === "working" ? "Building source ZIP…" : `Download ${ZIP_NAME}`}
          </button>
          <button
            onClick={() => void run("link")}
            className="inline-flex items-center gap-2 rounded-full border border-line px-5 py-3 text-sm"
          >
            <Share2 className="h-4 w-4 text-amber" />
            Build in-browser zip
          </button>
        </div>

        {href && (
          <a
            href={href}
            download={ZIP_NAME}
            className="mt-5 inline-flex items-center gap-2 rounded-2xl border border-amber/40 bg-amber/10 px-4 py-3 text-sm text-amber"
          >
            <Download className="h-4 w-4" />
            Tap here if the file did not start: {ZIP_NAME}
          </a>
        )}

        {message && <p className="mt-4 text-sm text-mist">{message}</p>}
        {state === "error" && <p className="mt-2 text-sm text-rose-400">{message}</p>}

        <div className="mt-10 rounded-3xl border border-line bg-panel p-5">
          <p className="inline-flex items-center gap-2 text-sm text-cream">
            <FolderArchive className="h-4 w-4 text-amber" /> Files in the zip
          </p>
          <ul className="mt-3 max-h-72 space-y-1 overflow-auto font-mono text-[11px] leading-relaxed text-mist">
            {files.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </div>

        <ol className="mt-8 list-decimal space-y-2 pl-5 text-sm text-mist">
          <li>Unzip {ZIP_NAME}</li>
          <li>Push the folder to github.com/Raheelatta1984/Rideshare-Retroflectivapp</li>
          <li>On Android, open TERMUX.md inside the zip</li>
          <li>Then open Codespaces on that repo</li>
        </ol>
      </div>
    </div>
  );
}
