import { describe, expect, it } from "bun:test";
import {
  DEFAULT_ROLE_CONFIGS,
  ROLE_DEFINITIONS,
  applyEnvRoleConfig,
  applyRoleOverride,
  cloneRoleConfigs,
  migrateLegacyModels,
  parseProvider,
  parseBoolean,
  parsePositiveInt,
} from "../role-config";
import {
  BUILD_DEFAULTS,
  DEFAULT_BUILD_CONFIG_FILE,
  envNumberOrDefault,
  loadBuildDefaults,
} from "../build-config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("role config defaults", () => {
  it("loads defaults from the tracked build config file", () => {
    const loaded = loadBuildDefaults(DEFAULT_BUILD_CONFIG_FILE);
    expect(path.basename(DEFAULT_BUILD_CONFIG_FILE)).toBe("configure.cm");
    expect(loaded.roles.primaryImpl.model).toBeTruthy();
    expect(loaded.limits.codexMaxIterations).toBe(10);
    expect(loaded.timeoutsMs.gemini).toBe(900000);
    expect(loaded.timeoutsMs.kimi).toBe(1500000);
    expect(BUILD_DEFAULTS.roles.primaryImpl.model).toBe(
      loaded.roles.primaryImpl.model,
    );
  });

  it("uses the tracked build config as the default routing source of truth", () => {
    const loaded = loadBuildDefaults(DEFAULT_BUILD_CONFIG_FILE);
    expect(DEFAULT_ROLE_CONFIGS).toEqual(BUILD_DEFAULTS.roles);
    expect(DEFAULT_ROLE_CONFIGS).toEqual(loaded.roles);
    for (const role of Object.values(DEFAULT_ROLE_CONFIGS)) {
      expect(role.model.trim()).not.toBe("");
    }
  });

  it("loads template-only plan location from configure.cm", () => {
    const loaded = loadBuildDefaults(DEFAULT_BUILD_CONFIG_FILE);
    const planLocator = (loaded.roles as any).planLocator;
    expect(planLocator).toBeDefined();
    expect(parseProvider(planLocator.provider, "planLocator.provider")).toBe(
      planLocator.provider,
    );
    expect(planLocator.model.trim()).not.toBe("");
  });

  it("includes the configured featureReview role", () => {
    // The configurable post-implementation reviewer is surfaced via
    // --feature-review-{provider,model,reasoning} CLI flags and
    // GSTACK_BUILD_FEATURE_REVIEW_{PROVIDER,MODEL,REASONING} env vars.
    expect(DEFAULT_ROLE_CONFIGS.featureReview).toBeDefined();
    expect(DEFAULT_ROLE_CONFIGS.featureReview.model.trim()).not.toBe("");
    // No `command` field — featureReview is a direct sub-agent invocation,
    // not a slash-command gate (review/qa/ship/land all carry .command).
    expect(DEFAULT_ROLE_CONFIGS.featureReview.command).toBeUndefined();
  });

  it("includes the configured monitorAgent role", () => {
    expect(DEFAULT_ROLE_CONFIGS.monitorAgent).toBeDefined();
    expect(["claude", "codex", "gemini", "kimi"]).toContain(
      DEFAULT_ROLE_CONFIGS.monitorAgent.provider,
    );
    expect(DEFAULT_ROLE_CONFIGS.monitorAgent.model.trim()).not.toBe("");
    expect(DEFAULT_ROLE_CONFIGS.monitorAgent.command).toBeUndefined();
    expect(
      ROLE_DEFINITIONS.some(([key, flag, prefix]) => {
        return (
          key === "monitorAgent" &&
          flag === "monitor-agent" &&
          prefix === "GSTACK_BUILD_MONITOR_AGENT"
        );
      }),
    ).toBe(true);
  });

  it("does not expose contextSave as a configured build role", () => {
    const loaded = loadBuildDefaults(DEFAULT_BUILD_CONFIG_FILE);
    expect((loaded.roles as any).contextSave).toBeUndefined();
    expect((DEFAULT_ROLE_CONFIGS as any).contextSave).toBeUndefined();
    expect(
      ROLE_DEFINITIONS.some(([key]) => key === ("contextSave" as any)),
    ).toBe(false);
  });

  it("exposes featureReviewMaxIterations and featureReview timeout in BUILD_DEFAULTS", () => {
    // The default cap on per-feature meta-review cycles. After this count,
    // the orchestrator pauses and prompts the user via stdin readline.
    // Bumped 3 -> 5 under liveness semantics, then reverted 5 -> 3 after the
    // tidy-haven loop incident proved that 5 iterations of a deterministic
    // same-shape failure was just burning compute. The new same-shape repeat
    // detector halts after 2 identical failures regardless, so 3 is now the
    // upper bound on truly novel iteration shapes a feature can need.
    expect(BUILD_DEFAULTS.limits.featureReviewMaxIterations).toBe(3);
    // 1200000ms = 20min stall window — larger than codex's 900000ms because
    // the feature review reads ALL phase artifacts (not just one phase's diff).
    expect(BUILD_DEFAULTS.timeoutsMs.featureReview).toBe(1200000);
  });
});

describe("role config precedence helpers", () => {
  it("can load an alternate config file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-build-config-"));
    try {
      const file = path.join(dir, "configure.cm");
      const defaults = loadBuildDefaults(DEFAULT_BUILD_CONFIG_FILE);
      defaults.roles.primaryImpl.model = "primary-model-under-test";
      defaults.limits.codexMaxIterations = 7;
      fs.writeFileSync(file, JSON.stringify(defaults, null, 2));

      const loaded = loadBuildDefaults(file);
      expect(loaded.roles.primaryImpl.model).toBe("primary-model-under-test");
      expect(loaded.limits.codexMaxIterations).toBe(7);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("backfills featureReview and monitorAgent roles + new limits/timeouts for older user configs", () => {
    // Real-world scenario: a user installed gstack before the feature-level
    // review existed and edited their configure.cm. On upgrade, they hit
    // `must be a positive number` on featureReviewMaxIterations because
    // their file predates the field. Backfill from the in-tree default.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-build-config-"));
    try {
      const file = path.join(dir, "configure.cm");
      const defaults = loadBuildDefaults(DEFAULT_BUILD_CONFIG_FILE);
      delete (defaults.roles as any).featureReview;
      delete (defaults.roles as any).monitorAgent;
      delete (defaults.limits as any).featureReviewMaxIterations;
      delete (defaults.timeoutsMs as any).kimi;
      delete (defaults.timeoutsMs as any).featureReview;
      fs.writeFileSync(file, JSON.stringify(defaults, null, 2));
      const loaded = loadBuildDefaults(file);
      expect(loaded.roles.featureReview).toEqual(
        DEFAULT_ROLE_CONFIGS.featureReview,
      );
      expect(loaded.roles.monitorAgent).toEqual(
        DEFAULT_ROLE_CONFIGS.monitorAgent,
      );
      expect(loaded.limits.featureReviewMaxIterations).toBe(3);
      expect(loaded.timeoutsMs.kimi).toBe(1500000);
      expect(loaded.timeoutsMs.featureReview).toBe(1200000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops legacy contextSave role entries when loading older alternate config files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-build-config-"));
    try {
      const file = path.join(dir, "configure.cm");
      const defaults = loadBuildDefaults(DEFAULT_BUILD_CONFIG_FILE);
      (defaults.roles as any).contextSave = {
        provider: "codex",
        model: "legacy-context-save-model",
        reasoning: "medium",
        command: "/context-save",
      };
      fs.writeFileSync(file, JSON.stringify(defaults, null, 2));

      const loaded = loadBuildDefaults(file);
      expect((loaded.roles as any).contextSave).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honors GSTACK_BUILD_FEATURE_REVIEW_* env overrides", () => {
    const roles = applyEnvRoleConfig(cloneRoleConfigs(), {
      GSTACK_BUILD_FEATURE_REVIEW_PROVIDER: "claude",
      GSTACK_BUILD_FEATURE_REVIEW_MODEL: "feature-review-model-under-test",
      GSTACK_BUILD_FEATURE_REVIEW_REASONING: "high",
    });
    expect(roles.featureReview.provider).toBe("claude");
    expect(roles.featureReview.model).toBe("feature-review-model-under-test");
    expect(roles.featureReview.reasoning).toBe("high");
  });

  it("honors GSTACK_BUILD_MONITOR_AGENT_* env overrides", () => {
    const roles = applyEnvRoleConfig(cloneRoleConfigs(), {
      GSTACK_BUILD_MONITOR_AGENT_PROVIDER: "codex",
      GSTACK_BUILD_MONITOR_AGENT_MODEL: "monitor-agent-model-under-test",
      GSTACK_BUILD_MONITOR_AGENT_REASONING: "medium",
    });
    expect(roles.monitorAgent.provider).toBe("codex");
    expect(roles.monitorAgent.model).toBe("monitor-agent-model-under-test");
    expect(roles.monitorAgent.reasoning).toBe("medium");
  });

  it("accepts kimi as a role provider", () => {
    expect(parseProvider("kimi", "provider")).toBe("kimi");
    const roles = applyEnvRoleConfig(cloneRoleConfigs(), {
      GSTACK_BUILD_PRIMARY_IMPL_PROVIDER: "kimi",
      GSTACK_BUILD_PRIMARY_IMPL_MODEL: "primary-model-under-test",
    });
    expect(roles.primaryImpl.provider).toBe("kimi");
    expect(roles.primaryImpl.model).toBe("primary-model-under-test");
  });

  it("honors BACKUP_PROVIDER / BACKUP_MODEL env overrides for primaryImpl", () => {
    const roles = applyEnvRoleConfig(cloneRoleConfigs(), {
      GSTACK_BUILD_PRIMARY_IMPL_BACKUP_PROVIDER: "gemini",
      GSTACK_BUILD_PRIMARY_IMPL_BACKUP_MODEL: "gemini-3.1-pro-preview",
    });
    expect(roles.primaryImpl.backupProvider).toBe("gemini");
    expect(roles.primaryImpl.backupModel).toBe("gemini-3.1-pro-preview");
  });

  it("rejects invalid backup provider in env", () => {
    expect(() =>
      applyEnvRoleConfig(cloneRoleConfigs(), {
        GSTACK_BUILD_PRIMARY_IMPL_BACKUP_PROVIDER: "unsupported-model",
      }),
    ).toThrow("GSTACK_BUILD_PRIMARY_IMPL_BACKUP_PROVIDER");
  });

  it("configure.cm sets the expected per-role backup providers and models", () => {
    // Pinned to the configure.cm defaults as of commit 8f604299
    // ("chore(build): swap testWriter/primaryImpl/testFixer providers in configure.cm").
    // testFixer + testWriter now use codex/gpt-5.3-codex-spark as backup (not gemini),
    // so the previous loop-over-roles shape no longer fits — backups are role-specific.
    const defaults = loadBuildDefaults(DEFAULT_BUILD_CONFIG_FILE);
    const expected: Record<
      "primaryImpl" | "testFixer" | "testWriter" | "ship" | "land",
      { backupProvider: "gemini" | "codex"; backupModel: string }
    > = {
      primaryImpl: {
        backupProvider: "gemini",
        backupModel: "gemini-3.5-flash",
      },
      testFixer: {
        backupProvider: "codex",
        backupModel: "gpt-5.3-codex-spark",
      },
      testWriter: {
        backupProvider: "codex",
        backupModel: "gpt-5.3-codex-spark",
      },
      ship: { backupProvider: "gemini", backupModel: "gemini-3.5-flash" },
      land: { backupProvider: "gemini", backupModel: "gemini-3.5-flash" },
    };
    for (const [role, want] of Object.entries(expected) as Array<
      [keyof typeof expected, (typeof expected)[keyof typeof expected]]
    >) {
      expect(defaults.roles[role].backupProvider).toBe(want.backupProvider);
      expect(defaults.roles[role].backupModel).toBe(want.backupModel);
    }
  });

  it("rejects invalid config files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-build-config-"));
    try {
      const file = path.join(dir, "bad.configure.cm");
      const defaults = loadBuildDefaults(DEFAULT_BUILD_CONFIG_FILE);
      (defaults.roles.primaryImpl as any).provider = "bad-provider";
      fs.writeFileSync(file, JSON.stringify(defaults, null, 2));

      expect(() => loadBuildDefaults(file)).toThrow(
        "roles.primaryImpl.provider",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid backup provider in config files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-build-config-"));
    try {
      const file = path.join(dir, "bad-backup.configure.cm");
      const defaults = loadBuildDefaults(DEFAULT_BUILD_CONFIG_FILE);
      (defaults.roles.primaryImpl as any).backupProvider = "bad-provider";
      fs.writeFileSync(file, JSON.stringify(defaults, null, 2));

      expect(() => loadBuildDefaults(file)).toThrow(
        "roles.primaryImpl.backupProvider",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("applyRoleOverride sets backupProvider on a role", () => {
    const roles = cloneRoleConfigs();
    applyRoleOverride(roles, "primaryImpl", "backupProvider", "gemini");
    expect(roles.primaryImpl.backupProvider).toBe("gemini");
  });

  it("applyRoleOverride rejects invalid backupProvider value", () => {
    const roles = cloneRoleConfigs();
    expect(() =>
      applyRoleOverride(
        roles,
        "primaryImpl",
        "backupProvider",
        "invalid-provider",
      ),
    ).toThrow("primaryImpl.backupProvider");
  });

  it("applyRoleOverride sets backupModel on a role", () => {
    const roles = cloneRoleConfigs();
    applyRoleOverride(
      roles,
      "primaryImpl",
      "backupModel",
      "gemini-3.1-pro-preview",
    );
    expect(roles.primaryImpl.backupModel).toBe("gemini-3.1-pro-preview");
  });

  it("applies env overrides over defaults", () => {
    const roles = applyEnvRoleConfig(cloneRoleConfigs(), {
      GSTACK_BUILD_SHIP_MODEL: "ship-model-under-test",
      GSTACK_BUILD_SHIP_REASONING: "medium",
      GSTACK_BUILD_SHIP_COMMAND: "/custom-ship",
    });
    expect(roles.ship.model).toBe("ship-model-under-test");
    expect(roles.ship.reasoning).toBe("medium");
    expect(roles.ship.command).toBe("/custom-ship");
  });

  it("fills new roles when migrating an older persisted role config", () => {
    const roles = cloneRoleConfigs({
      primaryImpl: {
        ...DEFAULT_ROLE_CONFIGS.primaryImpl,
        model: "old-primary-model",
      },
    });
    expect(roles.primaryImpl.model).toBe("old-primary-model");
    expect((roles as any).contextSave).toBeUndefined();
  });

  it("migrates old model fields into roleConfigs", () => {
    const roles = migrateLegacyModels({
      geminiModel: "legacy-primary-model",
      codexModel: "legacy-secondary-model",
      codexReviewModel: "legacy-review-model",
    });
    expect(roles.primaryImpl.model).toBe("legacy-primary-model");
    expect(roles.secondaryImpl.model).toBe("legacy-secondary-model");
    expect(roles.reviewSecondary.model).toBe("legacy-review-model");
  });
});

// T1.1, T1.2, T1.3 — kimi timeout bump to 1500000ms (25 min)
describe("kimi timeout bump (phase 1.1)", () => {
  it("T1.1 configure.cm default kimi timeout is 1500000ms", () => {
    // Fails (red) until configure.cm is updated from 900000 to 1500000.
    const loaded = loadBuildDefaults(DEFAULT_BUILD_CONFIG_FILE);
    expect(loaded.timeoutsMs.kimi).toBe(1500000);
  });

  it("T1.1b configure.cm.template kimi timeout is also 1500000ms", () => {
    // Fresh installs copy from the template; it must carry the same bump.
    // Fails (red) until configure.cm.template is updated.
    const templatePath = path.join(
      path.dirname(DEFAULT_BUILD_CONFIG_FILE),
      "configure.cm.template",
    );
    const raw = JSON.parse(fs.readFileSync(templatePath, "utf8")) as {
      timeoutsMs: Record<string, number>;
    };
    expect(raw.timeoutsMs.kimi).toBe(1500000);
  });

  it("T1.2 GSTACK_BUILD_KIMI_TIMEOUT env var overrides the kimi default", () => {
    // Env override must win over the file default regardless of what value
    // configure.cm carries. Tests the envNumberOrDefault plumbing used by
    // KIMI_TIMEOUT_MS in sub-agents.ts.
    const prev = process.env.GSTACK_BUILD_KIMI_TIMEOUT;
    process.env.GSTACK_BUILD_KIMI_TIMEOUT = "1800000";
    try {
      const resolved = envNumberOrDefault(
        "GSTACK_BUILD_KIMI_TIMEOUT",
        BUILD_DEFAULTS.timeoutsMs.kimi,
      );
      expect(resolved).toBe(1800000);
      // Env override must not equal the file default (1500000 post-impl).
      expect(resolved).not.toBe(BUILD_DEFAULTS.timeoutsMs.kimi);
    } finally {
      if (prev === undefined) delete process.env.GSTACK_BUILD_KIMI_TIMEOUT;
      else process.env.GSTACK_BUILD_KIMI_TIMEOUT = prev;
    }
  });

  it("T1.3 other timeouts are unchanged by the kimi bump", () => {
    // Regression guard: only timeoutsMs.kimi should change; every other
    // field must retain its pre-existing default from configure.cm.
    const loaded = loadBuildDefaults(DEFAULT_BUILD_CONFIG_FILE);
    expect(loaded.timeoutsMs.gemini).toBe(900000);
    expect(loaded.timeoutsMs.codex).toBe(900000);
    expect(loaded.timeoutsMs.ship).toBe(1800000);
    expect(loaded.timeoutsMs.test).toBe(900000);
    expect(loaded.timeoutsMs.judge).toBe(600000);
    expect(loaded.timeoutsMs.featureReview).toBe(1200000);
    expect(loaded.timeoutsMs.planReview).toBe(300000);
    // kimi must be the bumped value, not the old 900000
    expect(loaded.timeoutsMs.kimi).not.toBe(900000);
  });
});

describe("parseBoolean / parsePositiveInt", () => {
  it('parseBoolean accepts "true"/"false" only', () => {
    expect(parseBoolean("true", "x")).toBe(true);
    expect(parseBoolean("false", "x")).toBe(false);
    expect(() => parseBoolean("yes", "x")).toThrow();
    expect(() => parseBoolean("1", "x")).toThrow();
    expect(() => parseBoolean("", "x")).toThrow();
  });

  it("parsePositiveInt accepts positive integers, rejects others", () => {
    expect(parsePositiveInt("1000", "x")).toBe(1000);
    expect(parsePositiveInt("900000", "x")).toBe(900000);
    expect(() => parsePositiveInt("-1", "x")).toThrow();
    expect(() => parsePositiveInt("0", "x")).toThrow();
    expect(() => parsePositiveInt("3.5", "x")).toThrow();
    expect(() => parsePositiveInt("abc", "x")).toThrow();
    expect(() => parsePositiveInt("", "x")).toThrow();
  });
});

describe("RoleConfig timeout fields", () => {
  it("applyEnvRoleConfig parses GSTACK_BUILD_PRIMARY_IMPL_TIMEOUT", () => {
    const roles = applyEnvRoleConfig(cloneRoleConfigs(), {
      GSTACK_BUILD_PRIMARY_IMPL_TIMEOUT: "1800000",
    });
    expect(roles.primaryImpl.timeoutMs).toBe(1800000);
  });

  it("applyEnvRoleConfig parses GSTACK_BUILD_PRIMARY_IMPL_BACKUP_TIMEOUT", () => {
    const roles = applyEnvRoleConfig(cloneRoleConfigs(), {
      GSTACK_BUILD_PRIMARY_IMPL_BACKUP_TIMEOUT: "300000",
    });
    expect(roles.primaryImpl.backupTimeoutMs).toBe(300000);
  });

  it("applyEnvRoleConfig rejects malformed env vars", () => {
    expect(() =>
      applyEnvRoleConfig(cloneRoleConfigs(), {
        GSTACK_BUILD_PRIMARY_IMPL_TIMEOUT: "-1",
      }),
    ).toThrow();
  });

  it("applyRoleOverride sets timeoutMs", () => {
    const roles = cloneRoleConfigs();
    applyRoleOverride(roles, "primaryImpl", "timeoutMs", "1800000");
    expect(roles.primaryImpl.timeoutMs).toBe(1800000);
  });

  it("applyRoleOverride sets backupTimeoutMs", () => {
    const roles = cloneRoleConfigs();
    applyRoleOverride(roles, "primaryImpl", "backupTimeoutMs", "300000");
    expect(roles.primaryImpl.backupTimeoutMs).toBe(300000);
  });

  it("applyRoleOverride rejects negative timeoutMs", () => {
    const roles = cloneRoleConfigs();
    expect(() =>
      applyRoleOverride(roles, "primaryImpl", "timeoutMs", "-100"),
    ).toThrow();
  });

  it("cloneRoleConfigs preserves new optional fields when set", () => {
    const roles = cloneRoleConfigs({
      primaryImpl: {
        ...DEFAULT_ROLE_CONFIGS.primaryImpl,
        timeoutMs: 1200000,
        backupTimeoutMs: 400000,
      },
    });
    expect(roles.primaryImpl.timeoutMs).toBe(1200000);
    expect(roles.primaryImpl.backupTimeoutMs).toBe(400000);
  });
});
