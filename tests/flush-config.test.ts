/**
 * Tests for the project-local flush config feature.
 *
 * Covers `resolveFlushConfig` (load + validate cwd-local config), the default
 * project name derivation (inclusive of git common dir handling so worktrees
 * share the main repo name), fail-closed behavior for marked sessions whose
 * config is missing/invalid, the `/hindsight detach-flush-config` command,
 * flush-pending handling each session independently, and the `/hindsight config`
 * session-specific diagnostics.
 *
 * Adheres to AGENTS.md: never modifies the real pi agent directory (uses
 * setupTempAgentDir to redirect PI_CODING_AGENT_DIR), exercises real handlers
 * (no simulation of production logic), and tests behavior — not implementation.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HindsightClientWrapper } from "../src/client";
import { registerCommands } from "../src/commands";
import {
  evaluateActiveSessionFlushState,
  findFlushConfigFile,
  resolveFlushConfig,
  resolveProjectNameForFlush,
} from "../src/flush-config";
import type { RecallMessageDetails } from "../src/index";
import { getHindsightMeta, updateSessionMetadata } from "../src/meta";
import { getMessagesPath, getMetaPath } from "../src/parsed-store";
import {
  clearSessionQueueState,
  hasPendingFlag,
  removePendingFlag,
  touchPendingFlag,
} from "../src/queue";
import { parseAndUpsertSession } from "../src/retention";
import { getSessionStatePath } from "../src/session-state";
import {
  cleanupParsedArtifacts,
  createMockClient,
  HINDSIGHT_ENV_KEYS,
  makeNotifyCtx,
  saveEnvKeys,
  setupTempAgentDir,
  testConfig,
  withTempDir,
  writeSessionFile,
} from "./fixtures";

setupTempAgentDir("flush-config");

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = saveEnvKeys(HINDSIGHT_ENV_KEYS);
});

afterEach(() => {
  restoreEnv();
});

// ============================================
// Helpers
// ============================================

/**
 * Write a flush-config file (`.jsonc` or `.json`) under `<cwd>/.pi/epimetheus/`.
 */
function writeFlushConfig(cwd: string, ext: "jsonc" | "json", content: string): string {
  const dir = join(cwd, ".pi", "epimetheus");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `flush-config.${ext}`);
  writeFileSync(path, content, "utf-8");
  return path;
}

/**
 * Run a `git` command in `cwd`. Throws (failing the test) only on spawnSync error;
 * non-zero exit leaves it to the caller to assert — but for setup we expect 0.
 */
function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8", timeout: 30_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} (cwd=${cwd}) failed with status ${result.status}: ${result.stderr}`
    );
  }
}

/**
 * Capture the call args passed to client.retain by returning a mock client
 * and a `retainCalls` array mirroring production test helpers.
 */
function capturingClient(): {
  client: HindsightClientWrapper;
  retainCalls: { tags?: string[] }[];
} {
  const retainCalls: { tags?: string[] }[] = [];
  const client = {
    retain: mock(async (opts: { tags?: string[] }) => {
      retainCalls.push(opts);
      return { success: true };
    }),
    retainBatch: mock(async () => ({ success: true })),
  } as unknown as HindsightClientWrapper;
  return { client, retainCalls };
}

// ============================================
// resolveFlushConfig (load + schema)
// ============================================

describe("resolveFlushConfig", () => {
  it("fails closed (not ok) when no cwd-local config exists", async () => {
    await withTempDir(async (cwd) => {
      const r = resolveFlushConfig(cwd);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/no cwd-local flush-config/);
    });
  });

  it("loads .jsonc (preferred over .json)", async () => {
    await withTempDir(async (cwd) => {
      writeFlushConfig(cwd, "jsonc", JSON.stringify({ projectName: "from-jsonc" }));
      writeFlushConfig(cwd, "json", JSON.stringify({ projectName: "from-json" }));
      const r = resolveFlushConfig(cwd);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.config.projectName).toBe("from-jsonc");
        expect(r.path.endsWith("flush-config.jsonc")).toBe(true);
      }
    });
  });

  it("loads .json when no .jsonc exists", async () => {
    await withTempDir(async (cwd) => {
      writeFlushConfig(cwd, "json", JSON.stringify({ projectName: "from-json" }));
      const r = resolveFlushConfig(cwd);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.config.projectName).toBe("from-json");
    });
  });

  it("parses JSONC with comments and trailing commas", async () => {
    await withTempDir(async (cwd) => {
      writeFlushConfig(
        cwd,
        "jsonc",
        // Leading comment, inline comment, trailing comma
        `// project-local flush config
{
  "projectName": "commented", // inline comment
}`
      );
      const r = resolveFlushConfig(cwd);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.config.projectName).toBe("commented");
    });
  });

  it("fails closed when projectName is missing", async () => {
    await withTempDir(async (cwd) => {
      writeFlushConfig(cwd, "jsonc", JSON.stringify({ other: "x" }));
      const r = resolveFlushConfig(cwd);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/projectName/);
    });
  });

  it("fails closed when projectName is not a string", async () => {
    await withTempDir(async (cwd) => {
      writeFlushConfig(cwd, "jsonc", JSON.stringify({ projectName: 42 }));
      const r = resolveFlushConfig(cwd);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/projectName/);
    });
  });

  it("fails closed when projectName is empty/whitespace", async () => {
    await withTempDir(async (cwd) => {
      writeFlushConfig(cwd, "jsonc", JSON.stringify({ projectName: "   " }));
      const r = resolveFlushConfig(cwd);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/empty\/whitespace/);
    });
  });

  it("fails closed when top-level is not an object", async () => {
    await withTempDir(async (cwd) => {
      writeFlushConfig(cwd, "jsonc", `["not", "an", "object"]`);
      const r = resolveFlushConfig(cwd);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/JSON object/);
    });
  });

  it("fails closed when JSON is malformed", async () => {
    await withTempDir(async (cwd) => {
      writeFlushConfig(cwd, "jsonc", `{ "projectName": "x" `); // missing close
      const r = resolveFlushConfig(cwd);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/not valid JSON/);
    });
  });

  it("warns and ignores unknown keys while keeping projectName", async () => {
    await withTempDir(async (cwd) => {
      writeFlushConfig(
        cwd,
        "jsonc",
        JSON.stringify({ projectName: "stable", destination: "x", mode: "y" })
      );
      const r = resolveFlushConfig(cwd);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.config.projectName).toBe("stable");
        expect(r.warnings.some((w) => w.includes(`"destination"`))).toBe(true);
        expect(r.warnings.some((w) => w.includes(`"mode"`))).toBe(true);
      }
    });
  });

  it("trims whitespace around projectName", async () => {
    await withTempDir(async (cwd) => {
      writeFlushConfig(cwd, "jsonc", JSON.stringify({ projectName: "  stable  " }));
      const r = resolveFlushConfig(cwd);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.config.projectName).toBe("stable");
    });
  });

  it("findFlushConfigFile returns the path when jsonc present, null otherwise", async () => {
    await withTempDir(async (cwd) => {
      expect(findFlushConfigFile(cwd)).toBeNull();
      writeFlushConfig(cwd, "jsonc", JSON.stringify({ projectName: "x" }));
      expect(findFlushConfigFile(cwd)).not.toBeNull();
      expect(findFlushConfigFile(cwd)?.endsWith("flush-config.jsonc")).toBe(true);
    });
  });

  it("does not walk ancestors (only cwd-local checked)", async () => {
    await withTempDir(async (dir) => {
      const ancestor = join(dir, "ancestor");
      mkdirSync(ancestor, { recursive: true });
      writeFlushConfig(ancestor, "jsonc", JSON.stringify({ projectName: "ancestor-name" }));
      const child = join(ancestor, "child");
      mkdirSync(child, { recursive: true });
      // Child has no flush-config of its own; ancestor does. Should NOT find any.
      expect(findFlushConfigFile(child)).toBeNull();
      expect(resolveFlushConfig(child).ok).toBe(false);
    });
  });
});

// ============================================
// resolveProjectNameForFlush
// ============================================

describe("resolveProjectNameForFlush (default / non-marked)", () => {
  // Env-var overrides were removed; default derivation is git common dir -> basename.
  it("ignores EPIMETHEUS_PROJECT_NAME and falls back to basename", () => {
    process.env.EPIMETHEUS_PROJECT_NAME = "env-override";
    try {
      const r = resolveProjectNameForFlush("/some/path/myapp", false);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.projectName).toBe("myapp");
        expect(r.source).toBe("basename");
      }
    } finally {
      delete process.env.EPIMETHEUS_PROJECT_NAME;
    }
  });

  it("ignores legacy PI_HINDSIGHT_PROJECT_NAME and falls back to basename", () => {
    process.env.PI_HINDSIGHT_PROJECT_NAME = "legacy-override";
    try {
      const r = resolveProjectNameForFlush("/some/path/myapp", false);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.projectName).toBe("myapp");
        expect(r.source).toBe("basename");
      }
    } finally {
      delete process.env.PI_HINDSIGHT_PROJECT_NAME;
    }
  });

  it("falls back to basename when no env var and no .git", () => {
    const r = resolveProjectNameForFlush("/some/path/myapp", false);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.projectName).toBe("myapp");
      expect(r.source).toBe("basename");
    }
  });

  it("derives basename for non-existent cwd with no .git (no fail-closed)", () => {
    const r = resolveProjectNameForFlush("/totally/nonexistent/path-xyz", false);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.projectName).toBe("path-xyz");
      expect(r.source).toBe("basename");
    }
  });

  it("derives main-repo name from git common dir (basename of common dir parent)", async () => {
    await withTempDir(async (dir) => {
      const mainRepo = join(dir, "realrepo");
      mkdirSync(mainRepo, { recursive: true });
      git(mainRepo, ["init", "-q", "--initial-branch=main"]);
      git(mainRepo, ["config", "user.email", "test@test.local"]);
      git(mainRepo, ["config", "user.name", "Test"]);
      writeFileSync(join(mainRepo, "README.md"), "init\n", "utf-8");
      git(mainRepo, ["add", "."]);
      git(mainRepo, ["commit", "-q", "-m", "init"]);

      const r = resolveProjectNameForFlush(mainRepo, false);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.projectName).toBe("realrepo");
        expect(r.source).toBe("git");
      }
    });
  });

  it("worktrees share the main repo name (git common dir handles this)", async () => {
    await withTempDir(async (dir) => {
      const mainRepo = join(dir, "mainshared");
      mkdirSync(mainRepo, { recursive: true });
      git(mainRepo, ["init", "-q", "--initial-branch=main"]);
      git(mainRepo, ["config", "user.email", "test@test.local"]);
      git(mainRepo, ["config", "user.name", "Test"]);
      writeFileSync(join(mainRepo, "README.md"), "init\n", "utf-8");
      git(mainRepo, ["add", "."]);
      git(mainRepo, ["commit", "-q", "-m", "init"]);

      const worktree = join(dir, "wt-should-share-name");
      git(mainRepo, ["worktree", "add", "-q", worktree]);

      try {
        const mainR = resolveProjectNameForFlush(mainRepo, false);
        const wtR = resolveProjectNameForFlush(worktree, false);
        expect(mainR.ok).toBe(true);
        expect(wtR.ok).toBe(true);
        if (mainR.ok && wtR.ok) {
          expect(mainR.projectName).toBe("mainshared");
          expect(wtR.projectName).toBe("mainshared"); // shared with main repo
          expect(mainR.source).toBe("git");
          expect(wtR.source).toBe("git");
        }
      } finally {
        try {
          git(mainRepo, ["worktree", "remove", "--force", worktree]);
        } catch {
          // best-effort cleanup
          rmSync(worktree, { recursive: true, force: true });
        }
      }
    });
  });
});

describe("resolveProjectNameForFlush (marked case)", () => {
  it("uses cwd-local flush config projectName when marked", async () => {
    await withTempDir(async (cwd) => {
      writeFlushConfig(cwd, "jsonc", JSON.stringify({ projectName: "marked-stable" }));
      const r = resolveProjectNameForFlush(cwd, true);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.projectName).toBe("marked-stable");
        expect(r.source).toBe("flush-config");
      }
    });
  });

  it("does not fall back to env var when marked (config projectName is authoritative)", async () => {
    process.env.EPIMETHEUS_PROJECT_NAME = "env-should-be-ignored";
    await withTempDir(async (cwd) => {
      writeFlushConfig(cwd, "json", JSON.stringify({ projectName: "from-config" }));
      const r = resolveProjectNameForFlush(cwd, true);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.projectName).toBe("from-config");
        expect(r.source).toBe("flush-config");
      }
    });
  });

  it("fails closed when marked but cwd no longer exists", () => {
    const r = resolveProjectNameForFlush("/nonexistent/path/abc", true);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/cwd .* no longer exists/);
  });

  it("fails closed when marked and cwd-local config is missing", async () => {
    await withTempDir(async (cwd) => {
      // No flush config written.
      const r = resolveProjectNameForFlush(cwd, true);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/marked .* using project-local flush config/);
    });
  });

  it("fails closed when marked and cwd-local config is invalid (missing projectName)", async () => {
    await withTempDir(async (cwd) => {
      writeFlushConfig(cwd, "jsonc", JSON.stringify({ other: "x" }));
      const r = resolveProjectNameForFlush(cwd, true);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/invalid/);
    });
  });

  it("fails closed when marked and no cwd-local config even though an ancestor has one (no ancestor walk)", async () => {
    await withTempDir(async (dir) => {
      const ancestor = join(dir, "ancestor");
      mkdirSync(ancestor, { recursive: true });
      writeFlushConfig(ancestor, "jsonc", JSON.stringify({ projectName: "ancestor-name" }));
      const child = join(ancestor, "child");
      mkdirSync(child, { recursive: true });
      // Marked, cwd-local missing, ancestor has one — must fail closed.
      const r = resolveProjectNameForFlush(child, true);
      expect(r.ok).toBe(false);
    });
  });
});

// ============================================
// resolveProjectNameForFlush (unmarked / undefined tristate)
// ============================================

describe("resolveProjectNameForFlush (unmarked / undefined)", () => {
  it("uses cwd-local config projectName when a valid file is present (unmarked)", async () => {
    await withTempDir(async (cwd) => {
      writeFlushConfig(cwd, "jsonc", JSON.stringify({ projectName: "stable-name" }));
      // unmarked = undefined (NOT false) → valid config is used (mirrors session_start auto-mark intent)
      const r = resolveProjectNameForFlush(cwd, undefined);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.projectName).toBe("stable-name");
        expect(r.source).toBe("flush-config");
      }
    });
  });

  it("fails closed when a file is present but invalid (unmarked — no silent fallback)", async () => {
    // Point 4 regression: an invalid cwd-local flush-config for an unmarked
    // session must NOT silently fall back to env/git/basename and allow ingestion.
    await withTempDir(async (cwd) => {
      writeFlushConfig(cwd, "jsonc", JSON.stringify({ notProjectName: "x" }));
      const r = resolveProjectNameForFlush(cwd, undefined);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/invalid/);
    });
  });

  it("uses default derivation when no file is present (unmarked)", () => {
    const r = resolveProjectNameForFlush("/some/path/myapp", undefined);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.projectName).toBe("myapp");
      expect(r.source).toBe("basename");
    }
  });

  it("detached (false) ignores a present invalid file (detached wins, not fail-closed)", async () => {
    await withTempDir(async (cwd) => {
      writeFlushConfig(cwd, "jsonc", JSON.stringify({ notProjectName: "x" }));
      // false (detached) → ignore the flush config entirely → default derivation.
      const r = resolveProjectNameForFlush(cwd, false);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.projectName).toBe(cwd.split("/").pop() ?? "");
        expect(r.source).toBe("basename");
      }
    });
  });
});

// ============================================
// evaluateActiveSessionFlushState (session_start readiness gate)
// ============================================

describe("evaluateActiveSessionFlushState", () => {
  it("detached (false) is always ready, no auto-mark", () => {
    const r = evaluateActiveSessionFlushState("/anything", { usesProjectFlushConfig: false });
    expect(r.ready).toBe(true);
    expect(r.autoMark).toBeUndefined();
  });

  it("detached (false) is ready even with cwd undefined", () => {
    const r = evaluateActiveSessionFlushState(undefined, { usesProjectFlushConfig: false });
    expect(r.ready).toBe(true);
  });

  it("detached (false) is ready even when cwd has an invalid flush config (detach wins)", async () => {
    await withTempDir(async (cwd) => {
      writeFlushConfig(cwd, "jsonc", JSON.stringify({ notProjectName: "x" }));
      const r = evaluateActiveSessionFlushState(cwd, { usesProjectFlushConfig: false });
      expect(r.ready).toBe(true);
      expect(r.autoMark).toBeUndefined();
      expect(r.reason).toBeUndefined();
    });
  });

  it("marked (true) + valid config → ready, no auto-mark", async () => {
    await withTempDir(async (cwd) => {
      writeFlushConfig(cwd, "jsonc", JSON.stringify({ projectName: "marked" }));
      const r = evaluateActiveSessionFlushState(cwd, { usesProjectFlushConfig: true });
      expect(r.ready).toBe(true);
      expect(r.autoMark).toBeUndefined();
    });
  });

  it("marked (true) + invalid config → failed", async () => {
    await withTempDir(async (cwd) => {
      writeFlushConfig(cwd, "jsonc", JSON.stringify({ x: 1 }));
      const r = evaluateActiveSessionFlushState(cwd, { usesProjectFlushConfig: true });
      expect(r.ready).toBe(false);
      expect(r.reason).toMatch(/invalid/);
      expect(r.configPath).toBeTruthy();
    });
  });

  it("marked (true) + no config → failed (required but missing)", async () => {
    await withTempDir(async (cwd) => {
      const r = evaluateActiveSessionFlushState(cwd, { usesProjectFlushConfig: true });
      expect(r.ready).toBe(false);
      expect(r.reason).toMatch(/no cwd-local flush-config file is present/);
    });
  });

  it("marked (true) + cwd does not exist → failed", () => {
    const r = evaluateActiveSessionFlushState("/nonexistent/abc/xyz", {
      usesProjectFlushConfig: true,
    });
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/cwd .* does not exist/);
  });

  it("unmarked (undefined) + valid config → ready + autoMark", async () => {
    await withTempDir(async (cwd) => {
      writeFlushConfig(cwd, "jsonc", JSON.stringify({ projectName: "auto" }));
      const r = evaluateActiveSessionFlushState(cwd, null);
      expect(r.ready).toBe(true);
      expect(r.autoMark).toBe(true);
    });
  });

  it("unmarked (undefined) + invalid config → failed (no silent fallback)", async () => {
    await withTempDir(async (cwd) => {
      writeFlushConfig(cwd, "jsonc", JSON.stringify({ nope: true }));
      const r = evaluateActiveSessionFlushState(cwd, null);
      expect(r.ready).toBe(false);
      expect(r.autoMark).toBeUndefined();
      expect(r.reason).toMatch(/invalid/);
    });
  });

  it("unmarked (undefined) + no config → ready (default derivation), no autoMark", async () => {
    await withTempDir(async (cwd) => {
      const r = evaluateActiveSessionFlushState(cwd, null);
      expect(r.ready).toBe(true);
      expect(r.autoMark).toBeUndefined();
    });
  });

  it("unmarked (undefined) + cwd undefined → ready (non-fatal)", () => {
    const r = evaluateActiveSessionFlushState(undefined, null);
    expect(r.ready).toBe(true);
  });
});

// ============================================
// Hardened reads: findFlushConfigFile / resolveFlushConfig never throw
// ============================================

describe("flush-config hardened reads", () => {
  it("findFlushConfigFile returns the path for a directory named like the config (does not throw)", async () => {
    await withTempDir(async (cwd) => {
      // Create a DIRECTORY at the flush-config.jsonc path (existsSync is true
      // for dirs). findFlushConfigFile must not throw — it returns the path.
      const dir = join(cwd, ".pi", "epimetheus", "flush-config.jsonc");
      mkdirSync(dir, { recursive: true });
      const path = findFlushConfigFile(cwd);
      expect(path).not.toBeNull();
      expect(path?.endsWith("flush-config.jsonc")).toBe(true);
    });
  });

  it("resolveFlushConfig fails closed (ok:false) for a directory instead of throwing", async () => {
    await withTempDir(async (cwd) => {
      const dir = join(cwd, ".pi", "epimetheus", "flush-config.jsonc");
      mkdirSync(dir, { recursive: true });
      let threw = false;
      let r: ReturnType<typeof resolveFlushConfig> | undefined;
      try {
        r = resolveFlushConfig(cwd);
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(r?.ok).toBe(false);
      if (r && !r.ok) {
        expect(r.path).toBeTruthy();
        expect(r.error).toMatch(/could not read|not a regular file/);
      }
    });
  });

  it("findFlushConfigFile returns null when cwd doesn't exist (no throw)", () => {
    let threw = false;
    let path: string | null = null;
    try {
      path = findFlushConfigFile("/totally/nonexistent/xyz");
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(path).toBeNull();
  });
});

// ============================================
// parseAndUpsertSession integration (fail-closed + flush-config)
// ============================================

describe("parseAndUpsertSession: project-local flush config", () => {
  const SESSION_ID = "flush-config-session";

  async function setupSession(
    tmpDir: string,
    options: { usesProjectFlushConfig?: boolean }
  ): Promise<void> {
    // writeSessionFile's `cwd` option lets the session header point at a real
    // tmpdir (so existsSync checks behave realistically).
    writeSessionFile(tmpDir, SESSION_ID, {
      cwd: tmpDir,
      messages: [{ role: "user", content: "Hello" }],
      retained: true,
      usesProjectFlushConfig: options.usesProjectFlushConfig,
    });
    await touchPendingFlag(SESSION_ID);
  }

  afterEach(() => {
    removePendingFlag(SESSION_ID);
    clearSessionQueueState(SESSION_ID);
    cleanupParsedArtifacts(SESSION_ID);
    rmSync(getMetaPath(SESSION_ID), { force: true });
    rmSync(getMessagesPath(SESSION_ID), { force: true });
    rmSync(getSessionStatePath(SESSION_ID), { force: true });
  });

  it("uses cwd-local flush config projectName when session is marked and config is valid", async () => {
    await withTempDir(async (tmpDir) => {
      writeFlushConfig(tmpDir, "jsonc", JSON.stringify({ projectName: "from-flush-config" }));
      await setupSession(tmpDir, { usesProjectFlushConfig: true });

      const ctx = makeNotifyCtx();
      const { client, retainCalls } = capturingClient();
      await parseAndUpsertSession(
        join(tmpDir, `${SESSION_ID}.jsonl`),
        SESSION_ID,
        testConfig,
        client,
        ctx
      );

      expect(retainCalls).toHaveLength(1);
      const tags = retainCalls[0]?.tags ?? [];
      expect(tags).toContain("project:from-flush-config");
      // Pending marker cleared on successful flush.
      expect(hasPendingFlag(SESSION_ID)).toBe(false);
    });
  });

  it("fails closed (no upsert, pending stays queued) when marked and cwd-local config is missing", async () => {
    await withTempDir(async (tmpDir) => {
      // No flush config at tmpDir.
      await setupSession(tmpDir, { usesProjectFlushConfig: true });

      const ctx = makeNotifyCtx();
      const { client, retainCalls } = capturingClient();
      await parseAndUpsertSession(
        join(tmpDir, `${SESSION_ID}.jsonl`),
        SESSION_ID,
        testConfig,
        client,
        ctx
      );

      expect(retainCalls).toHaveLength(0); // no upsert
      expect(hasPendingFlag(SESSION_ID)).toBe(true); // pending left queued
      const notify = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls.map((c) => String(c[0]));
      expect(notify.some((m) => m.includes("Flush blocked for session"))).toBe(true);
      expect(notify.some((m) => m.includes("/hindsight detach-flush-config"))).toBe(true);
    });
  });

  it("fails closed (no upsert, pending stays queued) when marked and flush config is invalid", async () => {
    await withTempDir(async (tmpDir) => {
      writeFlushConfig(tmpDir, "jsonc", JSON.stringify({ notProjectName: "x" }));
      await setupSession(tmpDir, { usesProjectFlushConfig: true });

      const ctx = makeNotifyCtx();
      const { client, retainCalls } = capturingClient();
      await parseAndUpsertSession(
        join(tmpDir, `${SESSION_ID}.jsonl`),
        SESSION_ID,
        testConfig,
        client,
        ctx
      );

      expect(retainCalls).toHaveLength(0);
      expect(hasPendingFlag(SESSION_ID)).toBe(true);
    });
  });

  it("non-marked session still uses default derivation (basename) and flushes normally", async () => {
    await withTempDir(async (tmpDir) => {
      // No flush config, not marked → default derivation uses basename(tmpDir)
      // (no env var, no .git in the temp dir).
      await setupSession(tmpDir, { usesProjectFlushConfig: false });

      const ctx = makeNotifyCtx();
      const { client, retainCalls } = capturingClient();
      await parseAndUpsertSession(
        join(tmpDir, `${SESSION_ID}.jsonl`),
        SESSION_ID,
        testConfig,
        client,
        ctx
      );

      expect(retainCalls).toHaveLength(1);
      const tags = retainCalls[0]?.tags ?? [];
      const expectedBasename = tmpDir.split("/").pop();
      expect(expectedBasename).toBeTruthy();
      expect(tags).toContain(`project:${expectedBasename}`);
      expect(hasPendingFlag(SESSION_ID)).toBe(false);
    });
  });

  it("uses cwd-local config projectName per session (flush-pending handles sessions independently)", async () => {
    // Two sessions in two different cwds, each marked usesProjectFlushConfig
    // with its own flush config and its own projectName. parseAndUpsertSession
    // per session must use each cwd's config independently.
    const SESSION_A = `${SESSION_ID}-a`;
    const SESSION_B = `${SESSION_ID}-b`;

    try {
      await withTempDir(async (dirA) => {
        await withTempDir(async (dirB) => {
          writeFlushConfig(dirA, "jsonc", JSON.stringify({ projectName: "project-a" }));
          writeFlushConfig(dirB, "jsonc", JSON.stringify({ projectName: "project-b" }));

          for (const [sid, dir, _name] of [
            [SESSION_A, dirA, "project-a"],
            [SESSION_B, dirB, "project-b"],
          ] as const) {
            writeSessionFile(dir, sid, {
              cwd: dir,
              messages: [{ role: "user", content: "Hello" }],
              retained: true,
              usesProjectFlushConfig: true,
            });
            await touchPendingFlag(sid);
          }

          const ctx = makeNotifyCtx();
          const { client, retainCalls } = capturingClient();

          // Flush each session independently — like flush-pending iterates.
          await parseAndUpsertSession(
            join(dirA, `${SESSION_A}.jsonl`),
            SESSION_A,
            testConfig,
            client,
            ctx
          );
          await parseAndUpsertSession(
            join(dirB, `${SESSION_B}.jsonl`),
            SESSION_B,
            testConfig,
            client,
            ctx
          );

          expect(retainCalls).toHaveLength(2);
          expect(retainCalls[0]?.tags ?? []).toContain("project:project-a");
          expect(retainCalls[1]?.tags ?? []).toContain("project:project-b");
          expect(hasPendingFlag(SESSION_A)).toBe(false);
          expect(hasPendingFlag(SESSION_B)).toBe(false);
        });
      });
    } finally {
      for (const sid of [SESSION_A, SESSION_B]) {
        removePendingFlag(sid);
        clearSessionQueueState(sid);
        cleanupParsedArtifacts(sid);
        rmSync(getMetaPath(sid), { force: true });
        rmSync(getMessagesPath(sid), { force: true });
        rmSync(getSessionStatePath(sid), { force: true });
      }
    }
  });
});

// ============================================
// /hindsight detach-flush-config command
// ============================================

describe("/hindsight detach-flush-config", () => {
  const SESSION_ID = "detach-flush-config-session";

  it("appends usesProjectFlushConfig:false (latest-wins overrides true) and marks pending", async () => {
    // Use the fixtures' createMockPi builder so the command registration captures
    // the real /hindsight command handler + appendedEntries.
    const { createMockPi } = await import("./fixtures");
    const pi = createMockPi();
    registerCommands(
      pi,
      { ...testConfig, apiUrl: "https://x", apiKey: "y", bankId: "b", observationScopes: [] },
      createMockClient(),
      () => null as RecallMessageDetails | null,
      () => null,
      () => {},
      () => true,
      { configPath: undefined, envVars: [], warning: undefined, validationWarnings: [] }
    );

    const entries = [
      {
        type: "custom",
        customType: "hindsight-meta",
        data: { retained: true, usesProjectFlushConfig: true },
      },
    ];
    const ctx = {
      sessionManager: {
        getSessionId: () => SESSION_ID,
        getEntries: () => entries,
        getSessionFile: () => null,
        getHeader: () => ({ id: SESSION_ID, cwd: tmpdir() }),
        getSessionName: () => undefined,
      },
      ui: {
        notify: mock(),
        confirm: mock(async () => true),
        select: mock(),
      },
      signal: undefined,
      cwd: "/test",
    } as unknown as ExtensionContext;

    try {
      // createMockPi exposes `.commands` (a Map) on the ExtensionAPI mock.
      const cmd = (
        pi as unknown as {
          commands: Map<string, { handler: (a: string, ctx: ExtensionContext) => Promise<void> }>;
        }
      ).commands.get("hindsight");
      expect(cmd).toBeDefined();
      await cmd!.handler("detach-flush-config", ctx);

      // The latest hindsight-meta entry is built by buildMetaUpdate({retained:true,usesProjectFlushConfig:true}, {usesProjectFlushConfig:false}).
      // Latest value wins → false.
      const metaEntries = pi.appendedEntries.filter((e) => e.customType === "hindsight-meta");
      expect(metaEntries.length).toBeGreaterThan(0);
      const latestData = metaEntries[metaEntries.length - 1]?.data as {
        retained?: boolean;
        usesProjectFlushConfig?: boolean;
      };
      expect(latestData.retained).toBe(true); // carried forward
      expect(latestData.usesProjectFlushConfig).toBe(false); // latest-wins overrides true

      // Detach marks the session pending for a re-flush (project tag may change).
      expect(hasPendingFlag(SESSION_ID)).toBe(true);

      // The notification makes clear the file is NOT deleted.
      const notify = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls.map((c) => String(c[0]));
      expect(notify.some((m) => m.includes("NOT deleted"))).toBe(true);
    } finally {
      removePendingFlag(SESSION_ID);
      clearSessionQueueState(SESSION_ID);
    }
  });

  it("bails cleanly when the user declines confirmation", async () => {
    const { createMockPi } = await import("./fixtures");
    const pi = createMockPi();
    registerCommands(
      pi,
      { ...testConfig, apiUrl: "https://x", apiKey: "y", bankId: "b", observationScopes: [] },
      createMockClient(),
      () => null as RecallMessageDetails | null,
      () => null,
      () => {},
      () => true,
      { configPath: undefined, envVars: [], warning: undefined, validationWarnings: [] }
    );

    const ctx = {
      sessionManager: {
        getSessionId: () => SESSION_ID,
        getEntries: () => [
          {
            type: "custom",
            customType: "hindsight-meta",
            data: { retained: true, usesProjectFlushConfig: true },
          },
        ],
        getSessionFile: () => null,
        getHeader: () => ({ id: SESSION_ID, cwd: tmpdir() }),
        getSessionName: () => undefined,
      },
      ui: {
        notify: mock(),
        confirm: mock(async () => false), // decline
        select: mock(),
      },
      signal: undefined,
      cwd: "/test",
    } as unknown as ExtensionContext;

    try {
      const cmd = (
        pi as unknown as {
          commands: Map<string, { handler: (a: string, ctx: ExtensionContext) => Promise<void> }>;
        }
      ).commands.get("hindsight");
      await cmd!.handler("detach-flush-config", ctx);
      expect(pi.appendedEntries.filter((e) => e.customType === "hindsight-meta")).toHaveLength(0);
      expect(hasPendingFlag(SESSION_ID)).toBe(false);
      const notify = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls.map((c) => String(c[0]));
      expect(notify.some((m) => m.includes("not detached"))).toBe(true);
    } finally {
      removePendingFlag(SESSION_ID);
      clearSessionQueueState(SESSION_ID);
    }
  });

  it("remains available when not ready (failed/not-ready state) and clears the flush latch; does NOT re-enable tools if another degraded cause still applies", async () => {
    // Point 3: detach-flush-config is a recovery command that must remain
    // available even when isReady() returns false (NOT in
    // OPERATIONAL_SUBCOMMANDS). It clears the per-session flush latch. But
    // detach does NOT mark the extension operational if another degraded cause
    // still applies — here startup has not been latched (server degraded), so
    // tools stay hidden even after detach clears the project-local failure.
    const { createMockPi } = await import("./fixtures");
    const {
      setActiveSessionFlushReady,
      isActiveSessionFlushReady,
      resetStartupReady,
      resetRegisteredHindsightTools,
    } = await import("../src/runtime-state");
    const pi = createMockPi();
    // isReady returns false (simulating the operational-command gate blocked).
    registerCommands(
      pi,
      { ...testConfig, apiUrl: "https://x", apiKey: "y", bankId: "b", observationScopes: [] },
      createMockClient(),
      () => null as RecallMessageDetails | null,
      () => null,
      () => {},
      () => false, // not ready
      { configPath: undefined, envVars: [], warning: undefined, validationWarnings: [] }
    );

    // startup NOT latched (another degraded cause: server unreachable/incompat).
    resetStartupReady();
    // Simulate the failed active-session flush-config state from session_start.
    setActiveSessionFlushReady(false);
    expect(isActiveSessionFlushReady()).toBe(false);

    const ctx = {
      sessionManager: {
        getSessionId: () => SESSION_ID,
        getEntries: () => [
          {
            type: "custom",
            customType: "hindsight-meta",
            data: { retained: true, usesProjectFlushConfig: true },
          },
        ],
        getSessionFile: () => null,
        getHeader: () => ({ id: SESSION_ID, cwd: tmpdir() }),
        getSessionName: () => undefined,
      },
      ui: {
        notify: mock(),
        confirm: mock(async () => true),
        select: mock(),
      },
      signal: undefined,
      cwd: "/test",
    } as unknown as ExtensionContext;

    try {
      const cmd = (
        pi as unknown as {
          commands: Map<string, { handler: (a: string, ctx: ExtensionContext) => Promise<void> }>;
        }
      ).commands.get("hindsight");
      // detach-flush-config must NOT be blocked by the not-ready gate (it's the
      // recovery command). It runs and writes metadata despite isReady()=false.
      await cmd!.handler("detach-flush-config", ctx);

      const metaEntries = pi.appendedEntries.filter((e) => e.customType === "hindsight-meta");
      expect(metaEntries.length).toBeGreaterThan(0);
      const latestData = metaEntries[metaEntries.length - 1]?.data as {
        usesProjectFlushConfig?: boolean;
      };
      expect(latestData.usesProjectFlushConfig).toBe(false);

      // Detach clears the failed active-session flush latch (detached wins).
      expect(isActiveSessionFlushReady()).toBe(true);
      // But the extension is NOT operational (startup not latched), so tools
      // must NOT be re-enabled: no setActiveTools call re-adds hindsight_retain.
      const enableCalls = pi.setActiveToolsCalls.filter((names) =>
        names.includes("hindsight_retain")
      );
      expect(enableCalls.length).toBe(0);
      expect(hasPendingFlag(SESSION_ID)).toBe(true);
    } finally {
      removePendingFlag(SESSION_ID);
      clearSessionQueueState(SESSION_ID);
      setActiveSessionFlushReady(true);
      resetStartupReady();
      resetRegisteredHindsightTools();
    }
  });

  it("re-enables tools when detach clears the flush failure and the extension is otherwise operational", async () => {
    // When the ONLY degraded cause is the active-session flush config (startup
    // is latched), detach clears it and the extension becomes operational — so
    // tools are re-shown (retain visible because the session is retained:true).
    const { createMockPi } = await import("./fixtures");
    const {
      setActiveSessionFlushReady,
      isActiveSessionFlushReady,
      markStartupReady,
      resetStartupReady,
      resetRegisteredHindsightTools,
    } = await import("../src/runtime-state");
    const { registerTools } = await import("../src/tools");
    const pi = createMockPi();
    registerCommands(
      pi,
      { ...testConfig, apiUrl: "https://x", apiKey: "y", bankId: "b", observationScopes: [] },
      createMockClient(),
      () => null as RecallMessageDetails | null,
      () => null,
      () => {},
      () => true,
      { configPath: undefined, envVars: [], warning: undefined, validationWarnings: [] }
    );
    // Register tools so there's something to re-show, and latch startup.
    registerTools(pi, testConfig, createMockClient());
    markStartupReady();
    // Flush config failed (the only degraded cause).
    setActiveSessionFlushReady(false);
    expect(isActiveSessionFlushReady()).toBe(false);

    const ctx = {
      sessionManager: {
        getSessionId: () => SESSION_ID,
        getEntries: () => [
          {
            type: "custom",
            customType: "hindsight-meta",
            data: { retained: true, usesProjectFlushConfig: true },
          },
        ],
        getSessionFile: () => null,
        getHeader: () => ({ id: SESSION_ID, cwd: tmpdir() }),
        getSessionName: () => undefined,
      },
      ui: {
        notify: mock(),
        confirm: mock(async () => true),
        select: mock(),
      },
      signal: undefined,
      cwd: "/test",
    } as unknown as ExtensionContext;

    try {
      const cmd = (
        pi as unknown as {
          commands: Map<string, { handler: (a: string, ctx: ExtensionContext) => Promise<void> }>;
        }
      ).commands.get("hindsight");
      await cmd!.handler("detach-flush-config", ctx);

      // Detach clears the flush latch → now operational (startup was latched).
      expect(isActiveSessionFlushReady()).toBe(true);
      // Tools re-shown: a setActiveTools call re-adds hindsight_retain
      // (session is retained:true).
      const enableCalls = pi.setActiveToolsCalls.filter((names) =>
        names.includes("hindsight_retain")
      );
      expect(enableCalls.length).toBeGreaterThan(0);
    } finally {
      removePendingFlag(SESSION_ID);
      clearSessionQueueState(SESSION_ID);
      setActiveSessionFlushReady(true);
      resetStartupReady();
      resetRegisteredHindsightTools();
    }
  });
});

// ============================================
// /hindsight config shows session-specific flush config section
// ============================================

describe("/hindsight config: session-specific flush config section", () => {
  it("shows resolved and default project name from a real cwd-local flush config", async () => {
    const { createMockPi } = await import("./fixtures");
    const pi = createMockPi();
    registerCommands(
      pi,
      { ...testConfig, apiUrl: "https://x", apiKey: "y", bankId: "b", observationScopes: [] },
      createMockClient(),
      () => null as RecallMessageDetails | null,
      () => null,
      () => {},
      () => true,
      { configPath: undefined, envVars: [], warning: undefined, validationWarnings: [] }
    );

    await withTempDir(async (cwd) => {
      writeFlushConfig(cwd, "jsonc", JSON.stringify({ projectName: "stable-from-config" }));
      const notify = mock((_msg: string, _level?: "info" | "warning" | "error") => {});
      const ctx = {
        sessionManager: {
          getSessionId: () => "config-sess",
          getEntries: () => [
            {
              type: "custom",
              customType: "hindsight-meta",
              data: { retained: true, usesProjectFlushConfig: true },
            },
          ],
          getSessionFile: () => null,
          getHeader: () => ({ id: "config-sess", cwd }),
          getSessionName: () => undefined,
        },
        ui: { notify, confirm: mock(), select: mock() },
        signal: undefined,
        cwd,
      } as unknown as ExtensionContext;

      const cmd = (
        pi as unknown as {
          commands: Map<string, { handler: (a: string, ctx: ExtensionContext) => Promise<void> }>;
        }
      ).commands.get("hindsight");
      await cmd!.handler("config", ctx);
      const calls = notify.mock.calls.map((c) => String(c[0]));
      const section = calls.find((m) => m.includes("== Session-Specific Flush Config =="));
      expect(section).toBeDefined();
      expect(section).toContain(`Session cwd: ${cwd}`);
      expect(section).toContain("usesProjectFlushConfig: true");
      expect(section).toContain(`Config file:`);
      expect(section).toContain("flush-config.jsonc");
      expect(section).toContain("Config projectName: stable-from-config");
      expect(section).toContain("Resolved project name: stable-from-config (source: flush-config)");
      expect(section).toContain("Default project name:");
      // Marked case -> proceed; default case -> also proceed (cwd exists).
      expect(section).toContain("Flush would proceed: yes");
    });
  });

  it("shows blocked resolution when marked and cwd-local config is missing", async () => {
    const { createMockPi } = await import("./fixtures");
    const pi = createMockPi();
    registerCommands(
      pi,
      { ...testConfig, apiUrl: "https://x", apiKey: "y", bankId: "b", observationScopes: [] },
      createMockClient(),
      () => null as RecallMessageDetails | null,
      () => null,
      () => {},
      () => true,
      { configPath: undefined, envVars: [], warning: undefined, validationWarnings: [] }
    );

    await withTempDir(async (cwd) => {
      // No flush-config written at cwd.
      const notify = mock((_msg: string, _level?: "info" | "warning" | "error") => {});
      const ctx = {
        sessionManager: {
          getSessionId: () => "config-sess",
          getEntries: () => [
            {
              type: "custom",
              customType: "hindsight-meta",
              data: { retained: true, usesProjectFlushConfig: true },
            },
          ],
          getSessionFile: () => null,
          getHeader: () => ({ id: "config-sess", cwd }),
          getSessionName: () => undefined,
        },
        ui: { notify, confirm: mock(), select: mock() },
        signal: undefined,
        cwd,
      } as unknown as ExtensionContext;

      const cmd = (
        pi as unknown as {
          commands: Map<string, { handler: (a: string, ctx: ExtensionContext) => Promise<void> }>;
        }
      ).commands.get("hindsight");
      await cmd!.handler("config", ctx);
      const calls = notify.mock.calls.map((c) => String(c[0]));
      const section = calls.find((m) => m.includes("== Session-Specific Flush Config =="));
      expect(section).toBeDefined();
      expect(section).toContain(`Config file: (missing)`);
      expect(section).toContain("Resolved project name: (blocked)");
      expect(section).toContain("Flush would proceed: no");
    });
  });
});

// ============================================
// updateSessionMetadata carry-forward of usesProjectFlushConfig
// ============================================

describe("updateSessionMetadata carry-forward of usesProjectFlushConfig", () => {
  const SESSION_ID = "carryforward-meta";

  afterEach(() => {
    rmSync(getSessionStatePath(SESSION_ID), { force: true });
  });

  it("buildMetaUpdate carries forward existing usesProjectFlushConfig when updating other fields", async () => {
    const { buildMetaUpdate } = await import("../src/meta");
    const updated = buildMetaUpdate(
      { retained: true, usesProjectFlushConfig: true, tags: ["x"] },
      { retained: true }
    );
    expect(updated.usesProjectFlushConfig).toBe(true);
    expect(updated.retained).toBe(true);
    // tags should NOT be carried when input updates.tags is undefined? Actually
    // buildMetaUpdate carries existing tags forward when updates.tags is undefined.
    // Verify carry-forward keeps tags from existing.
    expect(updated.tags).toEqual(["x"]);
  });

  it("updates api call: detach via updateSessionMetadata appends latest-wins false", async () => {
    const { createMockPi } = await import("./fixtures");
    const pi = createMockPi();
    const existing = [
      {
        type: "custom",
        customType: "hindsight-meta",
        data: { retained: true, usesProjectFlushConfig: true },
      },
    ];
    await updateSessionMetadata(
      pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI,
      SESSION_ID,
      existing,
      { usesProjectFlushConfig: false },
      { ...testConfig }
    );
    const metaEntries = pi.appendedEntries.filter((e) => e.customType === "hindsight-meta");
    expect(metaEntries).toHaveLength(1);
    const data = metaEntries[0]?.data as { retained?: boolean; usesProjectFlushConfig?: boolean };
    expect(data.retained).toBe(true); // carried forward
    expect(data.usesProjectFlushConfig).toBe(false); // latest wins
  });

  it("getHindsightMeta exposes usesProjectFlushConfig", () => {
    const entries = [
      {
        type: "custom",
        customType: "hindsight-meta",
        data: { retained: true, usesProjectFlushConfig: true },
      },
    ];
    const meta = getHindsightMeta(entries);
    expect(meta?.usesProjectFlushConfig).toBe(true);
  });
});
