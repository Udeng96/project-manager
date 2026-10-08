import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 데이터는 PC마다 따로 저장 (회사 PC, 집 PC 각각)
export const DATA_DIR = process.env.PM_DATA_DIR ?? path.join(os.homedir(), ".project-manager");
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, "data.db"));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  path        TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL,
  run_cmd     TEXT NOT NULL DEFAULT '',
  build_cmd   TEXT NOT NULL DEFAULT '',
  clean_cmd   TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prompts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id        INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at        TEXT NOT NULL,
  question          TEXT NOT NULL,
  answer            TEXT NOT NULL DEFAULT '',
  claude_code_prompt TEXT NOT NULL DEFAULT '',
  error             TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS todos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'task',   -- task: 남은 작업, check: 확인할 것
  note        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open',   -- open | done
  created_at  TEXT NOT NULL,
  done_at     TEXT
);

-- 날짜별, 프로젝트별 작업 기록. source_hash 로 원본(프롬프트/커밋/완료 작업)이 바뀌었는지 판단
CREATE TABLE IF NOT EXISTS worklogs (
  date         TEXT NOT NULL,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  summary      TEXT NOT NULL,
  source_hash  TEXT NOT NULL,
  edited       INTEGER NOT NULL DEFAULT 0,
  generated_at TEXT NOT NULL,
  PRIMARY KEY (date, project_id)
);

-- 자동으로 못 찾는 배포 파일을 직접 등록
CREATE TABLE IF NOT EXISTS deploy_files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  category    TEXT NOT NULL,
  UNIQUE (project_id, path)
);

-- 배포 기록. snapshot 은 배포 당시 배포 관련 파일들의 해시 (다음 배포 때 바뀐 것 표시용)
CREATE TABLE IF NOT EXISTS deployments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  deployed_at  TEXT NOT NULL,
  version      TEXT NOT NULL DEFAULT '',
  artifact     TEXT NOT NULL DEFAULT '',
  target       TEXT NOT NULL DEFAULT '',
  sqls         TEXT NOT NULL DEFAULT '[]',
  scripts      TEXT NOT NULL DEFAULT '[]',
  checklist    TEXT NOT NULL DEFAULT '[]',
  memo         TEXT NOT NULL DEFAULT '',
  snapshot     TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// 이전 버전 DB 에 새 컬럼 추가
const projectCols = (db.prepare("PRAGMA table_info(projects)").all() as { name: string }[]).map((c) => c.name);
if (!projectCols.includes("clean_cmd")) db.exec("ALTER TABLE projects ADD COLUMN clean_cmd TEXT NOT NULL DEFAULT ''");

export function getSetting(key: string): string | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string) {
  db.prepare("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function nowIso() {
  return new Date().toISOString();
}

/** 로컬 시간 기준 YYYY-MM-DD */
export function localDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
