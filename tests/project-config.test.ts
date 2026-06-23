/**
 * Tests for the project-local config feature.
 *
 * Covers `resolveProjectConfig` (load + validate cwd-local config), the default
 * project name derivation (inclusive of git common dir handling so worktrees
 * share the main repo name), fail-closed behavior for marked sessions whose
 * config is missing/invalid, the `/hindsight detach-project-name` command,
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
import type { RecallMessageDetails } from "../src/index";
import { getHindsightMeta, updateSessionMetadata } from "../src/meta";
import { getMessagesPath, getMetaPath } from "../src/parsed-store";
import {
  evaluateActiveSessionProjectState,
  findProjectConfigFile,
  resolveProjectConfig,
  resolveProjectName,
} from "../src/project-config";
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

setupTempAgentDir("project-config");

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
 * Write a config file (`.jsonc` or `.json`) under `<cwd>/.pi/epimetheus/`.
 */
function writeProjectConfig(cwd: string, ext: "jsonc" | "json", content: string): string {
  const dir = join(cwd, ".pi", "epimetheus");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `config.${ext}`);
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
// resolveProjectConfig (load + schema)
// ============================================

describe("resolveProjectConfig", () => {
  it("fails closed (not ok) when no cwd-local config exists", async () => {
    await withTempDir(async (cwd) => {
      const r = resolveProjectConfig(cwd);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/no project config file found/);
    });
  });

  it("loads .jsonc (preferred over .json)", async () => {
    await withTempDir(async (cwd) => {
      writeProjectConfig(cwd, "jsonc", JSON.stringify({ projectName: "from-jsonc" }));
      writeProjectConfig(cwd, "json", JSON.stringify({ projectName: "from-json" }));
      const r = resolveProjectConfig(cwd);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.config.projectName).toBe("from-jsonc");
        expect(r.path.endsWith("config.jsonc")).toBe(true);
      }
    });
  });

  it("loads .json when no .jsonc exists", async () => {
    await withTempDir(async (cwd) => {
      writeProjectConfig(cwd, "json", JSON.stringify({ projectName: "from-json" }));
      const r = resolveProjectConfig(cwd);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.config.projectName).toBe("from-json");
    });
  });

  it("parses JSONC with comments and trailing commas", async () => {
    await withTempDir(async (cwd) => {
      writeProjectConfig(
        cwd,
        "jsonc",
        // Leading comment, inline comment, trailing comma
        `// project-local config
{
  "projectName": "commented", // inline comment
}`
      );
      const r = resolveProjectConfig(cwd);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.config.projectName).toBe("commented");
    });
  });

  it("fails closed when projectName is missing", async () => {
    await withTempDir(async (cwd) => {
      writeProjectConfig(cwd, "jsonc", JSON.stringify({ other: "x" }));
      const r = resolveProjectConfig(cwd);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/projectName/);
    });
  });

  it("fails closed when projectName is not a string", async () => {
    await withTempDir(async (cwd) => {
      writeProjectConfig(cwd, "jsonc", JSON.stringify({ projectName: 42 }));
      const r = resolveProjectConfig(cwd);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/projectName/);
    });
  });

  it("fails closed when projectName is empty/whitespace", async () => {
    await withTempDir(async (cwd) => {
      writeProjectConfig(cwd, "jsonc", JSON.stringify({ projectName: "   " }));
      const r = resolveProjectConfig(cwd);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/empty\/whitespace/);
    });
  });

  it("fails closed when top-level is not an object", async () => {
    await withTempDir(async (cwd) => {
      writeProjectConfig(cwd, "jsonc", `["not", "an", "object"]`);
      const r = resolveProjectConfig(cwd);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/JSON object/);
    });
  });

  it("fails closed when JSON is malformed", async () => {
    await withTempDir(async (cwd) => {
      writeProjectConfig(cwd, "jsonc", `{ "projectName": "x" `); // missing close
      const r = resolveProjectConfig(cwd);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/not valid JSON/);
    });
  });

  it("warns and ignores unknown keys while keeping projectName", async () => {
    await withTempDir(async (cwd) => {
      writeProjectConfig(
        cwd,
        "jsonc",
        JSON.stringify({ projectName: "stable", destination: "x", mode: "y" })
      );
      const r = resolveProjectConfig(cwd);
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
      writeProjectConfig(cwd, "jsonc", JSON.stringify({ projectName: "  stable  " }));
      const r = resolveProjectConfig(cwd);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.config.projectName).toBe("stable");
    });
  });

  it("findProjectConfigFile returns the path when jsonc present, null otherwise", async () => {
    await withTempDir(async (cwd) => {
      expect(findProjectConfigFile(cwd)).toBeNull();
      writeProjectConfig(cwd, "jsonc", JSON.stringify({ projectName: "x" }));
      expect(findProjectConfigFile(cwd)).not.toBeNull();
      expect(findProjectConfigFile(cwd)?.endsWith("config.jsonc")).toBe(true);
    });
  });

  it("does not walk ancestors (only cwd-local and git commondir checked)", async () => {
    await withTempDir(async (dir) => {
      const ancestor = join(dir, "ancestor");
      mkdirSync(ancestor, { recursive: true });
      writeProjectConfig(ancestor, "jsonc", JSON.stringify({ projectName: "ancestor-name" }));
      const child = join(ancestor, "child");
      mkdirSync(child, { recursive: true });
      // Child has no project-config of its own; ancestor does. Should NOT find any
      // (no .git in child, so no commondir fallback either).
      expect(findProjectConfigFile(child)).toBeNull();
      expect(resolveProjectConfig(child).ok).toBe(false);
    });
  });

  it("worktree finds main repo's project config via commondir fallback", async () => {
    await withTempDir(async (dir) => {
      const mainRepo = join(dir, "mainrepo");
      mkdirSync(mainRepo, { recursive: true });
      git(mainRepo, ["init", "-q", "--initial-branch=main"]);
      git(mainRepo, ["config", "user.email", "test@test.local"]);
      git(mainRepo, ["config", "user.name", "Test"]);
      writeFileSync(join(mainRepo, "README.md"), "init\n", "utf-8");
      git(mainRepo, ["add", "."]);
      git(mainRepo, ["commit", "-q", "-m", "init"]);

      // Put project config only in the main repo.
      writeProjectConfig(mainRepo, "jsonc", JSON.stringify({ projectName: "shared-project" }));

      const worktree = join(dir, "wt-fallback");
      git(mainRepo, ["worktree", "add", "-q", worktree]);

      try {
        // Worktree has no .pi dir — should find main repo's config.
        expect(findProjectConfigFile(worktree)).not.toBeNull();
        const loaded = resolveProjectConfig(worktree);
        expect(loaded.ok).toBe(true);
        if (loaded.ok) {
          expect(loaded.config.projectName).toBe("shared-project");
        }
      } finally {
        try {
          git(mainRepo, ["worktree", "remove", "--force", worktree]);
        } catch {
          rmSync(worktree, { recursive: true, force: true });
        }
      }
    });
  });

  it("worktree's own project config takes precedence over main repo's", async () => {
    await withTempDir(async (dir) => {
      const mainRepo = join(dir, "mainrepo");
      mkdirSync(mainRepo, { recursive: true });
      git(mainRepo, ["init", "-q", "--initial-branch=main"]);
      git(mainRepo, ["config", "user.email", "test@test.local"]);
      git(mainRepo, ["config", "user.name", "Test"]);
      writeFileSync(join(mainRepo, "README.md"), "init\n", "utf-8");
      git(mainRepo, ["add", "."]);
      git(mainRepo, ["commit", "-q", "-m", "init"]);

      writeProjectConfig(mainRepo, "jsonc", JSON.stringify({ projectName: "main-project" }));

      const worktree = join(dir, "wt-override");
      git(mainRepo, ["worktree", "add", "-q", worktree]);

      try {
        // Worktree has its own config — should use that, not main repo's.
        writeProjectConfig(worktree, "jsonc", JSON.stringify({ projectName: "wt-project" }));
        const loaded = resolveProjectConfig(worktree);
        expect(loaded.ok).toBe(true);
        if (loaded.ok) {
          expect(loaded.config.projectName).toBe("wt-project");
        }
      } finally {
        try {
          git(mainRepo, ["worktree", "remove", "--force", worktree]);
        } catch {
          rmSync(worktree, { recursive: true, force: true });
        }
      }
    });
  });

  it("submodule (and its worktrees) resolve to the submodule name, not the commondir parent", async () => {
    // A submodule's commondir is <super>/.git/modules/<name>, whose basename is
    // not `.git`. resolveGitCommonDirParent must return null so the submodule
    // falls back to its own cwd basename instead of resolving to `modules`.
    await withTempDir(async (dir) => {
      const superRepo = join(dir, "superrepo");
      mkdirSync(superRepo, { recursive: true });
      git(superRepo, ["init", "-q", "--initial-branch=main"]);
      git(superRepo, ["config", "user.email", "test@test.local"]);
      git(superRepo, ["config", "user.name", "Test"]);
      writeFileSync(join(superRepo, "README.md"), "init\n", "utf-8");
      git(superRepo, ["add", "."]);
      git(superRepo, ["commit", "-q", "-m", "init"]);

      // Create a sub-repo to add as a submodule.
      const subRepo = join(dir, "subrepo-src");
      mkdirSync(subRepo, { recursive: true });
      git(subRepo, ["init", "-q", "--initial-branch=main"]);
      git(subRepo, ["config", "user.email", "test@test.local"]);
      git(subRepo, ["config", "user.name", "Test"]);
      writeFileSync(join(subRepo, "README.md"), "sub\n", "utf-8");
      git(subRepo, ["add", "."]);
      git(subRepo, ["commit", "-q", "-m", "sub"]);

      git(superRepo, [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "-q",
        subRepo,
        "mysub",
      ]);
      git(superRepo, ["commit", "-q", "-m", "add submodule"]);

      const submodCwd = join(superRepo, "mysub");
      // Add a worktree of the submodule to verify worktrees share the name.
      const submodWt = join(dir, "wt-submod");
      git(submodCwd, ["-c", "protocol.file.allow=always", "worktree", "add", "-q", submodWt]);
      try {
        // resolveProjectConfig should NOT find the superproject's .pi via
        // the commondir fallback (the submodule's commondir is not a `.git`).
        const loaded = resolveProjectConfig(submodCwd);
        expect(loaded.ok).toBe(false);

        // Default project name should be the submodule name (`mysub`), not
        // `modules` or the superproject name. Source is `git` because the
        // commondir basename (`mysub`) is used directly.
        const r = resolveProjectName(submodCwd, false);
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(r.projectName).toBe("mysub");
          expect(r.source).toBe("git");
        }

        // A worktree of the submodule shares the submodule name (not the
        // worktree dir name `wt-submod`).
        const wtR = resolveProjectName(submodWt, false);
        expect(wtR.ok).toBe(true);
        if (wtR.ok) {
          expect(wtR.projectName).toBe("mysub");
          expect(wtR.source).toBe("git");
        }
      } finally {
        try {
          git(submodCwd, ["worktree", "remove", "--force", submodWt]);
        } catch {
          rmSync(submodWt, { recursive: true, force: true });
        }
        try {
          git(superRepo, [
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "deinit",
            "-f",
            "mysub",
          ]);
          git(superRepo, ["rm", "-f", "mysub"]);
        } catch {
          // best-effort cleanup
        }
      }
    });
  });
});

// ============================================
// resolveProjectName
// ============================================

describe("resolveProjectName (default / non-marked)", () => {
  // Env-var overrides were removed; default derivation is git common dir -> basename.
  it("ignores EPIMETHEUS_PROJECT_NAME and falls back to basename", () => {
    process.env.EPIMETHEUS_PROJECT_NAME = "env-override";
    try {
      const r = resolveProjectName("/some/path/myapp", false);
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
      const r = resolveProjectName("/some/path/myapp", false);
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
    const r = resolveProjectName("/some/path/myapp", false);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.projectName).toBe("myapp");
      expect(r.source).toBe("basename");
    }
  });

  it("derives basename for non-existent cwd with no .git (no fail-closed)", () => {
    const r = resolveProjectName("/totally/nonexistent/path-xyz", false);
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

      const r = resolveProjectName(mainRepo, false);
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
        const mainR = resolveProjectName(mainRepo, false);
        const wtR = resolveProjectName(worktree, false);
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

describe("resolveProjectName (marked case)", () => {
  it("uses cwd-local project config projectName when marked", async () => {
    await withTempDir(async (cwd) => {
      writeProjectConfig(cwd, "jsonc", JSON.stringify({ projectName: "marked-stable" }));
      const r = resolveProjectName(cwd, true);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.projectName).toBe("marked-stable");
        expect(r.source).toBe("project-local-config");
      }
    });
  });

  it("does not fall back to env var when marked (config projectName is authoritative)", async () => {
    process.env.EPIMETHEUS_PROJECT_NAME = "env-should-be-ignored";
    await withTempDir(async (cwd) => {
      writeProjectConfig(cwd, "json", JSON.stringify({ projectName: "from-config" }));
      const r = resolveProjectName(cwd, true);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.projectName).toBe("from-config");
        expect(r.source).toBe("project-local-config");
      }
    });
  });

  it("fails closed when marked but cwd no longer exists", () => {
    const r = resolveProjectName("/nonexistent/path/abc", true);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/cwd .* no longer exists/);
  });

  it("fails closed when marked and cwd-local config is missing", async () => {
    await withTempDir(async (cwd) => {
      // No project config written.
      const r = resolveProjectName(cwd, true);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/marked .* using project-local config/);
    });
  });

  it("fails closed when marked and cwd-local config is invalid (missing projectName)", async () => {
    await withTempDir(async (cwd) => {
      writeProjectConfig(cwd, "jsonc", JSON.stringify({ other: "x" }));
      const r = resolveProjectName(cwd, true);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/invalid/);
    });
  });

  it("fails closed when marked and no cwd-local config even though an ancestor has one (no ancestor walk)", async () => {
    await withTempDir(async (dir) => {
      const ancestor = join(dir, "ancestor");
      mkdirSync(ancestor, { recursive: true });
      writeProjectConfig(ancestor, "jsonc", JSON.stringify({ projectName: "ancestor-name" }));
      const child = join(ancestor, "child");
      mkdirSync(child, { recursive: true });
      // Marked, cwd-local missing, ancestor has one — must fail closed.
      const r = resolveProjectName(child, true);
      expect(r.ok).toBe(false);
    });
  });

  it("marked worktree finds main repo's config via commondir fallback", async () => {
    await withTempDir(async (dir) => {
      const mainRepo = join(dir, "mainrepo");
      mkdirSync(mainRepo, { recursive: true });
      git(mainRepo, ["init", "-q", "--initial-branch=main"]);
      git(mainRepo, ["config", "user.email", "test@test.local"]);
      git(mainRepo, ["config", "user.name", "Test"]);
      writeFileSync(join(mainRepo, "README.md"), "init\n", "utf-8");
      git(mainRepo, ["add", "."]);
      git(mainRepo, ["commit", "-q", "-m", "init"]);

      writeProjectConfig(mainRepo, "jsonc", JSON.stringify({ projectName: "marked-wt" }));

      const worktree = join(dir, "wt-marked");
      git(mainRepo, ["worktree", "add", "-q", worktree]);

      try {
        const r = resolveProjectName(worktree, true);
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(r.projectName).toBe("marked-wt");
          expect(r.source).toBe("project-local-config");
        }
      } finally {
        try {
          git(mainRepo, ["worktree", "remove", "--force", worktree]);
        } catch {
          rmSync(worktree, { recursive: true, force: true });
        }
      }
    });
  });

  it("marked worktree fails closed when commondir config is invalid (no silent fallback)", async () => {
    await withTempDir(async (dir) => {
      const mainRepo = join(dir, "mainrepo");
      mkdirSync(mainRepo, { recursive: true });
      git(mainRepo, ["init", "-q", "--initial-branch=main"]);
      git(mainRepo, ["config", "user.email", "test@test.local"]);
      git(mainRepo, ["config", "user.name", "Test"]);
      writeFileSync(join(mainRepo, "README.md"), "init\n", "utf-8");
      git(mainRepo, ["add", "."]);
      git(mainRepo, ["commit", "-q", "-m", "init"]);

      // Invalid config in main repo (missing projectName).
      writeProjectConfig(mainRepo, "jsonc", JSON.stringify({ other: "x" }));

      const worktree = join(dir, "wt-marked-invalid");
      git(mainRepo, ["worktree", "add", "-q", worktree]);

      try {
        const r = resolveProjectName(worktree, true);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/invalid/);
      } finally {
        try {
          git(mainRepo, ["worktree", "remove", "--force", worktree]);
        } catch {
          rmSync(worktree, { recursive: true, force: true });
        }
      }
    });
  });
});

// ============================================
// resolveProjectName (unmarked / undefined tristate)
// ============================================

describe("resolveProjectName (unmarked / undefined)", () => {
  it("uses cwd-local config projectName when a valid file is present (unmarked)", async () => {
    await withTempDir(async (cwd) => {
      writeProjectConfig(cwd, "jsonc", JSON.stringify({ projectName: "stable-name" }));
      // unmarked = undefined (NOT false) → valid config is used (mirrors session_start auto-mark intent)
      const r = resolveProjectName(cwd, undefined);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.projectName).toBe("stable-name");
        expect(r.source).toBe("project-local-config");
      }
    });
  });

  it("fails closed when a file is present but invalid (unmarked — no silent fallback)", async () => {
    // Point 4 regression: an invalid cwd-local project-config for an unmarked
    // session must NOT silently fall back to env/git/basename and allow ingestion.
    await withTempDir(async (cwd) => {
      writeProjectConfig(cwd, "jsonc", JSON.stringify({ notProjectName: "x" }));
      const r = resolveProjectName(cwd, undefined);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/invalid/);
    });
  });

  it("uses default derivation when no file is present (unmarked)", () => {
    const r = resolveProjectName("/some/path/myapp", undefined);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.projectName).toBe("myapp");
      expect(r.source).toBe("basename");
    }
  });

  it("detached (false) ignores a present invalid file (detached wins, not fail-closed)", async () => {
    await withTempDir(async (cwd) => {
      writeProjectConfig(cwd, "jsonc", JSON.stringify({ notProjectName: "x" }));
      // false (detached) → ignore the project config entirely → default derivation.
      const r = resolveProjectName(cwd, false);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.projectName).toBe(cwd.split("/").pop() ?? "");
        expect(r.source).toBe("basename");
      }
    });
  });

  it("unmarked worktree picks up main repo's config via commondir fallback", async () => {
    await withTempDir(async (dir) => {
      const mainRepo = join(dir, "mainrepo");
      mkdirSync(mainRepo, { recursive: true });
      git(mainRepo, ["init", "-q", "--initial-branch=main"]);
      git(mainRepo, ["config", "user.email", "test@test.local"]);
      git(mainRepo, ["config", "user.name", "Test"]);
      writeFileSync(join(mainRepo, "README.md"), "init\n", "utf-8");
      git(mainRepo, ["add", "."]);
      git(mainRepo, ["commit", "-q", "-m", "init"]);

      writeProjectConfig(mainRepo, "jsonc", JSON.stringify({ projectName: "wt-unmarked" }));

      const worktree = join(dir, "wt-unmarked");
      git(mainRepo, ["worktree", "add", "-q", worktree]);

      try {
        const r = resolveProjectName(worktree, undefined);
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(r.projectName).toBe("wt-unmarked");
          expect(r.source).toBe("project-local-config");
        }
      } finally {
        try {
          git(mainRepo, ["worktree", "remove", "--force", worktree]);
        } catch {
          rmSync(worktree, { recursive: true, force: true });
        }
      }
    });
  });

  it("unmarked worktree fails closed when commondir config is invalid (no silent fallback)", async () => {
    await withTempDir(async (dir) => {
      const mainRepo = join(dir, "mainrepo");
      mkdirSync(mainRepo, { recursive: true });
      git(mainRepo, ["init", "-q", "--initial-branch=main"]);
      git(mainRepo, ["config", "user.email", "test@test.local"]);
      git(mainRepo, ["config", "user.name", "Test"]);
      writeFileSync(join(mainRepo, "README.md"), "init\n", "utf-8");
      git(mainRepo, ["add", "."]);
      git(mainRepo, ["commit", "-q", "-m", "init"]);

      // Invalid config in main repo (missing projectName).
      writeProjectConfig(mainRepo, "jsonc", JSON.stringify({ notProjectName: "x" }));

      const worktree = join(dir, "wt-unmarked-invalid");
      git(mainRepo, ["worktree", "add", "-q", worktree]);

      try {
        const r = resolveProjectName(worktree, undefined);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/invalid/);
      } finally {
        try {
          git(mainRepo, ["worktree", "remove", "--force", worktree]);
        } catch {
          rmSync(worktree, { recursive: true, force: true });
        }
      }
    });
  });
});

// ============================================
// evaluateActiveSessionProjectState (session_start readiness gate)
// ============================================

describe("evaluateActiveSessionProjectState", () => {
  it("detached (false) is always ready, no auto-mark", () => {
    const r = evaluateActiveSessionProjectState("/anything", { usesProjectConfig: false });
    expect(r.ready).toBe(true);
    expect(r.autoMark).toBeUndefined();
  });

  it("detached (false) is ready even with cwd undefined", () => {
    const r = evaluateActiveSessionProjectState(undefined, { usesProjectConfig: false });
    expect(r.ready).toBe(true);
  });

  it("detached (false) is ready even when cwd has an invalid project config (detach wins)", async () => {
    await withTempDir(async (cwd) => {
      writeProjectConfig(cwd, "jsonc", JSON.stringify({ notProjectName: "x" }));
      const r = evaluateActiveSessionProjectState(cwd, { usesProjectConfig: false });
      expect(r.ready).toBe(true);
      expect(r.autoMark).toBeUndefined();
      expect(r.reason).toBeUndefined();
    });
  });

  it("marked (true) + valid config → ready, no auto-mark", async () => {
    await withTempDir(async (cwd) => {
      writeProjectConfig(cwd, "jsonc", JSON.stringify({ projectName: "marked" }));
      const r = evaluateActiveSessionProjectState(cwd, { usesProjectConfig: true });
      expect(r.ready).toBe(true);
      expect(r.autoMark).toBeUndefined();
    });
  });

  it("marked (true) + invalid config → failed", async () => {
    await withTempDir(async (cwd) => {
      writeProjectConfig(cwd, "jsonc", JSON.stringify({ x: 1 }));
      const r = evaluateActiveSessionProjectState(cwd, { usesProjectConfig: true });
      expect(r.ready).toBe(false);
      expect(r.reason).toMatch(/invalid/);
      expect(r.configPath).toBeTruthy();
    });
  });

  it("marked (true) + no config → failed (required but missing)", async () => {
    await withTempDir(async (cwd) => {
      const r = evaluateActiveSessionProjectState(cwd, { usesProjectConfig: true });
      expect(r.ready).toBe(false);
      expect(r.reason).toMatch(/no project config file is present/);
    });
  });

  it("marked (true) + cwd does not exist → failed", () => {
    const r = evaluateActiveSessionProjectState("/nonexistent/abc/xyz", {
      usesProjectConfig: true,
    });
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/cwd .* does not exist/);
  });

  it("unmarked (undefined) + valid config → ready + autoMark", async () => {
    await withTempDir(async (cwd) => {
      writeProjectConfig(cwd, "jsonc", JSON.stringify({ projectName: "auto" }));
      const r = evaluateActiveSessionProjectState(cwd, null);
      expect(r.ready).toBe(true);
      expect(r.autoMark).toBe(true);
    });
  });

  it("unmarked (undefined) + invalid config → failed (no silent fallback)", async () => {
    await withTempDir(async (cwd) => {
      writeProjectConfig(cwd, "jsonc", JSON.stringify({ nope: true }));
      const r = evaluateActiveSessionProjectState(cwd, null);
      expect(r.ready).toBe(false);
      expect(r.autoMark).toBeUndefined();
      expect(r.reason).toMatch(/invalid/);
    });
  });

  it("unmarked (undefined) + no config → ready (default derivation), no autoMark", async () => {
    await withTempDir(async (cwd) => {
      const r = evaluateActiveSessionProjectState(cwd, null);
      expect(r.ready).toBe(true);
      expect(r.autoMark).toBeUndefined();
    });
  });

  it("unmarked (undefined) + cwd undefined → ready (non-fatal)", () => {
    const r = evaluateActiveSessionProjectState(undefined, null);
    expect(r.ready).toBe(true);
  });

  it("unmarked worktree with commondir config → ready + autoMark", async () => {
    await withTempDir(async (dir) => {
      const mainRepo = join(dir, "mainrepo");
      mkdirSync(mainRepo, { recursive: true });
      git(mainRepo, ["init", "-q", "--initial-branch=main"]);
      git(mainRepo, ["config", "user.email", "test@test.local"]);
      git(mainRepo, ["config", "user.name", "Test"]);
      writeFileSync(join(mainRepo, "README.md"), "init\n", "utf-8");
      git(mainRepo, ["add", "."]);
      git(mainRepo, ["commit", "-q", "-m", "init"]);

      writeProjectConfig(mainRepo, "jsonc", JSON.stringify({ projectName: "wt-auto" }));

      const worktree = join(dir, "wt-auto");
      git(mainRepo, ["worktree", "add", "-q", worktree]);

      try {
        const r = evaluateActiveSessionProjectState(worktree, null);
        expect(r.ready).toBe(true);
        expect(r.autoMark).toBe(true);
      } finally {
        try {
          git(mainRepo, ["worktree", "remove", "--force", worktree]);
        } catch {
          rmSync(worktree, { recursive: true, force: true });
        }
      }
    });
  });

  it("marked worktree with valid commondir config → ready, no autoMark", async () => {
    await withTempDir(async (dir) => {
      const mainRepo = join(dir, "mainrepo");
      mkdirSync(mainRepo, { recursive: true });
      git(mainRepo, ["init", "-q", "--initial-branch=main"]);
      git(mainRepo, ["config", "user.email", "test@test.local"]);
      git(mainRepo, ["config", "user.name", "Test"]);
      writeFileSync(join(mainRepo, "README.md"), "init\n", "utf-8");
      git(mainRepo, ["add", "."]);
      git(mainRepo, ["commit", "-q", "-m", "init"]);

      writeProjectConfig(mainRepo, "jsonc", JSON.stringify({ projectName: "wt-marked-ready" }));

      const worktree = join(dir, "wt-marked-ready");
      git(mainRepo, ["worktree", "add", "-q", worktree]);

      try {
        const r = evaluateActiveSessionProjectState(worktree, { usesProjectConfig: true });
        expect(r.ready).toBe(true);
        expect(r.autoMark).toBeUndefined();
      } finally {
        try {
          git(mainRepo, ["worktree", "remove", "--force", worktree]);
        } catch {
          rmSync(worktree, { recursive: true, force: true });
        }
      }
    });
  });

  it("marked worktree with invalid commondir config → failed (no silent fallback)", async () => {
    await withTempDir(async (dir) => {
      const mainRepo = join(dir, "mainrepo");
      mkdirSync(mainRepo, { recursive: true });
      git(mainRepo, ["init", "-q", "--initial-branch=main"]);
      git(mainRepo, ["config", "user.email", "test@test.local"]);
      git(mainRepo, ["config", "user.name", "Test"]);
      writeFileSync(join(mainRepo, "README.md"), "init\n", "utf-8");
      git(mainRepo, ["add", "."]);
      git(mainRepo, ["commit", "-q", "-m", "init"]);

      writeProjectConfig(mainRepo, "jsonc", JSON.stringify({ broken: true }));

      const worktree = join(dir, "wt-marked-failed");
      git(mainRepo, ["worktree", "add", "-q", worktree]);

      try {
        const r = evaluateActiveSessionProjectState(worktree, { usesProjectConfig: true });
        expect(r.ready).toBe(false);
        expect(r.autoMark).toBeUndefined();
        expect(r.reason).toMatch(/invalid/);
        expect(r.configPath).toBeTruthy();
      } finally {
        try {
          git(mainRepo, ["worktree", "remove", "--force", worktree]);
        } catch {
          rmSync(worktree, { recursive: true, force: true });
        }
      }
    });
  });
});

// ============================================
// Hardened reads: findProjectConfigFile / resolveProjectConfig never throw
// ============================================

describe("project-config hardened reads", () => {
  it("findProjectConfigFile returns the path for a directory named like the config (does not throw)", async () => {
    await withTempDir(async (cwd) => {
      // Create a DIRECTORY at the config.jsonc path (existsSync is true
      // for dirs). findProjectConfigFile must not throw — it returns the path.
      const dir = join(cwd, ".pi", "epimetheus", "config.jsonc");
      mkdirSync(dir, { recursive: true });
      const path = findProjectConfigFile(cwd);
      expect(path).not.toBeNull();
      expect(path?.endsWith("config.jsonc")).toBe(true);
    });
  });

  it("resolveProjectConfig fails closed (ok:false) for a directory instead of throwing", async () => {
    await withTempDir(async (cwd) => {
      const dir = join(cwd, ".pi", "epimetheus", "config.jsonc");
      mkdirSync(dir, { recursive: true });
      let threw = false;
      let r: ReturnType<typeof resolveProjectConfig> | undefined;
      try {
        r = resolveProjectConfig(cwd);
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

  it("findProjectConfigFile returns null when cwd doesn't exist (no throw)", () => {
    let threw = false;
    let path: string | null = null;
    try {
      path = findProjectConfigFile("/totally/nonexistent/xyz");
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(path).toBeNull();
  });
});

// ============================================
// parseAndUpsertSession integration (fail-closed + project-config)
// ============================================

describe("parseAndUpsertSession: project-local config", () => {
  const SESSION_ID = "project-config-session";

  async function setupSession(
    tmpDir: string,
    options: { usesProjectConfig?: boolean }
  ): Promise<void> {
    // writeSessionFile's `cwd` option lets the session header point at a real
    // tmpdir (so existsSync checks behave realistically).
    writeSessionFile(tmpDir, SESSION_ID, {
      cwd: tmpDir,
      messages: [{ role: "user", content: "Hello" }],
      retained: true,
      usesProjectConfig: options.usesProjectConfig,
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

  it("uses cwd-local project config projectName when session is marked and config is valid", async () => {
    await withTempDir(async (tmpDir) => {
      writeProjectConfig(tmpDir, "jsonc", JSON.stringify({ projectName: "from-project-config" }));
      await setupSession(tmpDir, { usesProjectConfig: true });

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
      expect(tags).toContain("project:from-project-config");
      // Pending marker cleared on successful flush.
      expect(hasPendingFlag(SESSION_ID)).toBe(false);
    });
  });

  it("fails closed (no upsert, pending stays queued) when marked and cwd-local config is missing", async () => {
    await withTempDir(async (tmpDir) => {
      // No project config at tmpDir.
      await setupSession(tmpDir, { usesProjectConfig: true });

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
      expect(notify.some((m) => m.includes("/hindsight detach-project-name"))).toBe(true);
    });
  });

  it("fails closed (no upsert, pending stays queued) when marked and project config is invalid", async () => {
    await withTempDir(async (tmpDir) => {
      writeProjectConfig(tmpDir, "jsonc", JSON.stringify({ notProjectName: "x" }));
      await setupSession(tmpDir, { usesProjectConfig: true });

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
      // No project config, not marked → default derivation uses basename(tmpDir)
      // (no env var, no .git in the temp dir).
      await setupSession(tmpDir, { usesProjectConfig: false });

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
    // Two sessions in two different cwds, each marked usesProjectConfig
    // with its own project config and its own projectName. parseAndUpsertSession
    // per session must use each cwd's config independently.
    const SESSION_A = `${SESSION_ID}-a`;
    const SESSION_B = `${SESSION_ID}-b`;

    try {
      await withTempDir(async (dirA) => {
        await withTempDir(async (dirB) => {
          writeProjectConfig(dirA, "jsonc", JSON.stringify({ projectName: "project-a" }));
          writeProjectConfig(dirB, "jsonc", JSON.stringify({ projectName: "project-b" }));

          for (const [sid, dir, _name] of [
            [SESSION_A, dirA, "project-a"],
            [SESSION_B, dirB, "project-b"],
          ] as const) {
            writeSessionFile(dir, sid, {
              cwd: dir,
              messages: [{ role: "user", content: "Hello" }],
              retained: true,
              usesProjectConfig: true,
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

  it("auto-flush suppresses the project-name block warning in non-debug mode", async () => {
    // Like other transient block warnings (extra-context guard, not-retained),
    // the project-name fail-closed block is suppressed during auto-flushes
    // unless debug: true. Pending work stays queued either way.
    await withTempDir(async (tmpDir) => {
      // No project config at tmpDir -> marked + missing -> fail closed.
      await setupSession(tmpDir, { usesProjectConfig: true });
      const ctx = makeNotifyCtx();
      const { client, retainCalls } = capturingClient();
      await parseAndUpsertSession(
        join(tmpDir, `${SESSION_ID}.jsonl`),
        SESSION_ID,
        testConfig,
        client,
        ctx,
        undefined,
        { autoFlush: true }
      );
      expect(retainCalls).toHaveLength(0); // no upsert
      expect(hasPendingFlag(SESSION_ID)).toBe(true); // pending stays queued
      const notify = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls.map((c) => String(c[0]));
      expect(notify.some((m) => m.includes("Flush blocked for session"))).toBe(false);
    });
  });

  it("auto-flush surfaces the project-name block warning in debug mode", async () => {
    await withTempDir(async (tmpDir) => {
      await setupSession(tmpDir, { usesProjectConfig: true });
      const ctx = makeNotifyCtx();
      const { client, retainCalls } = capturingClient();
      await parseAndUpsertSession(
        join(tmpDir, `${SESSION_ID}.jsonl`),
        SESSION_ID,
        { ...testConfig, debug: true },
        client,
        ctx,
        undefined,
        { autoFlush: true }
      );
      expect(retainCalls).toHaveLength(0); // no upsert
      expect(hasPendingFlag(SESSION_ID)).toBe(true); // pending stays queued
      const notify = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls.map((c) => String(c[0]));
      expect(notify.some((m) => m.includes("Flush blocked for session"))).toBe(true);
    });
  });
});

// ============================================
// /hindsight detach-project-name command
// ============================================

describe("/hindsight detach-project-name", () => {
  const SESSION_ID = "detach-project-name-session";

  it("appends usesProjectConfig:false (latest-wins overrides true) and marks pending", async () => {
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
        data: { retained: true, usesProjectConfig: true },
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
      await cmd!.handler("detach-project-name", ctx);

      // The latest hindsight-meta entry is built by buildMetaUpdate({retained:true,usesProjectConfig:true}, {usesProjectConfig:false}).
      // Latest value wins → false.
      const metaEntries = pi.appendedEntries.filter((e) => e.customType === "hindsight-meta");
      expect(metaEntries.length).toBeGreaterThan(0);
      const latestData = metaEntries[metaEntries.length - 1]?.data as {
        retained?: boolean;
        usesProjectConfig?: boolean;
      };
      expect(latestData.retained).toBe(true); // carried forward
      expect(latestData.usesProjectConfig).toBe(false); // latest-wins overrides true

      // Detach marks the session pending for a re-flush (project tag may change).
      expect(hasPendingFlag(SESSION_ID)).toBe(true);

      // The notification makes clear the file is not deleted.
      const notify = (ctx.ui.notify as ReturnType<typeof mock>).mock.calls.map((c) => String(c[0]));
      expect(notify.some((m) => m.includes("not deleted"))).toBe(true);
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
            data: { retained: true, usesProjectConfig: true },
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
      await cmd!.handler("detach-project-name", ctx);
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
    // Point 3: detach-project-name is a recovery command that must remain
    // available even when isReady() returns false (NOT in
    // OPERATIONAL_SUBCOMMANDS). It clears the per-session flush latch. But
    // detach does NOT mark the extension operational if another degraded cause
    // still applies — here startup has not been latched (server degraded), so
    // tools stay hidden even after detach clears the project-local failure.
    const { createMockPi } = await import("./fixtures");
    const {
      setActiveSessionProjectReady,
      isActiveSessionProjectReady,
      resetStartupReady,
      resetRegisteredHindsightTools,
      setDegradedReason,
      DegradedReasonKind,
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
    // Simulate the failed active-session project-name state from session_start.
    // The degraded reason must be ProjectName so detach-project-name (a
    // project-name recovery command) is not blocked by the global-config gate.
    setActiveSessionProjectReady(false);
    setDegradedReason({
      kind: DegradedReasonKind.ProjectName,
      message: "project config is invalid",
    });
    expect(isActiveSessionProjectReady()).toBe(false);

    const ctx = {
      sessionManager: {
        getSessionId: () => SESSION_ID,
        getEntries: () => [
          {
            type: "custom",
            customType: "hindsight-meta",
            data: { retained: true, usesProjectConfig: true },
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
        setStatus: mock(),
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
      // detach-project-name must NOT be blocked by the not-ready gate (it's the
      // recovery command). It runs and writes metadata despite isReady()=false.
      await cmd!.handler("detach-project-name", ctx);

      const metaEntries = pi.appendedEntries.filter((e) => e.customType === "hindsight-meta");
      expect(metaEntries.length).toBeGreaterThan(0);
      const latestData = metaEntries[metaEntries.length - 1]?.data as {
        usesProjectConfig?: boolean;
      };
      expect(latestData.usesProjectConfig).toBe(false);

      // Detach clears the failed active-session flush latch (detached wins).
      expect(isActiveSessionProjectReady()).toBe(true);
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
      setActiveSessionProjectReady(true);
      resetStartupReady();
      resetRegisteredHindsightTools();
      setDegradedReason(null);
    }
  });

  it("re-enables tools when detach clears the flush failure and the extension is otherwise operational", async () => {
    // When the ONLY degraded cause is the active-session project config (startup
    // is latched), detach clears it and the extension becomes operational — so
    // tools are re-shown (retain visible because the session is retained:true).
    const { createMockPi } = await import("./fixtures");
    const {
      setActiveSessionProjectReady,
      isActiveSessionProjectReady,
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
    // Project config failed (the only degraded cause).
    setActiveSessionProjectReady(false);
    expect(isActiveSessionProjectReady()).toBe(false);

    const ctx = {
      sessionManager: {
        getSessionId: () => SESSION_ID,
        getEntries: () => [
          {
            type: "custom",
            customType: "hindsight-meta",
            data: { retained: true, usesProjectConfig: true },
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
        setStatus: mock(),
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
      await cmd!.handler("detach-project-name", ctx);

      // Detach clears the flush latch → now operational (startup was latched).
      expect(isActiveSessionProjectReady()).toBe(true);
      // Tools re-shown: a setActiveTools call re-adds hindsight_retain
      // (session is retained:true).
      const enableCalls = pi.setActiveToolsCalls.filter((names) =>
        names.includes("hindsight_retain")
      );
      expect(enableCalls.length).toBeGreaterThan(0);
      // Status bar restored to healthy (detach cleared the only degraded cause).
      const statusCalls = (ctx.ui.setStatus as ReturnType<typeof mock>).mock.calls.map((c) =>
        String(c[1])
      );
      expect(statusCalls.some((s) => s.includes("🧠"))).toBe(true);
    } finally {
      removePendingFlag(SESSION_ID);
      clearSessionQueueState(SESSION_ID);
      setActiveSessionProjectReady(true);
      resetStartupReady();
      resetRegisteredHindsightTools();
    }
  });

  it("is blocked when the degraded cause is global config (no session writes)", async () => {
    // When global config is invalid, the fail-fast bootstrap path promises no
    // metadata/session-state/queue writes. detach-project-name writes session
    // metadata + a pending marker, so it must be blocked for global-config
    // degraded mode — even though it is not in OPERATIONAL_SUBCOMMANDS.
    const { createMockPi } = await import("./fixtures");
    const {
      setActiveSessionProjectReady,
      resetStartupReady,
      resetRegisteredHindsightTools,
      setDegradedReason,
      DegradedReasonKind,
    } = await import("../src/runtime-state");
    const pi = createMockPi();
    registerCommands(
      pi,
      { ...testConfig, apiUrl: "https://x", apiKey: "y", bankId: "b", observationScopes: [] },
      createMockClient(),
      () => null as RecallMessageDetails | null,
      () => null,
      () => {},
      () => false, // not ready (global config invalid)
      { configPath: undefined, envVars: [], warning: undefined, validationWarnings: [] }
    );

    resetStartupReady();
    setActiveSessionProjectReady(false);
    setDegradedReason({
      kind: DegradedReasonKind.GlobalConfig,
      message: "global config is invalid",
    });

    const notifyMock = mock();
    const ctx = {
      sessionManager: {
        getSessionId: () => SESSION_ID,
        getEntries: () => [
          {
            type: "custom",
            customType: "hindsight-meta",
            data: { retained: true, usesProjectConfig: true },
          },
        ],
        getSessionFile: () => null,
        getHeader: () => ({ id: SESSION_ID, cwd: tmpdir() }),
        getSessionName: () => undefined,
      },
      ui: {
        notify: notifyMock,
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
      await cmd!.handler("detach-project-name", ctx);

      // No metadata was written (detach was blocked).
      const metaEntries = pi.appendedEntries.filter((e) => e.customType === "hindsight-meta");
      expect(metaEntries.length).toBe(0);
      // No pending marker was touched.
      expect(hasPendingFlag(SESSION_ID)).toBe(false);
      // A blocked message was shown.
      const notifyMsgs = notifyMock.mock.calls.map((c) => String(c[0]));
      expect(notifyMsgs.some((m) => m.includes("operational commands"))).toBe(true);
    } finally {
      removePendingFlag(SESSION_ID);
      clearSessionQueueState(SESSION_ID);
      setActiveSessionProjectReady(true);
      resetStartupReady();
      resetRegisteredHindsightTools();
      setDegradedReason(null);
    }
  });
});

// ============================================
// /hindsight config shows session-specific project config section
// ============================================

describe("/hindsight config: session-specific project config section", () => {
  it("shows resolved project name from a real cwd-local project config", async () => {
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
      writeProjectConfig(cwd, "jsonc", JSON.stringify({ projectName: "stable-from-config" }));
      const notify = mock((_msg: string, _level?: "info" | "warning" | "error") => {});
      const ctx = {
        sessionManager: {
          getSessionId: () => "config-sess",
          getEntries: () => [
            {
              type: "custom",
              customType: "hindsight-meta",
              data: { retained: true, usesProjectConfig: true },
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
      const section = calls.find((m) => m.includes("== Session-Specific Project Config =="));
      expect(section).toBeDefined();
      expect(section).toContain(`Session cwd: ${cwd}`);
      expect(section).toContain("usesProjectConfig: true");
      expect(section).toContain("Project-local config:");
      expect(section).toContain("config.jsonc");
      expect(section).toContain("(valid)");
      expect(section).toContain("projectName: stable-from-config");
      expect(section).toContain("Project name: stable-from-config (source: project-local-config)");
      expect(section).not.toContain("default if detached:");
      expect(section).not.toContain("Flush: would proceed");
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
      // No project-config written at cwd.
      const notify = mock((_msg: string, _level?: "info" | "warning" | "error") => {});
      const ctx = {
        sessionManager: {
          getSessionId: () => "config-sess",
          getEntries: () => [
            {
              type: "custom",
              customType: "hindsight-meta",
              data: { retained: true, usesProjectConfig: true },
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
      const section = calls.find((m) => m.includes("== Session-Specific Project Config =="));
      expect(section).toBeDefined();
      expect(section).toContain("Project-local config: <missing>");
      expect(section).toContain("Project name: (blocked)");
      expect(section).toContain("Flush: blocked — pending left queued");
    });
  });
});

// ============================================
// updateSessionMetadata carry-forward of usesProjectConfig
// ============================================

describe("updateSessionMetadata carry-forward of usesProjectConfig", () => {
  const SESSION_ID = "carryforward-meta";

  afterEach(() => {
    rmSync(getSessionStatePath(SESSION_ID), { force: true });
  });

  it("buildMetaUpdate carries forward existing usesProjectConfig when updating other fields", async () => {
    const { buildMetaUpdate } = await import("../src/meta");
    const updated = buildMetaUpdate(
      { retained: true, usesProjectConfig: true, tags: ["x"] },
      { retained: true }
    );
    expect(updated.usesProjectConfig).toBe(true);
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
        data: { retained: true, usesProjectConfig: true },
      },
    ];
    await updateSessionMetadata(
      pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI,
      SESSION_ID,
      existing,
      { usesProjectConfig: false },
      { ...testConfig }
    );
    const metaEntries = pi.appendedEntries.filter((e) => e.customType === "hindsight-meta");
    expect(metaEntries).toHaveLength(1);
    const data = metaEntries[0]?.data as { retained?: boolean; usesProjectConfig?: boolean };
    expect(data.retained).toBe(true); // carried forward
    expect(data.usesProjectConfig).toBe(false); // latest wins
  });

  it("getHindsightMeta exposes usesProjectConfig", () => {
    const entries = [
      {
        type: "custom",
        customType: "hindsight-meta",
        data: { retained: true, usesProjectConfig: true },
      },
    ];
    const meta = getHindsightMeta(entries);
    expect(meta?.usesProjectConfig).toBe(true);
  });
});
