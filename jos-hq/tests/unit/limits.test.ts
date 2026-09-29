import { describe, expect, it } from "vitest";
import { blankLimitRow, flip, hasNever, limitsToText, newLimitRow, textToLimits, verbsFor, type Limits } from "@/lib/client/limits";

const support = { platform: "gmail", name: "Main Support" };
const notion = { platform: "notion", name: "Main Notion" };
const exa = { platform: "exa", name: "Main Exa" };

describe("limits as toggles", () => {
  it("gives each platform its verbs, paid tools one, and anything else read, write and delete", () => {
    expect(verbsFor("gmail")).toEqual(["read", "draft", "send", "delete"]);
    expect(verbsFor("google-calendar")).toEqual(["read", "create and edit", "invite or cancel"]);
    expect(verbsFor("tavily")).toEqual(["use (paid)"]);
    expect(verbsFor("hubspot")).toEqual(["read", "write", "delete"]);
  });

  it("starts a new connection with its first verb as may and the rest as never, written as lines", () => {
    const l: Limits = { rows: [newLimitRow(support), newLimitRow(notion)], mayFree: "", neverFree: "" };
    expect(limitsToText(l)).toEqual({
      mayDo: '- gmail · "Main Support": read\n- notion · "Main Notion": read',
      mustNever: '- gmail · "Main Support": draft, send, delete\n- notion · "Main Notion": create and edit, delete',
    });
    expect(hasNever(l)).toBe(true);
  });

  it("flips a verb between may and never, and puts the free text after the lines", () => {
    const l: Limits = { rows: [flip(newLimitRow(support), "draft")], mayFree: "Label threads it has read.", neverFree: "Contact a customer directly." };
    expect(limitsToText(l)).toEqual({
      mayDo: '- gmail · "Main Support": read, draft\n\nLabel threads it has read.',
      mustNever: '- gmail · "Main Support": send, delete\n\nContact a customer directly.',
    });
    expect(flip(flip(newLimitRow(support), "send"), "send").verbs.find((v) => v.verb === "send")?.verdict).toBe("never");
  });

  it("reads its own lines back into the same toggles and free text", () => {
    const l: Limits = { rows: [flip(newLimitRow(support), "draft"), newLimitRow(exa)], mayFree: "Label threads.", neverFree: "Contact a customer.\n\nShare a draft outside One." };
    expect(textToLimits(limitsToText(l), [support, exa])).toEqual(l);
  });

  it("keeps every line it does not own, word for word, in the free text", () => {
    const mustNever = ['- gmail · "Main Support": send', '- gmail · "Acme Support": send', '- gmail · "Main Support": fly', "Never reply to legal threads."].join("\n");
    const l = textToLimits({ mayDo: "", mustNever }, [support]);
    expect(l.rows[0].verbs.map((v) => v.verdict)).toEqual([null, null, "never", null]);
    expect(l.neverFree).toBe(['- gmail · "Acme Support": send', '- gmail · "Main Support": fly', "Never reply to legal threads."].join("\n"));
  });

  it("leaves an older SOP's sentences as free text, with its toggles unset and writing nothing", () => {
    const older = { mayDo: "Search and summarize public information.", mustNever: "Send, publish, delete or charge anything." };
    const l = textToLimits(older, [exa]);
    expect(l).toEqual({ rows: [blankLimitRow(exa)], mayFree: older.mayDo, neverFree: older.mustNever });
    expect(limitsToText(l)).toEqual(older);
    expect(hasNever(l)).toBe(true);
    // Touching an unset verb sets it to may, and only then does it write a line.
    expect(limitsToText({ ...l, rows: [flip(l.rows[0], "use (paid)")] }).mayDo).toBe('- exa · "Main Exa": use (paid)\n\nSearch and summarize public information.');
  });

  it("knows when nothing says what the agent must never do", () => {
    expect(hasNever({ rows: [newLimitRow(exa)], mayFree: "", neverFree: "  " })).toBe(false);
  });
});
