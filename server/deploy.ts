import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { db, nowIso } from "./db.js";
import { allFiles, resolveIn } from "./files.js";
import { httpError, type Project } from "./projects.js";

export const CATEGORIES = [
  { key: "config", label: "설정 (yml)" },
  { key: "log", label: "로그 설정" },
  { key: "sql", label: "DB 쿼리" },
  { key: "script", label: "스크립트" },
  { key: "service", label: "서비스 · 서버 설정" },
  { key: "artifact", label: "배포 파일 (war/jar)" },
  { key: "doc", label: "배포 문서" },
] as const;
export type Category = (typeof CATEGORIES)[number]["key"];

/** 파일 경로를 보고 배포 분류를 정한다. 해당 없으면 null */
function classify(rel: string): Category | null {
  const lower = rel.toLowerCase();
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  if (/(^|\/)(bin|build\/resources)\//.test(lower)) return null; // IDE/빌드 복사본 제외
  if (/^application.*\.(ya?ml|properties)(\.example)?$/.test(base)) return "config";
  if (/^logback.*\.xml$/.test(base) || /^log4j2?.*\.xml$/.test(base) || base === "logging.md") return "log";
  if (base.endsWith(".sql")) return "sql";
  if (/^(gradlew|mvnw)(\.bat|\.cmd)?$/.test(base)) return null; // 빌드 도구 래퍼 제외
  if (base.endsWith(".sh") || base.endsWith(".bat") || base.endsWith(".ps1")) return "script";
  if (base.endsWith(".service") || (base.endsWith(".conf") && /nginx|deploy/.test(lower))) return "service";
  if (/^deploy.*\.md$/.test(base) || (lower.startsWith("deploy/") && base.endsWith(".md"))) return "doc";
  return null;
}

/** Flyway 파일 이름에서 버전 번호 (V12__xxx.sql → 12) */
function sqlVersion(rel: string) {
  const m = rel.match(/(?:^|\/)V(\d+(?:[._]\d+)*)__/i);
  return m ? Number(m[1].replace(/_/g, ".")) : null;
}

function hashFile(abs: string) {
  return crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
}

// war/jar sha256 은 크고 느리므로 (경로, 수정시각, 크기) 기준으로 캐시
const shaCache = new Map<string, { key: string; sha: string }>();
function cachedSha(abs: string, st: fs.Stats) {
  const key = `${st.mtimeMs}:${st.size}`;
  const c = shaCache.get(abs);
  if (c?.key === key) return c.sha;
  const sha = hashFile(abs);
  shaCache.set(abs, { key, sha });
  return sha;
}

function findArtifacts(root: string) {
  const out: string[] = [];
  for (const dir of ["build/libs", "target", "deploy", "dist"]) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      if (/\.(war|jar)$/i.test(name) && !/-plain\.(jar|war)$/i.test(name)) out.push(`${dir}/${name}`);
    }
  }
  return out;
}

export type DeployFile = {
  path: string;
  category: Category;
  size: number;
  mtime: string;
  hash: string;
  sqlVersion: number | null;
  custom: boolean;
  /** 마지막 배포 기록 이후 상태: new(새로 생김) / changed(바뀜) / same / null(배포 기록 없음) */
  since: "new" | "changed" | "same" | null;
  sha256?: string;
};

function lastSnapshot(projectId: number): Record<string, string> | null {
  const row = db.prepare("SELECT snapshot FROM deployments WHERE project_id = ? ORDER BY deployed_at DESC, id DESC LIMIT 1").get(projectId) as
    | { snapshot: string }
    | undefined;
  return row ? (JSON.parse(row.snapshot) as Record<string, string>) : null;
}

export function scan(project: Project): DeployFile[] {
  const root = project.path;
  const found = new Map<string, { category: Category; custom: boolean }>();
  for (const rel of allFiles(root)) {
    const c = classify(rel);
    if (c) found.set(rel, { category: c, custom: false });
  }
  for (const rel of findArtifacts(root)) found.set(rel, { category: "artifact", custom: false });
  const customs = db.prepare("SELECT path, category FROM deploy_files WHERE project_id = ?").all(project.id) as { path: string; category: Category }[];
  for (const c of customs) found.set(c.path, { category: c.category, custom: true });

  const snap = lastSnapshot(project.id);
  const result: DeployFile[] = [];
  for (const [rel, info] of found) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    const st = fs.statSync(abs);
    const isArtifact = info.category === "artifact";
    const hash = isArtifact ? cachedSha(abs, st) : hashFile(abs);
    result.push({
      path: rel,
      category: info.category,
      size: st.size,
      mtime: st.mtime.toISOString(),
      hash,
      sqlVersion: info.category === "sql" ? sqlVersion(rel) : null,
      custom: info.custom,
      since: snap == null || isArtifact ? null : !(rel in snap) ? "new" : snap[rel] !== hash ? "changed" : "same",
      sha256: isArtifact ? hash : undefined,
    });
  }
  return result.sort((a, b) =>
    a.category === "sql" && b.category === "sql"
      ? (a.sqlVersion ?? 1e9) - (b.sqlVersion ?? 1e9) || a.path.localeCompare(b.path)
      : a.path.localeCompare(b.path),
  );
}

export function addCustom(project: Project, rel: string, category: Category) {
  const abs = resolveIn(project.path, rel);
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) throw httpError(400, `파일이 없습니다: ${rel}`);
  const norm = path.relative(project.path, abs).split(path.sep).join("/");
  db.prepare("INSERT OR REPLACE INTO deploy_files(project_id, path, category) VALUES(?, ?, ?)").run(project.id, norm, category);
}

export function removeCustom(projectId: number, rel: string) {
  db.prepare("DELETE FROM deploy_files WHERE project_id = ? AND path = ?").run(projectId, rel);
}

// ---------- 배포 기록 ----------

export const DEFAULT_CHECKLIST = [
  "클린 빌드 완료",
  "war/jar 파일 확인 (크기, sha256)",
  "운영 yml 설정 확인",
  "새 SQL 적용",
  "서버에 업로드",
  "서비스 재시작",
  "동작 확인 (verify)",
  "로그 확인",
];

type DeploymentRow = {
  id: number;
  project_id: number;
  deployed_at: string;
  version: string;
  artifact: string;
  target: string;
  sqls: string;
  scripts: string;
  checklist: string;
  memo: string;
  snapshot: string;
  created_at: string;
};

const parse = (r: DeploymentRow) => ({
  ...r,
  sqls: JSON.parse(r.sqls) as string[],
  scripts: JSON.parse(r.scripts) as string[],
  checklist: JSON.parse(r.checklist) as { text: string; done: boolean }[],
  snapshot: undefined,
});

export function listDeployments(projectId: number) {
  return (db.prepare("SELECT * FROM deployments WHERE project_id = ? ORDER BY deployed_at DESC, id DESC").all(projectId) as DeploymentRow[]).map(parse);
}

export type DeploymentInput = {
  deployed_at?: string;
  version?: string;
  artifact?: string;
  target?: string;
  sqls?: string[];
  scripts?: string[];
  checklist?: { text: string; done: boolean }[];
  memo?: string;
};

export function createDeployment(project: Project, d: DeploymentInput) {
  // 기록하는 시점의 배포 파일 상태를 저장해 두고, 다음 배포 때 "바뀐 것"을 비교한다
  const snapshot: Record<string, string> = {};
  for (const f of scan(project)) if (f.category !== "artifact") snapshot[f.path] = f.hash;
  const info = db
    .prepare(
      `INSERT INTO deployments(project_id, deployed_at, version, artifact, target, sqls, scripts, checklist, memo, snapshot, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      project.id,
      d.deployed_at || nowIso(),
      d.version ?? "",
      d.artifact ?? "",
      d.target ?? "",
      JSON.stringify(d.sqls ?? []),
      JSON.stringify(d.scripts ?? []),
      JSON.stringify(d.checklist ?? DEFAULT_CHECKLIST.map((text) => ({ text, done: false }))),
      d.memo ?? "",
      JSON.stringify(snapshot),
      nowIso(),
    );
  return parse(db.prepare("SELECT * FROM deployments WHERE id = ?").get(Number(info.lastInsertRowid)) as DeploymentRow);
}

export function updateDeployment(id: number, d: DeploymentInput) {
  const row = db.prepare("SELECT * FROM deployments WHERE id = ?").get(id) as DeploymentRow | undefined;
  if (!row) throw httpError(404, "없는 배포 기록입니다.");
  db.prepare(
    "UPDATE deployments SET deployed_at = ?, version = ?, artifact = ?, target = ?, sqls = ?, scripts = ?, checklist = ?, memo = ? WHERE id = ?",
  ).run(
    d.deployed_at ?? row.deployed_at,
    d.version ?? row.version,
    d.artifact ?? row.artifact,
    d.target ?? row.target,
    d.sqls ? JSON.stringify(d.sqls) : row.sqls,
    d.scripts ? JSON.stringify(d.scripts) : row.scripts,
    d.checklist ? JSON.stringify(d.checklist) : row.checklist,
    d.memo ?? row.memo,
    id,
  );
  return parse(db.prepare("SELECT * FROM deployments WHERE id = ?").get(id) as DeploymentRow);
}

export function deleteDeployment(id: number) {
  db.prepare("DELETE FROM deployments WHERE id = ?").run(id);
}

// ---------- Tailscale 프로그램으로 넘기기 ----------

export const UPLOAD_SCHEME = "ulsan-tailscale";

/** Tailscale 관리 프로그램을 열고 올릴 파일을 넘긴다 (프로그램이 ulsan-tailscale:// 주소를 받도록 등록되어 있어야 함) */
export function openUpload(project: Project, rel: string, remoteDir?: string) {
  const abs = resolveIn(project.path, rel);
  if (!fs.existsSync(abs)) throw httpError(400, `파일이 없습니다: ${rel}`);
  const q = new URLSearchParams({ file: abs, project: project.name });
  if (remoteDir) q.set("remoteDir", remoteDir);
  const url = `${UPLOAD_SCHEME}://upload?${q.toString()}`;

  return new Promise<{ url: string }>((resolve, reject) => {
    const child =
      process.platform === "win32"
        ? spawn("cmd", ["/c", "start", '""', url.replace(/&/g, "^&")], { windowsVerbatimArguments: true })
        : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url]);
    let err = "";
    child.stderr?.on("data", (d) => (err += d));
    child.on("error", () => reject(httpError(400, "Tailscale 프로그램을 열지 못했습니다. 설치되어 있는지 확인해 주세요.")));
    child.on("exit", (code) => {
      if (code === 0) resolve({ url });
      else reject(httpError(400, "Tailscale 프로그램이 설치되어 있지 않거나 아직 연결 기능이 없습니다." + (err ? `\n${err.trim()}` : "")));
    });
  });
}
