import { Component, type ErrorInfo, type ReactNode } from "react";

interface State {
  error: Error | null;
}

/**
 * Catches render errors anywhere below it.
 *
 * Before this existed, one bad record — a stored device profile saved by an
 * older build, missing a field — threw during render and React unmounted the
 * whole tree. The app went blank and every control stopped responding, with no
 * way back except clearing site data by hand. A screen that fails should cost
 * you that screen, not the app.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Retroflex render error", error, info.componentStack);
  }

  private clearLocalData = () => {
    try {
      Object.keys(localStorage)
        .filter((key) => key.startsWith("rf:"))
        .forEach((key) => localStorage.removeItem(key));
    } catch {
      // Storage unavailable: reloading is still the best available action.
    }
    window.location.reload();
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="grid min-h-dvh place-items-center bg-ink px-6 py-12 text-center text-mist">
        <div className="max-w-md">
          <p className="text-[11px] tracking-[0.4em] text-amber">SCREEN RECOVERED</p>
          <h1 className="mt-3 font-display text-3xl text-cream">This screen failed to render.</h1>
          <p className="mt-3 text-sm leading-relaxed">
            The rest of Retroflex is unaffected. Reloading normally clears it. If it comes back, the saved display
            settings may be from an older version — clearing local data rebuilds them (it removes local settings,
            not the source code).
          </p>
          <p className="mt-3 break-words font-mono text-[10px] text-mist/70">{this.state.error.message}</p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <button
              onClick={() => window.location.reload()}
              className="rounded-full bg-amber px-5 py-2 text-sm font-semibold text-ink"
            >
              Reload
            </button>
            <button
              onClick={this.clearLocalData}
              className="rounded-full border border-line px-5 py-2 text-sm text-cream"
            >
              Clear local data &amp; reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
