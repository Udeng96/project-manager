import fs from "node:fs";
import path from "node:path";
import { httpError } from "./projects.js";

// 기본으로 숨기는 폴더 (코드 탭의 "숨김 폴더 보기"를 켜면 보임)
export const HIDDEN_DIRS = new Set([".git", "node_modules", "build", "dist", "target", ".gradle", ".idea", "bin", "out", ".vscode", ".next"]);
const MAX_VIEW = 2 * 1024 * 1024;

/** 프로젝트 폴더 밖으로 나가는 경로를 막는다 */
export function resolveIn(root: string, rel: string) {
  const abs = path.resolve(root, rel || ".");
  const r = path.relative(root, abs);
  if (r.startsWith("..") || path.isAbsolute(r)) throw httpError(400, "프로젝트 폴더 밖은 볼 수 없습니다.");
  return abs;
}

const toRel = (root: string, abs: string) => path.relative(root, abs).split(path.sep).join("/");

export type Entry = { name: string; path: string; dir: boolean; size?: number };

export function listDir(root: string, rel: string, showHidden: boolean): Entry[] {
  const abs = resolveIn(root, rel);
  const ents = fs.readdirSync(abs, { withFileTypes: true });
  return ents
    .filter((e) => showHidden || !(e.isDirectory() && HIDDEN_DIRS.has(e.name)))
    .filter((e) => e.name !== ".DS_Store")
    .map((e) => {
      const p = path.join(abs, e.name);
      const dir = e.isDirectory();
      return { name: e.name, path: toRel(root, p), dir, size: dir ? undefined : safeSize(p) };
    })
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}

function safeSize(p: string) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

export function readText(root: string, rel: string) {
  const abs = resolveIn(root, rel);
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) throw httpError(404, "파일이 없습니다.");
  const st = fs.statSync(abs);
  if (st.size > MAX_VIEW) return { path: rel, binary: false, tooLarge: true, size: st.size, content: "" };
  const buf = fs.readFileSync(abs);
  const binary = buf.subarray(0, 8000).includes(0);
  return { path: rel, binary, tooLarge: false, size: st.size, mtime: st.mtime.toISOString(), content: binary ? "" : buf.toString("utf8") };
}

/** 숨김 폴더를 뺀 모든 파일 경로 (파일 이름 찾기용) */
export function allFiles(root: string, limit = 20000) {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (out.length >= limit) return;
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (HIDDEN_DIRS.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else out.push(toRel(root, abs));
      if (out.length >= limit) return;
    }
  };
  walk(root);
  return out;
}

export function findFiles(root: string, q: string) {
  const needle = q.toLowerCase().replace(/\s+/g, "");
  if (!needle) return [];
  // 파일 이름에 포함 > 경로에 포함 > 글자 순서대로 포함(IntelliJ 식) 순으로 정렬
  const fuzzy = (s: string) => {
    let i = 0;
    for (const ch of s) if (ch === needle[i]) i++;
    return i === needle.length;
  };
  const scored: { p: string; s: number }[] = [];
  for (const p of allFiles(root)) {
    const lower = p.toLowerCase();
    const base = lower.slice(lower.lastIndexOf("/") + 1);
    const s = base.startsWith(needle) ? 0 : base.includes(needle) ? 1 : lower.includes(needle) ? 2 : fuzzy(base) ? 3 : -1;
    if (s >= 0) scored.push({ p, s });
  }
  return scored
    .sort((a, b) => a.s - b.s || a.p.length - b.p.length)
    .slice(0, 50)
    .map((x) => x.p);
}

export type Hit = { path: string; line: number; text: string };

export function searchText(root: string, q: string, limit = 300): Hit[] {
  if (!q) return [];
  const needle = q.toLowerCase();
  const hits: Hit[] = [];
  for (const rel of allFiles(root)) {
    if (hits.length >= limit) break;
    const abs = path.join(root, rel);
    let buf: Buffer;
    try {
      if (fs.statSync(abs).size > 1024 * 1024) continue;
      buf = fs.readFileSync(abs);
    } catch {
      continue;
    }
    if (buf.subarray(0, 8000).includes(0)) continue;
    const lines = buf.toString("utf8").split("\n");
    for (let i = 0; i < lines.length && hits.length < limit; i++) {
      if (lines[i].toLowerCase().includes(needle)) hits.push({ path: rel, line: i + 1, text: lines[i].trim().slice(0, 240) });
    }
  }
  return hits;
}
