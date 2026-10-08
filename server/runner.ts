import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Project } from "./projects.js";

const isWin = process.platform === "win32";
const MAX_LINES = 3000;
const TASK_LABEL = { run: "실행", build: "빌드", clean: "클린 빌드" } as const;

export type Task = "run" | "build" | "clean";

export type LogLine = { seq: number; at: string; stream: "out" | "err" | "sys"; text: string };

type Proc = {
  child: ChildProcess | null;
  task: Task | null;
  startedAt: string | null;
  exitCode: number | null;
  lines: LogLine[];
  seq: number;
  events: EventEmitter;
};

const procs = new Map<number, Proc>();

function state(projectId: number): Proc {
  let p = procs.get(projectId);
  if (!p) {
    p = { child: null, task: null, startedAt: null, exitCode: null, lines: [], seq: 0, events: new EventEmitter() };
    p.events.setMaxListeners(50);
    procs.set(projectId, p);
  }
  return p;
}

function push(p: Proc, stream: LogLine["stream"], text: string) {
  const line: LogLine = { seq: ++p.seq, at: new Date().toISOString(), stream, text };
  p.lines.push(line);
  if (p.lines.length > MAX_LINES) p.lines.splice(0, p.lines.length - MAX_LINES);
  p.events.emit("line", line);
}

function pipe(p: Proc, stream: "out" | "err", src: NodeJS.ReadableStream | null) {
  if (!src) return;
  let buf = "";
  src.setEncoding("utf8");
  src.on("data", (chunk: string) => {
    buf += chunk;
    const parts = buf.split(/\r?\n/);
    buf = parts.pop() ?? "";
    for (const t of parts) push(p, stream, t);
  });
  src.on("end", () => {
    if (buf) push(p, stream, buf);
  });
}

export function status(projectId: number) {
  const p = state(projectId);
  return {
    running: !!p.child,
    task: p.task,
    pid: p.child?.pid ?? null,
    startedAt: p.startedAt,
    exitCode: p.exitCode,
  };
}

export function start(project: Project, task: Task) {
  const p = state(project.id);
  if (p.child) throw Object.assign(new Error("이미 실행 중입니다. 먼저 중지해 주세요."), { statusCode: 409 });
  const cmd = task === "run" ? project.run_cmd : task === "clean" ? project.clean_cmd : project.build_cmd;
  if (!cmd.trim()) throw Object.assign(new Error("실행 명령이 비어 있습니다. 설정에서 입력해 주세요."), { statusCode: 400 });

  push(p, "sys", `▶ ${TASK_LABEL[task]}: ${cmd}  (${project.path})`);
  const child = spawn(cmd, {
    cwd: project.path,
    shell: true,
    // 유닉스에서는 프로세스 그룹을 만들어 자식(java 등)까지 한 번에 종료
    detached: !isWin,
    env: {
      ...process.env,
      // 윈도우 콘솔 한글 깨짐 방지
      JAVA_TOOL_OPTIONS: [process.env.JAVA_TOOL_OPTIONS, "-Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8"]
        .filter(Boolean)
        .join(" "),
      FORCE_COLOR: "0",
    },
  });
  p.child = child;
  p.task = task;
  p.startedAt = new Date().toISOString();
  p.exitCode = null;
  pipe(p, "out", child.stdout);
  pipe(p, "err", child.stderr);
  child.on("error", (e) => push(p, "sys", `실행 오류: ${e.message}`));
  child.on("exit", (code, signal) => {
    p.exitCode = code;
    p.child = null;
    push(p, "sys", `■ 종료됨 (코드 ${code ?? "-"}${signal ? `, ${signal}` : ""})`);
    p.events.emit("status");
  });
  p.events.emit("status");
  return status(project.id);
}

export function stop(projectId: number) {
  const p = state(projectId);
  const child = p.child;
  if (!child?.pid) return status(projectId);
  push(p, "sys", "■ 중지 요청");
  if (isWin) {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    // 10초 안에 안 꺼지면 강제 종료
    setTimeout(() => {
      if (p.child === child && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* 이미 종료 */
        }
      }
    }, 10_000).unref();
  }
  return status(projectId);
}

export function clearLogs(projectId: number) {
  const p = state(projectId);
  p.lines = [];
}

export function logs(projectId: number, afterSeq = 0) {
  return state(projectId).lines.filter((l) => l.seq > afterSeq);
}

export function subscribe(projectId: number, onLine: (l: LogLine) => void, onStatus: () => void) {
  const p = state(projectId);
  p.events.on("line", onLine);
  p.events.on("status", onStatus);
  return () => {
    p.events.off("line", onLine);
    p.events.off("status", onStatus);
  };
}

export function stopAll() {
  for (const id of procs.keys()) stop(id);
}
