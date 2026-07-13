import { ApiError } from "@google/genai";
import { describe, expect, it, vi } from "vitest";
import type { LinearIssue } from "../types/worker.js";
import { GeminiClient } from "./gemini-client.js";

const issue: LinearIssue = {
  id: "issue-1",
  identifier: "ALL-1",
  title: "Summarize the pilot",
  description: "Prepare a concise summary.",
  url: "https://linear.app/issue/ALL-1",
  state: { id: "todo", name: "Todo" },
  team: { id: "team-1", states: [] },
  project: { id: "project-1", name: "Pilot" },
  labels: [],
};

describe("GeminiClient", () => {
  it("returns validated structured output with free-tier token usage", async () => {
    const generateContent = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        complexity: "simple",
        outcome: "execute",
        reason: "Small text task",
      }),
      responseId: "gemini-request-1",
      usageMetadata: {
        promptTokenCount: 20,
        candidatesTokenCount: 10,
        thoughtsTokenCount: 5,
        totalTokenCount: 35,
      },
    });
    const client = new GeminiClient("test-key", { generateContent });

    const result = await client.route(issue, "gemini-3.1-flash-lite");

    expect(result.value).toMatchObject({ complexity: "simple", outcome: "execute" });
    expect(result.providerRequestId).toBe("gemini-request-1");
    expect(result.usage).toEqual({
      inputTokens: 20,
      outputTokens: 10,
      reasoningTokens: 5,
      totalTokens: 35,
      estimatedCostMicros: 0,
      costSource: "free-tier",
      pricing: { inputPerToken: 0, outputPerToken: 0 },
    });
    expect(generateContent).toHaveBeenCalledWith(expect.objectContaining({
      model: "gemini-3.1-flash-lite",
      config: expect.objectContaining({ responseMimeType: "application/json" }),
    }));
  });

  it("marks quota exhaustion as eligible for a paid fallback", async () => {
    const generateContent = vi.fn().mockRejectedValue(
      new ApiError({ status: 429, message: "Quota exhausted" }),
    );
    const client = new GeminiClient("test-key", { generateContent });

    await expect(client.route(issue, "gemini-3.1-flash-lite")).rejects.toMatchObject({
      name: "RetryableProviderError",
      provider: "google-gemini",
      status: 429,
    });
  });
});
