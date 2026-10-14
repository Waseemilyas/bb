import { describe, expect, it } from "vitest";
import { splitPluginDisplayName } from "../src/plugin-display-name.js";

describe("splitPluginDisplayName", () => {
  it.each([
    ["Account Pooler [Experimental]", "Account Pooler", true],
    ["Modal Sandbox [experimental]  ", "Modal Sandbox", true],
    ["Storage & retention", "Storage & retention", false],
    ["[Experimental] Lab", "[Experimental] Lab", false],
    ["Experimental Lab", "Experimental Lab", false],
    ["[Experimental]", "[Experimental]", false],
  ])("splits %j", (displayName, name, experimental) => {
    expect(splitPluginDisplayName(displayName)).toEqual({ name, experimental });
  });
});
