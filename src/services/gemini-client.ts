import { ApiError, GoogleGenAI } from "@google/genai";
import type {
  ExecutionResult,
  LinearIssue,
  ModelResult,
  RouteDecision,
} from "../types/worker.js";
import {
  ensureExecution,
  ensureRoute,
  executorPrompt,
  executorSystem,
  parseJson,
  routerPrompt,
  routerSystem,
  type ModelClient,
} from "./model-client.js";
import {
  ProviderConfigurationError,
  RetryableProviderError,
} from "./provider-errors.js";

interface GeminiResponse {
  text?: string;
  responseId?: string;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
}

interface GeminiModels {
  generateContent(input: {
    model: string;
    contents: string;
    config: {
      systemInstruction: string;
      temperature: number;
      maxOutputTokens: number;
      responseMimeType: string;
      responseJsonSchema: object;
    };
  }): Promise<GeminiResponse>;
}

const routeSchema = {
  type: "object",
  required: ["complexity", "outcome", "reason"],
  properties: {
    complexity: { type: "string", enum: ["simple", "complex"] },
    outcome: { type: "string", enum: ["execute", "needs_human"] },
    reason: { type: "string" },
    humanAction: { type: "string" },
  },
};

const executionSchema = {
  type: "object",
  required: ["outcome", "summary", "result", "verification"],
  properties: {
    outcome: { type: "string", enum: ["ready_for_review", "needs_human"] },
    summary: { type: "string" },
    result: { type: "string" },
    verification: { type: "array", items: { type: "string" } },
    humanAction: { type: "string" },
  },
};

function mapError(error: unknown): Error {
  if (!(error instanceof ApiError)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  const status = error.status;
  if (status === 401 || status === 403) {
    return new ProviderConfigurationError(error.message, "google-gemini", status);
  }
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
    return new RetryableProviderError(error.message, "google-gemini", status);
  }
  return error;
}

export class GeminiClient implements ModelClient {
  private readonly models: GeminiModels;

  constructor(apiKey: string, models?: GeminiModels) {
    this.models = models ?? (new GoogleGenAI({ apiKey }).models as unknown as GeminiModels);
  }

  private async generate<T>(
    model: string,
    systemInstruction: string,
    prompt: string,
    responseJsonSchema: object,
    validate: (value: T) => T,
  ): Promise<ModelResult<T>> {
    let response: GeminiResponse;
    try {
      response = await this.models.generateContent({
        model,
        contents: prompt,
        config: {
          systemInstruction,
          temperature: 0.1,
          maxOutputTokens: 2500,
          responseMimeType: "application/json",
          responseJsonSchema,
        },
      });
    } catch (error) {
      throw mapError(error);
    }

    const rawText = response.text?.trim();
    if (!rawText) throw new Error("Gemini returned no text");
    const usage = response.usageMetadata;
    const inputTokens = usage?.promptTokenCount ?? 0;
    const reasoningTokens = usage?.thoughtsTokenCount ?? 0;
    const outputTokens = usage?.candidatesTokenCount ?? 0;
    return {
      value: validate(parseJson<T>(rawText)),
      rawText,
      providerRequestId: response.responseId ?? null,
      usage: {
        inputTokens,
        outputTokens,
        reasoningTokens,
        totalTokens:
          usage?.totalTokenCount ?? inputTokens + outputTokens + reasoningTokens,
        estimatedCostMicros: 0,
        pricing: { inputPerToken: 0, outputPerToken: 0 },
      },
    };
  }

  route(issue: LinearIssue, model: string): Promise<ModelResult<RouteDecision>> {
    return this.generate(
      model,
      routerSystem,
      routerPrompt(issue),
      routeSchema,
      ensureRoute,
    );
  }

  execute(
    issue: LinearIssue,
    route: RouteDecision,
    model: string,
  ): Promise<ModelResult<ExecutionResult>> {
    return this.generate(
      model,
      executorSystem,
      executorPrompt(issue, route),
      executionSchema,
      ensureExecution,
    );
  }
}
