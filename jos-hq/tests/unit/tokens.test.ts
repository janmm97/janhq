import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The darkroom palette (Tasks/HQ-Redesign-Spec-2026-09-25.md, 1.2), read from the CSS that ships it.
const css = fs.readFileSync(path.join(import.meta.dirname, "..", "..", "app", "globals.css"), "utf8");

function token(name: string): string {
  const m = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(css);
  if (!m) throw new Error(`--color-${name} is missing from app/globals.css`);
  return m[1].toLowerCase();
}
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("the darkroom palette", () => {
  it("has the plan's exact values", () => {
    const names = ["ground", "room", "tray", "rim", "rim-strong", "gray", "silver", "silver-hi", "paper", "fixed", "safe", "safe-lit", "on-safe", "fog", "strip-1", "strip-2", "strip-3", "strip-4", "strip-5", "strip-6"];
    expect(Object.fromEntries(names.map((n) => [n, token(n)]))).toEqual({
      ground: "#0b0b0b",
      room: "#121212",
      tray: "#1a1a1a",
      rim: "#2a2a2a",
      "rim-strong": "#4a4a4a",
      gray: "#6a6a6a",
      silver: "#9a9a9a",
      "silver-hi": "#c4c4c4",
      paper: "#f2f2f2",
      fixed: "#d9d9d9",
      safe: "#ffb000",
      "safe-lit": "#ffc233",
      "on-safe": "#0b0b0b",
      fog: "#f16464",
      "strip-1": "#f2f2f2",
      "strip-2": "#c4c4c4",
      "strip-3": "#8a8a8a",
      "strip-4": "#3a3a3a",
      "strip-5": "#222222",
      "strip-6": "#141414",
    });
  });

  it("every text colour reads at 4.5:1 on every surface it is used on", () => {
    const surfaces = ["ground", "room", "tray"];
    for (const fg of ["paper", "silver-hi", "silver", "safe", "fog"]) for (const bg of surfaces) expect(contrast(token(fg), token(bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("on-safe"), token("safe")), "on-safe on safe").toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("on-safe"), token("safe-lit")), "on-safe on safe-lit").toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("ground"), token("fixed")), "ground on fixed").toBeGreaterThanOrEqual(4.5);
  });

  it("every test-strip tone carries its label at 4.5:1", () => {
    const pairs: Array<[string, string]> = [["ground", "strip-1"], ["ground", "strip-2"], ["ground", "strip-3"], ["paper", "strip-4"], ["silver", "strip-5"], ["silver", "strip-6"]];
    for (const [fg, bg] of pairs) expect(contrast(token(fg), token(bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });
});
