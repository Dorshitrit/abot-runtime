import { afterEach, describe, expect, test } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadModelParameterProfileCatalog } from "./loader.js";
import { matchModelParameterProfile } from "./matcher.js";
import { parseModelParameterProfile } from "./schema.js";
import type {
  ModelParameterProfile,
  ModelParameterProfileCatalog,
} from "../../shared/model-parameters.js";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function profile(
  id = "example",
  overrides: Partial<ModelParameterProfile> = {},
): ModelParameterProfile {
  return {
    schemaVersion: 1,
    id,
    match: [{ kind: "glob", pattern: "example-*" }],
    defaults: { top_k: 0 },
    ...overrides,
  };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "parameter-profiles-"));
  temporaryDirectories.push(directory);
  const builtinDirectory = join(directory, "builtin");
  const localDirectory = join(directory, "model-parameter-profiles");
  mkdirSync(builtinDirectory);
  mkdirSync(localDirectory);
  const options = {
    builtinDirectory,
    mainConfigPath: join(directory, "runtime.config.json"),
  };
  return { builtinDirectory, localDirectory, options };
}

function writeProfile(directory: string, entry: ModelParameterProfile): void {
  writeFileSync(join(directory, `${entry.id}.json`), JSON.stringify(entry));
}

function catalog(
  profiles: ModelParameterProfile[],
): ModelParameterProfileCatalog {
  return { schemaVersion: 1, profiles, diagnostics: [], revision: "test" };
}

describe("model parameter profile schema", () => {
  test("preserves explicit zero defaults and validates mapping targets", () => {
    const parsed = parseModelParameterProfile(
      profile("example", {
        reasoning: {
          efforts: ["low", "medium", "high"],
          mappings: { none: null, xhigh: "high" },
          canDisableThinking: false,
        },
      }),
      "example",
    );
    expect(parsed.defaults?.top_k).toBe(0);
    expect(parsed.reasoning?.mappings).toEqual({ none: null, xhigh: "high" });
    expect(() =>
      parseModelParameterProfile(
        profile("example", {
          reasoning: { efforts: ["low"], mappings: { high: "medium" } },
        }),
      ),
    ).toThrow("declared effort");
  });

  test.each([
    { schemaVersion: 2 },
    { defaults: { unknown: 1 } },
    { defaults: { top_k: -1 } },
    { defaults: { seed: 1.5 } },
    { reasoning: { efforts: ["none", "low"], canDisableThinking: false } },
    { reasoning: { efforts: ["max"] } },
    { reasoning: { efforts: ["high"], mappings: { xhigh: "max" } } },
    { match: [{ kind: "regex", pattern: "[" }] },
    { constraints: { top_k: { min: 10, max: 2 } } },
    { defaults: { top_p: 0.1 }, constraints: { top_p: { supported: false } } },
    { constraints: { top_p: { requires: { key: "unknown", values: [1] } } } },
    {
      constraints: {
        top_p: {
          requires: {
            key: "reasoning_effort",
            values: ["high"],
            allowMissing: "yes",
          },
        },
      },
    },
  ])("rejects malformed profile %j", (overrides) => {
    expect(() =>
      parseModelParameterProfile({ ...profile(), ...overrides }),
    ).toThrow();
  });

  test("requires filename identity and never accepts unknown profile fields", () => {
    expect(() => parseModelParameterProfile(profile(), "another")).toThrow(
      "filename",
    );
    expect(() =>
      parseModelParameterProfile({ ...profile(), script: "ignored" }),
    ).toThrow("not supported");
  });

  test("accepts declared sampling compatibility with a missing effort value", () => {
    const requires = {
      key: "reasoning_effort" as const,
      values: ["low", "medium", "high"],
      allowMissing: true,
    };
    const parsed = parseModelParameterProfile(
      profile("example", { constraints: { temperature: { requires } } }),
    );
    expect(parsed.constraints?.temperature?.requires).toEqual(requires);
  });
});

describe("model parameter profile matching", () => {
  test("honors exact, glob, regex and provider restrictions without case/path guessing", () => {
    const exact = profile("exact", {
      match: [{ provider: "ollama", kind: "exact", pattern: "model:tag" }],
      priority: 2,
    });
    const glob = profile("glob", {
      match: [{ kind: "glob", pattern: "model:*" }],
    });
    const regex = profile("regex", {
      match: [{ kind: "regex", pattern: "^other-[0-9]+$" }],
    });
    expect(
      matchModelParameterProfile(
        catalog([exact, glob, regex]),
        "ollama",
        "model:tag",
      ).profile?.id,
    ).toBe("exact");
    expect(
      matchModelParameterProfile(
        catalog([exact, glob, regex]),
        "llamacpp",
        "model:tag",
      ).profile?.id,
    ).toBe("glob");
    expect(
      matchModelParameterProfile(catalog([regex]), "ollama", "other-12").profile
        ?.id,
    ).toBe("regex");
    expect(
      matchModelParameterProfile(catalog([exact]), "ollama", "Model:tag")
        .profile,
    ).toBeUndefined();
  });

  test("equal highest priorities produce a diagnostic and no profile", () => {
    const result = matchModelParameterProfile(
      catalog([profile("a"), profile("b")]),
      "llamacpp",
      "example-1",
    );
    expect(result.profile).toBeUndefined();
    expect(result.diagnostics[0].code).toBe("ambiguous_parameter_profile");
  });

  test("bundled profile covers both model sizes and preserves intended effort controls", () => {
    const path = fileURLToPath(
      new URL("./builtin/gpt-oss.json", import.meta.url),
    );
    const builtin = parseModelParameterProfile(
      JSON.parse(readFileSync(path, "utf8")),
    );
    for (const model of [
      "gpt-oss",
      "gpt-oss:latest",
      "gpt-oss:20b",
      "gpt-oss:120b",
      "openai/gpt-oss-20b",
      "ggml-org/gpt-oss-120b-MXFP4.gguf",
    ]) {
      expect(
        matchModelParameterProfile(catalog([builtin]), "llamacpp", model)
          .profile?.id,
      ).toBe(builtin.id);
    }
    expect(
      matchModelParameterProfile(
        catalog([builtin]),
        "llamacpp",
        "another-gpt-oss-20b",
      ).profile,
    ).toBeUndefined();
    expect(builtin.defaults).toEqual({
      temperature: 1,
      top_p: 1,
      top_k: 0,
      min_p: 0,
      repeat_penalty: 1,
    });
    expect(builtin.reasoning).toEqual({
      efforts: ["low", "medium", "high"],
      mappings: { minimal: "low", xhigh: "high", none: null },
      canDisableThinking: false,
    });
  });
});

describe("model parameter catalog loading", () => {
  test("replaces a bundled same-id profile wholesale and freezes request catalog data", () => {
    const target = fixture();
    writeProfile(
      target.builtinDirectory,
      profile("example", {
        notes: "bundled",
        defaults: { temperature: 1, top_k: 0 },
      }),
    );
    writeProfile(
      target.localDirectory,
      profile("example", { defaults: { temperature: 0.2 } }),
    );
    const loaded = loadModelParameterProfileCatalog(target.options);
    expect(loaded.profiles).toHaveLength(1);
    expect(loaded.profiles[0].defaults).toEqual({ temperature: 0.2 });
    expect(loaded.profiles[0].notes).toBeUndefined();
    expect(Object.isFrozen(loaded.profiles[0].defaults)).toBe(true);
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(loadModelParameterProfileCatalog(target.options).revision).toBe(
      loaded.revision,
    );
  });

  test("isolates cold malformed overrides without falling back to the same bundled id", () => {
    const target = fixture();
    writeProfile(target.builtinDirectory, profile());
    writeProfile(target.localDirectory, profile("unrelated"));
    writeFileSync(join(target.localDirectory, "example.json"), "{");
    const loaded = loadModelParameterProfileCatalog(target.options);
    expect(loaded.profiles.map((entry) => entry.id)).toEqual(["unrelated"]);
    expect(loaded.diagnostics[0]).toMatchObject({
      code: "invalid_local_parameter_profile",
      profileId: "example",
    });
  });

  test("isolates a profile with an effort the request contract cannot send", () => {
    const target = fixture();
    writeProfile(
      target.localDirectory,
      profile("example", { reasoning: { efforts: ["max"] } }),
    );
    const loaded = loadModelParameterProfileCatalog(target.options);
    expect(loaded.profiles).toEqual([]);
    expect(loaded.diagnostics[0]).toMatchObject({
      code: "invalid_local_parameter_profile",
      profileId: "example",
    });
    expect(loaded.diagnostics[0].message).toContain(
      "unsupported generic enum value",
    );
  });

  test("retains a last-valid local profile on warm invalid refresh with restart warning", () => {
    const target = fixture();
    writeProfile(
      target.builtinDirectory,
      profile("example", { defaults: { temperature: 1 } }),
    );
    writeProfile(
      target.localDirectory,
      profile("example", { defaults: { temperature: 0.4 } }),
    );
    const previous = loadModelParameterProfileCatalog(target.options);
    writeFileSync(join(target.localDirectory, "example.json"), "malformed");
    const retained = loadModelParameterProfileCatalog(target.options);
    expect(retained.profiles).toEqual(previous.profiles);
    expect(retained.revision).toBe(previous.revision);
    expect(retained.diagnostics[0].message).toContain("after restart");
    expect(retained.diagnostics[0].code).toBe(
      "parameter_profile_last_valid_retained",
    );
  });

  test("a newly broken local override does not retain a previously bundled profile", () => {
    const target = fixture();
    writeProfile(target.builtinDirectory, profile());
    expect(
      loadModelParameterProfileCatalog(target.options).profiles,
    ).toHaveLength(1);
    writeFileSync(join(target.localDirectory, "example.json"), "{");
    expect(
      loadModelParameterProfileCatalog(target.options).profiles,
    ).toHaveLength(0);
  });

  test.each(["directory", "symlink"])(
    "a %s override suppresses same-id bundled fallback",
    (kind) => {
      const target = fixture();
      writeProfile(target.builtinDirectory, profile());
      const path = join(target.localDirectory, "example.json");
      if (kind === "directory") mkdirSync(path);
      if (kind === "symlink")
        symlinkSync(join(target.builtinDirectory, "example.json"), path);
      const loaded = loadModelParameterProfileCatalog(target.options);
      expect(loaded.profiles).toEqual([]);
      expect(loaded.diagnostics[0].code).toBe(
        "invalid_local_parameter_profile",
      );
    },
  );

  test("rejects oversized input before parsing and sanitizes malformed JSON diagnostics", () => {
    const target = fixture();
    writeFileSync(
      join(target.localDirectory, "example.json"),
      " ".repeat(256 * 1024 + 1),
    );
    expect(
      loadModelParameterProfileCatalog(target.options).diagnostics[0].message,
    ).toContain("exceeds");
    writeFileSync(
      join(target.localDirectory, "example.json"),
      "private-profile-text",
    );
    const loaded = loadModelParameterProfileCatalog(target.options);
    expect(loaded.diagnostics[0].message).toContain("invalid JSON");
    expect(loaded.diagnostics[0].message).not.toContain("private-profile-text");
  });

  test("an unreadable directory retains the previous catalog and fixes produce new revisions", () => {
    const target = fixture();
    writeProfile(
      target.localDirectory,
      profile("example", { defaults: { seed: 0 } }),
    );
    const previous = loadModelParameterProfileCatalog(target.options);
    rmSync(target.localDirectory, { recursive: true });
    writeFileSync(target.localDirectory, "not a directory");
    const retained = loadModelParameterProfileCatalog(target.options);
    expect(retained.profiles).toEqual(previous.profiles);
    expect(retained.diagnostics[0].code).toBe(
      "local_parameter_profiles_unavailable",
    );
    rmSync(target.localDirectory);
    mkdirSync(target.localDirectory);
    writeProfile(
      target.localDirectory,
      profile("example", { defaults: { seed: 7 } }),
    );
    expect(loadModelParameterProfileCatalog(target.options).revision).not.toBe(
      previous.revision,
    );
  });
});
