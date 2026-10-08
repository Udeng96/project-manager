import fs from "node:fs";
import path from "node:path";
import { db, nowIso } from "./db.js";

export type Project = {
  id: number;
  name: string;
  path: string;
  kind: string;
  run_cmd: string;
  build_cmd: string;
  created_at: string;
};

const isWin = process.platform === "win32";

/** 폴더 안의 빌드 파일을 보고 프로젝트 종류와 기본 실행/빌드 명령을 정한다 */
export function detect(dir: string): { kind: string; run_cmd: string; build_cmd: string } {
  const has = (f: string) => fs.existsSync(path.join(dir, f));

  if (has("build.gradle") || has("build.gradle.kts")) {
    const g = has("gradlew") ? (isWin ? "gradlew.bat" : "./gradlew") : "gradle";
    return { kind: "gradle", run_cmd: `${g} bootRun`, build_cmd: `${g} build` };
  }
  if (has("pom.xml")) {
    const m = has("mvnw") ? (isWin ? "mvnw.cmd" : "./mvnw") : "mvn";
    return { kind: "maven", run_cmd: `${m} spring-boot:run`, build_cmd: `${m} package` };
  }
  if (has("package.json")) {
    const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "npm run";
    return { kind: "node", run_cmd: `${pm} dev`, build_cmd: `${pm} build` };
  }
  return { kind: "unknown", run_cmd: "", build_cmd: "" };
}

export function listProjects(): Project[] {
  return db.prepare("SELECT * FROM projects ORDER BY name").all() as Project[];
}

export function getProject(id: number): Project {
  const p = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Project | undefined;
  if (!p) throw httpError(404, "프로젝트를 찾을 수 없습니다.");
  return p;
}

export function addProject(rawPath: string, name?: string): Project {
  const dir = path.resolve(rawPath.trim());
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw httpError(400, `폴더가 없습니다: ${dir}`);
  }
  const exists = db.prepare("SELECT id FROM projects WHERE path = ?").get(dir);
  if (exists) throw httpError(409, "이미 등록된 폴더입니다.");

  const d = detect(dir);
  const info = db
    .prepare("INSERT INTO projects(name, path, kind, run_cmd, build_cmd, created_at) VALUES(?, ?, ?, ?, ?, ?)")
    .run(name?.trim() || path.basename(dir), dir, d.kind, d.run_cmd, d.build_cmd, nowIso());
  return getProject(Number(info.lastInsertRowid));
}

export function updateProject(id: number, patch: Partial<Pick<Project, "name" | "run_cmd" | "build_cmd">>) {
  const p = getProject(id);
  db.prepare("UPDATE projects SET name = ?, run_cmd = ?, build_cmd = ? WHERE id = ?").run(
    patch.name ?? p.name,
    patch.run_cmd ?? p.run_cmd,
    patch.build_cmd ?? p.build_cmd,
    id,
  );
  return getProject(id);
}

export function removeProject(id: number) {
  db.prepare("DELETE FROM projects WHERE id = ?").run(id);
}

export function httpError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}
