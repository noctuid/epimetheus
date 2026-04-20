/**
 * Hindsight client wrapper with timeout and error handling.
 */

import {
  type Budget,
  type EntityInput,
  HindsightClient,
  HindsightError,
  type MemoryItemInput,
  type RecallResponse,
  type ReflectResponse,
} from "@vectorize-io/hindsight-client";
import type { HindsightConfig } from "./config";

export interface RetainOptions {
  content: string;
  timestamp?: string;
  context?: string;
  tags?: string[];
  metadata?: Record<string, string>;
  documentId?: string;
  updateMode?: "replace" | "append";
  entities?: EntityInput[];
}

export interface RecallOptions {
  query: string;
  tags?: string[];
  tagsMatch?: "any" | "all" | "any_strict" | "all_strict";
  types?: ("world" | "experience" | "observation")[];
  budget?: Budget;
  maxTokens?: number | null;
}

export interface ReflectOptions {
  query: string;
  /** Filter memories by tags during reflection. If not specified, all memories are considered. */
  tags?: string[];
  /** How to match tags: 'any' (OR, includes untagged), 'all' (AND, includes untagged), 'any_strict' (OR, excludes untagged), 'all_strict' (AND, excludes untagged). Default: 'any'. */
  tagsMatch?: "any" | "all" | "any_strict" | "all_strict";
  /** Budget level controlling how much effort to spend on retrieval and reasoning: 'low', 'mid', or 'high'.
   *  Default: 'low' (per Hindsight SDK). Reflect runs an agentic loop with up to 10 iterations
   *  of multi-tool search + LLM calls, so it is substantially slower than recall even at low budget. */
  budget?: Budget;
  // Not currently exposed (simplified HindsightClient wrapper doesn't support these;
  // the underlying ReflectRequest API supports fact_types, exclude_mental_models,
  // exclude_mental_model_ids, tag_groups, max_tokens, include, response_schema):
  // - fact_types / exclude_mental_models: can be added if the client SDK is updated
  //   or when switching to the generated SDK directly
  // - max_tokens: not currently configurable (default 4096 output)
  // - response_schema: not adding for now as structured output seems less useful
  //   for coding agent integration
  // - include: can be added later if needed (for trace, facts, chunks, etc.)
}

export class HindsightClientWrapper {
  private client: HindsightClient;
  private config: HindsightConfig;

  constructor(config: HindsightConfig) {
    this.config = config;
    this.client = new HindsightClient({
      baseUrl: config.apiUrl,
      apiKey: config.apiKey,
    });
  }

  /**
   * Check server health by pinging the health endpoint.
   */
  async healthCheck(
    signal?: AbortSignal,
    timeoutMs: number = 5000
  ): Promise<{ success: boolean; error?: string }> {
    const controller = new AbortController();
    let timedOut = false;

    // Chain external abort signal
    let abortHandler: (() => void) | undefined;
    if (signal) {
      if (signal.aborted) {
        controller.abort();
      } else {
        abortHandler = () => controller.abort();
        signal.addEventListener("abort", abortHandler);
      }
    }

    try {
      const timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);

      const response = await fetch(`${this.config.apiUrl}/health`, {
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      if (response.ok) {
        return { success: true };
      }
      return { success: false, error: `HTTP ${response.status}` };
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        if (timedOut) {
          return { success: false, error: `Operation timed out after ${timeoutMs}ms` };
        }
        return { success: false, error: "Operation cancelled" };
      }
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      if (abortHandler) {
        signal?.removeEventListener("abort", abortHandler);
      }
    }
  }

  /**
   * Retain content with timeout and optional abort signal.
   */
  async retain(
    options: RetainOptions,
    signal?: AbortSignal,
    timeoutMs: number = 30000
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await this.withTimeout(
        this.client.retain(this.config.bankId, options.content, {
          timestamp: options.timestamp ? new Date(options.timestamp) : undefined,
          context: options.context,
          tags: options.tags,
          metadata: options.metadata,
          documentId: options.documentId,
          updateMode: options.updateMode,
          entities: options.entities,
          async: true,
        }),
        timeoutMs,
        signal
      );

      return { success: true };
    } catch (e) {
      return { success: false, error: this.formatError(e) };
    }
  }

  /**
   * Retain multiple items in batch with timeout and optional abort signal.
   */
  async retainBatch(
    items: MemoryItemInput[],
    signal?: AbortSignal,
    timeoutMs: number = 30000
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await this.withTimeout(
        this.client.retainBatch(this.config.bankId, items, {
          async: true,
        }),
        timeoutMs,
        signal
      );

      return { success: true };
    } catch (e) {
      return { success: false, error: this.formatError(e) };
    }
  }

  /**
   * Recall memories with timeout and optional abort signal.
   */
  async recall(
    options: RecallOptions,
    signal?: AbortSignal,
    timeoutMs: number = 10000
  ): Promise<{ success: boolean; response?: RecallResponse; error?: string }> {
    try {
      const result = await this.withTimeout(
        this.client.recall(this.config.bankId, options.query, {
          tags: options.tags,
          tagsMatch: options.tagsMatch,
          types: options.types,
          budget: options.budget ?? this.config.autoRecallBudget,
          maxTokens: options.maxTokens ?? this.config.maxRecallTokens ?? undefined,
          includeEntities: true,
        }),
        timeoutMs,
        signal
      );

      return { success: true, response: result };
    } catch (e) {
      return { success: false, error: this.formatError(e) };
    }
  }

  /**
   * Reflect and generate a contextual answer using the bank's identity and memories.
   */
  async reflect(
    options: ReflectOptions,
    signal?: AbortSignal,
    timeoutMs: number = 90000
  ): Promise<{ success: boolean; response?: ReflectResponse; error?: string }> {
    try {
      // Note: unlike recall, we don't fall back to autoRecallBudget (which defaults to 'mid').
      // The Hindsight SDK defaults reflect budget to 'low' since reflect is much more expensive
      // (agentic loop with up to 10 iterations of multi-tool search + LLM calls).
      // Only override when the user explicitly sets a budget.
      const result = await this.withTimeout(
        this.client.reflect(this.config.bankId, options.query, {
          tags: options.tags,
          tagsMatch: options.tagsMatch,
          budget: options.budget,
        }),
        timeoutMs,
        signal
      );

      return { success: true, response: result };
    } catch (e) {
      return { success: false, error: this.formatError(e) };
    }
  }

  /**
   * Wrap a promise with a timeout and optional abort signal.
   */
  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      // Check if already aborted
      if (signal?.aborted) {
        reject(new Error("Operation aborted"));
        return;
      }

      // Handle abort signal
      const abortHandler = () => {
        signal?.removeEventListener("abort", abortHandler);
        clearTimeout(timer);
        reject(new Error("Operation aborted"));
      };

      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", abortHandler);
        reject(new Error(`Operation timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      signal?.addEventListener("abort", abortHandler);

      promise
        .then((result) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abortHandler);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abortHandler);
          reject(error);
        });
    });
  }

  /**
   * Format error with details from HindsightError.
   */
  private formatError(e: unknown): string {
    if (e instanceof Error && e.message === "Operation aborted") {
      return "Operation cancelled";
    }
    if (e instanceof HindsightError) {
      // Message already includes details from validateResponse, just add status code and context
      const parts = [e.message];
      if (e.statusCode) parts.push(`(status ${e.statusCode})`);
      parts.push(`[bank=${this.config.bankId} url=${this.config.apiUrl}]`);
      return parts.join(" ");
    }
    return `${String(e)} [bank=${this.config.bankId} url=${this.config.apiUrl}]`;
  }
}
