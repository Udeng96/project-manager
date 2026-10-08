export type RunStatus = { running: boolean; task: "run" | "build" | null; pid: number | null; startedAt: string | null; exitCode: number | null };

export type Project = {
  id: number;
  name: string;
  path: string;
  kind: string;
  run_cmd: string;
  build_cmd: string;
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
