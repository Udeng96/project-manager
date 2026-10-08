import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { httpError } from "./projects.js";

type GitResult = { stdout: string; stderr: string; code: number };

export function git(cwd: string, args: string[], timeoutMs = 60_000): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-c", "core.quotepath=false", "-c", "color.ui=false", ...args],
      { cwd, maxBuffer: 20 * 1024 * 1024, timeout: timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
        resolve({ stdout: String(stdout), stderr: String(stderr) || (err && !stderr ? err.message : ""), code });
      },
    );
  });
}

async function must(cwd: string, args: string[], timeoutMs?: number) {
  const r = await git(cwd, args, timeoutMs);
  if (r.code !== 0) throw httpError(400, (r.stderr || r.stdout).trim() || `git ${args[0]} 실패`);
  return r.stdout;
}

export async function isRepo(cwd: string) {
  const r = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return r.code === 0 && r.stdout.trim() === "true";
}

export type FileChange = { path: string; index: string; worktree: string; untracked: boolean };

export async function status(cwd: string) {
  if (!(await isRepo(cwd))) return { repo: false as const };
  const out = await must(cwd, ["status", "--porcelain=v1", "-b", "-z", "--untracked-files=all"]);
  const entries = out.split("\0").filter(Boolean);
  let branch = "";
  let ahead = 0;
  let behind = 0;
  let upstream: string | null = null;
  const files: FileChange[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.startsWith("## ")) {
      // 예: ## main...origin/main [ahead 1, behind 2]
      const m = e.slice(3).match(/^(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/);
      branch = m?.[1] ?? e.slice(3);
      upstream = m?.[2] ?? null;
      ahead = Number(m?.[3]?.match(/ahead (\d+)/)?.[1] ?? 0);
      behind = Number(m?.[3]?.match(/behind (\d+)/)?.[1] ?? 0);
      continue;
    }
    const x = e[0];
    const y = e[1];
    const file = e.slice(3);
    if (x === "R" || x === "C") i++; // 이름 변경은 원래 경로가 다음 항목에 붙어 온다
    files.push({ path: file, index: x, worktree: y, untracked: x === "?" });
  }
  return { repo: true as const, branch, upstream, ahead, behind, files };
}

export async function diff(cwd: string, file: string) {
  const st = await git(cwd, ["status", "--porcelain=v1", "--", file]);
  if (st.stdout.startsWith("??")) {
    // 새 파일은 내용 전체를 추가로 보여준다
    const abs = path.join(cwd, file);
    const text = fs.statSync(abs).size > 512 * 1024 ? "(파일이 너무 커서 표시하지 않습니다)" : fs.readFileSync(abs, "utf8");
    return `새 파일: ${file}\n` + text.split("\n").map((l) => `+${l}`).join("\n");
  }
  const r = await git(cwd, ["diff", "HEAD", "--", file]);
  if (r.code === 0) return r.stdout || "(변경 내용 없음)";
  // 첫 커밋 전에는 HEAD 가 없다
  return (await git(cwd, ["diff", "--cached", "--", file])).stdout;
}

export async function commit(cwd: string, files: string[], message: string) {
  if (!message.trim()) throw httpError(400, "커밋 메시지를 입력해 주세요.");
  if (!files.length) throw httpError(400, "커밋할 파일을 선택해 주세요.");
  await must(cwd, ["reset", "-q"]).catch(() => undefined); // 이전에 스테이징된 것 정리 (첫 커밋 전엔 실패할 수 있음)
  await must(cwd, ["add", "-A", "--", ...files]);
  const out = await must(cwd, ["commit", "-m", message]);
  return out.trim();
}

export async function push(cwd: string) {
  const st = await status(cwd);
  if (!st.repo) throw httpError(400, "git 저장소가 아닙니다.");
  const args = st.upstream ? ["push"] : ["push", "-u", "origin", "HEAD"];
  const r = await git(cwd, args, 120_000);
  if (r.code !== 0) throw httpError(400, (r.stderr || r.stdout).trim());
  return (r.stderr + r.stdout).trim() || "푸쉬 완료";
}

export async function pull(cwd: string) {
  const r = await git(cwd, ["pull", "--ff-only"], 120_000);
  if (r.code !== 0) throw httpError(400, (r.stderr || r.stdout).trim());
  return (r.stdout + r.stderr).trim();
}

export type Commit = { hash: string; author: string; email: string; date: string; subject: string };

const SEP = "\x1f";
const FMT = ["%H", "%an", "%ae", "%aI", "%s"].join(SEP);

function parseLog(out: string): Commit[] {
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [hash, author, email, date, subject] = l.split(SEP);
      return { hash, author, email, date, subject };
    });
}

export async function log(cwd: string, limit = 50) {
  if (!(await isRepo(cwd))) return [];
  const r = await git(cwd, ["log", `-n${limit}`, `--pretty=format:${FMT}`]);
  return r.code === 0 ? parseLog(r.stdout) : [];
}

/** 특정 날짜(로컬)의 내 커밋과 변경 파일 목록 */
export async function commitsOn(cwd: string, date: string) {
  if (!(await isRepo(cwd))) return [];
  const email = (await git(cwd, ["config", "user.email"])).stdout.trim();
  const args = [
    "log",
    "--all",
    `--since=${date} 00:00:00`,
    `--until=${date} 23:59:59`,
    `--pretty=format:${FMT}`,
  ];
  if (email) args.push(`--author=${email}`);
  const r = await git(cwd, args);
  if (r.code !== 0) return [];
  const commits = parseLog(r.stdout);
  const result: (Commit & { files: string[] })[] = [];
  for (const c of commits) {
    const f = await git(cwd, ["show", "--name-only", "--pretty=format:", c.hash]);
    result.push({ ...c, files: f.stdout.split("\n").filter(Boolean).slice(0, 30) });
  }
  return result;
}
