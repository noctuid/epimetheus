/**
 * Unit tests for parsed-store.ts artifact and JSONL operations.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  getMessagesPath,
  getMetaPath,
  parseCurrentSession,
  writeMessagesJsonl,
} from "../src/parsed-store";
import { getSessionStatePath, readSessionState, writeSessionState } from "../src/session-state";
import {
  makeNotifyCtx,
  setupTempAgentDir,
  testConfig,
  withTempDir,
  writeSessionFile,
} from "./fixtures";

const TEST_SESSION = `test-parsed-${Date.now()}`;

setupTempAgentDir("parsed");

afterEach(() => {
  rmSync(getMessagesPath(TEST_SESSION), { force: true });
  rmSync(getMetaPath(TEST_SESSION), { force: true });
  rmSync(getSessionStatePath(TEST_SESSION), { force: true });
});

describe("writeMessagesJsonl", () => {
  it("writes exact JSONL content", () => {
    const msgs = [
      JSON.stringify({ role: "user", content: "hello" }),
      JSON.stringify({ role: "assistant", content: "hi" }),
    ];
    writeMessagesJsonl(TEST_SESSION, msgs);

    const raw = readFileSync(getMessagesPath(TEST_SESSION), "utf-8");
    const lines = raw.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ role: "user", content: "hello" });
    expect(JSON.parse(lines[1]!)).toEqual({ role: "assistant", content: "hi" });
  });

  it("writes empty content for empty array", () => {
    writeMessagesJsonl(TEST_SESSION, []);
    const raw = readFileSync(getMessagesPath(TEST_SESSION), "utf-8");
    expect(raw).toBe("");
  });
});

describe("parseCurrentSession", () => {
  it("returns error for missing file", async () => {
    const ctx = makeNotifyCtx();
    const result = parseCurrentSession("/nonexistent/path.jsonl", TEST_SESSION, testConfig, ctx);

    expect(result).toBeNull();
  });

  it("returns parsed result with retained=false for non-retained session", async () => {
    await withTempDir(async (tmpDir) => {
      const path = writeSessionFile(tmpDir, TEST_SESSION, { retained: false });
      const ctx = makeNotifyCtx();
      const result = parseCurrentSession(path, TEST_SESSION, testConfig, ctx);

      // parse-session is a non-upsert operation, so it succeeds even when
      // retained=false (the result includes retained status for callers)
      expect(result).not.toBeNull();
      if (result) {
        expect(result.retained).toBe(false);
      }
    });
  });

  it("returns parsed result for retained session without extra context", async () => {
    await withTempDir(async (tmpDir) => {
      const path = writeSessionFile(tmpDir, TEST_SESSION);
      const ctx = makeNotifyCtx();
      const result = parseCurrentSession(path, TEST_SESSION, testConfig, ctx);

      expect(result).not.toBeNull();
      if (result) {
        expect(result.messageCount).toBeGreaterThan(0);
        expect(result.retained).toBe(true);
        expect(result.extraContext).toBeNull();
        expect(result.sessionCwd).toBe("/test");
        expect(typeof result.sessionId).toBe("string");
        expect(typeof result.sessionName).toBe("string");
      }
    });
  });

  it("returns parsed result with extraContext when extra context is set", async () => {
    await withTempDir(async (tmpDir) => {
      const path = writeSessionFile(tmpDir, TEST_SESSION, { extraContext: "Fiction session" });
      const ctx = makeNotifyCtx();
      const result = parseCurrentSession(path, TEST_SESSION, testConfig, ctx);

      expect(result).not.toBeNull();
      if (result) {
        expect(result.retained).toBe(true);
        expect(result.extraContext).toBe("Fiction session");
      }
    });
  });

  it("parse-session succeeds even when retained=false (non-upsert operation)", async () => {
    await withTempDir(async (tmpDir) => {
      const path = writeSessionFile(tmpDir, TEST_SESSION, { retained: false });
      const ctx = makeNotifyCtx();

      const result = parseCurrentSession(path, TEST_SESSION, testConfig, ctx);
      // parse-session does not upsert, so retention status should not block
      expect(result).not.toBeNull();
      if (result) {
        expect(result.retained).toBe(false);
      }
    });
  });

  it("parse-session is not blocked by extraContext=null under guard (non-upsert operation)", async () => {
    await withTempDir(async (tmpDir) => {
      const path = writeSessionFile(tmpDir, TEST_SESSION);
      const ctx = makeNotifyCtx();

      writeSessionState(TEST_SESSION, {
        retained: true,
        extraContext: null,
        updatedAt: new Date().toISOString(),
      });

      const configWithGuard = { ...testConfig, requireExtraContextBeforeFlush: true };
      const result = parseCurrentSession(path, TEST_SESSION, configWithGuard, ctx);
      // parse-session does not upsert, so extra context guard does not apply
      expect(result).not.toBeNull();
    });
  });

  it("parse-session with retained=false still attempts to parse (gets parse error for malformed file)", async () => {
    await withTempDir(async (tmpDir) => {
      // Write a malformed file (no valid session header) that would throw on parse
      const path = join(tmpDir, "malformed.jsonl");
      writeFileSync(path, "not valid jsonl at all\n", "utf8");
      const ctx = makeNotifyCtx();

      // Live state says retained=false — but parse-session should still try
      writeSessionState(TEST_SESSION, {
        retained: false,
        extraContext: null,
        updatedAt: new Date().toISOString(),
      });

      const result = parseCurrentSession(path, TEST_SESSION, testConfig, ctx);
      expect(result).toBeNull();

      // Should get a parse error (not a retention block message)
      const notifyCalls = (ctx.ui.notify as any).mock.calls;
      const messages = notifyCalls.map((c: any[]) => String(c[0]));
      expect(messages.every((m: string) => !m.includes("does not allow retention"))).toBe(true);
    });
  });

  it("live state extraContext=null does not block parsing malformed session file under guard", async () => {
    await withTempDir(async (tmpDir) => {
      // Write a malformed file that would throw on parse
      const path = join(tmpDir, "malformed.jsonl");
      writeFileSync(path, "not valid jsonl at all\n", "utf8");
      const ctx = makeNotifyCtx();

      // Live state says retained=true but extraContext=null
      writeSessionState(TEST_SESSION, {
        retained: true,
        extraContext: null,
        updatedAt: new Date().toISOString(),
      });

      const configWithGuard = { ...testConfig, requireExtraContextBeforeFlush: true };
      const result = parseCurrentSession(path, TEST_SESSION, configWithGuard, ctx);
      // Should get a parse error (not an extra-context block), since
      // parse-session is a non-upsert operation and extra context guard
      // does not apply
      expect(result).toBeNull();
      const notifyCalls = (ctx.ui.notify as any).mock.calls;
      const messages = notifyCalls.map((c: any[]) => String(c[0]));
      expect(messages.every((m: string) => !m.includes("extra context not set"))).toBe(true);
    });
  });

  it("parse-session is not blocked by live state extraContext=null under guard", async () => {
    await withTempDir(async (tmpDir) => {
      const path = writeSessionFile(tmpDir, TEST_SESSION);
      const ctx = makeNotifyCtx();

      writeSessionState(TEST_SESSION, {
        retained: true,
        extraContext: null,
        updatedAt: new Date().toISOString(),
      });

      const configWithGuard = { ...testConfig, requireExtraContextBeforeFlush: true };
      const result = parseCurrentSession(path, TEST_SESSION, configWithGuard, ctx);
      // parse-session does not upsert, so extra context guard does not apply
      expect(result).not.toBeNull();
    });
  });

  it("parse-session succeeds when parsed entries lack extraContext even with stale live state", async () => {
    await withTempDir(async (tmpDir) => {
      // Session file has no extraContext in hindsight-meta
      const path = writeSessionFile(tmpDir, TEST_SESSION);
      const ctx = makeNotifyCtx();

      // Live state has extraContext="" (stale — but parse-session doesn't guard on it)
      writeSessionState(TEST_SESSION, {
        retained: true,
        extraContext: "",
        updatedAt: new Date().toISOString(),
      });

      const configWithGuard = { ...testConfig, requireExtraContextBeforeFlush: true };
      const result = parseCurrentSession(path, TEST_SESSION, configWithGuard, ctx);
      // parse-session does not upsert, so extra context guard does not apply
      expect(result).not.toBeNull();
      if (result) {
        expect(result.extraContext).toBeNull();
      }
    });
  });

  it("falls back to session entries when live state is missing", async () => {
    await withTempDir(async (tmpDir) => {
      // Session file has extraContext in hindsight-meta
      const path = writeSessionFile(tmpDir, TEST_SESSION, { extraContext: "from entries" });
      const ctx = makeNotifyCtx();

      // No live state file exists
      const result = parseCurrentSession(path, TEST_SESSION, testConfig, ctx);
      expect(result).not.toBeNull();
      if (result) {
        expect(result.extraContext).toBe("from entries");
      }
    });
  });

  it("does not write live session state when no live state exists", async () => {
    await withTempDir(async (tmpDir) => {
      const path = writeSessionFile(tmpDir, TEST_SESSION, { extraContext: "from entries" });
      const ctx = makeNotifyCtx();

      expect(readSessionState(TEST_SESSION)).toBeNull();

      const result = parseCurrentSession(path, TEST_SESSION, testConfig, ctx);
      expect(result).not.toBeNull();
      expect(result!.extraContext).toBe("from entries");
      expect(readSessionState(TEST_SESSION)).toBeNull();
    });
  });

  it("does not mutate existing live session state", async () => {
    await withTempDir(async (tmpDir) => {
      const path = writeSessionFile(tmpDir, TEST_SESSION, { extraContext: "from entries" });
      const ctx = makeNotifyCtx();

      const staleState = {
        retained: true,
        extraContext: "stale",
        updatedAt: "2024-01-01T00:00:00.000Z",
      };
      writeSessionState(TEST_SESSION, staleState);

      const result = parseCurrentSession(path, TEST_SESSION, testConfig, ctx);
      expect(result).not.toBeNull();
      expect(result!.extraContext).toBe("from entries");

      const liveState = readSessionState(TEST_SESSION);
      expect(liveState).toEqual(staleState);
    });
  });

  it("extracts parentSessionId from parent reference", async () => {
    await withTempDir(async (tmpDir) => {
      const parentUuid = "12345678-1234-1234-1234-123456789abc";
      // Write parent session file so fork detection works
      writeSessionFile(tmpDir, parentUuid, {
        messages: [
          { role: "user", content: "Hi" },
          { role: "assistant", content: "Hello" },
        ],
      });
      const parentPath = join(tmpDir, `${parentUuid}.jsonl`);
      const path = writeSessionFile(tmpDir, TEST_SESSION, {
        parentSession: parentPath,
        messages: [
          { role: "user", content: "Hi" },
          { role: "assistant", content: "Hello there" },
        ],
      });
      const ctx = makeNotifyCtx();
      const result = parseCurrentSession(path, TEST_SESSION, testConfig, ctx);

      expect(result).not.toBeNull();
      if (result) {
        expect(result.parentSessionId).toBe(parentUuid);
      }
    });
  });

  it("returns warning when parent session file not found", async () => {
    await withTempDir(async (tmpDir) => {
      const path = writeSessionFile(tmpDir, TEST_SESSION, {
        parentSession: "/nonexistent/parent.jsonl",
        messages: [
          { role: "user", content: "Hi" },
          { role: "assistant", content: "Hello" },
        ],
      });
      const ctx = makeNotifyCtx();
      const result = parseCurrentSession(path, TEST_SESSION, testConfig, ctx);

      // Should be a null early-exit (no messages due to missing parent)
      expect(result).toBeNull();
    });
  });
});
