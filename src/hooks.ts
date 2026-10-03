import { useEffect, useState } from "react";

export function useHash(): [string, (path: string) => void] {
  const [hash, setHash] = useState(() => {
    if (typeof window === "undefined") return "/";
    return window.location.hash.slice(1) || "/";
  });

  useEffect(() => {
    const handleChange = () => {
      setHash(window.location.hash.slice(1) || "/");
    };

    window.addEventListener("hashchange", handleChange);
    return () => window.removeEventListener("hashchange", handleChange);
  }, []);

  const go = (path: string) => {
    if (typeof window !== "undefined") {
      window.location.hash = path;
    }
  };

  return [hash, go];
}

export function useNow(interval = 1000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), interval);
    return () => window.clearInterval(timer);
  }, [interval]);

  return now;
}

export async function requestWakeLock(): Promise<{ release: () => Promise<void> } | null> {
  if (typeof navigator === "undefined" || !("wakeLock" in navigator)) {
    return null;
  }

  try {
    const lock = await (navigator as any).wakeLock.request("screen");
    return {
      release: async () => {
        if (lock) await lock.release();
      },
    };
  } catch {
    return null;
  }
}