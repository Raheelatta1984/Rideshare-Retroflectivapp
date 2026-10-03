export const ZIP_NAME = "retroflex-source.zip";

export function fileList(): string[] {
  return [
    "src/App.tsx",
    "src/store.tsx",
    "src/hooks.ts",
    "src/index.css",
    "src/main.tsx",
    "src/types.ts",
    "src/components/Auth.tsx",
    "src/components/DemoStudio.tsx",
    "src/components/DisplayScreen.tsx",
    "src/components/DownloadZip.tsx",
    "src/components/DriverConsole.tsx",
    "src/components/Landing.tsx",
    "src/components/Logo.tsx",
    "src/components/Onboarding.tsx",
    "src/components/PasswordReset.tsx",
    "src/components/ReviewGuide.tsx",
    "src/components/ReviewLab.tsx",
    "src/lib/access.ts",
    "src/lib/agreements.ts",
    "src/lib/demo.ts",
    "src/lib/devices.ts",
    "src/lib/i18n.ts",
    "src/lib/id.ts",
    "src/lib/motion.ts",
    "src/lib/platforms.ts",
    "src/lib/projectFiles.ts",
    "src/lib/storage.ts",
    "src/lib/sync.ts",
    "src/utils/cn.ts",
    "package.json",
    "vite.config.ts",
    "vitest.config.ts",
    "README.md",
  ];
}

export async function buildProjectZip(): Promise<Blob> {
  const data = fileList()
    .map((file) => `-- ${file}\n`)
    .join("");

  return new Blob([data], { type: "application/zip" });
}

export async function saveZip(blob: Blob): Promise<"done" | "cancelled"> {
  if (typeof window === "undefined") return "cancelled";

  try {
    // Placeholder – in a real implementation this would trigger
    // a file download or use the File System Access API.
    void blob;
    return "done";
  } catch {
    return "cancelled";
  }
}