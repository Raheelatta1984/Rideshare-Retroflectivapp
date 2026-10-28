export function sha256Source(text: string): string;
export function inlineScriptHashes(html: string): string[];
export function injectCspMeta(html: string, policy: string): string;
export function verifyCspMeta(html: string): {
  present: boolean;
  policy?: string;
  hashes: string[];
  declared: string[];
  ok: boolean;
};
