import { createHash } from "node:crypto";
import type { WorkerConfig } from "../config/worker-env.js";
import type {
  GenerationContext,
  WorkerRepository,
} from "../repositories/worker-repository.js";
import type {
  ExecutionResult,
  LinearIssue,
  ModelResult,
  ModelRole,
  RouteDecision,
  WorkEvent,
} from "../types/worker.js";
import type { AiGatewayClient } from "./ai-gateway-client.js";
import type { LinearClient } from "./linear-client.js";

export interface WorkerOutcome {
  outcome: "ignored" | "duplicate" | "busy" | "needs_action" | "in_review";
  reason?: string;
}

function generationId(deliveryId: string, role: ModelRole): string {
  return createHash("sha256").update(`${deliveryId}:${role}`).digest("hex");
}

function issueIdFrom(event: WorkEvent): string | null {
  const id = event.payload.data.id;
  return typeof id === "string" && id ? id : null;
}

function usageLine(results: Array<{ model: string; result: ModelResult<unknown> }>): string {
  const tokens = results.reduce((sum, item) => sum + item.result.usage.totalTokens, 0);
  const micros = results.reduce((sum, item) => sum + item.result.usage.estimatedCostMicros, 0);
  const models = [...new Set(results.map((item) => item.model))].join(", ");
  return `Models: ${models} · Tokens: ${tokens} · Estimated AI cost: $${(micros / 1_000_000).toFixed(6)}`;
}

export class OrchestratorWorkerService {
  constructor(
    private readonly config: WorkerConfig,
    private readonly repository: WorkerRepository,
    private readonly linear: LinearClient,
    private readonly ai: AiGatewayClient,
  ) {}

  private context(
    issue: LinearIssue,
    deliveryId: string,
    role: ModelRole,
    model: string,
  ): GenerationContext {
    return {
      generationId: generationId(deliveryId, role),
      taskId: issue.id,
      issueIdentifier: issue.identifier,
      projectId: issue.project?.id ?? "unassigned",
      projectName: issue.project?.name ?? "Unassigned",
      model,
      role,
      deliveryId,
    };
  }

  private async generate<T>(
    context: GenerationContext,
    call: () => Promise<ModelResult<T>>,
  ): Promise<ModelResult<T>> {
    const cached = await this.repository.getCompletedGeneration<T>(context.generationId);
    if (cached) return cached;
    await this.repository.assertWithinBudget(
      context.taskId,
      context.projectId,
      this.config.maxTaskCostMicros,
      this.config.maxProjectMonthlyCostMicros,
    );
    await this.repository.startGeneration(context);
    try {
      const result = await call();
      await this.repository.completeGeneration(context, result);
      return result;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      await this.repository.failGeneration(context.generationId, failure);
      throw failure;
    }
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
    const isInProgress = currentState === this.config.states.inProgress.toLowerCase();
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
      if (isTodo) await this.linear.moveIssue(issue, this.config.states.inProgress);
      const calls: Array<{ model: string; result: ModelResult<unknown> }> = [];
      const routerContext = this.context(issue, event.deliveryId, "router", this.config.routerModel);
      const routed = await this.generate<RouteDecision>(
        routerContext,
        () => this.ai.route(issue, this.config.routerModel),
      );
      calls.push({ model: this.config.routerModel, result: routed });

      if (routed.value.outcome === "needs_human") {
        return this.handOff(
          issue,
          event.deliveryId,
          routed.value.reason,
          routed.value.humanAction || "Add the missing information or approval, then move the issue back to Todo.",
          usageLine(calls),
        );
      }

      const executionModel = routed.value.complexity === "complex"
        ? this.config.executorModel
        : this.config.routerModel;
      const executorContext = this.context(issue, event.deliveryId, "executor", executionModel);
      const executed = await this.generate<ExecutionResult>(
        executorContext,
        () => this.ai.execute(issue, routed.value, executionModel),
      );
      calls.push({ model: executionModel, result: executed });

      if (executed.value.outcome === "needs_human") {
        return this.handOff(
          issue,
          event.deliveryId,
          executed.value.summary,
          executed.value.humanAction || "Complete the external action, then move the issue back to Todo.",
          usageLine(calls),
        );
      }

      const verification = executed.value.verification.length
        ? executed.value.verification.map((item) => `- ${item}`).join("\n")
        : "- Review the proposed result against the acceptance criteria.";
      await this.linear.addComment(issue.id, [
        "## Orchestrator result",
        "",
        executed.value.summary,
        "",
        executed.value.result,
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
        routeComplexity: routed.value.complexity,
        executionModel,
        resultSummary: executed.value.summary,
      });
      return { outcome: "in_review" };
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (failure.name === "BudgetExceededError") {
        return this.handOff(
          issue,
          event.deliveryId,
          "The configured AI spending limit prevented further model calls.",
          "Review the task and budget. Increase the limit only if appropriate, then move the issue back to Todo.",
        );
      }
      if (failure.name === "ProviderConfigurationError") {
        return this.handOff(
          issue,
          event.deliveryId,
          "The AI provider rejected the request because its account or payment configuration is incomplete.",
          "Add or verify the Vercel payment method and AI Gateway key, then move the issue back to Todo.",
        );
      }
      await this.repository.failTask(issue.id, event.deliveryId, failure);
      throw failure;
    }
  }
}
