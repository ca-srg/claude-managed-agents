export type GitHubIssue = {
  body?: string | null;
  id: number;
  number: number;
  pull_request?: Record<string, unknown>;
  state: string;
  title: string;
} & Record<string, unknown>;

export type GitHubIssueClient = {
  paginate: (route: string, parameters?: Record<string, unknown>) => Promise<unknown[]>;
  request: (route: string, parameters?: Record<string, unknown>) => Promise<{ data: unknown }>;
};

export interface GitHubRequestClient {
  request<TResponse>(
    route: string,
    parameters?: Record<string, unknown>,
  ): Promise<{ data: TResponse; status?: number }>;
}
