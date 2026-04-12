/**
 * Hindsight client wrapper with timeout and error handling.
 */

import { HindsightClient, HindsightError, type RecallResponse, type Budget, type MemoryItemInput, type EntityInput } from "@vectorize-io/hindsight-client";
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
        signal!.removeEventListener("abort", abortHandler);
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
