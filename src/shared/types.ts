import type { RunOrigin } from "@/shared/run-origin";

export type DecomposedTask = {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
};

export type AgentState = {
  parentAgentId: string;
  parentAgentVersion: number;
  childAgentId: string;
  childAgentVersion: number;
  environmentId: string;
  definitionHash: string;
  createdAt: string;
};

export type AgentRegistryState = {
  parentAgentId: string;
  parentAgentVersion: number;
  childAgentId: string;
  childAgentVersion: number;
  definitionHash: string;
  parentDefinitionHash?: string | null;
  childDefinitionHash?: string | null;
  createdAt: string;
  updatedAt?: string;
};

export type PersistedAgentRegistryState = AgentRegistryState & {
  parentDefinitionHash: string;
  childDefinitionHash: string;
};

export type SystemSkillKey = "github_operations";

export type SystemSkillState = {
  key: SystemSkillKey;
  skillId: string;
  skillVersion: string;
  contentHash: string;
  createdAt: string;
  updatedAt?: string;
};

export type PersistedSystemSkillState = Omit<SystemSkillState, "updatedAt">;

export type DefaultEnvironmentState = {
  environmentId: string;
  definitionHash: string;
  createdAt: string;
  updatedAt: string;
};

export type RunState = {
  runId: string;
  issueNumber: number | null;
  origin?: RunOrigin;
  repo: string;
  branch: string;
  startedAt: string;
  subIssues: Array<{
    taskId: string;
    issueId: number;
    issueNumber: number;
  }>;
  prUrl?: string;
  vaultId?: string;
  sessionIds: string[];
  pid?: number;
};

export type RunStatus = "queued" | "running" | "completed" | "failed" | "aborted";

export type RunPhase =
  | "preflight"
  | "environment"
  | "vault"
  | "lock"
  | "session_start"
  | "decomposition"
  | "child_execution"
  | "finalize_pr"
  | "cleanup"
  | "aborted";

export type RunEventKind = "phase" | "session" | "subIssue" | "log" | "complete" | "error";

export type RunEvent = {
  id: string;
  runId: string;
  ts: string;
  kind: RunEventKind;
  payload: unknown;
};

export type RunSummary = {
  runId: string;
  issueNumber: number | null;
  origin?: RunOrigin;
  repo: string;
  branch?: string;
  startedAt: string;
  status: RunStatus;
  phase?: RunPhase;
  prUrl?: string;
};
