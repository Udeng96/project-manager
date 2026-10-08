import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, getSetting, nowIso, setSetting, DATA_DIR } from "./db.js";
import * as projects from "./projects.js";
import * as runner from "./runner.js";
import * as git from "./git.js";
import * as ai from "./ai.js";
import * as worklog from "./worklog.js";

const PORT = Number(process.env.PORT ?? 4100);
const HOST = process.env.HOST ?? "127.0.0.1"; // 내 PC에서만 접속
const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(here, "../dist");

const app = Fastify({ logger: { level: "warn" } });

app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
  reply.status(err.statusCode ?? 500).send({ error: err.message });
});

const id = (p: unknown) => Number((p as { id: string }).id);

// ---------- 설정 ----------
app.get("/api/settings", async () => ({
  hasApiKey: ai.hasApiKey(),
  apiKeySource: getSetting("anthropic_api_key") ? "settings" : process.env.ANTHROPIC_API_KEY ? "env" : null,
  dataDir: DATA_DIR,
  platform: process.platform,
}));

app.put("/api/settings/api-key", async (req) => {
  const { apiKey } = req.body as { apiKey: string };
  setSetting("anthropic_api_key", (apiKey ?? "").trim());
  return { ok: true };
});

// ---------- 프로젝트 ----------
app.get("/api/projects", async () =>
  projects.listProjects().map((p) => ({ ...p, status: runner.status(p.id) })),
);

app.post("/api/projects", async (req) => {
  const { path: dir, name } = req.body as { path: string; name?: string };
  return projects.addProject(dir, name);
});

app.patch("/api/projects/:id", async (req) => projects.updateProject(id(req.params), req.body as object));

app.delete("/api/projects/:id", async (req) => {
  runner.stop(id(req.params));
  projects.removeProject(id(req.params));
  return { ok: true };
});

app.get("/api/projects/:id/redetect", async (req) => projects.detect(projects.getProject(id(req.params)).path));

// ---------- 실행 / 로그 ----------
app.post("/api/projects/:id/run", async (req) => {
  const { task } = (req.body ?? {}) as { task?: "run" | "build" };
  return runner.start(projects.getProject(id(req.params)), task ?? "run");
});

app.post("/api/projects/:id/stop", async (req) => runner.stop(id(req.params)));

app.delete("/api/projects/:id/logs", async (req) => {
  runner.clearLogs(id(req.params));
  return { ok: true };
});

// 실시간 로그 (Server-Sent Events)
app.get("/api/projects/:id/logs/stream", (req, reply) => {
  const pid = id(req.params);
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("status", runner.status(pid));
  send("lines", runner.logs(pid));
  const unsubscribe = runner.subscribe(
    pid,
    (l) => send("lines", [l]),
    () => send("status", runner.status(pid)),
  );
  const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
  req.raw.on("close", () => {
    clearInterval(ping);
    unsubscribe();
  });
});

// ---------- git ----------
app.get("/api/projects/:id/git/status", async (req) => git.status(projects.getProject(id(req.params)).path));
app.get("/api/projects/:id/git/log", async (req) => git.log(projects.getProject(id(req.params)).path));
app.get("/api/projects/:id/git/diff", async (req) => {
  const { file } = req.query as { file: string };
  return { diff: await git.diff(projects.getProject(id(req.params)).path, file) };
});
app.post("/api/projects/:id/git/commit", async (req) => {
  const { files, message } = req.body as { files: string[]; message: string };
  return { output: await git.commit(projects.getProject(id(req.params)).path, files, message) };
});
app.post("/api/projects/:id/git/push", async (req) => ({ output: await git.push(projects.getProject(id(req.params)).path) }));
app.post("/api/projects/:id/git/pull", async (req) => ({ output: await git.pull(projects.getProject(id(req.params)).path) }));

// ---------- 프롬프트 ----------
app.get("/api/projects/:id/prompts", async (req) =>
  db.prepare("SELECT * FROM prompts WHERE project_id = ? ORDER BY id DESC LIMIT 100").all(id(req.params)),
);

app.post("/api/projects/:id/prompts", async (req) => {
  const project = projects.getProject(id(req.params));
  const { question } = req.body as { question: string };
  if (!question?.trim()) throw projects.httpError(400, "내용을 입력해 주세요.");
  const info = db
    .prepare("INSERT INTO prompts(project_id, created_at, question) VALUES(?, ?, ?)")
    .run(project.id, nowIso(), question.trim());
  const promptId = Number(info.lastInsertRowid);
  const history = (
    db
      .prepare("SELECT question, answer FROM prompts WHERE project_id = ? AND id < ? AND answer != '' ORDER BY id DESC LIMIT 4")
      .all(project.id, promptId) as { question: string; answer: string }[]
  ).reverse();
  try {
    const r = await ai.answerPrompt(project.path, project.name, question.trim(), history);
    db.prepare("UPDATE prompts SET answer = ?, claude_code_prompt = ? WHERE id = ?").run(r.answer, r.claudeCodePrompt, promptId);
  } catch (e) {
    // 답변에 실패해도 작성한 글은 작업기록용으로 남긴다
    db.prepare("UPDATE prompts SET error = ? WHERE id = ?").run((e as Error).message, promptId);
  }
  return db.prepare("SELECT * FROM prompts WHERE id = ?").get(promptId);
});

app.delete("/api/prompts/:id", async (req) => {
  db.prepare("DELETE FROM prompts WHERE id = ?").run(id(req.params));
  return { ok: true };
});

// ---------- 남은 작업 / 확인할 것 ----------
app.get("/api/todos", async (req) => {
  const { projectId } = req.query as { projectId?: string };
  const sql = `SELECT t.*, p.name AS project_name FROM todos t JOIN projects p ON p.id = t.project_id
               ${projectId ? "WHERE t.project_id = ?" : ""}
               ORDER BY t.status = 'done', CASE WHEN t.status = 'done' THEN t.done_at END DESC, t.id DESC`;
  return projectId ? db.prepare(sql).all(Number(projectId)) : db.prepare(sql).all();
});

app.post("/api/todos", async (req) => {
  const { projectId, title, kind, note } = req.body as { projectId: number; title: string; kind?: string; note?: string };
  if (!title?.trim()) throw projects.httpError(400, "내용을 입력해 주세요.");
  const info = db
    .prepare("INSERT INTO todos(project_id, title, kind, note, created_at) VALUES(?, ?, ?, ?, ?)")
    .run(projectId, title.trim(), kind === "check" ? "check" : "task", note ?? "", nowIso());
  return db.prepare("SELECT * FROM todos WHERE id = ?").get(Number(info.lastInsertRowid));
});

app.patch("/api/todos/:id", async (req) => {
  const t = db.prepare("SELECT * FROM todos WHERE id = ?").get(id(req.params)) as Record<string, unknown> | undefined;
  if (!t) throw projects.httpError(404, "없는 항목입니다.");
  const b = req.body as { title?: string; kind?: string; note?: string; status?: string };
  const status = b.status ?? (t.status as string);
  const doneAt = status === "done" ? ((t.done_at as string | null) ?? nowIso()) : null;
  db.prepare("UPDATE todos SET title = ?, kind = ?, note = ?, status = ?, done_at = ? WHERE id = ?").run(
    b.title ?? (t.title as string),
    b.kind ?? (t.kind as string),
    b.note ?? (t.note as string),
    status,
    doneAt,
    id(req.params),
  );
  return db.prepare("SELECT * FROM todos WHERE id = ?").get(id(req.params));
});

app.delete("/api/todos/:id", async (req) => {
  db.prepare("DELETE FROM todos WHERE id = ?").run(id(req.params));
  return { ok: true };
});

// ---------- 작업 기록 ----------
app.get("/api/worklogs", async () => worklog.list());

app.post("/api/worklogs/refresh", async (req) => {
  const { date } = (req.body ?? {}) as { date?: string };
  if (date) {
    for (const p of projects.listProjects()) await worklog.generate(p, date, true);
  } else {
    await worklog.refreshRecent();
  }
  return worklog.list();
});

app.put("/api/worklogs/:date/:projectId", async (req) => {
  const { date, projectId } = req.params as { date: string; projectId: string };
  worklog.edit(date, Number(projectId), (req.body as { summary: string }).summary);
  return { ok: true };
});

// ---------- 화면 ----------
if (fs.existsSync(distDir)) {
  await app.register(fastifyStatic, { root: distDir });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) return reply.status(404).send({ error: "없는 API 입니다." });
    return reply.sendFile("index.html");
  });
}

worklog.startScheduler();

const shutdown = () => {
  runner.stopAll();
  worklog.stopScheduler();
  setTimeout(() => process.exit(0), 500);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: PORT, host: HOST });
console.log(`\n  프로젝트 관리 도구: http://localhost:${PORT}\n  데이터 위치: ${DATA_DIR}\n`);
