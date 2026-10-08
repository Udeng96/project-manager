import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { api, fmtSize, type FileContent, type FsEntry, type GitStatus, type Hit, type OpenRequest, type Project } from "../api";
import { languageOf } from "../monaco";

type OpenFile = FileContent & { line?: number };
type ChangeMap = Map<string, "new" | "mod" | "del">;

export default function CodePanel({ project, openRequest, visible }: { project: Project; openRequest: OpenRequest | null; visible: boolean }) {
  const [showHidden, setShowHidden] = useState(false);
  const [mode, setMode] = useState<"tree" | "search">("tree");
  const [tabs, setTabs] = useState<OpenFile[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [changes, setChanges] = useState<ChangeMap>(new Map());
  const [quickOpen, setQuickOpen] = useState(false);
  const [error, setError] = useState("");
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

  // git 변경 파일을 트리에 색으로 표시
  useEffect(() => {
    api.get<GitStatus>(`/api/projects/${project.id}/git/status`).then((s) => {
      const m: ChangeMap = new Map();
      if (s.repo)
        for (const f of s.files) {
          const c = f.untracked || f.index === "A" ? "new" : f.worktree === "D" || f.index === "D" ? "del" : "mod";
          m.set(f.path.replace(/\/$/, ""), c);
        }
      setChanges(m);
    });
  }, [project.id]);

  const open = useCallback(
    async (path: string, line?: number) => {
      setError("");
      const existing = tabs.find((t) => t.path === path);
      if (existing) {
        setTabs((prev) => prev.map((t) => (t.path === path ? { ...t, line } : t)));
        setActive(path);
        return;
      }
      try {
        const f = await api.get<FileContent>(`/api/projects/${project.id}/fs/file?path=${encodeURIComponent(path)}`);
        setTabs((prev) => [...prev.filter((t) => t.path !== path), { ...f, line }]);
        setActive(path);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [project.id, tabs],
  );

  // 다른 화면(형상관리, 프롬프트, 배포)에서 온 열기 요청
  const lastNonce = useRef(0);
  useEffect(() => {
    if (openRequest && openRequest.nonce !== lastNonce.current) {
      lastNonce.current = openRequest.nonce;
      open(openRequest.path, openRequest.line);
    }
  }, [openRequest, open]);

  // Ctrl+P / Cmd+P 로 파일 찾기
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setQuickOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible]);

  const current = tabs.find((t) => t.path === active) ?? null;

  // 줄 번호로 이동
  useEffect(() => {
    const ed = editorRef.current;
    if (ed && current?.line) {
      ed.revealLineInCenter(current.line);
      ed.setSelection({ startLineNumber: current.line, startColumn: 1, endLineNumber: current.line, endColumn: 1000 });
    }
  }, [current?.path, current?.line]);

  const close = (path: string) => {
    setTabs((prev) => {
      const next = prev.filter((t) => t.path !== path);
      if (active === path) setActive(next.at(-1)?.path ?? null);
      return next;
    });
  };

  return (
    <div className="code">
      <div className="code-side">
        <div className="code-side-head">
          <div className="seg">
            <button className={mode === "tree" ? "on" : ""} onClick={() => setMode("tree")}>
              폴더
            </button>
            <button className={mode === "search" ? "on" : ""} onClick={() => setMode("search")}>
              검색
            </button>
          </div>
          <button className="btn small ghost" onClick={() => setQuickOpen(true)} title="Ctrl+P / Cmd+P">
            파일 찾기
          </button>
        </div>
        {mode === "tree" ? (
          <>
            <label className="check small pad">
              <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> build, node_modules 등 보기
            </label>
            <div className="tree">
              <TreeDir key={String(showHidden)} project={project} dir="" depth={0} showHidden={showHidden} changes={changes} active={active} onOpen={open} initiallyOpen />
            </div>
          </>
        ) : (
          <SearchPane project={project} onOpen={open} />
        )}
      </div>

      <div className="code-main">
        <div className="code-tabs">
          {tabs.map((t) => (
            <div key={t.path} className={"code-tab" + (t.path === active ? " active" : "")} onClick={() => setActive(t.path)} title={t.path}>
              <span className={"fname " + (changes.get(t.path) ?? "")}>{t.path.split("/").pop()}</span>
              <button
                className="x"
                onClick={(e) => {
                  e.stopPropagation();
                  close(t.path);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        {error && <div className="error">{error}</div>}
        {current ? (
          <>
            <div className="code-path mono small muted">
              {current.path} · {fmtSize(current.size)} · 읽기 전용
            </div>
            {current.binary || current.tooLarge ? (
              <div className="empty">{current.binary ? "바이너리 파일이라 내용을 표시하지 않습니다." : "파일이 너무 커서(2MB 초과) 표시하지 않습니다."}</div>
            ) : (
              <Editor
                height="calc(100vh - 250px)"
                path={current.path}
                language={languageOf(current.path)}
                value={current.content}
                theme="vs"
                onMount={(ed) => {
                  editorRef.current = ed;
                  if (current.line) {
                    ed.revealLineInCenter(current.line);
                    ed.setSelection({ startLineNumber: current.line, startColumn: 1, endLineNumber: current.line, endColumn: 1000 });
                  }
                }}
                options={{ readOnly: true, domReadOnly: true, minimap: { enabled: true }, fontSize: 13, scrollBeyondLastLine: false, renderWhitespace: "selection" }}
              />
            )}
          </>
        ) : (
          <div className="empty">왼쪽에서 파일을 고르거나 Ctrl+P(맥은 Cmd+P)로 파일 이름을 찾아 여세요.</div>
        )}
      </div>

      {quickOpen && <QuickOpen project={project} onClose={() => setQuickOpen(false)} onPick={(p) => (setQuickOpen(false), open(p))} />}
    </div>
  );
}

function TreeDir(props: {
  project: Project;
  dir: string;
  depth: number;
  showHidden: boolean;
  changes: ChangeMap;
  active: string | null;
  onOpen: (path: string) => void;
  initiallyOpen?: boolean;
}) {
  const { project, dir, depth, showHidden, changes, active, onOpen } = props;
  const [entries, setEntries] = useState<FsEntry[] | null>(null);
  const [openDirs, setOpenDirs] = useState<Set<string>>(new Set());

  useEffect(() => {
    api.get<FsEntry[]>(`/api/projects/${project.id}/fs/list?dir=${encodeURIComponent(dir)}&hidden=${showHidden ? 1 : 0}`).then(setEntries);
  }, [project.id, dir, showHidden]);

  // 폴더 안에 변경 파일이 있으면 폴더도 표시
  const dirChanged = (p: string) => {
    for (const k of changes.keys()) if (k.startsWith(p + "/")) return true;
    return false;
  };

  if (!entries) return <div className="tree-row muted small" style={{ paddingLeft: 8 + depth * 14 }}>…</div>;
  return (
    <>
      {entries.map((e) =>
        e.dir ? (
          <div key={e.path}>
            <div
              className={"tree-row dir" + (dirChanged(e.path) ? " mod" : "")}
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() => {
                const n = new Set(openDirs);
                if (n.has(e.path)) n.delete(e.path);
                else n.add(e.path);
                setOpenDirs(n);
              }}
            >
              <span className="caret">{openDirs.has(e.path) ? "▾" : "▸"}</span>📁 {e.name}
            </div>
            {openDirs.has(e.path) && <TreeDir {...props} dir={e.path} depth={depth + 1} initiallyOpen={false} />}
          </div>
        ) : (
          <div
            key={e.path}
            className={"tree-row file " + (changes.get(e.path) ?? "") + (active === e.path ? " active" : "")}
            style={{ paddingLeft: 22 + depth * 14 }}
            onClick={() => onOpen(e.path)}
            title={e.size != null ? fmtSize(e.size) : ""}
          >
            {e.name}
          </div>
        ),
      )}
    </>
  );
}

function SearchPane({ project, onOpen }: { project: Project; onOpen: (path: string, line?: number) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!q.trim()) return;
    setBusy(true);
    setHits(await api.get<Hit[]>(`/api/projects/${project.id}/fs/search?q=${encodeURIComponent(q)}`));
    setBusy(false);
  };

  const grouped = useMemo(() => {
    const m = new Map<string, Hit[]>();
    for (const h of hits ?? []) {
      if (!m.has(h.path)) m.set(h.path, []);
      m.get(h.path)!.push(h);
    }
    return [...m.entries()];
  }, [hits]);

  return (
    <div className="search-pane">
      <form onSubmit={run} className="pad">
        <input autoFocus className="full" placeholder="전체 내용 검색 후 Enter" value={q} onChange={(e) => setQ(e.target.value)} />
      </form>
      {busy && <div className="muted small pad">검색 중…</div>}
      {hits && !busy && <div className="muted small pad">{hits.length >= 300 ? "300건 이상 (앞부분만 표시)" : `${hits.length}건`}</div>}
      <div className="tree">
        {grouped.map(([path, list]) => (
          <div key={path}>
            <div className="hit-file mono small" title={path}>
              {path}
            </div>
            {list.map((h) => (
              <div key={h.line} className="hit" onClick={() => onOpen(h.path, h.line)}>
                <span className="muted">{h.line}</span> {h.text}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function QuickOpen({ project, onClose, onPick }: { project: Project; onClose: () => void; onPick: (path: string) => void }) {
  const [q, setQ] = useState("");
  const [list, setList] = useState<string[]>([]);
  const [sel, setSel] = useState(0);

  useEffect(() => {
    const t = setTimeout(async () => {
      setList(q.trim() ? await api.get<string[]>(`/api/projects/${project.id}/fs/find?q=${encodeURIComponent(q)}`) : []);
      setSel(0);
    }, 120);
    return () => clearTimeout(t);
  }, [q, project.id]);

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal quick" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          className="full"
          placeholder="파일 이름 (예: SignboardPusher, app.yml)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            if (e.key === "ArrowDown") setSel((s) => Math.min(s + 1, list.length - 1));
            if (e.key === "ArrowUp") setSel((s) => Math.max(s - 1, 0));
            if (e.key === "Enter" && list[sel]) onPick(list[sel]);
          }}
        />
        <div className="quick-list">
          {list.map((p, i) => (
            <div key={p} className={"quick-item" + (i === sel ? " on" : "")} onMouseEnter={() => setSel(i)} onClick={() => onPick(p)}>
              <strong>{p.split("/").pop()}</strong> <span className="muted small mono">{p}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
