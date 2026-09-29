import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Pure-validator tests only, plus a refusal path that throws BEFORE any write. Never call
// saveQuestionText with criteria that would actually validate — reference/judge-questions.json is a
// real, committed file and a passing save would overwrite it with a bumped version.

describe("validateCriteria", () => {
  it("validates noul criteria (understand.uses, understand.side_effects, trim.connection, repeat.same_as)", async () => {
    const { validateCriteria } = await import("@/lib/server/judge/questions");
    expect(validateCriteria("understand.uses", { true: "a", false: "b" })).toBeNull();
    expect(validateCriteria("understand.side_effects", "x")).toMatch(/object with true and false/);
    expect(validateCriteria("trim.connection", { true: "", false: "b" })).toMatch(/non-empty/);
    expect(validateCriteria("repeat.same_as", { true: "a" })).toMatch(/non-empty/);
    expect(validateCriteria("understand.uses", ["a", "b"])).toMatch(/object with true and false/);
  });

  it("validates choice criteria (understand.mail_role), requiring an other key", async () => {
    const { validateCriteria } = await import("@/lib/server/judge/questions");
    expect(validateCriteria("understand.mail_role", { a: "A", other: "O" })).toBeNull();
    expect(validateCriteria("understand.mail_role", { a: "A", other: null })).toBeNull();
    expect(validateCriteria("understand.mail_role", "x")).toMatch(/non-empty object/);
    expect(validateCriteria("understand.mail_role", {})).toMatch(/non-empty object/);
    expect(validateCriteria("understand.mail_role", { a: "A" })).toMatch(/other/);
    expect(validateCriteria("understand.mail_role", { a: 5, other: "O" })).toMatch(/must be a string or null/);
  });

  it("validates score criteria (understand.complexity): 2-10 non-empty strings", async () => {
    const { validateCriteria } = await import("@/lib/server/judge/questions");
    expect(validateCriteria("understand.complexity", ["a", "b"])).toBeNull();
    expect(validateCriteria("understand.complexity", "x")).toMatch(/array/);
    expect(validateCriteria("understand.complexity", ["a"])).toMatch(/between 2 and 10/);
    expect(validateCriteria("understand.complexity", Array.from({ length: 11 }, (_, i) => `s${i}`))).toMatch(/between 2 and 10/);
    expect(validateCriteria("understand.complexity", ["a", ""])).toMatch(/non-empty strings/);
  });

  it("saveQuestionText refuses invalid criteria and never writes the file", async () => {
    const { saveQuestionText } = await import("@/lib/server/judge/questions");
    const file = path.join(process.cwd(), "reference", "judge-questions.json");
    const before = fs.readFileSync(file, "utf8");
    expect(() => saveQuestionText("understand.mail_role", { criteria: { a: "A" } })).toThrow(/other/);
    expect(() => saveQuestionText("understand.complexity", { criteria: ["only one"] })).toThrow(/between 2 and 10/);
    expect(() => saveQuestionText("understand.uses", { criteria: "x" as unknown as { true: string; false: string } })).toThrow(/object with true and false/);
    expect(() => saveQuestionText("understand.uses", {})).toThrow(/nothing to save/);
    expect(() => saveQuestionText("understand.uses", { instructions: "Is a {platform} tool needed?" })).toThrow(/keep \{purpose\}/);
    expect(() => saveQuestionText("repeat.same_as", { instructions: "Same task?" })).toThrow(/keep \{i\}/);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });
});

describe("validateQuestionPatch", () => {
  it("refuses an empty patch, blank or overlong instructions, and templated instructions that drop a placeholder", async () => {
    const { validateQuestionPatch } = await import("@/lib/server/judge/questions");
    expect(validateQuestionPatch("understand.mail_role", {})).toMatch(/nothing to save/);
    expect(validateQuestionPatch("understand.mail_role", { instructions: "  " })).toMatch(/must be text/);
    expect(validateQuestionPatch("understand.mail_role", { instructions: 5 })).toMatch(/must be text/);
    expect(validateQuestionPatch("understand.mail_role", { instructions: "x".repeat(1001) })).toMatch(/at most 1000/);
    expect(validateQuestionPatch("understand.mail_role", { instructions: "What role does email play?" })).toBeNull();
    expect(validateQuestionPatch("understand.uses", { instructions: "Is {platform} ({purpose}) needed?" })).toBeNull();
    expect(validateQuestionPatch("understand.uses", { instructions: "Is it needed?" })).toMatch(/keep \{platform\} and \{purpose\}/);
    expect(validateQuestionPatch("trim.connection", { instructions: "Is it useful?" })).toMatch(/keep \{name\}/);
    expect(validateQuestionPatch("trim.connection", { instructions: "Is \"{name}\" useful?" })).toBeNull();
    expect(validateQuestionPatch("repeat.same_as", { instructions: "Same as candidates[{i}]?" })).toBeNull();
    expect(validateQuestionPatch("understand.mail_role", { criteria: { a: "A" } })).toMatch(/other/);
  });
});
