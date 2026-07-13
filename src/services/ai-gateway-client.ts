import type {
  ExecutionResult,
  LinearIssue,
  ModelResult,
  RouteDecision,
} from "../types/worker.js";
import {
  ensureExecution,
  ensureRoute,
  executionJsonSchema,
  executorPrompt,
  executorSystem,
  parseJson,
  routeJsonSchema,
  routerPrompt,
  routerSystem,
  type ModelClient,
} from "./model-client.js";
import {
  ModelOutputError,
  ProviderConfigurationError,
  ProviderRequestError,
} from "./provider-errors.js";

interface ChatResponse {
  id?: string;
  choices?: Array<{ message?: { content?: string } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
    cost?: number | string;
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

function gatewayCostMicros(value: unknown): number | null {
  const dollars = typeof value === "string" ? Number(value) : value;
  return typeof dollars === "number" && Number.isFinite(dollars) && dollars >= 0
    ? Math.round(dollars * 1_000_000)
    : null;
}

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
    schemaName: string,
    responseJsonSchema: object,
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
        response_format: {
          type: "json_schema",
          json_schema: {
            name: schemaName,
            schema: responseJsonSchema,
          },
        },
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
      } else if (
        response.status === 400 ||
        response.status === 404 ||
        response.status === 422
      ) {
        error = new ProviderRequestError(
          message,
          "vercel-ai-gateway",
          response.status,
        );
      }
      throw error;
    }
    const rawText = body.choices?.[0]?.message?.content?.trim() ?? "";
    const inputTokens = body.usage?.prompt_tokens ?? 0;
    const outputTokens = body.usage?.completion_tokens ?? 0;
    const responseCostMicros = gatewayCostMicros(body.usage?.cost);
    const pricing = responseCostMicros === null ? await this.pricing(model) : null;
    const estimatedCostMicros = responseCostMicros ?? (pricing
      ? Math.round((inputTokens * pricing.inputPerToken + outputTokens * pricing.outputPerToken) * 1_000_000)
      : 0);
    const result = {
      rawText,
      providerRequestId: body.id ?? null,
      usage: {
        inputTokens,
        outputTokens,
        reasoningTokens: body.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
        totalTokens: body.usage?.total_tokens ?? inputTokens + outputTokens,
        estimatedCostMicros,
        costSource: responseCostMicros === null
          ? "model-catalog" as const
          : "gateway-response" as const,
        pricing,
      },
    };
    try {
      if (!rawText) throw new Error("AI Gateway returned no text");
      return { ...result, value: validate(parseJson<T>(rawText)) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ModelOutputError(
        `AI Gateway returned invalid structured output: ${message}`,
        "vercel-ai-gateway",
        model,
        result,
      );
    }
  }

  route(issue: LinearIssue, model: string): Promise<ModelResult<RouteDecision>> {
    return this.generate(
      model,
      routerSystem,
      routerPrompt(issue),
      "linear_route_decision",
      routeJsonSchema,
      ensureRoute,
    );
  }

  execute(issue: LinearIssue, route: RouteDecision, model: string): Promise<ModelResult<ExecutionResult>> {
    return this.generate(
      model,
      executorSystem,
      executorPrompt(issue, route),
      "linear_execution_result",
      executionJsonSchema,
      ensureExecution,
    );
  }
}
