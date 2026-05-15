import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Migration script location (relative to repo root). Tests run from repo root.
const MIGRATION = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "gstack-upgrade",
  "migrations",
  "v1.39.1.0.sh",
);

interface Scenario {
  queue: boolean;
  plist?: { hasEnvVars: boolean; loaded: boolean };
  systemdUnit?: { hasPath: boolean };
}

interface RunOpts {
  tmpHome: string;
  platform?: "darwin" | "linux";
  // Mock launchctl to report whether the daemon is loaded.
  launchctlLoaded?: boolean;
}

function setupScenario(home: string, sc: Scenario): void {
  if (sc.queue) {
    const queueDir = path.join(home, ".gstack", "build-state", "release-queue");
    fs.mkdirSync(queueDir, { recursive: true });
    fs.writeFileSync(
      path.join(queueDir, "r1.json"),
      JSON.stringify({ prNumber: 1, status: "queued" }),
    );
  }
  if (sc.plist) {
    const dir = path.join(home, "Library", "LaunchAgents");
    fs.mkdirSync(dir, { recursive: true });
    const content = sc.plist.hasEnvVars
      ? "<plist><dict><key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin</string></dict></dict></plist>"
      : "<plist><dict><key>Label</key><string>com.gstack.release-daemon</string></dict></plist>";
    fs.writeFileSync(
      path.join(dir, "com.gstack.release-daemon.plist"),
      content,
    );
  }
  if (sc.systemdUnit) {
    const dir = path.join(home, ".config", "systemd", "user");
    fs.mkdirSync(dir, { recursive: true });
    const content = sc.systemdUnit.hasPath
      ? '[Service]\nEnvironment="PATH=/opt/homebrew/bin:/usr/bin"\nExecStart=/bin/true\n'
      : "[Service]\nExecStart=/bin/true\n";
    fs.writeFileSync(path.join(dir, "gstack-release-daemon.service"), content);
  }
}

// Build a temp dir that injects a fake `launchctl` early on PATH. The fake
// looks at the LAUNCHCTL_LOADED env var to decide what to print.
function makeFakeLaunchctlDir(loaded: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-launchctl-"));
  const script = loaded
    ? '#!/usr/bin/env bash\nif [ "$1" = "list" ]; then echo "0\t0\tcom.gstack.release-daemon"; fi\n'
    : '#!/usr/bin/env bash\nif [ "$1" = "list" ]; then echo ""; fi\n';
  const target = path.join(dir, "launchctl");
  fs.writeFileSync(target, script, { mode: 0o755 });
  return dir;
}

function runMigration(opts: RunOpts): { stdout: string; status: number } {
  const home = opts.tmpHome;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    GSTACK_HOME: path.join(home, ".gstack"),
  };
  // Only mock launchctl on darwin scenarios; on linux scenarios we want the
  // script's uname -s check to skip the launchctl path entirely.
  if (opts.platform === "darwin" && opts.launchctlLoaded !== undefined) {
    const fakeDir = makeFakeLaunchctlDir(opts.launchctlLoaded);
    env.PATH = `${fakeDir}:${process.env.PATH ?? ""}`;
  }
  const result = spawnSync("bash", [MIGRATION], { encoding: "utf8", env });
  return { stdout: result.stdout ?? "", status: result.status ?? -1 };
}

describe("v1.39.1.0 migration", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "v1391-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // Darwin scenarios — skip on Linux CI because we mock launchctl on PATH.
  // The migration's `uname -s` check makes Linux-CI a no-op for darwin paths;
  // we explicitly skip there rather than try to simulate it.
  const isDarwin = process.platform === "darwin";
  const isLinux = process.platform === "linux";

  it.skipIf(!isDarwin)("1. queue + no daemon → Notice A", () => {
    setupScenario(tmp, { queue: true });
    const { stdout } = runMigration({
      tmpHome: tmp,
      platform: "darwin",
      launchctlLoaded: false,
    });
    expect(stdout).toContain("release daemon not installed");
    expect(stdout).toContain("1 record(s)");
    expect(
      fs.existsSync(
        path.join(
          tmp,
          ".gstack",
          ".migrations",
          "v1.39.1.0.queue-no-daemon.done",
        ),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(tmp, ".gstack", ".migrations", "v1.39.1.0.stale-plist.done"),
      ),
    ).toBe(true);
  });

  it.skipIf(!isDarwin)(
    "2. queue + plist exists + not loaded → macOS Notice B",
    () => {
      setupScenario(tmp, {
        queue: true,
        plist: { hasEnvVars: true, loaded: false },
      });
      const { stdout } = runMigration({
        tmpHome: tmp,
        platform: "darwin",
        launchctlLoaded: false,
      });
      expect(stdout).toContain("release daemon plist needs reload");
      expect(stdout).not.toContain("release daemon not installed");
    },
  );

  it.skipIf(!isDarwin)(
    "3. queue + plist exists + loaded + no env vars → macOS Notice B",
    () => {
      setupScenario(tmp, {
        queue: true,
        plist: { hasEnvVars: false, loaded: true },
      });
      const { stdout } = runMigration({
        tmpHome: tmp,
        platform: "darwin",
        launchctlLoaded: true,
      });
      expect(stdout).toContain("release daemon plist needs reload");
    },
  );

  it.skipIf(!isDarwin)(
    "4. queue + plist + loaded + has env vars → no notice",
    () => {
      setupScenario(tmp, {
        queue: true,
        plist: { hasEnvVars: true, loaded: true },
      });
      const { stdout } = runMigration({
        tmpHome: tmp,
        platform: "darwin",
        launchctlLoaded: true,
      });
      expect(stdout.trim()).toBe("");
    },
  );

  it.skipIf(!isLinux)(
    "5. linux: queue + unit exists + no PATH env → Linux Notice B",
    () => {
      setupScenario(tmp, {
        queue: true,
        systemdUnit: { hasPath: false },
      });
      const { stdout } = runMigration({
        tmpHome: tmp,
        platform: "linux",
      });
      expect(stdout).toContain("release daemon unit needs reload");
    },
  );

  it.skipIf(!isLinux)(
    "6. linux: queue + unit exists + has PATH env → no notice",
    () => {
      setupScenario(tmp, {
        queue: true,
        systemdUnit: { hasPath: true },
      });
      const { stdout } = runMigration({
        tmpHome: tmp,
        platform: "linux",
      });
      expect(stdout.trim()).toBe("");
    },
  );

  it("7. no queue → silent regardless of daemon state", () => {
    // Empty queue dir → no banners on either platform.
    const { stdout } = runMigration({
      tmpHome: tmp,
      platform: process.platform as "darwin" | "linux",
      launchctlLoaded: false,
    });
    expect(stdout.trim()).toBe("");
    // Touchfiles still get written (always).
    expect(
      fs.existsSync(
        path.join(
          tmp,
          ".gstack",
          ".migrations",
          "v1.39.1.0.queue-no-daemon.done",
        ),
      ),
    ).toBe(true);
  });

  it.skipIf(!isDarwin)(
    "8. idempotency: re-running with touchfiles present is silent",
    () => {
      setupScenario(tmp, { queue: true });
      // First run prints Notice A.
      const first = runMigration({
        tmpHome: tmp,
        platform: "darwin",
        launchctlLoaded: false,
      });
      expect(first.stdout).toContain("release daemon not installed");
      // Second run is silent.
      const second = runMigration({
        tmpHome: tmp,
        platform: "darwin",
        launchctlLoaded: false,
      });
      expect(second.stdout.trim()).toBe("");
    },
  );
});
