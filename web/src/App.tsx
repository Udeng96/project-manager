import { useCallback, useEffect, useState } from "react";
import { api, type OpenRequest, type Project, type Settings } from "./api";
import RunPanel from "./pages/RunPanel";
import GitPanel from "./pages/GitPanel";
import PromptPanel from "./pages/PromptPanel";
import TodoPanel from "./pages/TodoPanel";
import WorklogPage from "./pages/WorklogPage";
import SettingsPage from "./pages/SettingsPage";
import ProjectSettings from "./pages/ProjectSettings";
import CodePanel from "./pages/CodePanel";
import DeployPanel from "./pages/DeployPanel";

type View = { kind: "project"; id: number } | { kind: "worklog" } | { kind: "todos" } | { kind: "settings" };
type Tab = "ops" | "code" | "deploy" | "prompt" | "todo" | "flow" | "suggest" | "config";

const TABS: { key: Tab; label: string; later?: string }[] = [
  { key: "ops", label: "실행 · 형상관리" },
  { key: "code", label: "코드" },
  { key: "deploy", label: "배포" },
  { key: "prompt", label: "프롬프트" },
  { key: "todo", label: "남은 작업" },
  { key: "flow", label: "구조 흐름도", later: "2단계" },
  { key: "suggest", label: "개선 제안", later: "3단계" },
  { key: "config", label: "프로젝트 설정" },
];

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [view, setView] = useState<View>({ kind: "worklog" });
  const [tab, setTab] = useState<Tab>("ops");
  const [adding, setAdding] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [openRequest, setOpenRequest] = useState<OpenRequest | null>(null);

  // 다른 화면에서 파일을 누르면 코드 탭으로 이동해서 연다
  const openInCode = useCallback((path: string, line?: number) => {
    setOpenRequest({ path, line, nonce: Date.now() });
    setTab("code");
  }, []);

  const load = useCallback(async () => {
    const list = await api.get<Project[]>("/api/projects");
    setProjects(list);
    return list;
  }, []);

  useEffect(() => {
    load().then((list) => list.length && setView({ kind: "project", id: list[0].id }));
    api.get<Settings>("/api/settings").then(setSettings);
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const current = view.kind === "project" ? projects.find((p) => p.id === view.id) : undefined;

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">프로젝트 관리</div>
        <div className="side-label">프로젝트</div>
        {projects.map((p) => (
          <button
            key={p.id}
            className={"side-item" + (view.kind === "project" && view.id === p.id ? " active" : "")}
            onClick={() => {
              setView({ kind: "project", id: p.id });
              setOpenRequest(null);
            }}
            title={p.path}
          >
            <span className={"dot" + (p.status.running ? " on" : "")} />
            {p.name}
            <span className="kind">{p.kind}</span>
          </button>
        ))}
        <button className="side-item add" onClick={() => setAdding(true)}>
          + 프로젝트 추가
        </button>

        <div className="side-label">전체</div>
        <button className={"side-item" + (view.kind === "worklog" ? " active" : "")} onClick={() => setView({ kind: "worklog" })}>
          날짜별 작업 기록
        </button>
        <button className={"side-item" + (view.kind === "todos" ? " active" : "")} onClick={() => setView({ kind: "todos" })}>
          전체 남은 작업
        </button>
        <button className={"side-item" + (view.kind === "settings" ? " active" : "")} onClick={() => setView({ kind: "settings" })}>
          설정 {settings && !settings.hasApiKey && <span className="warn-badge">API 키 필요</span>}
        </button>
      </aside>

      <main className="main">
        {view.kind === "project" && current && (
          <>
            <header className="page-head">
              <div>
                <h1>{current.name}</h1>
                <div className="muted mono">{current.path}</div>
              </div>
            </header>
            <nav className="tabs">
              {TABS.map((t) => (
                <button key={t.key} className={"tab" + (tab === t.key ? " active" : "")} onClick={() => setTab(t.key)}>
                  {t.label}
                  {t.later && <span className="later">{t.later}</span>}
                </button>
              ))}
            </nav>
            <section className="tab-body">
              {tab === "ops" && (
                <div className="ops">
                  <RunPanel key={`run-${current.id}`} project={current} onChange={load} />
                  <GitPanel key={`git-${current.id}`} project={current} onOpenInCode={openInCode} />
                </div>
              )}
              {/* 코드 탭은 열린 파일 탭을 유지하도록 숨기기만 한다 */}
              <div style={{ display: tab === "code" ? "block" : "none" }}>
                <CodePanel key={current.id} project={current} openRequest={openRequest} visible={tab === "code"} />
              </div>
              {tab === "deploy" && <DeployPanel key={current.id} project={current} onOpenInCode={openInCode} />}
              {tab === "prompt" && <PromptPanel key={current.id} project={current} hasApiKey={!!settings?.hasApiKey} onOpenInCode={openInCode} />}
              {tab === "todo" && <TodoPanel key={current.id} projectId={current.id} projects={projects} />}
              {(tab === "flow" || tab === "suggest") && (
                <div className="empty">
                  {tab === "flow" ? "구조 흐름도는 2단계에서 만듭니다." : "개선 제안은 3단계에서 만듭니다."}
                </div>
              )}
              {tab === "config" && (
                <ProjectSettings
                  key={current.id}
                  project={current}
                  onSaved={load}
                  onDeleted={async () => {
                    const list = await load();
                    setView(list.length ? { kind: "project", id: list[0].id } : { kind: "worklog" });
                  }}
                />
              )}
            </section>
          </>
        )}
        {view.kind === "worklog" && <WorklogPage />}
        {view.kind === "todos" && <TodoPanel projects={projects} />}
        {view.kind === "settings" && (
          <SettingsPage settings={settings} onSaved={() => api.get<Settings>("/api/settings").then(setSettings)} />
        )}
      </main>

      {adding && (
        <AddProject
          onClose={() => setAdding(false)}
          onAdded={async (p) => {
            setAdding(false);
            await load();
            setView({ kind: "project", id: p.id });
            setTab("ops");
          }}
        />
      )}
    </div>
  );
}

function AddProject({ onClose, onAdded }: { onClose: () => void; onAdded: (p: Project) => void }) {
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      onAdded(await api.post<Project>("/api/projects", { path, name }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>프로젝트 추가</h2>
        <label>
          프로젝트 폴더 경로
          <input
            autoFocus
            className="mono"
            placeholder="예: C:\work\ulsan\gis 또는 /Users/me/work/ulsan/gis"
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
        </label>
        <label>
          이름 (비워 두면 폴더 이름)
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <p className="muted small">gradle, maven, pnpm/npm 프로젝트는 실행·빌드 명령을 자동으로 채웁니다.</p>
        {error && <div className="error">{error}</div>}
        <div className="row end">
          <button type="button" className="btn ghost" onClick={onClose}>
            취소
          </button>
          <button className="btn primary" disabled={!path.trim() || busy}>
            추가
          </button>
        </div>
      </form>
    </div>
  );
}
