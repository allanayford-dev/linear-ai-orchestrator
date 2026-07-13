import type { LinearIssue } from "../types/worker.js";

interface GraphQlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

export interface LinearClient {
  getIssue(id: string): Promise<LinearIssue>;
  moveIssue(issue: LinearIssue, stateName: string): Promise<void>;
  addComment(issueId: string, body: string): Promise<void>;
}

export class LinearGraphQlClient implements LinearClient {
  constructor(
    private readonly apiKey: string,
    private readonly endpoint = "https://api.linear.app/graphql",
  ) {}

  private async request<T>(query: string, variables: object): Promise<T> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        Authorization: this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await response.json()) as GraphQlResponse<T>;
    if (!response.ok || body.errors?.length || !body.data) {
      const detail = body.errors?.map((error) => error.message).join("; ");
      throw new Error(`Linear request failed: ${detail || response.status}`);
    }
    return body.data;
  }

  async getIssue(id: string): Promise<LinearIssue> {
    const data = await this.request<{ issue: {
      id: string;
      identifier: string;
      title: string;
      description: string | null;
      url: string;
      state: { id: string; name: string };
      team: { id: string; states: { nodes: Array<{ id: string; name: string; type: string }> } };
      project: { id: string; name: string } | null;
      labels: { nodes: Array<{ id: string; name: string }> };
    } }>(
      `query WorkerIssue($id: String!) {
        issue(id: $id) {
          id identifier title description url
          state { id name }
          team { id states { nodes { id name type } } }
          project { id name }
          labels { nodes { id name } }
        }
      }`,
      { id },
    );
    return {
      ...data.issue,
      team: { id: data.issue.team.id, states: data.issue.team.states.nodes },
      labels: data.issue.labels.nodes,
    };
  }

  async moveIssue(issue: LinearIssue, stateName: string): Promise<void> {
    const state = issue.team.states.find(
      (candidate) => candidate.name.toLowerCase() === stateName.toLowerCase(),
    );
    if (!state) throw new Error(`Linear state not found: ${stateName}`);
    await this.request(
      `mutation WorkerMoveIssue($id: String!, $stateId: String!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) { success }
      }`,
      { id: issue.id, stateId: state.id },
    );
    issue.state = { id: state.id, name: state.name };
  }

  async addComment(issueId: string, body: string): Promise<void> {
    await this.request(
      `mutation WorkerComment($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) { success }
      }`,
      { issueId, body },
    );
  }
}
