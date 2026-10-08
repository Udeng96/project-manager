export type RunStatus = { running: boolean; task: "run" | "build" | "clean" | null; pid: number | null; startedAt: string | null; exitCode: number | null };

export type Project = {
  id: number;
  name: string;
  path: string;
  kind: string;
  run_cmd: string;
  build_cmd: string;
  clean_cmd: string;
  status: RunStatus;
};

export type LogLine = { seq: number; at: string; stream: "out" | "err" | "sys"; text: string };

export type GitStatus =
  | { repo: false }
  | {
      repo: true;
      branch: string;
      upstream: string | null;
      ahead: number;
      behind: number;
      files: { path: string; index: string; worktree: string; untracked: boolean }[];
    };

export type Commit = { hash: string; author: string; date: string; subject: string };

export type Prompt = {
  id: number;
  project_id: number;
  created_at: string;
  question: string;
  answer: string;
  claude_code_prompt: string;
  error: string;
};

export type Todo = {
  id: number;
  project_id: number;
  project_name: string;
  title: string;
  kind: "task" | "check";
  note: string;
  status: "open" | "done";
  created_at: string;
  done_at: string | null;
};

export type WorklogDay = {
  date: string;
  label: string;
  items: { date: string; project_id: number; project_name: string; summary: string; edited: number }[];
};

export type Settings = { hasApiKey: boolean; apiKeySource: string | null; dataDir: string; platform: string };

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `요청 실패 (${res.status})`);
  return data as T;
}

export const api = {
  get: <T>(url: string) => req<T>("GET", url),
  post: <T>(url: string, body: unknown = {}) => req<T>("POST", url, body),
  patch: <T>(url: string, body: unknown) => req<T>("PATCH", url, body),
  put: <T>(url: string, body: unknown) => req<T>("PUT", url, body),
  del: <T>(url: string) => req<T>("DELETE", url),
};

/** 2026-10-08T... → 10월 8일 (수) 14:05 */
export function fmtTime(iso: string) {
  const d = new Date(iso);
  const days = ["일", "월", "화", "수", "목", "금", "토"];
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${days[d.getDay()]}) ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export type FsEntry = { name: string; path: string; dir: boolean; size?: number };
export type FileContent = { path: string; binary: boolean; tooLarge: boolean; size: number; mtime?: string; content: string };
export type Hit = { path: string; line: number; text: string };

/** 다른 화면에서 코드 탭으로 파일 열기 요청 */
export type OpenRequest = { path: string; line?: number; nonce: number };

export type DeployCategory = "config" | "log" | "sql" | "script" | "service" | "artifact" | "doc";
export type DeployFile = {
  path: string;
  category: DeployCategory;
  size: number;
  mtime: string;
  hash: string;
  sqlVersion: number | null;
  custom: boolean;
  since: "new" | "changed" | "same" | null;
  sha256?: string;
};
export type Deployment = {
  id: number;
  project_id: number;
  deployed_at: string;
  version: string;
  artifact: string;
  target: string;
  sqls: string[];
  scripts: string[];
  checklist: { text: string; done: boolean }[];
  memo: string;
};

export function fmtSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export type FlowKind =
  | "screen"
  | "api"
  | "controller"
  | "service"
  | "repository"
  | "client"
  | "scheduler"
  | "component"
  | "entity"
  | "table"
  | "external";

export type FlowNode = {
  id: string;
  projectId: number | null;
  project: string;
  kind: FlowKind;
  label: string;
  file?: string;
  fileProjectId?: number;
  folder?: string;
  line?: number;
  desc?: string;
  descBy?: "code" | "claude";
  group?: string;
  endpoints?: { method: string; path: string; line: number }[];
  calls?: { method: string; url: string }[];
  scheduled?: boolean;
  changed?: boolean;
  schema?: string;
};

export type FlowEdge = { id: string; source: string; target: string; label?: string; cross?: boolean };

export type FlowGraph = {
  nodes: FlowNode[];
  edges: FlowEdge[];
  unresolved: { projectId: number; project: string; file: string; url: string; reason: string }[];
  generatedAt: string;
};

export type Prediction = {
  summary: string;
  newNodes: { key: string; kind: string; project: string; label: string; group: string; desc: string; file: string; endpoints: string[] }[];
  changedNodes: { id: string; change: string }[];
  newEdges: { source: string; target: string; label: string }[];
  tasks: { project: string; projectId: number; file: string; action: "add" | "modify"; detail: string }[];
  risks: string[];
  claudeCodePrompt: string;
};

export type PredictionItem = {
  id: number;
  projectId: number;
  createdAt: string;
  request: string;
  result: Prediction | null;
  error: string | null;
  pending: boolean;
  stale: boolean;
};
