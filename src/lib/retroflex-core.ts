export function sanitizePairCode(value: string | null | undefined): string {
  return (value ?? "").replace(/[^A-Za-z0-9]/g, "");
}

export function normalizePosition(value: string | null | undefined): "front" | "rear" {
  return value === "front" ? "front" : "rear";
}

export function normalizeHashPath(path: string | null | undefined): string {
  const cleaned = path ?? "/";
  return cleaned === "" ? "/" : cleaned.startsWith("/") ? cleaned : `/${cleaned}`;
}