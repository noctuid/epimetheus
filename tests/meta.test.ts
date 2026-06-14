/**
 * Unit tests for session metadata management.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildMetaUpdate,
  getHindsightMeta,
  isExtraContextSet,
  readMetaFile,
  readMetaFileByPath,
  resolveExtraContext,
  resolveRetained,
  shouldSessionBeRetained,
} from "../src/meta";
import { ensureParsedSessionDir, getMetaPath } from "../src/parsed-store";
import { getSessionStatePath } from "../src/session-state";
import { setupTempAgentDir } from "./fixtures";

const TEST_SESSION = `test-meta-${Date.now()}`;

setupTempAgentDir("meta");

afterEach(() => {
  rmSync(getMetaPath(TEST_SESSION), { force: true });
  rmSync(getSessionStatePath(TEST_SESSION), { force: true });
});

type MetaEntry = Parameters<typeof getHindsightMeta>[0][number];

describe("getHindsightMeta", () => {
  it("returns null when no hindsight-meta entries exist", () => {
    const entries: MetaEntry[] = [
      { type: "message" },
      { type: "custom", customType: "other-type", data: { foo: "bar" } },
    ];
    expect(getHindsightMeta(entries)).toBeNull();
  });

  it("returns the latest hindsight-meta entry data", () => {
    const entries: MetaEntry[] = [
      { type: "custom", customType: "hindsight-meta", data: { retained: true } },
      { type: "message" },
      { type: "custom", customType: "hindsight-meta", data: { retained: false } },
    ];
    expect(getHindsightMeta(entries)).toEqual({ retained: false });
  });

  it("returns single hindsight-meta entry", () => {
    const entries: MetaEntry[] = [
      { type: "custom", customType: "hindsight-meta", data: { retained: true, tags: ["test"] } },
    ];
    expect(getHindsightMeta(entries)).toEqual({ retained: true, tags: ["test"] });
  });

  it("returns null for hindsight-meta entry with undefined data", () => {
    const entries: MetaEntry[] = [
      { type: "custom", customType: "hindsight-meta", data: undefined },
    ];
    expect(getHindsightMeta(entries)).toBeNull();
  });

  it("returns null for empty entries array", () => {
    expect(getHindsightMeta([])).toBeNull();
  });

  it("returns meta with tags only", () => {
    const entries: MetaEntry[] = [
      { type: "custom", customType: "hindsight-meta", data: { tags: ["topic:ai"] } },
    ];
    expect(getHindsightMeta(entries)).toEqual({ tags: ["topic:ai"] });
  });

  it("returns meta with extraContext", () => {
    const entries: MetaEntry[] = [
      {
        type: "custom",
        customType: "hindsight-meta",
        data: { retained: true, extraContext: "This is fiction" },
      },
    ];
    expect(getHindsightMeta(entries)).toEqual({
      retained: true,
      extraContext: "This is fiction",
    });
  });

  it("returns latest meta with extraContext", () => {
    const entries: MetaEntry[] = [
      {
        type: "custom",
        customType: "hindsight-meta",
        data: { retained: true, extraContext: "old context" },
      },
      {
        type: "custom",
        customType: "hindsight-meta",
        data: { retained: true, extraContext: "new context" },
      },
    ];
    expect(getHindsightMeta(entries)).toEqual({
      retained: true,
      extraContext: "new context",
    });
  });
});

describe("shouldSessionBeRetained", () => {
  it("returns true by default when retainSessionsByDefault is true", () => {
    expect(shouldSessionBeRetained([], { retainSessionsByDefault: true })).toBe(true);
  });

  it("returns false by default when retainSessionsByDefault is false", () => {
    expect(shouldSessionBeRetained([], { retainSessionsByDefault: false })).toBe(false);
  });

  it("returns retained value from meta when present", () => {
    const entries: MetaEntry[] = [
      { type: "custom", customType: "hindsight-meta", data: { retained: false } },
    ];
    expect(shouldSessionBeRetained(entries, { retainSessionsByDefault: true })).toBe(false);
  });

  it("returns retained: true from meta even when default is false", () => {
    const entries: MetaEntry[] = [
      { type: "custom", customType: "hindsight-meta", data: { retained: true } },
    ];
    expect(shouldSessionBeRetained(entries, { retainSessionsByDefault: false })).toBe(true);
  });

  it("falls back to config when retained is undefined in meta", () => {
    const entries: MetaEntry[] = [
      { type: "custom", customType: "hindsight-meta", data: { tags: ["test"] } },
    ];
    expect(shouldSessionBeRetained(entries, { retainSessionsByDefault: false })).toBe(false);
  });

  it("uses latest meta entry when multiple exist", () => {
    const entries: MetaEntry[] = [
      { type: "custom", customType: "hindsight-meta", data: { retained: true } },
      { type: "custom", customType: "hindsight-meta", data: { retained: false } },
    ];
    expect(shouldSessionBeRetained(entries, { retainSessionsByDefault: true })).toBe(false);
  });
});

describe("isExtraContextSet", () => {
  it("returns false for null", () => {
    expect(isExtraContextSet(null)).toBe(false);
  });

  it("returns true for empty string", () => {
    expect(isExtraContextSet("")).toBe(true);
  });

  it("returns true for non-empty string", () => {
    expect(isExtraContextSet("Fiction session")).toBe(true);
  });
});

describe("resolveExtraContext", () => {
  it("returns null when no live state and no hindsight-meta", () => {
    expect(resolveExtraContext(null, null)).toBeNull();
  });

  it("returns null when no live state and hindsight-meta has no extraContext key", () => {
    expect(resolveExtraContext(null, { retained: true })).toBeNull();
  });

  it("returns extraContext from hindsight-meta when no live state", () => {
    expect(resolveExtraContext(null, { retained: true, extraContext: "Fiction" })).toBe("Fiction");
  });

  it("returns empty string from hindsight-meta when no live state", () => {
    expect(resolveExtraContext(null, { retained: true, extraContext: "" })).toBe("");
  });

  it("returns extraContext from live state (authoritative)", () => {
    const state = {
      retained: true,
      extraContext: "from state",
      updatedAt: new Date().toISOString(),
    };
    expect(resolveExtraContext(state, { extraContext: "from meta" })).toBe("from state");
  });

  it("returns null from live state when extraContext is null", () => {
    const state = { retained: true, extraContext: null, updatedAt: new Date().toISOString() };
    expect(resolveExtraContext(state, { extraContext: "from meta" })).toBeNull();
  });
});

describe("resolveRetained", () => {
  it("uses live state when available", () => {
    const state = { retained: false, extraContext: null, updatedAt: new Date().toISOString() };
    expect(resolveRetained(state, [], { retainSessionsByDefault: true })).toBe(false);
  });

  it("falls back to session entries when no live state", () => {
    const entries: MetaEntry[] = [
      { type: "custom", customType: "hindsight-meta", data: { retained: false } },
    ];
    expect(resolveRetained(null, entries, { retainSessionsByDefault: true })).toBe(false);
  });

  it("falls back to config default when no live state and no entries", () => {
    expect(resolveRetained(null, [], { retainSessionsByDefault: true })).toBe(true);
    expect(resolveRetained(null, [], { retainSessionsByDefault: false })).toBe(false);
  });
});

describe("buildMetaUpdate", () => {
  it("sets retained from updates when no existing meta", () => {
    expect(buildMetaUpdate(null, { retained: true })).toEqual({ retained: true });
  });

  it("sets retained: false from updates when no existing meta", () => {
    expect(buildMetaUpdate(null, { retained: false })).toEqual({ retained: false });
  });

  it("preserves existing fields not overridden", () => {
    expect(buildMetaUpdate({ retained: true, tags: ["x"] }, { extraContext: "foo" })).toEqual({
      retained: true,
      tags: ["x"],
      extraContext: "foo",
    });
  });

  it("drops tags when updates has empty array", () => {
    expect(buildMetaUpdate({ retained: true, tags: ["x"] }, { tags: [] })).toEqual({
      retained: true,
    });
  });

  it("stores empty string extraContext (satisfies flush guard)", () => {
    expect(buildMetaUpdate(null, { extraContext: "" })).toEqual({ extraContext: "" });
  });

  it("preserves existing retained and tags when setting extraContext", () => {
    expect(
      buildMetaUpdate({ retained: false, tags: ["a", "b"] }, { extraContext: "fiction" })
    ).toEqual({ retained: false, tags: ["a", "b"], extraContext: "fiction" });
  });

  it("preserves existing extraContext when updating tags", () => {
    expect(buildMetaUpdate({ retained: true, extraContext: "old" }, { tags: ["new"] })).toEqual({
      retained: true,
      extraContext: "old",
      tags: ["new"],
    });
  });

  it("returns empty object when no existing meta and no updates set", () => {
    expect(buildMetaUpdate(null, {})).toEqual({});
  });

  it("overrides retained from existing with update", () => {
    expect(buildMetaUpdate({ retained: true }, { retained: false })).toEqual({ retained: false });
  });

  it("overrides extraContext from existing with update", () => {
    expect(buildMetaUpdate({ extraContext: "old" }, { extraContext: "new" })).toEqual({
      extraContext: "new",
    });
  });

  it("replaces tags from existing with update tags", () => {
    expect(buildMetaUpdate({ tags: ["old"] }, { tags: ["a", "b"] })).toEqual({
      tags: ["a", "b"],
    });
  });

  it("carries forward existing retained when updates has no retained", () => {
    expect(buildMetaUpdate({ retained: true }, { tags: ["x"] })).toEqual({
      retained: true,
      tags: ["x"],
    });
  });

  it("carries forward existing extraContext when updates has no extraContext", () => {
    expect(buildMetaUpdate({ extraContext: "fiction" }, { retained: false })).toEqual({
      retained: false,
      extraContext: "fiction",
    });
  });

  it("drops tags when existing has tags but updates has empty array", () => {
    expect(buildMetaUpdate({ retained: true, tags: ["x"] }, { tags: [], retained: true })).toEqual({
      retained: true,
    });
  });
});

describe("readMetaFile", () => {
  function writeRawMetaFile(content: string) {
    ensureParsedSessionDir();
    writeFileSync(getMetaPath(TEST_SESSION), content, "utf-8");
  }

  const validMeta = JSON.stringify({
    sessionId: "doc-123",
    sessionName: "test session",
    extraContext: null,
    sessionUserTags: [],
    sessionCwd: "/home/user/project",
    sessionTimestamp: "2024-01-01T00:00:00Z",
    messageCount: 5,
    retained: true,
  });

  it("returns valid meta for well-formed file", () => {
    writeRawMetaFile(validMeta);
    const result = readMetaFile(TEST_SESSION);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("doc-123");
    expect(result!.retained).toBe(true);
  });

  it("returns null when file does not exist", () => {
    expect(readMetaFile(TEST_SESSION)).toBeNull();
  });

  it("returns null for invalid JSON syntax", () => {
    writeRawMetaFile("{ not valid json");
    expect(readMetaFile(TEST_SESSION)).toBeNull();
  });

  it("returns null for empty object", () => {
    writeRawMetaFile("{}");
    expect(readMetaFile(TEST_SESSION)).toBeNull();
  });

  it("returns null when sessionId is missing", () => {
    writeRawMetaFile(
      JSON.stringify({
        sessionName: "test",
        extraContext: null,
        sessionCwd: "/test",
        sessionTimestamp: "2024-01-01T00:00:00Z",
        messageCount: 1,
        retained: true,
      })
    );
    expect(readMetaFile(TEST_SESSION)).toBeNull();
  });

  it("returns null when sessionName is missing", () => {
    writeRawMetaFile(
      JSON.stringify({
        sessionId: "doc",
        extraContext: null,
        sessionCwd: "/test",
        sessionTimestamp: "2024-01-01T00:00:00Z",
        messageCount: 1,
        retained: true,
      })
    );
    expect(readMetaFile(TEST_SESSION)).toBeNull();
  });

  it("returns null when sessionTimestamp is empty", () => {
    writeRawMetaFile(
      JSON.stringify({
        sessionId: "doc",
        sessionName: "test",
        extraContext: null,
        sessionCwd: "/test",
        sessionTimestamp: "",
        messageCount: 1,
        retained: true,
      })
    );
    expect(readMetaFile(TEST_SESSION)).toBeNull();
  });

  it("returns null when retained is a string instead of boolean", () => {
    writeRawMetaFile(
      JSON.stringify({
        sessionId: "doc",
        sessionName: "test",
        extraContext: null,
        sessionCwd: "/test",
        sessionTimestamp: "2024-01-01T00:00:00Z",
        messageCount: 0,
        retained: "nope",
      })
    );
    expect(readMetaFile(TEST_SESSION)).toBeNull();
  });

  it("returns null when messageCount is not a finite number", () => {
    writeRawMetaFile(
      JSON.stringify({
        sessionId: "doc",
        sessionName: "test",
        extraContext: null,
        sessionCwd: "/test",
        sessionTimestamp: "2024-01-01T00:00:00Z",
        messageCount: Infinity,
        retained: true,
      })
    );
    expect(readMetaFile(TEST_SESSION)).toBeNull();
  });

  it("returns null when extraContext is not null or string", () => {
    writeRawMetaFile(
      JSON.stringify({
        sessionId: "doc",
        sessionName: "test",
        extraContext: 123,
        sessionCwd: "/test",
        sessionTimestamp: "2024-01-01T00:00:00Z",
        messageCount: 0,
        retained: true,
      })
    );
    expect(readMetaFile(TEST_SESSION)).toBeNull();
  });

  it("returns null when sessionUserTags is not an array of strings", () => {
    writeRawMetaFile(
      JSON.stringify({
        sessionId: "doc",
        sessionName: "test",
        extraContext: null,
        sessionCwd: "/test",
        sessionTimestamp: "2024-01-01T00:00:00Z",
        messageCount: 0,
        retained: true,
        sessionUserTags: [123, true],
      })
    );
    expect(readMetaFile(TEST_SESSION)).toBeNull();
  });

  it("returns null when parentSessionId is not a string", () => {
    writeRawMetaFile(
      JSON.stringify({
        sessionId: "doc",
        sessionName: "test",
        extraContext: null,
        sessionCwd: "/test",
        sessionTimestamp: "2024-01-01T00:00:00Z",
        messageCount: 0,
        retained: true,
        parentSessionId: 42,
      })
    );
    expect(readMetaFile(TEST_SESSION)).toBeNull();
  });

  it("accepts valid meta with optional fields", () => {
    writeRawMetaFile(
      JSON.stringify({
        sessionId: "doc",
        sessionName: "test",
        extraContext: "fiction",
        sessionCwd: "/test",
        sessionTimestamp: "2024-01-01T00:00:00Z",
        messageCount: 3,
        retained: false,
        sessionUserTags: ["tag1", "tag2"],
        parentSessionId: "parent-123",
      })
    );
    const result = readMetaFile(TEST_SESSION);
    expect(result).not.toBeNull();
    expect(result!.sessionUserTags).toEqual(["tag1", "tag2"]);
    expect(result!.parentSessionId).toBe("parent-123");
    expect(result!.extraContext).toBe("fiction");
  });

  it("accepts valid meta without optional fields", () => {
    writeRawMetaFile(validMeta);
    const result = readMetaFile(TEST_SESSION);
    expect(result).not.toBeNull();
    expect(result!.sessionUserTags).toEqual([]);
    expect(result!.parentSessionId).toBeUndefined();
    expect(result!.extraContext).toBeNull();
  });
});

describe("readMetaFileByPath", () => {
  const validMeta = JSON.stringify({
    sessionId: "doc-123",
    sessionName: "test session",
    extraContext: null,
    sessionUserTags: [],
    sessionCwd: "/home/user/project",
    sessionTimestamp: "2024-01-01T00:00:00Z",
    messageCount: 5,
    retained: true,
  });

  it("returns valid meta for well-formed file at arbitrary path", () => {
    const tmpPath = join(tmpdir(), `test-meta-by-path-${Date.now()}.json`);
    writeFileSync(tmpPath, validMeta, "utf-8");
    try {
      const result = readMetaFileByPath(tmpPath);
      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe("doc-123");
    } finally {
      rmSync(tmpPath, { force: true });
    }
  });

  it("returns null when file does not exist", () => {
    expect(readMetaFileByPath("/nonexistent/path.json")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    const tmpPath = join(tmpdir(), `test-meta-malformed-${Date.now()}.json`);
    writeFileSync(tmpPath, "{ invalid json", "utf-8");
    try {
      expect(readMetaFileByPath(tmpPath)).toBeNull();
    } finally {
      rmSync(tmpPath, { force: true });
    }
  });

  it("returns null for structurally invalid meta", () => {
    const tmpPath = join(tmpdir(), `test-meta-invalid-${Date.now()}.json`);
    writeFileSync(tmpPath, JSON.stringify({ sessionId: 123 }), "utf-8");
    try {
      expect(readMetaFileByPath(tmpPath)).toBeNull();
    } finally {
      rmSync(tmpPath, { force: true });
    }
  });
});
