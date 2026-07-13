import { createHash } from "node:crypto";
import type { WorkerConfig } from "../config/worker-env.js";
import type {
  GenerationContext,
  WorkerRepository,
} from "../repositories/worker-repository.js";
import type {
  ExecutionResult,
  LinearIssue,
  ModelProvider,
  ModelResult,
  ModelRole,
  PricingTier,
  RouteDecision,
  WorkEvent,
} from "../types/worker.js";
import type { LinearClient } from "./linear-client.js";
import type { ModelClient } from "./model-client.js";
import {
  ModelOutputError,
  ProviderConfigurationError,
  ProviderRequestError,
  RetryableProviderError,
} from "./provider-errors.js";

export interface WorkerOutcome {
  outcome: "ignored" | "duplicate" | "busy" | "needs_action" | "in_review";
  reason?: string;
}

interface AttemptSpec {
  provider: ModelProvider;
  model: string;
  pricingTier: PricingTier;
  client: ModelClient;
}

interface ModelCall {
  provider: ModelProvider;
  model: string;
  pricingTier: PricingTier;
  attempt: number;
  result: ModelResult<unknown>;
}

function modelCall<T>(
  spec: AttemptSpec,
  attempt: number,
  result: ModelResult<T>,
): ModelCall & { result: ModelResult<T> } {
  return {
    provider: spec.provider,
    model: spec.model,
    pricingTier: spec.pricingTier,
    attempt,
    result,
  };
}

function generationId(
  deliveryId: string,
  role: ModelRole,
  attempt: number,
  provider: ModelProvider,
  model: string,
): string {
  return createHash("sha256")
    .update(`${deliveryId}:${role}:${attempt}:${provider}:${model}`)
    .digest("hex");
}

function issueIdFrom(event: WorkEvent): string | null {
  const id = event.payload.data.id;
  return typeof id === "string" && id ? id : null;
}

function usageLine(results: ModelCall[]): string {
  const tokens = results.reduce(
    (sum, item) => sum + item.result.usage.totalTokens,
    0,
  );
  const micros = results.reduce(
    (sum, item) => sum + item.result.usage.estimatedCostMicros,
    0,
  );
  const models = [...new Set(results.map(
    (item) => `${item.provider}/${item.model} (${item.pricingTier})`,
  ))].join(", ");
  return `Models: ${models} · Tokens: ${tokens} · Estimated AI cost: $${(micros / 1_000_000).toFixed(6)}`;
}

export class OrchestratorWorkerService {
  constructor(
    private readonly config: WorkerConfig,
    private readonly repository: WorkerRepository,
    private readonly linear: LinearClient,
    private readonly gemini: ModelClient,
    private readonly paidAi: ModelClient,
  ) {}

  private context(
    issue: LinearIssue,
    deliveryId: string,
    role: ModelRole,
    attempt: number,
    spec: AttemptSpec,
  ): GenerationContext {
    return {
      generationId: generationId(
        deliveryId,
        role,
        attempt,
        spec.provider,
        spec.model,
      ),
      taskId: issue.id,
      issueIdentifier: issue.identifier,
      projectId: issue.project?.id ?? "unassigned",
      projectName: issue.project?.name ?? "Unassigned",
      provider: spec.provider,
      model: spec.model,
      pricingTier: spec.pricingTier,
      role,
      attempt,
      deliveryId,
    };
  }

  private async generate<T>(
    context: GenerationContext,
    call: () => Promise<ModelResult<T>>,
  ): Promise<ModelResult<T>> {
    const cached = await this.repository.getCompletedGeneration<T>(
      context.generationId,
    );
    if (cached) return cached;
    await this.repository.assertWithinBudget(
      context.taskId,
      context.projectId,
      this.config.maxTaskCostMicros,
      this.config.maxProjectMonthlyCostMicros,
      this.config.maxTaskTokens,
    );
    await this.repository.startGeneration(context);
    try {
      const result = await call();
      await this.repository.completeGeneration(context, result);
      return result;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      await this.repository.failGeneration(
        context,
        failure,
        failure instanceof ModelOutputError ? failure.result : undefined,
      );
      throw failure;
    }
  }

  private async generateWithFallback<T>(
    issue: LinearIssue,
    deliveryId: string,
    role: ModelRole,
    primary: AttemptSpec,
    fallback: AttemptSpec | null,
    call: (client: ModelClient, model: string) => Promise<ModelResult<T>>,
  ): Promise<ModelCall & { result: ModelResult<T> }> {
    const primaryContext = this.context(issue, deliveryId, role, 1, primary);
    const fallbackContext = fallback
      ? this.context(issue, deliveryId, role, 2, fallback)
      : null;

    if (fallbackContext && fallback) {
      const cachedFallback = await this.repository.getCompletedGeneration<T>(
        fallbackContext.generationId,
      );
      if (cachedFallback) {
        return modelCall(fallback, 2, cachedFallback);
      }
    }
    const cachedPrimary = await this.repository.getCompletedGeneration<T>(
      primaryContext.generationId,
    );
    if (cachedPrimary) {
      return modelCall(primary, 1, cachedPrimary);
    }

    try {
      const result = await this.generate(
        primaryContext,
        () => call(primary.client, primary.model),
      );
      return modelCall(primary, 1, result);
    } catch (error) {
      if (
        !(error instanceof RetryableProviderError) ||
        !fallback ||
        !fallbackContext
      ) {
        throw error;
      }
      const result = await this.generate(
        fallbackContext,
        () => call(fallback.client, fallback.model),
      );
      return modelCall(fallback, 2, result);
    }
  }

  private geminiEligible(issue: LinearIssue): boolean {
    if (!issue.project || this.config.geminiAllowedProjects.length === 0) {
      return false;
    }
    const allowed = new Set(
      this.config.geminiAllowedProjects.map((value) => value.toLowerCase()),
    );
    const projectAllowed =
      allowed.has(issue.project.id.toLowerCase()) ||
      allowed.has(issue.project.name.toLowerCase());
    if (!projectAllowed) return false;

    const sensitive = new Set(
      this.config.geminiSensitiveLabels.map((value) => value.toLowerCase()),
    );
    return !issue.labels.some((label) => sensitive.has(label.name.toLowerCase()));
  }

  private async handOff(
    issue: LinearIssue,
    deliveryId: string,
    reason: string,
    action: string,
    usage?: string,
  ): Promise<WorkerOutcome> {
    await this.linear.addComment(
      issue.id,
      [
        "## Orchestrator handoff",
        "",
        reason,
        "",
        `**Action needed:** ${action}`,
        ...(usage ? ["", usage] : []),
      ].join("\n"),
    );
    await this.linear.moveIssue(issue, this.config.states.needsAction);
    await this.repository.completeTask(issue.id, deliveryId, "needs_action", {
      handoffReason: reason,
      requestedAction: action,
      linearState: this.config.states.needsAction,
    });
    return { outcome: "needs_action", reason };
  }

  async handle(event: WorkEvent): Promise<WorkerOutcome> {
    if (event.source !== "linear" || event.payload.type !== "Issue") {
      return { outcome: "ignored", reason: "Not a Linear issue event" };
    }
    const issueId = issueIdFrom(event);
    if (!issueId || event.payload.action === "remove") {
      return { outcome: "ignored", reason: "No actionable issue" };
    }

    const issue = await this.linear.getIssue(issueId);
    const currentState = issue.state.name.toLowerCase();
    const isTodo = currentState === this.config.states.todo.toLowerCase();
    const isInProgress =
      currentState === this.config.states.inProgress.toLowerCase();
    if (!isTodo && !isInProgress) {
      return { outcome: "ignored", reason: `Current state is ${issue.state.name}` };
    }

    const claim = await this.repository.claim(
      issue,
      event.deliveryId,
      this.config.leaseSeconds,
      isTodo,
    );
    if (claim !== "claimed") return { outcome: claim };

    try {
      if (isTodo) {
        await this.linear.moveIssue(issue, this.config.states.inProgress);
      }
      const calls: ModelCall[] = [];
      const paidRouter: AttemptSpec = {
        provider: "vercel-ai-gateway",
        model: this.config.routerModel,
        pricingTier: "paid",
        client: this.paidAi,
      };
      const gemini: AttemptSpec = {
        provider: "google-gemini",
        model: this.config.geminiModel,
        pricingTier: "free",
        client: this.gemini,
      };
      const useGemini = this.geminiEligible(issue);
      const routed = await this.generateWithFallback<RouteDecision>(
        issue,
        event.deliveryId,
        "router",
        useGemini ? gemini : paidRouter,
        useGemini ? paidRouter : null,
        (client, model) => client.route(issue, model),
      );
      calls.push(routed);

      if (routed.result.value.outcome === "needs_human") {
        return this.handOff(
          issue,
          event.deliveryId,
          routed.result.value.reason,
          routed.result.value.humanAction ||
            "Add the missing information or approval, then move the issue back to Todo.",
          usageLine(calls),
        );
      }

      const isComplex = routed.result.value.complexity === "complex";
      const geminiAvailable = useGemini && routed.provider === "google-gemini";
      const paidExecutor: AttemptSpec = {
        provider: "vercel-ai-gateway",
        model: isComplex ? this.config.executorModel : this.config.routerModel,
        pricingTier: "paid",
        client: this.paidAi,
      };
      const executed = await this.generateWithFallback<ExecutionResult>(
        issue,
        event.deliveryId,
        "executor",
        !isComplex && geminiAvailable ? gemini : paidExecutor,
        !isComplex && geminiAvailable ? paidExecutor : null,
        (client, model) => client.execute(issue, routed.result.value, model),
      );
      calls.push(executed);

      if (executed.result.value.outcome === "needs_human") {
        return this.handOff(
          issue,
          event.deliveryId,
          executed.result.value.summary,
          executed.result.value.humanAction ||
            "Complete the external action, then move the issue back to Todo.",
          usageLine(calls),
        );
      }

      const verification = executed.result.value.verification.length
        ? executed.result.value.verification
          .map((item) => `- ${item}`)
          .join("\n")
        : "- Review the proposed result against the acceptance criteria.";
      await this.linear.addComment(issue.id, [
        "## Orchestrator result",
        "",
        executed.result.value.summary,
        "",
        executed.result.value.result,
        "",
        "### Verification",
        verification,
        "",
        usageLine(calls),
        "",
        "This is a candidate result awaiting human review; the worker has not marked the issue Done.",
      ].join("\n"));
      await this.linear.moveIssue(issue, this.config.states.review);
      await this.repository.completeTask(issue.id, event.deliveryId, "in_review", {
        linearState: this.config.states.review,
        routeComplexity: routed.result.value.complexity,
        executionModel: executed.model,
        executionProvider: executed.provider,
        resultSummary: executed.result.value.summary,
      });
      return { outcome: "in_review" };
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (failure.name === "BudgetExceededError") {
        return this.handOff(
          issue,
          event.deliveryId,
          "The configured AI spending or token limit prevented further model calls.",
          "Review the task and budget. Increase the limit only if appropriate, then move the issue back to Todo.",
        );
      }
      if (
        failure instanceof ProviderConfigurationError ||
        failure.name === "ProviderConfigurationError"
      ) {
        const provider = failure instanceof ProviderConfigurationError
          ? failure.provider
          : "configured AI provider";
        return this.handOff(
          issue,
          event.deliveryId,
          `${provider} rejected the request because its authentication, account, or payment configuration is incomplete.`,
          "Verify the provider credential and account configuration, then move the issue back to Todo.",
        );
      }
      if (failure instanceof ProviderRequestError || failure.name === "ProviderRequestError") {
        const provider = failure instanceof ProviderRequestError
          ? failure.provider
          : "The configured AI provider";
        return this.handOff(
          issue,
          event.deliveryId,
          `${provider} permanently rejected the model request. It will not be retried automatically.`,
          "Review the selected model and structured-output configuration, then move the issue back to Todo.",
        );
      }
      if (failure instanceof ModelOutputError || failure.name === "ModelOutputError") {
        const provider = failure instanceof ModelOutputError
          ? `${failure.provider}/${failure.model}`
          : "The selected model";
        return this.handOff(
          issue,
          event.deliveryId,
          `${provider} returned output that did not satisfy the required structured response contract. The call was recorded and will not be retried automatically.`,
          "Review the provider/model configuration or retry the issue manually by moving it back to Todo.",
        );
      }
      await this.repository.failTask(issue.id, event.deliveryId, failure);
      throw failure;
    }
  }
}
