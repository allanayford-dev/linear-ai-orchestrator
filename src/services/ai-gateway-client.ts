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
import { ProviderConfigurationError } from "./provider-errors.js";

interface ChatResponse {
  id?: string;
  choices?: Array<{ message?: { content?: string } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

interface ModelCatalog {
  data?: Array<{
    id: string;
    pricing?: { input?: string; output?: string };
  }>;
}

// Used only when the live catalog is unavailable. Values are USD/token and
// intentionally conservative for the configured models.
const FALLBACK_PRICING: Record<string, { inputPerToken: number; outputPerToken: number }> = {
  "zai/glm-4.7-flashx": { inputPerToken: 0.06 / 1_000_000, outputPerToken: 0.40 / 1_000_000 },
  "zai/glm-5.2": { inputPerToken: 3 / 1_000_000, outputPerToken: 10.25 / 1_000_000 },
};

export class VercelAiGatewayClient implements ModelClient {
  private catalog: { expiresAt: number; models: ModelCatalog["data"] } | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://ai-gateway.vercel.sh/v1",
  ) {}

  private async pricing(model: string): Promise<{ inputPerToken: number; outputPerToken: number } | null> {
    if (!this.catalog || this.catalog.expiresAt < Date.now()) {
      try {
        const response = await fetch(`${this.baseUrl}/models`, {
          headers: { Authorization: `Bearer ${this.apiKey}` },
        });
        if (response.ok) {
          const body = (await response.json()) as ModelCatalog;
          this.catalog = { expiresAt: Date.now() + 6 * 60 * 60 * 1000, models: body.data };
        }
      } catch {
        // A pricing lookup must never turn a successful, billable generation
        // into a retry. The conservative fallback below keeps cost accounting.
      }
    }
    const pricing = this.catalog?.models?.find((entry) => entry.id === model)?.pricing;
    if (!pricing?.input || !pricing.output) return FALLBACK_PRICING[model] ?? null;
    const inputPerToken = Number(pricing.input);
    const outputPerToken = Number(pricing.output);
    return Number.isFinite(inputPerToken) && Number.isFinite(outputPerToken)
      ? { inputPerToken, outputPerToken }
      : FALLBACK_PRICING[model] ?? null;
  }

  private async generate<T>(
    model: string,
    system: string,
    prompt: string,
    validate: (value: T) => T,
  ): Promise<ModelResult<T>> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "X-Vercel-AI-Gateway-User-Agent": "linear-ai-orchestrator/0.2.0",
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        max_tokens: 2500,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
      }),
    });
    const body = (await response.json()) as ChatResponse & { error?: { message?: string } };
    if (!response.ok) {
      const message = body.error?.message || `AI Gateway failed: ${response.status}`;
      let error: Error = new Error(message);
      if (response.status === 402) {
        error.name = "BudgetExceededError";
      } else if (
        response.status === 401 ||
        response.status === 403 ||
        /credit card|payment method|invalid api key|authentication/i.test(message)
      ) {
        error = new ProviderConfigurationError(
          message,
          "vercel-ai-gateway",
          response.status,
        );
      }
      throw error;
    }
    const rawText = body.choices?.[0]?.message?.content;
    if (!rawText) throw new Error("AI Gateway returned no text");
    const value = validate(parseJson<T>(rawText));
    const inputTokens = body.usage?.prompt_tokens ?? 0;
    const outputTokens = body.usage?.completion_tokens ?? 0;
    const pricing = await this.pricing(model);
    const estimatedCostMicros = pricing
      ? Math.round((inputTokens * pricing.inputPerToken + outputTokens * pricing.outputPerToken) * 1_000_000)
      : 0;
    return {
      value,
      rawText,
      providerRequestId: body.id ?? null,
      usage: {
        inputTokens,
        outputTokens,
        reasoningTokens: body.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
        totalTokens: body.usage?.total_tokens ?? inputTokens + outputTokens,
        estimatedCostMicros,
        pricing,
      },
    };
  }

  route(issue: LinearIssue, model: string): Promise<ModelResult<RouteDecision>> {
    return this.generate(
      model,
      routerSystem,
      routerPrompt(issue),
      ensureRoute,
    );
  }

  execute(issue: LinearIssue, route: RouteDecision, model: string): Promise<ModelResult<ExecutionResult>> {
    return this.generate(
      model,
      executorSystem,
      executorPrompt(issue, route),
      ensureExecution,
    );
  }
}
