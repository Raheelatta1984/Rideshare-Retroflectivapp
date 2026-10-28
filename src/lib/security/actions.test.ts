import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("GitHub Actions supply-chain pins", () => {
  it("pins every external workflow action to a full commit SHA", () => {
    const directory = ".github/workflows";
    for (const file of readdirSync(directory).filter((name) => /\.ya?ml$/.test(name))) {
      const content = readFileSync(`${directory}/${file}`, "utf8");
      for (const line of content.split("\n")) {
        const action = line.match(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/)?.[1];
        if (!action || action.startsWith("./") || action.startsWith("docker://")) continue;
        expect(action, `${file}: ${line.trim()}`).toMatch(/@[0-9a-f]{40}$/);
      }
    }
  });
});
