import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The redesign's guard (Tasks/HQ-Redesign-Plan-2026-09-25.md, Task 10): the old palette, its tone names,
// the ring gauge and IBM Plex never come back into the UI sources.
const app = path.join(import.meta.dirname, "..", "..");
function sources(dir: string): string[] {
  return fs
    .readdirSync(path.join(app, dir), { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.(tsx?|css)$/.test(e.name))
    .map((e) => path.join(e.parentPath, e.name));
}
const files = ["app", "components", "lib/client"].flatMap(sources);
const OLD = "ink-2|ink|panel-2|panel|raised|line-strong|line|text|soft|muted|faint|blue-bright|blue|cyan|green|amber|red|purple";
const UTIL = new RegExp(`\\b(?:bg|text|border(?:-[trblxy])?|divide|ring|outline|fill|stroke|decoration|from|to|via|accent|caret)-(?:${OLD})(?![\\w-])`);
const VAR = new RegExp(`--color-(?:${OLD})(?![\\w-])`);
const TONE = /\btone=["'{]+(?:blue|cyan|green|amber|red|purple|muted)["']/;
const NAMES = /\bDonut\b|\bworkspaceTone\b|\bLegacyTone\b|\bresolveTone\b|ibm-plex|IBM Plex|\bis-working\b|\bsignal-line\b/;

describe("the old look is gone", () => {
  it("no UI source uses an old colour token, tone name, ring gauge or IBM Plex", () => {
    const found: string[] = [];
    for (const f of files) {
      fs.readFileSync(f, "utf8")
        .split("\n")
        .forEach((l, i) => {
          if (UTIL.test(l) || VAR.test(l) || TONE.test(l) || NAMES.test(l)) found.push(`${path.relative(app, f)}:${i + 1}: ${l.trim().slice(0, 120)}`);
        });
    }
    expect(found).toEqual([]);
  });

  it("the one-time codemod is gone", () => {
    expect(fs.existsSync(path.join(app, "scripts", "retoken.mjs"))).toBe(false);
  });
});
