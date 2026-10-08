// 개선 제안: Claude 없이 하는 자동 검사 + 기능 묶음별 Claude 분석.
// 결과는 저장해 두고, 무시한 항목은 다시 띄우지 않는다.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { db, nowIso } from "./db.js";
import { httpError, type Project } from "./projects.js";
import * as flow from "./flow.js";
import { runAgent } from "./agent.js";

db.exec(`CREATE TABLE IF NOT EXISTS suggestions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source      TEXT NOT NULL,              -- static | claude
  group_name  TEXT NOT NULL DEFAULT '',
  fingerprint TEXT NOT NULL,
  category    TEXT NOT NULL,              -- tech | logic | performance | security | structure | ops
  title       TEXT NOT NULL,
  file        TEXT NOT NULL DEFAULT '',
  line        INTEGER,
  problem     TEXT NOT NULL DEFAULT '',
  suggestion  TEXT NOT NULL DEFAULT '',
  reason      TEXT NOT NULL DEFAULT '',
  difficulty  TEXT NOT NULL DEFAULT 'normal',   -- easy | normal | hard
  priority    TEXT NOT NULL DEFAULT 'normal',   -- high | normal | low
  status      TEXT NOT NULL DEFAULT 'open',     -- open | ignored | todo
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE(project_id, fingerprint)
);
CREATE TABLE IF NOT EXISTS suggestion_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  group_name  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  added       INTEGER NOT NULL DEFAULT 0,
  error       TEXT
)`);

const CATEGORIES = ["tech", "logic", "performance", "security", "structure", "ops"] as const;
type Item = {
  category: (typeof CATEGORIES)[number];
  title: string;
  file: string;
  line: number | null;
  problem: string;
  suggestion: string;
  reason: string;
  difficulty: "easy" | "normal" | "hard";
  priority: "high" | "normal" | "low";
};

const fp = (...parts: (string | number | null)[]) =>
  crypto
    .createHash("sha1")
    .update(parts.map((x) => String(x ?? "")).join("|"))
    .digest("hex")
    .slice(0, 16);

const read = (root: string, rel: string) => {
  try {
    return fs.readFileSync(path.join(root, rel), "utf8");
  } catch {
    return "";
  }
};

// ---------------- 자동 검사 ----------------
function staticChecks(p: Project, g: flow.Graph): (Item & { key: string })[] {
  const out: (Item & { key: string })[] = [];
  const own = g.nodes.filter((n) => n.projectId === p.id);
  const incoming = new Map<string, number>();
  for (const e of g.edges) incoming.set(e.target, (incoming.get(e.target) ?? 0) + 1);
  const byId = new Map(g.nodes.map((n) => [n.id, n]));

  // 1) 아무 데서도 안 쓰는 Service / Repository / Component / 외부 호출
  for (const n of own) {
    if (!["service", "repository", "component", "client"].includes(n.kind) || n.scheduled) continue;
    if (incoming.get(n.id)) continue;
    const src = read(p.path, n.file ?? "");
    if (/@(EventListener|KafkaListener|RabbitListener|PostConstruct|Bean|Configuration|ControllerAdvice|RestControllerAdvice|Aspect)\b|implements\s+(ApplicationRunner|CommandLineRunner|Filter|HandlerInterceptor|WebMvcConfigurer|Converter|Formatter|HealthIndicator|ApplicationListener)\b/.test(src)) continue;
    out.push({
      key: `unused:${n.file}`,
      category: "structure",
      title: `${n.label} 를 쓰는 곳이 없음`,
      file: n.file ?? "",
      line: n.line ?? null,
      problem: "다른 클래스가 주입받지 않는 클래스입니다. 지금은 쓰이지 않는 코드일 수 있습니다.",
      suggestion: "정말 안 쓰는지 확인하고, 안 쓰면 지우거나 쓰는 곳에 연결하세요.",
      reason: "쓰지 않는 코드는 읽는 사람을 헷갈리게 하고 고칠 때 비용이 듭니다. (생성자 주입·필드 주입만 보고 판단한 것이라 리플렉션·설정으로 쓰는 경우는 놓칠 수 있습니다.)",
      difficulty: "easy",
      priority: "low",
    });
  }

  // 2) Controller 가 Repository 를 바로 부름
  for (const e of g.edges) {
    const a = byId.get(e.source);
    const b = byId.get(e.target);
    if (a?.projectId !== p.id || a.kind !== "controller" || b?.kind !== "repository") continue;
    out.push({
      key: `ctrl-repo:${a.file}:${b.label}`,
      category: "structure",
      title: `${a.label} 가 ${b.label} 를 바로 부름`,
      file: a.file ?? "",
      line: a.line ?? null,
      problem: "Controller 에서 Service 를 거치지 않고 Repository 를 바로 씁니다.",
      suggestion: "조회·저장 로직을 Service 로 옮기고 Controller 는 Service 만 부르게 하세요.",
      reason: "트랜잭션 범위와 업무 규칙이 한곳(Service)에 모여 있어야 고치기 쉽습니다.",
      difficulty: "normal",
      priority: "low",
    });
  }

  // 3) 연결 못 찾은 API 호출
  for (const u of g.unresolved.filter((x) => x.projectId === p.id)) {
    out.push({
      key: `unresolved:${u.file}:${u.url}`,
      category: "logic",
      title: `연결 못 찾은 호출 ${u.url}`,
      file: u.file,
      line: null,
      problem: u.reason,
      suggestion: "주소 오타인지, 백엔드에 아직 없는 API 인지 확인하세요.",
      reason: "백엔드에 없는 주소를 부르면 화면에서 404 오류가 납니다. (정적 분석이라 동적으로 만든 주소는 틀리게 볼 수 있습니다.)",
      difficulty: "easy",
      priority: "normal",
    });
  }

  // 4) yml 에 비밀번호·키가 그대로 들어 있음 (값은 보여주지 않는다)
  const resDir = "src/main/resources";
  let ymls: string[] = [];
  try {
    ymls = fs.readdirSync(path.join(p.path, resDir)).filter((f) => /^application.*\.ya?ml$/.test(f)).map((f) => `${resDir}/${f}`);
  } catch {
    /* 없음 */
  }
  for (const f of ymls) {
    read(p.path, f)
      .split(/\r?\n/)
      .forEach((l, i) => {
        const m = l.match(/^\s*([\w.-]*(password|passwd|secret|api[-_]?key|token|credential|private[-_]?key|service[-_]?key)[\w.-]*)\s*:\s*(.+?)\s*(#.*)?$/i);
        if (!m) return;
        const v = m[3].replace(/^["']|["']$/g, "");
        if (!v || /^\$\{[^:}]+\}$/.test(v) || /^\$\{[^:}]+:\s*\}$/.test(v)) return; // 환경변수만 쓰면 괜찮음
        out.push({
          key: `secret:${f}:${m[1]}`,
          category: "security",
          title: `${path.basename(f)} 의 ${m[1]} 값이 파일에 들어 있음`,
          file: f,
          line: i + 1,
          problem: /^\$\{/.test(v) ? "환경변수가 없을 때 쓰는 기본값으로 실제 값이 들어 있습니다." : "비밀번호·키 값이 설정 파일에 그대로 적혀 있습니다.",
          suggestion: "값을 환경변수(예: ${DB_PASSWORD})나 서버의 외부 yml 로 옮기고, git 에 올라간 값은 바꾸세요.",
          reason: "저장소를 볼 수 있는 사람이면 누구나 값을 알 수 있습니다.",
          difficulty: "easy",
          priority: "high",
        });
      });
  }

  // 5) 저장·삭제하는 Service 메서드에 @Transactional 이 없음 (클래스가 readOnly 이면 저장이 안 될 수 있음)
  for (const n of own.filter((x) => x.kind === "service" && x.file)) {
    const src = read(p.path, n.file!);
    const classAnn = src.slice(0, src.search(/\bclass\s+\w+/));
    const classTx = /@Transactional\b(?!\s*\(\s*readOnly\s*=\s*true)/.test(classAnn);
    const classRO = /@Transactional\s*\(\s*readOnly\s*=\s*true/.test(classAnn);
    if (classTx) continue;
    const re = /((?:\s*@[\w.]+(?:\([^)]*\))?\s*)*)\s*public\s+[\w<>\[\], ?]+\s+(\w+)\s*\([^)]*\)\s*(?:throws [\w., ]+)?\{/g;
    for (const m of src.matchAll(re)) {
      const ann = m[1];
      if (/@Transactional\b(?!\s*\(\s*readOnly\s*=\s*true)/.test(ann)) continue;
      // 메서드 본문 (중괄호 짝)
      let i = (m.index ?? 0) + m[0].length;
      let depth = 1;
      const start = i;
      for (; i < src.length && depth; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}") depth--;
      }
      const body = src.slice(start, i);
      if (!/\.\s*(save|saveAll|saveAndFlush|delete\w*|update\w*|insert\w*|merge|persist|remove)\s*\(/.test(body)) continue;
      out.push({
        key: `tx:${n.file}:${m[2]}`,
        category: "logic",
        title: `${n.label}.${m[2]}() 에 @Transactional 이 없음`,
        file: n.file!,
        line: src.slice(0, m.index).split("\n").length + 1,
        problem: classRO
          ? "클래스가 @Transactional(readOnly = true) 인데 이 메서드는 저장·삭제를 하면서 따로 @Transactional 을 붙이지 않았습니다."
          : "저장·삭제를 하는 메서드인데 트랜잭션이 없습니다.",
        suggestion: "메서드에 @Transactional 을 붙이세요.",
        reason: classRO ? "읽기 전용 트랜잭션에서는 변경 내용이 반영되지 않거나 오류가 날 수 있습니다." : "여러 번 저장하다 중간에 실패하면 일부만 저장된 채로 남습니다.",
        difficulty: "easy",
        priority: classRO ? "high" : "normal",
      });
    }
  }
  return out;
}

function upsert(projectId: number, source: string, group: string, items: (Item & { key?: string })[]) {
  const now = nowIso();
  const stmt = db.prepare(`INSERT INTO suggestions(project_id, source, group_name, fingerprint, category, title, file, line, problem, suggestion, reason, difficulty, priority, created_at, updated_at)
    VALUES(@project_id, @source, @group_name, @fingerprint, @category, @title, @file, @line, @problem, @suggestion, @reason, @difficulty, @priority, @now, @now)
    ON CONFLICT(project_id, fingerprint) DO UPDATE SET title=excluded.title, line=excluded.line, problem=excluded.problem,
      suggestion=excluded.suggestion, reason=excluded.reason, difficulty=excluded.difficulty, priority=excluded.priority, updated_at=excluded.updated_at`);
  const fps: string[] = [];
  for (const it of items) {
    const f = it.key ? fp("static", it.key) : fp("claude", it.category, it.file, it.title.replace(/\s+/g, ""));
    fps.push(f);
    stmt.run({ ...it, project_id: projectId, source, group_name: group, fingerprint: f, now, line: it.line ?? null });
  }
  return fps;
}

type Row = Record<string, unknown> & { status: string };

export async function list(projects: Project[], projectId: number) {
  const p = projects.find((x) => x.id === projectId);
  if (!p) throw httpError(404, "없는 프로젝트입니다.");
  const g = await flow.buildAll(projects);
  // 자동 검사는 매번 다시 하고, 더 이상 안 걸리는 항목(열린 것)은 지운다
  const fps = upsert(p.id, "static", "", staticChecks(p, g));
  const stale = db
    .prepare("SELECT id, fingerprint FROM suggestions WHERE project_id = ? AND source = 'static' AND status = 'open'")
    .all(p.id) as { id: number; fingerprint: string }[];
  for (const s of stale) if (!fps.includes(s.fingerprint)) db.prepare("DELETE FROM suggestions WHERE id = ?").run(s.id);

  const groups = [...new Set(g.nodes.filter((n) => n.projectId === p.id && n.file).map((n) => n.group ?? ""))].sort();
  return {
    items: db
      .prepare(
        `SELECT * FROM suggestions WHERE project_id = ?
         ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, category, id`,
      )
      .all(p.id) as Row[],
    groups,
    runs: db.prepare("SELECT * FROM suggestion_runs WHERE project_id = ? ORDER BY id DESC LIMIT 30").all(p.id),
  };
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["category", "title", "file", "line", "problem", "suggestion", "reason", "difficulty", "priority"],
        properties: {
          category: { type: "string", enum: [...CATEGORIES], description: "tech=더 맞는 기술·라이브러리, logic=버그 가능성·로직, performance=성능, security=보안, structure=구조·중복, ops=운영·배포·로그" },
          title: { type: "string", description: "한 줄 제목 (한국어)" },
          file: { type: "string", description: "프로젝트 기준 파일 경로" },
          line: { anyOf: [{ type: "integer" }, { type: "null" }], description: "관련 줄 번호, 모르면 null" },
          problem: { type: "string", description: "지금 무엇이 문제인지 (한국어)" },
          suggestion: { type: "string", description: "어떻게 바꾸면 좋은지 (한국어, 구체적으로)" },
          reason: { type: "string", description: "왜 그게 나은지 (한국어)" },
          difficulty: { type: "string", enum: ["easy", "normal", "hard"] },
          priority: { type: "string", enum: ["high", "normal", "low"] },
        },
      },
    },
  },
};

const SYSTEM = `당신은 울산 프로젝트 코드를 검토하는 시니어 개발자입니다. 주어진 기능 묶음의 코드를 도구로 직접 읽고 고치면 좋을 점을 찾습니다.

- 분류: tech(더 맞는 기술·라이브러리), logic(버그 가능성·잘못된 로직), performance(성능), security(보안), structure(구조·중복·이름), ops(운영·배포·로그).
- 실제로 코드를 읽고 근거가 있는 것만 씁니다. 파일 경로와 줄 번호는 read_file 결과의 줄 번호 그대로 씁니다.
- 사소한 스타일 지적보다 실제 문제가 될 만한 것을 우선합니다. 항목은 많아야 15개입니다.
- 이미 알려진 항목(아래 목록)은 다시 쓰지 않습니다.
- 코드는 고치지 않습니다. 마지막에 반드시 submit 도구로 결과를 냅니다. 모든 설명은 한국어로 씁니다.`;

export async function analyze(projects: Project[], projectId: number, group: string) {
  const p = projects.find((x) => x.id === projectId);
  if (!p) throw httpError(404, "없는 프로젝트입니다.");
  const g = await flow.buildAll(projects);
  const files = g.nodes.filter((n) => n.projectId === p.id && (group === "" || n.group === group) && n.file).map((n) => `${n.kind}\t${n.label}\t${n.file}`);
  if (!files.length) throw httpError(400, "이 기능 묶음에서 분석할 파일을 못 찾았습니다.");
  const known = db.prepare("SELECT title, file FROM suggestions WHERE project_id = ?").all(p.id) as { title: string; file: string }[];
  const run = db.prepare("INSERT INTO suggestion_runs(project_id, group_name, created_at) VALUES(?, ?, ?)").run(p.id, group, nowIso());
  const runId = Number(run.lastInsertRowid);
  try {
    const r = await runAgent<{ items: Item[] }>({
      projects: [p],
      system: SYSTEM,
      user:
        `프로젝트: ${p.name} (${p.kind})\n분석할 기능 묶음: ${group || "(프로젝트 전체)"}\n\n이 묶음의 클래스·파일 (종류, 이름, 경로):\n${files.join("\n")}\n\n` +
        `필요하면 관련된 다른 파일(설정, 공통 코드)도 읽어도 됩니다.\n\n이미 알려진 항목:\n${known.map((k) => `- ${k.title} (${k.file})`).join("\n") || "(없음)"}`,
      submitDescription: "찾은 개선 항목을 제출한다. 이 도구를 부르면 작업이 끝난다.",
      submitSchema: SCHEMA,
      effort: "medium",
      maxTurns: 40,
    });
    upsert(p.id, "claude", group, r.items);
    db.prepare("UPDATE suggestion_runs SET added = ? WHERE id = ?").run(r.items.length, runId);
    return { added: r.items.length };
  } catch (e) {
    db.prepare("UPDATE suggestion_runs SET error = ? WHERE id = ?").run((e as Error).message, runId);
    throw e;
  }
}

export function setStatus(id: number, status: string) {
  if (!["open", "ignored", "todo"].includes(status)) throw httpError(400, "잘못된 상태입니다.");
  db.prepare("UPDATE suggestions SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), id);
  return db.prepare("SELECT * FROM suggestions WHERE id = ?").get(id);
}
