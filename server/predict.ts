// "이 기능을 추가하면?" 예상 흐름도.
// Claude 가 지금 구조(흐름도 그래프)와 코드를 읽고, 새로 생길 것 / 바뀔 것 / 새 연결 / 할 일을 정해진 형식으로 낸다.
// 영향 범위(바뀌는 클래스를 쓰는 곳)는 흐름도 연결로 직접 계산한다.
import fs from "node:fs";
import path from "node:path";
import { db, nowIso } from "./db.js";
import { httpError, type Project } from "./projects.js";
import * as flow from "./flow.js";
import { runAgent } from "./agent.js";

db.exec(`CREATE TABLE IF NOT EXISTS predictions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  request     TEXT NOT NULL,
  result      TEXT,            -- JSON (Prediction)
  files       TEXT,            -- JSON {"프로젝트id:경로": mtimeMs} 예상 당시 바뀔 파일들의 수정 시각
  error       TEXT
)`);

const KINDS = ["screen", "api", "controller", "service", "repository", "client", "scheduler", "component", "entity", "table"] as const;

export type Prediction = {
  summary: string;
  newNodes: { key: string; kind: (typeof KINDS)[number]; project: string; label: string; group: string; desc: string; file: string; endpoints: string[] }[];
  changedNodes: { id: string; change: string }[];
  newEdges: { source: string; target: string; label: string }[];
  tasks: { project: string; file: string; action: "add" | "modify"; detail: string }[];
  risks: string[];
  claudeCodePrompt: string;
};

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "newNodes", "changedNodes", "newEdges", "tasks", "risks", "claudeCodePrompt"],
  properties: {
    summary: { type: "string", description: "무엇을 어떻게 바꾸는지 2~4문장 요약 (한국어)" },
    newNodes: {
      type: "array",
      description: "새로 만들 클래스·파일·테이블",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "kind", "project", "label", "group", "desc", "file", "endpoints"],
        properties: {
          key: { type: "string", description: "이 결과 안에서만 쓰는 짧은 영문 키 (예: excelCtrl)" },
          kind: { type: "string", enum: [...KINDS] },
          project: { type: "string" },
          label: { type: "string", description: "클래스 이름, 파일 이름 또는 테이블 이름" },
          group: { type: "string", description: "기능 묶음 (기존 그래프의 group 과 맞춤)" },
          desc: { type: "string", description: "하는 일 한 줄 (한국어)" },
          file: { type: "string", description: "만들 파일의 프로젝트 기준 경로. 테이블이면 마이그레이션 SQL 경로" },
          endpoints: { type: "array", items: { type: "string" }, description: "새 주소 (예: GET /api/broadcast/dispatches/excel). 없으면 빈 배열" },
        },
      },
    },
    changedNodes: {
      type: "array",
      description: "고쳐야 하는 기존 노드",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "change"],
        properties: {
          id: { type: "string", description: "그래프에 있는 기존 노드 id 그대로" },
          change: { type: "string", description: "무엇을 바꾸는지 한 줄 (한국어)" },
        },
      },
    },
    newEdges: {
      type: "array",
      description: "새로 생기는 연결. source/target 은 기존 노드 id 또는 'new:<key>'",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["source", "target", "label"],
        properties: { source: { type: "string" }, target: { type: "string" }, label: { type: "string", description: "주소 등, 없으면 빈 문자열" } },
      },
    },
    tasks: {
      type: "array",
      description: "파일 단위 할 일 (작업 순서대로)",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["project", "file", "action", "detail"],
        properties: {
          project: { type: "string" },
          file: { type: "string" },
          action: { type: "string", enum: ["add", "modify"] },
          detail: { type: "string", description: "할 일 한두 문장 (한국어)" },
        },
      },
    },
    risks: { type: "array", items: { type: "string" }, description: "주의할 점·확인할 것 (한국어). 없으면 빈 배열" },
    claudeCodePrompt: { type: "string", description: "Claude Code 에 그대로 붙여넣을 구현 요청 프롬프트 (한국어, 목표·파일·규칙·완료 기준 포함)" },
  },
};

const SYSTEM = `당신은 울산 프로젝트의 시니어 개발자입니다. 사용자가 추가하려는 기능을 지금 코드 구조에 어떻게 넣을지 설계합니다.

- 먼저 주어진 구조 그래프를 보고, 관련 코드를 도구로 직접 읽어 기존 규칙(패키지 구조, 이름 짓는 법, DTO/응답 형식, Flyway 버전 번호)을 확인합니다.
- 기존 클래스에 메서드를 더하는 것으로 충분하면 새 클래스를 만들지 말고 changedNodes 로 표현합니다. 꼭 필요한 것만 새로 만듭니다.
- changedNodes 의 id 와 newEdges 의 기존 노드는 그래프에 적힌 id 를 정확히 그대로 씁니다.
- DB 변경이 있으면 테이블을 newNodes(kind=table) 로, 마이그레이션 SQL 파일은 tasks 에 넣습니다. 버전 번호는 기존 마지막 번호 다음으로 합니다.
- 코드는 고치지 않습니다. 마지막에 반드시 submit 도구로 결과를 냅니다. 모든 설명은 한국어로 씁니다.`;

/** Claude 에게 줄 그래프 요약 */
function graphText(g: flow.Graph) {
  const nodes = g.nodes
    .map((n) => {
      const eps = n.endpoints?.length ? ` [${n.endpoints.map((e) => `${e.method} ${e.path}`).join(", ")}]` : "";
      const calls = n.calls?.length ? ` 부름[${n.calls.map((c) => `${c.method} ${c.url}`.trim()).join(", ")}]` : "";
      return `${n.id} | ${n.kind} | ${n.project} | ${n.group ?? ""} | ${n.label}${n.file ? ` (${n.file})` : ""}${eps}${calls}`;
    })
    .join("\n");
  const edges = g.edges.map((e) => `${e.source} -> ${e.target}${e.label ? ` (${e.label.split("\n").join(", ")})` : ""}`).join("\n");
  return `노드 (id | 종류 | 프로젝트 | 기능 묶음 | 이름 (파일) [주소]):\n${nodes}\n\n연결 (부르는 쪽 -> 불리는 쪽):\n${edges}`;
}

function fileMtimes(projects: Project[], g: flow.Graph, r: Prediction) {
  const out: Record<string, number> = {};
  for (const c of r.changedNodes) {
    const n = g.nodes.find((x) => x.id === c.id);
    const pid = n?.fileProjectId ?? n?.projectId;
    const p = projects.find((x) => x.id === pid);
    if (!n?.file || !p) continue;
    try {
      out[`${p.id}:${n.file}`] = fs.statSync(path.join(p.path, n.file)).mtimeMs;
    } catch {
      /* 파일 없음 */
    }
  }
  return out;
}

/** 잘못된 id 를 걸러 낸다 */
function clean(g: flow.Graph, r: Prediction): Prediction {
  const ids = new Set(g.nodes.map((n) => n.id));
  const keys = new Set(r.newNodes.map((n) => `new:${n.key}`));
  const ok = (id: string) => ids.has(id) || keys.has(id);
  return {
    ...r,
    changedNodes: r.changedNodes.filter((c) => ids.has(c.id)),
    newEdges: r.newEdges.filter((e) => ok(e.source) && ok(e.target) && e.source !== e.target),
  };
}

export async function create(projects: Project[], project: Project, request: string) {
  if (!request.trim()) throw httpError(400, "추가할 기능을 적어 주세요.");
  const info = db.prepare("INSERT INTO predictions(project_id, created_at, request) VALUES(?, ?, ?)").run(project.id, nowIso(), request.trim());
  const id = Number(info.lastInsertRowid);
  try {
    const g = await flow.buildAll(projects, true);
    const raw = await runAgent<Prediction>({
      projects,
      system: SYSTEM,
      user:
        `기준 프로젝트: ${project.name}\n등록된 프로젝트: ${projects.map((p) => `${p.name} (${p.kind})`).join(", ")}\n\n` +
        `지금 구조 그래프:\n${graphText(g)}\n\n---\n추가하려는 기능:\n${request.trim()}`,
      submitDescription: "설계 결과를 제출한다. 이 도구를 부르면 작업이 끝난다.",
      submitSchema: SCHEMA,
      effort: "medium",
    });
    const r = clean(g, raw);
    db.prepare("UPDATE predictions SET result = ?, files = ? WHERE id = ?").run(JSON.stringify(r), JSON.stringify(fileMtimes(projects, g, r)), id);
  } catch (e) {
    db.prepare("UPDATE predictions SET error = ? WHERE id = ?").run((e as Error).message, id);
  }
  return get(projects, id);
}

type Row = { id: number; project_id: number; created_at: string; request: string; result: string | null; files: string | null; error: string | null };

function toItem(projects: Project[], row: Row) {
  // 예상 이후 바뀔 파일이 수정됐는지
  let stale = false;
  for (const [k, mtime] of Object.entries(JSON.parse(row.files ?? "{}") as Record<string, number>)) {
    const [pid, ...rest] = k.split(":");
    const p = projects.find((x) => x.id === Number(pid));
    try {
      if (p && fs.statSync(path.join(p.path, rest.join(":"))).mtimeMs > mtime + 1) stale = true;
    } catch {
      stale = true;
    }
  }
  const result = row.result ? (JSON.parse(row.result) as Prediction) : null;
  // 할 일에 프로젝트 id 를 붙여 둔다 (남은 작업으로 보낼 때 사용)
  const tasks = result?.tasks.map((t) => ({ ...t, projectId: projects.find((p) => p.name === t.project)?.id ?? row.project_id }));
  return {
    id: row.id,
    projectId: row.project_id,
    createdAt: row.created_at,
    request: row.request,
    result: result && { ...result, tasks },
    error: row.error,
    pending: !row.result && !row.error,
    stale,
  };
}

export function get(projects: Project[], id: number) {
  const row = db.prepare("SELECT * FROM predictions WHERE id = ?").get(id) as Row | undefined;
  if (!row) throw httpError(404, "없는 예상입니다.");
  return toItem(projects, row);
}

export function list(projects: Project[], projectId: number) {
  const rows = db.prepare("SELECT * FROM predictions WHERE project_id = ? ORDER BY id DESC LIMIT 50").all(projectId) as Row[];
  return rows.map((r) => toItem(projects, r));
}

export function remove(id: number) {
  db.prepare("DELETE FROM predictions WHERE id = ?").run(id);
}
