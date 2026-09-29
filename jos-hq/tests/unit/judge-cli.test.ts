import { describe, expect, it } from "vitest";
import { assertReadOnly, TYPESAFE_SYSTEMONE } from "@/lib/server/one/cli";

const key = "live::typesafe::default::abc";
const body = JSON.stringify({ state: "x", model: "jev-1.13.0", questions: {} });

describe("HQ's systemone exception", () => {
  it("admits exactly the systemone shape", () => {
    expect(() => assertReadOnly(["--agent", "actions", "execute", "typesafe", TYPESAFE_SYSTEMONE, key, "-d", body])).not.toThrow();
  });
  it.each([
    ["another action", ["--agent", "actions", "execute", "typesafe", "conn_mod_def::X::Y", key, "-d", body]],
    ["a non-live key", ["--agent", "actions", "execute", "typesafe", TYPESAFE_SYSTEMONE, "fake::typesafe::x", "-d", body]],
    ["extra flags", ["--agent", "actions", "execute", "typesafe", TYPESAFE_SYSTEMONE, key, "-d", body, "--parallel"]],
    ["path vars", ["--agent", "actions", "execute", "typesafe", TYPESAFE_SYSTEMONE, key, "--path-vars", "{}"]],
    ["another platform", ["--agent", "actions", "execute", "open-router", TYPESAFE_SYSTEMONE, key, "-d", body]],
  ])("refuses %s", (_label, args) => {
    expect(() => assertReadOnly(args)).toThrow(/refuses/);
  });
});
