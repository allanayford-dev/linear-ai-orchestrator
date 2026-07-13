import { afterEach, describe, expect, it, vi } from "vitest";
import type { LinearIssue } from "../types/worker.js";
import { VercelAiGatewayClient } from "./ai-gateway-client.js";

const issue: LinearIssue = {
  id: "issue-1",
  identifier: "ALL-1",
  title: "Prepare a decision memo",
  description: "Compare the available approaches.",
  url: "https://linear.app/issue/ALL-1",
  state: { id: "todo", name: "Todo" },
  team: { id: "team-1", states: [] },
  project: { id: "project-1", name: "Pilot" },
  labels: [],
};

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("VercelAiGatewayClient", () => {
  it("requests router output with the documented JSON Schema format", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        id: "generation-1",
        choices: [{ message: { content: JSON.stringify({
          complexity: "complex",
          outcome: "execute",
          reason: "Requires comparison",
        }) } }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new VercelAiGatewayClient("test-key");

    await client.route(issue, "zai/glm-4.7-flashx");

    const request = fetchMock.mock.calls[0];
    const body = JSON.parse((request[1] as RequestInit).body as string) as {
      response_format: {
        type: string;
        json_schema: { name: string; schema: Record<string, unknown> };
      };
    };
    expect(body.response_format).toMatchObject({
      type: "json_schema",
      json_schema: {
        name: "linear_route_decision",
        schema: { type: "object", additionalProperties: false },
      },
    });
  });

  it("returns billable metadata when structured output is malformed", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        id: "generation-2",
        choices: [{ message: { content: "not-json" } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new VercelAiGatewayClient("test-key");

    await expect(client.route(issue, "zai/glm-4.7-flashx")).rejects.toMatchObject({
      name: "ModelOutputError",
      provider: "vercel-ai-gateway",
      model: "zai/glm-4.7-flashx",
      result: {
        rawText: "not-json",
        providerRequestId: "generation-2",
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
        },
      },
    });
  });

  it("classifies an unsupported structured-output request as permanent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      error: { message: "response_format is not supported" },
    }, 400)));
    const client = new VercelAiGatewayClient("test-key");

    await expect(client.route(issue, "zai/glm-4.7-flashx")).rejects.toMatchObject({
      name: "ProviderRequestError",
      provider: "vercel-ai-gateway",
      status: 400,
    });
  });
});
