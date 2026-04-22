/**
 * Unit tests for HindsightClientWrapper.
 * Covers healthCheck, retain, retainBatch, recall, reflect, withTimeout, and formatError.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { HindsightError } from "@vectorize-io/hindsight-client";
import { HindsightClientWrapper } from "../src/client";
import { testConfig } from "./fixtures";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = mock() as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/**
 * Helper: create a fetch mock that respects AbortSignal.
 */
function createAbortAwareFetch(resolveWith?: object) {
  return mock((_url: string, options?: { signal?: AbortSignal }) => {
    const signal = options?.signal;

    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        reject(error);
        return;
      }

      if (signal) {
        const onAbort = () => {
          const error = new Error("The operation was aborted");
          error.name = "AbortError";
          reject(error);
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }

      if (resolveWith) {
        resolve(resolveWith);
      }
    });
  });
}

/**
 * Helper: mock the internal HindsightClient methods on a wrapper instance.
 * Returns the original methods so they can be restored after the test.
 */
function mockSdkMethods(client: HindsightClientWrapper) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdk = (client as any).client;
  const origRetainBatch = sdk.retainBatch.bind(sdk);
  const origRecall = sdk.recall.bind(sdk);
  const origReflect = sdk.reflect.bind(sdk);
  return { sdk, origRetainBatch, origRecall, origReflect };
}

// ============================================
// healthCheck
// ============================================

describe("healthCheck", () => {
  it("returns { success: true } when server responds with OK", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof mock>).mockImplementationOnce(
      createAbortAwareFetch({ ok: true, status: 200 })
    );

    const client = new HindsightClientWrapper(testConfig);
    const result = await client.healthCheck();

    expect(result).toEqual({ success: true });
  });

  it("returns { success: false, error: 'HTTP 500' } for non-OK response", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof mock>).mockImplementationOnce(
      createAbortAwareFetch({ ok: false, status: 500 })
    );

    const client = new HindsightClientWrapper(testConfig);
    const result = await client.healthCheck();

    expect(result).toEqual({ success: false, error: "HTTP 500" });
  });

  it("returns { success: false, error: 'Operation timed out...' } when timeout fires", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof mock>).mockImplementationOnce(
      createAbortAwareFetch()
    );

    const client = new HindsightClientWrapper(testConfig);
    const result = await client.healthCheck(undefined, 100);

    expect(result).toEqual({ success: false, error: "Operation timed out after 100ms" });
  });

  it("returns { success: false, error: 'Operation cancelled' } when signal is aborted", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof mock>).mockImplementationOnce(
      createAbortAwareFetch()
    );

    const client = new HindsightClientWrapper(testConfig);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    const result = await client.healthCheck(controller.signal, 5000);
    expect(result).toEqual({ success: false, error: "Operation cancelled" });
  });

  it("returns { success: false, error: 'Operation cancelled' } when signal is already aborted", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof mock>).mockImplementationOnce(
      createAbortAwareFetch()
    );

    const client = new HindsightClientWrapper(testConfig);
    const controller = new AbortController();
    controller.abort();

    const result = await client.healthCheck(controller.signal, 5000);
    expect(result).toEqual({ success: false, error: "Operation cancelled" });
  });

  it("returns network error message on fetch failure", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof mock>).mockRejectedValueOnce(
      new TypeError("fetch failed")
    );

    const client = new HindsightClientWrapper(testConfig);
    const result = await client.healthCheck();

    expect(result.success).toBe(false);
    expect(result.error).toBe("fetch failed");
  });

  it("cleans up abort listener after success", async () => {
    const removeEventListenerSpy = mock();
    const signal = {
      aborted: false,
      addEventListener: mock(),
      removeEventListener: removeEventListenerSpy,
    } as unknown as AbortSignal;

    (globalThis.fetch as unknown as ReturnType<typeof mock>).mockResolvedValueOnce({
      ok: true,
      status: 200,
    });

    const client = new HindsightClientWrapper(testConfig);
    await client.healthCheck(signal);

    expect(removeEventListenerSpy).toHaveBeenCalledTimes(1);
  });

  it("cleans up abort listener after error", async () => {
    const removeEventListenerSpy = mock();
    const signal = {
      aborted: false,
      addEventListener: mock(),
      removeEventListener: removeEventListenerSpy,
    } as unknown as AbortSignal;

    (globalThis.fetch as unknown as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error("network error")
    );

    const client = new HindsightClientWrapper(testConfig);
    await client.healthCheck(signal);

    expect(removeEventListenerSpy).toHaveBeenCalledTimes(1);
  });
});

// ============================================
// retain
// ============================================

describe("retain", () => {
  it("returns { success: true } on successful retain", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origRetainBatch } = mockSdkMethods(client);
    sdk.retainBatch = mock(() =>
      Promise.resolve({ results: [{ documentId: "doc1", status: "ok" }] })
    );

    const result = await client.retain({
      content: "Test content",
      tags: ["test"],
      documentId: "test-doc",
      updateMode: "replace",
    });

    expect(result.success).toBe(true);
    expect(sdk.retainBatch).toHaveBeenCalled();
    sdk.retainBatch = origRetainBatch;
  });

  it("returns error on retain failure", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origRetainBatch } = mockSdkMethods(client);
    sdk.retainBatch = mock(() => Promise.reject(new Error("retain failed")));

    const result = await client.retain({ content: "Test content" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("retain failed");
    sdk.retainBatch = origRetainBatch;
  });

  it("returns error on timeout", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origRetainBatch } = mockSdkMethods(client);
    sdk.retainBatch = mock(() => new Promise(() => {}));

    const result = await client.retain({ content: "Test content" }, undefined, 50);

    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
    sdk.retainBatch = origRetainBatch;
  });
});

// ============================================
// retainBatch
// ============================================

describe("retainBatch", () => {
  it("returns { success: true } on success", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origRetainBatch } = mockSdkMethods(client);
    sdk.retainBatch = mock(() =>
      Promise.resolve({ results: [{ documentId: "doc1", status: "ok" }] })
    );

    const result = await client.retainBatch([]);

    expect(result.success).toBe(true);
    sdk.retainBatch = origRetainBatch;
  });

  it("returns error on failure", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origRetainBatch } = mockSdkMethods(client);
    sdk.retainBatch = mock(() => Promise.reject(new Error("batch failed")));

    const result = await client.retainBatch([]);

    expect(result.success).toBe(false);
    expect(result.error).toContain("batch failed");
    sdk.retainBatch = origRetainBatch;
  });
});

// ============================================
// recall
// ============================================

describe("recall", () => {
  it("returns { success: true, response } on success", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origRecall } = mockSdkMethods(client);
    const mockResponse = { results: [{ id: "1", text: "Memory" }] };
    sdk.recall = mock(() => Promise.resolve(mockResponse));

    const result = await client.recall({ query: "test query" });

    expect(result.success).toBe(true);
    expect(result.response).toEqual(mockResponse);
    sdk.recall = origRecall;
  });

  it("passes config defaults for budget and maxTokens", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origRecall } = mockSdkMethods(client);
    sdk.recall = mock(() => Promise.resolve({ results: [] }));

    await client.recall({ query: "test" });

    expect(sdk.recall).toHaveBeenCalled();
    const callOpts = (sdk.recall as unknown as ReturnType<typeof mock>).mock.calls[0]![2];
    expect(callOpts.budget).toBe("mid");
    sdk.recall = origRecall;
  });

  it("returns error on failure", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origRecall } = mockSdkMethods(client);
    sdk.recall = mock(() => Promise.reject(new Error("recall failed")));

    const result = await client.recall({ query: "test" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("recall failed");
    sdk.recall = origRecall;
  });

  it("returns error on timeout", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origRecall } = mockSdkMethods(client);
    sdk.recall = mock(() => new Promise(() => {}));

    const result = await client.recall({ query: "test" }, undefined, 50);

    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
    sdk.recall = origRecall;
  });

  it("returns error on abort", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origRecall } = mockSdkMethods(client);
    sdk.recall = mock(() => new Promise(() => {}));

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    const result = await client.recall({ query: "test" }, controller.signal, 5000);

    expect(result.success).toBe(false);
    expect(result.error).toContain("cancelled");
    sdk.recall = origRecall;
  });
});

// ============================================
// reflect
// ============================================

describe("reflect", () => {
  it("returns { success: true, response } on success", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origReflect } = mockSdkMethods(client);
    const mockResponse = { text: "Based on memories..." };
    sdk.reflect = mock(() => Promise.resolve(mockResponse));

    const result = await client.reflect({ query: "test query" });

    expect(result.success).toBe(true);
    expect(result.response).toEqual(mockResponse);
    sdk.reflect = origReflect;
  });

  it("does not override budget with config default (unlike recall)", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origReflect } = mockSdkMethods(client);
    sdk.reflect = mock(() => Promise.resolve({ text: "result" }));

    await client.reflect({ query: "test" });

    expect(sdk.reflect).toHaveBeenCalled();
    const callOpts = (sdk.reflect as unknown as ReturnType<typeof mock>).mock.calls[0]![2];
    expect(callOpts.budget).toBeUndefined();
    sdk.reflect = origReflect;
  });

  it("returns error on failure", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origReflect } = mockSdkMethods(client);
    sdk.reflect = mock(() => Promise.reject(new Error("reflect failed")));

    const result = await client.reflect({ query: "test" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("reflect failed");
    sdk.reflect = origReflect;
  });

  it("returns error on timeout", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origReflect } = mockSdkMethods(client);
    sdk.reflect = mock(() => new Promise(() => {}));

    const result = await client.reflect({ query: "test" }, undefined, 50);

    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
    sdk.reflect = origReflect;
  });
});

// ============================================
// formatError (tested indirectly via failures above + directly here)
// ============================================

describe("formatError", () => {
  it("formats HindsightError with status code and bank info", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origRetainBatch } = mockSdkMethods(client);
    const hindsightErr = new HindsightError("API error", 429);
    sdk.retainBatch = mock(() => Promise.reject(hindsightErr));

    const result = await client.retain({ content: "test" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("API error");
    expect(result.error).toContain("429");
    expect(result.error).toContain("test-bank");
    sdk.retainBatch = origRetainBatch;
  });

  it("formats non-Error values with bank info", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origRetainBatch } = mockSdkMethods(client);
    sdk.retainBatch = mock(() => Promise.reject("string error"));

    const result = await client.retain({ content: "test" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("string error");
    expect(result.error).toContain("test-bank");
    sdk.retainBatch = origRetainBatch;
  });

  it("formats 'Operation aborted' as 'Operation cancelled'", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origRetainBatch } = mockSdkMethods(client);
    sdk.retainBatch = mock(() => Promise.reject(new Error("Operation aborted")));

    const result = await client.retain({ content: "test" });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Operation cancelled");
    sdk.retainBatch = origRetainBatch;
  });
});

// ============================================
// withTimeout (tested indirectly via timeout tests above + directly here)
// ============================================

describe("withTimeout", () => {
  it("resolves before timeout", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origRecall } = mockSdkMethods(client);
    sdk.recall = mock(() => Promise.resolve({ results: [] }));

    const result = await client.recall({ query: "fast" }, undefined, 5000);

    expect(result.success).toBe(true);
    sdk.recall = origRecall;
  });

  it("rejects with timeout when promise hangs", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origRecall } = mockSdkMethods(client);
    sdk.recall = mock(() => new Promise(() => {}));

    const result = await client.recall({ query: "slow" }, undefined, 50);

    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
    sdk.recall = origRecall;
  });

  it("rejects immediately when signal is already aborted", async () => {
    const client = new HindsightClientWrapper(testConfig);
    const { sdk, origRecall } = mockSdkMethods(client);
    sdk.recall = mock(() => new Promise(() => {}));

    const controller = new AbortController();
    controller.abort();

    const result = await client.recall({ query: "test" }, controller.signal, 5000);

    expect(result.success).toBe(false);
    expect(result.error).toContain("cancelled");
    sdk.recall = origRecall;
  });
});
