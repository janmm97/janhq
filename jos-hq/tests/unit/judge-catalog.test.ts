import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useJudgeConfig } from "./fixtures/judge";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jos-hq-judge-cat-"));
const c = (platform: string, name: string, state = "operational") => ({ platform, name, key: `live::${platform}::default::${name.replace(/\W/g, "")}`, state, access: null });

describe("tool catalog", () => {
  it("joins the catalog with live, operational connections and never exposes keys in the line", async () => {
    const { toolsFor, toolLine } = await import("@/lib/server/judge/catalog");
    const tools = toolsFor([c("exa", "Main Exa"), c("gmail", "Main Riley"), c("google-places", "Studio Places", "failed")]);
    expect(tools.map((t) => t.name)).toEqual(["Main Exa", "Main Riley"]);
    expect(toolLine(tools[0])).toMatch(/^exa: Web search/);
    expect(toolLine(tools[0])).not.toContain("live::");
  });
  it("lists platforms with no catalog entry", async () => {
    const { undescribedPlatforms } = await import("@/lib/server/judge/catalog");
    expect(undescribedPlatforms([c("exa", "A"), c("zoho", "B")])).toEqual(["zoho"]);
  });
});

describe("questions and config", () => {
  it("fills placeholders and sums the fastpath version", async () => {
    const { fill, gateVersion, questionText } = await import("@/lib/server/judge/questions");
    expect(fill("a {platform} ({purpose}) {x}", { platform: "exa", purpose: "search" })).toBe("a exa (search) {x}");
    expect(gateVersion("fastpath")).toBe(questionText("understand.uses").version + questionText("understand.complexity").version + questionText("understand.side_effects").version);
  });
  it("is off without a judge section and on with one", async () => {
    const { gateMode, judgeEnabled } = await import("@/lib/server/judge/config");
    useJudgeConfig(tmp, {});
    expect(judgeEnabled()).toBe(false);
    useJudgeConfig(tmp, { "understand.mail_role": { mode: "live", threshold: 0.9 } });
    expect(gateMode("understand.mail_role")).toBe("live");
    expect(gateMode("fastpath")).toBe("off");
    expect(judgeEnabled()).toBe(true);
  });
});
