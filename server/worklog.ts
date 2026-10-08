import crypto from "node:crypto";
import { db, localDate, nowIso } from "./db.js";
import { ask, hasApiKey } from "./ai.js";
import { commitsOn } from "./git.js";
import { listProjects, type Project } from "./projects.js";

const DAYS = ["일", "월", "화", "수", "목", "금", "토"];

/** 2026-10-08 → 10월 8일 (수) */
export function koreanDate(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  return `${m}월 ${d}일 (${DAYS[dow]})`;
}

type Sources = {
  prompts: string[];
  commits: { subject: string; files: string[] }[];
  doneTodos: string[];
};

async function collect(project: Project, date: string): Promise<Sources> {
  const inDate = (iso: string | null) => !!iso && localDate(new Date(iso)) === date;

  const prompts = (
    db.prepare("SELECT question, created_at FROM prompts WHERE project_id = ? ORDER BY id").all(project.id) as {
      question: string;
      created_at: string;
    }[]
  )
    .filter((p) => inDate(p.created_at))
    .map((p) => p.question);

  const doneTodos = (
    db.prepare("SELECT title, done_at FROM todos WHERE project_id = ? AND status = 'done'").all(project.id) as {
      title: string;
      done_at: string | null;
    }[]
  )
    .filter((t) => inDate(t.done_at))
    .map((t) => t.title);

  const commits = (await commitsOn(project.path, date)).map((c) => ({ subject: c.subject, files: c.files }));
  return { prompts, commits, doneTodos };
}

const isEmpty = (s: Sources) => !s.prompts.length && !s.commits.length && !s.doneTodos.length;

const SYSTEM = `개발자의 하루 작업 기록을 정리합니다.
입력으로 그날 개발자가 작성한 요청(프롬프트), git 커밋, 완료한 할 일이 주어집니다.
- 커밋 메시지를 그대로 옮기지 말고, 실제로 한 일을 "무엇을 했다" 수준으로 짧게 요약합니다.
- 비슷한 일은 하나로 묶고, 1~5줄의 "- " 목록으로만 답합니다. 머리말이나 날짜는 쓰지 않습니다.
- 각 줄은 "~함", "~ 추가", "~ 수정"처럼 짧은 명사형/개조식 한국어로 씁니다.
- 질문만 하고 실제 변경이 없으면 "~ 검토", "~ 확인"처럼 씁니다.`;

function fallbackSummary(s: Sources) {
  const lines = [
    ...s.commits.map((c) => c.subject),
    ...s.doneTodos.map((t) => `${t} 완료`),
    ...s.prompts.map((p) => `${p.split("\n")[0].slice(0, 60)} 검토`),
  ];
  return [...new Set(lines)].slice(0, 6).map((l) => `- ${l}`).join("\n");
}

export async function generate(project: Project, date: string, force = false) {
  const src = await collect(project, date);
  if (isEmpty(src)) return null;
  const hash = crypto.createHash("sha1").update(JSON.stringify(src)).digest("hex");
  const existing = db.prepare("SELECT source_hash, edited FROM worklogs WHERE date = ? AND project_id = ?").get(date, project.id) as
    | { source_hash: string; edited: number }
    | undefined;
  if (!force && existing && (existing.edited || existing.source_hash === hash)) return null;

  let summary: string;
  if (hasApiKey()) {
    const input = [
      `프로젝트: ${project.name}`,
      src.prompts.length ? `\n[요청]\n${src.prompts.map((p) => `- ${p.slice(0, 800)}`).join("\n")}` : "",
      src.commits.length
        ? `\n[커밋]\n${src.commits.map((c) => `- ${c.subject} (파일: ${c.files.slice(0, 8).join(", ")})`).join("\n")}`
        : "",
      src.doneTodos.length ? `\n[완료한 할 일]\n${src.doneTodos.map((t) => `- ${t}`).join("\n")}` : "",
    ].join("\n");
    try {
      summary = await ask(SYSTEM, input);
    } catch (e) {
      console.error("작업기록 요약 실패:", (e as Error).message);
      summary = fallbackSummary(src);
    }
  } else {
    summary = fallbackSummary(src);
  }

  db.prepare(
    `INSERT INTO worklogs(date, project_id, summary, source_hash, edited, generated_at) VALUES(?, ?, ?, ?, 0, ?)
     ON CONFLICT(date, project_id) DO UPDATE SET summary = excluded.summary, source_hash = excluded.source_hash, edited = 0, generated_at = excluded.generated_at`,
  ).run(date, project.id, summary, hash, nowIso());
  return summary;
}

/** 최근 N일 중 기록이 없거나 바뀐 날을 정리 */
export async function refreshRecent(days = 14) {
  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const date = localDate(d);
    for (const p of listProjects()) {
      try {
        await generate(p, date);
      } catch (e) {
        console.error(`작업기록 생성 실패 (${p.name}, ${date}):`, (e as Error).message);
      }
    }
  }
}

export function list(limitDays = 60) {
  const rows = db
    .prepare(
      `SELECT w.date, w.project_id, p.name AS project_name, w.summary, w.edited, w.generated_at
       FROM worklogs w JOIN projects p ON p.id = w.project_id
       ORDER BY w.date DESC, p.name`,
    )
    .all() as { date: string; project_id: number; project_name: string; summary: string; edited: number; generated_at: string }[];
  const byDate = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date)!.push(r);
  }
  return [...byDate.entries()].slice(0, limitDays).map(([date, items]) => ({ date, label: koreanDate(date), items }));
}

export function edit(date: string, projectId: number, summary: string) {
  db.prepare("UPDATE worklogs SET summary = ?, edited = 1 WHERE date = ? AND project_id = ?").run(summary, date, projectId);
}

let timer: NodeJS.Timeout | null = null;
let busy = false;

export function startScheduler() {
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await refreshRecent();
    } finally {
      busy = false;
    }
  };
  setTimeout(tick, 5_000);
  timer = setInterval(tick, 30 * 60 * 1000); // 30분마다
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
}
