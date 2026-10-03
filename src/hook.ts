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