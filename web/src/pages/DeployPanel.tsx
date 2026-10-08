import { useCallback, useEffect, useMemo, useState } from "react";
import Editor, { DiffEditor } from "@monaco-editor/react";
import { api, fmtSize, fmtTime, type DeployCategory, type DeployFile, type Deployment, type FileContent, type Project } from "../api";
import { languageOf } from "../monaco";

const CATS: { key: DeployCategory; label: string }[] = [
  { key: "artifact", label: "배포 파일 (war/jar)" },
  { key: "config", label: "설정 (yml)" },
  { key: "sql", label: "DB 쿼리" },
  { key: "script", label: "스크립트" },
  { key: "log", label: "로그 설정" },
  { key: "service", label: "서비스 · 서버 설정" },
  { key: "doc", label: "배포 문서" },
];

const SINCE_LABEL = { new: "새로 생김", changed: "바뀜" } as const;

export default function DeployPanel({ project, onOpenInCode }: { project: Project; onOpenInCode: (path: string) => void }) {
  const [view, setView] = useState<"files" | "history">("files");
  const [files, setFiles] = useState<DeployFile[] | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [selected, setSelected] = useState<DeployFile | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const [f, d] = await Promise.all([
        api.get<DeployFile[]>(`/api/projects/${project.id}/deploy/files`),
        api.get<Deployment[]>(`/api/projects/${project.id}/deployments`),
      ]);
      setFiles(f);
      setDeployments(d);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [project.id]);

  useEffect(() => {
    load();
  }, [load]);

  const pending = (files ?? []).filter((f) => f.since === "new" || f.since === "changed");

  return (
    <div>
      <div className="row">
        <div className="seg">
          <button className={view === "files" ? "on" : ""} onClick={() => setView("files")}>
            배포 파일
          </button>
          <button className={view === "history" ? "on" : ""} onClick={() => setView("history")}>
            배포 기록 {deployments.length ? `(${deployments.length})` : ""}
          </button>
        </div>
        <button className="btn ghost small" onClick={load}>
          새로고침
        </button>
        <span className="grow" />
        {deployments[0] && (
          <span className="muted small">
            마지막 배포: {fmtTime(deployments[0].deployed_at)} {deployments[0].version && `· ${deployments[0].version}`}
          </span>
        )}
      </div>
      {error && <div className="error">{error}</div>}

      {view === "files" && files && (
        <>
          {deployments.length > 0 && pending.length > 0 && (
            <div className="warn">
              마지막 배포 이후 새로 생기거나 바뀐 파일이 {pending.length}개 있습니다. 이번 배포에 포함할지 확인해 주세요.
            </div>
          )}
          <div className="deploy">
            <div className="deploy-list card">
              {CATS.map((c) => {
                const list = files.filter((f) => f.category === c.key);
                if (!list.length) return null;
                return (
                  <div key={c.key} className="deploy-cat">
                    <div className="deploy-cat-head">
                      {c.label} <span className="count">{list.length}</span>
                    </div>
                    {list.map((f) => (
                      <div key={f.path} className={"deploy-item" + (selected?.path === f.path ? " active" : "")} onClick={() => setSelected(f)} title={f.path}>
                        <span className="mono small grow ell">{f.category === "sql" || f.category === "artifact" ? f.path.split("/").pop() : f.path}</span>
                        {f.since && f.since !== "same" && <span className={"tag t-" + (f.since === "new" ? "추가" : "수정")}>{SINCE_LABEL[f.since]}</span>}
                        {f.custom && <span className="tag">직접 등록</span>}
                      </div>
                    ))}
                  </div>
                );
              })}
              <AddCustom project={project} onAdded={load} />
            </div>
            <div className="deploy-view">
              {selected ? (
                <FileView
                  key={selected.path}
                  project={project}
                  file={selected}
                  configs={files.filter((f) => f.category === "config")}
                  onOpenInCode={onOpenInCode}
                  onRemoved={() => {
                    setSelected(null);
                    load();
                  }}
                />
              ) : (
                <div className="empty">왼쪽에서 파일을 고르면 내용을 볼 수 있습니다.</div>
              )}
            </div>
          </div>
        </>
      )}
      {view === "files" && !files && !error && <div className="muted">배포 관련 파일을 찾는 중…</div>}

      {view === "history" && files && <History project={project} files={files} deployments={deployments} onChange={load} />}
    </div>
  );
}

function FileView(props: { project: Project; file: DeployFile; configs: DeployFile[]; onOpenInCode: (p: string) => void; onRemoved: () => void }) {
  const { project, file, configs, onOpenInCode, onRemoved } = props;
  const [content, setContent] = useState<FileContent | null>(null);
  const [compareWith, setCompareWith] = useState("");
  const [other, setOther] = useState<FileContent | null>(null);
  // 서버 id, 경로는 프로젝트마다 마지막 값을 기억
  const memKey = `pm.upload.${project.id}`;
  const remembered = (() => {
    try {
      return JSON.parse(localStorage.getItem(memKey) ?? "{}") as { server?: string; remoteDir?: string };
    } catch {
      return {};
    }
  })();
  const [server, setServer] = useState(remembered.server ?? "");
  const [remoteDir, setRemoteDir] = useState(remembered.remoteDir ?? "");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (file.category !== "artifact") api.get<FileContent>(`/api/projects/${project.id}/fs/file?path=${encodeURIComponent(file.path)}`).then(setContent);
  }, [project.id, file]);

  useEffect(() => {
    if (compareWith) api.get<FileContent>(`/api/projects/${project.id}/fs/file?path=${encodeURIComponent(compareWith)}`).then(setOther);
    else setOther(null);
  }, [project.id, compareWith]);

  const upload = async () => {
    setMsg(null);
    try {
      try {
        localStorage.setItem(memKey, JSON.stringify({ server, remoteDir }));
      } catch {
        /* 저장 못 해도 업로드에는 영향 없음 */
      }
      await api.post(`/api/projects/${project.id}/deploy/upload`, {
        path: file.path,
        server: server.trim() || undefined,
        remoteDir: remoteDir.trim() || undefined,
      });
      setMsg({ ok: true, text: "Tailscale 프로그램을 열었습니다. 그쪽에서 서버와 경로를 확인한 뒤 업로드하세요." });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2 className="mono">{file.path}</h2>
          <div className="muted small">
            {fmtSize(file.size)} · 수정 {fmtTime(file.mtime)}
            {file.sqlVersion != null && ` · 버전 V${file.sqlVersion}`}
          </div>
        </div>
        <div className="row">
          {file.category !== "artifact" && (
            <button className="btn small" onClick={() => onOpenInCode(file.path)}>
              코드 탭에서 열기
            </button>
          )}
          {file.custom && (
            <button
              className="btn small ghost"
              onClick={async () => {
                await api.del(`/api/projects/${project.id}/deploy/files?path=${encodeURIComponent(file.path)}`);
                onRemoved();
              }}
            >
              등록 해제
            </button>
          )}
        </div>
      </div>

      {file.category === "artifact" ? (
        <div>
          <div className="kv">
            <span>sha256</span>
            <span className="mono small break">{file.sha256}</span>
            <button className="btn small ghost" onClick={() => navigator.clipboard.writeText(file.sha256 ?? "")}>
              복사
            </button>
          </div>
          <h3>서버에 올리기</h3>
          <p className="muted small">Tailscale 프로그램이 열리고 이 파일이 업로드 대상으로 잡힙니다. 실제 업로드는 그 프로그램에서 서버와 경로를 확인한 뒤 진행합니다.</p>
          <div className="row">
            <input className="mono" placeholder="서버 (선택, 예: dashboard)" value={server} onChange={(e) => setServer(e.target.value)} />
            <input className="grow mono" placeholder="서버 경로 (선택, 예: /opt/broadcast)" value={remoteDir} onChange={(e) => setRemoteDir(e.target.value)} />
            <button className="btn primary" onClick={upload}>
              ↑ 서버에 올리기
            </button>
          </div>
          {msg && <div className={msg.ok ? "output ok" : "error"}>{msg.text}</div>}
        </div>
      ) : (
        <>
          {file.category === "config" && configs.length > 1 && (
            <div className="row">
              <span className="small muted">나란히 비교:</span>
              <select value={compareWith} onChange={(e) => setCompareWith(e.target.value)}>
                <option value="">비교 안 함</option>
                {configs
                  .filter((c) => c.path !== file.path)
                  .map((c) => (
                    <option key={c.path} value={c.path}>
                      {c.path}
                    </option>
                  ))}
              </select>
            </div>
          )}
          {!content ? (
            <div className="muted">불러오는 중…</div>
          ) : content.binary || content.tooLarge ? (
            <div className="empty">내용을 표시할 수 없는 파일입니다.</div>
          ) : other ? (
            <>
              <div className="diff-labels small muted mono">
                <span>{file.path}</span>
                <span>{compareWith}</span>
              </div>
              <DiffEditor
                key={compareWith}
                keepCurrentOriginalModel
                keepCurrentModifiedModel
                height="60vh"
                language={languageOf(file.path)}
                original={content.content}
                modified={other.content}
                options={{ readOnly: true, originalEditable: false, renderSideBySide: true, minimap: { enabled: false }, fontSize: 13 }}
              />
            </>
          ) : (
            <Editor
              height="60vh"
              path={`deploy:${file.path}`}
              language={languageOf(file.path)}
              value={content.content}
              options={{ readOnly: true, domReadOnly: true, minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false }}
            />
          )}
        </>
      )}
    </div>
  );
}

function AddCustom({ project, onAdded }: { project: Project; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const [category, setCategory] = useState<DeployCategory>("sql");
  const [error, setError] = useState("");
  if (!open)
    return (
      <button className="link small pad" onClick={() => setOpen(true)}>
        + 파일 직접 등록
      </button>
    );
  return (
    <form
      className="pad"
      onSubmit={async (e) => {
        e.preventDefault();
        setError("");
        try {
          await api.post(`/api/projects/${project.id}/deploy/files`, { path, category });
          setPath("");
          setOpen(false);
          onAdded();
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <input className="full mono small" placeholder="프로젝트 기준 경로 (예: docs/patch-1008.sql)" value={path} onChange={(e) => setPath(e.target.value)} />
      <div className="row">
        <select value={category} onChange={(e) => setCategory(e.target.value as DeployCategory)}>
          {CATS.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </select>
        <button className="btn small primary" disabled={!path.trim()}>
          등록
        </button>
        <button type="button" className="btn small ghost" onClick={() => setOpen(false)}>
          취소
        </button>
      </div>
      {error && <div className="error small">{error}</div>}
    </form>
  );
}

// ---------- 배포 기록 ----------

function History({ project, files, deployments, onChange }: { project: Project; files: DeployFile[]; deployments: Deployment[]; onChange: () => void }) {
  const [creating, setCreating] = useState(false);
  return (
    <div className="history">
      {!creating ? (
        <button className="btn primary" onClick={() => setCreating(true)}>
          + 이번 배포 기록하기
        </button>
      ) : (
        <NewDeployment
          project={project}
          files={files}
          hasPrevious={deployments.length > 0}
          onDone={() => {
            setCreating(false);
            onChange();
          }}
          onCancel={() => setCreating(false)}
        />
      )}
      {deployments.length === 0 && !creating && <div className="empty">아직 배포 기록이 없습니다. 첫 배포를 기록하면, 다음부터 그 이후에 새로 생기거나 바뀐 SQL·yml·sh를 표시해 줍니다.</div>}
      {deployments.map((d) => (
        <DeploymentCard key={d.id} d={d} onChange={onChange} />
      ))}
    </div>
  );
}

function NewDeployment(props: { project: Project; files: DeployFile[]; hasPrevious: boolean; onDone: () => void; onCancel: () => void }) {
  const { project, files, hasPrevious, onDone, onCancel } = props;
  const artifacts = files.filter((f) => f.category === "artifact").sort((a, b) => b.mtime.localeCompare(a.mtime));
  const sqls = files.filter((f) => f.category === "sql");
  const scripts = files.filter((f) => f.category === "script");

  const [artifact, setArtifact] = useState(artifacts[0]?.path ?? "");
  const versionFromName = (p: string) => p.split("/").pop()?.match(/-(\d[\w.\-]*)\.(war|jar)$/)?.[1] ?? "";
  const [version, setVersion] = useState(versionFromName(artifacts[0]?.path ?? ""));
  const [target, setTarget] = useState("");
  // 배포 기록이 있으면 그 이후 새로 생긴/바뀐 SQL 을 미리 체크
  const [pickedSql, setPickedSql] = useState<Set<string>>(new Set(hasPrevious ? sqls.filter((s) => s.since === "new" || s.since === "changed").map((s) => s.path) : []));
  const [pickedSh, setPickedSh] = useState<Set<string>>(new Set());
  const [memo, setMemo] = useState("");
  const [date, setDate] = useState(() => {
    const d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  });
  const [error, setError] = useState("");

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, p: string) => {
    const n = new Set(set);
    if (n.has(p)) n.delete(p);
    else n.add(p);
    setter(n);
  };

  const sha = useMemo(() => artifacts.find((a) => a.path === artifact)?.sha256, [artifact, artifacts]);

  return (
    <div className="card">
      <h2>이번 배포 기록</h2>
      <div className="grid2">
        <label>
          배포 일시
          <input type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label>
          대상 서버
          <input placeholder="예: 운영 broadcast 서버" value={target} onChange={(e) => setTarget(e.target.value)} />
        </label>
        <label>
          배포 파일
          <select
            value={artifact}
            onChange={(e) => {
              setArtifact(e.target.value);
              setVersion(versionFromName(e.target.value));
            }}
          >
            <option value="">(없음)</option>
            {artifacts.map((a) => (
              <option key={a.path} value={a.path}>
                {a.path} · {fmtSize(a.size)} · {fmtTime(a.mtime)}
              </option>
            ))}
          </select>
        </label>
        <label>
          버전
          <input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="예: 0.1.0" />
        </label>
      </div>
      {sha && <div className="muted small mono">sha256 {sha}</div>}

      <h3>적용한 SQL {hasPrevious && <span className="muted small">(지난 배포 이후 새로 생기거나 바뀐 것은 미리 체크됨)</span>}</h3>
      <div className="checks">
        {sqls.length === 0 && <span className="muted small">SQL 파일 없음</span>}
        {sqls.map((s) => (
          <label key={s.path} className="check small">
            <input type="checkbox" checked={pickedSql.has(s.path)} onChange={() => toggle(pickedSql, setPickedSql, s.path)} />
            <span className="mono">{s.path.split("/").pop()}</span>
            {s.since && s.since !== "same" && <span className={"tag t-" + (s.since === "new" ? "추가" : "수정")}>{SINCE_LABEL[s.since]}</span>}
          </label>
        ))}
      </div>

      <h3>실행한 스크립트</h3>
      <div className="checks">
        {scripts.length === 0 && <span className="muted small">스크립트 없음</span>}
        {scripts.map((s) => (
          <label key={s.path} className="check small">
            <input type="checkbox" checked={pickedSh.has(s.path)} onChange={() => toggle(pickedSh, setPickedSh, s.path)} />
            <span className="mono">{s.path}</span>
          </label>
        ))}
      </div>

      <h3>메모</h3>
      <textarea rows={3} value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="변경 내용, 주의할 점 등" />
      <p className="muted small">체크리스트는 기록을 만든 뒤 하나씩 체크할 수 있습니다. 지금 시점의 설정·SQL·스크립트 상태를 저장해 두고, 다음 배포 때 바뀐 것을 표시합니다.</p>
      {error && <div className="error">{error}</div>}
      <div className="row end">
        <button className="btn ghost" onClick={onCancel}>
          취소
        </button>
        <button
          className="btn primary"
          onClick={async () => {
            try {
              await api.post(`/api/projects/${project.id}/deployments`, {
                deployed_at: new Date(date).toISOString(),
                version,
                artifact,
                target,
                sqls: [...pickedSql],
                scripts: [...pickedSh],
                memo,
              });
              onDone();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          기록 저장
        </button>
      </div>
    </div>
  );
}

function DeploymentCard({ d, onChange }: { d: Deployment; onChange: () => void }) {
  const [memo, setMemo] = useState(d.memo);
  const [newItem, setNewItem] = useState("");
  const done = d.checklist.filter((c) => c.done).length;

  const save = async (patch: Partial<Deployment>) => {
    await api.patch(`/api/deployments/${d.id}`, patch);
    onChange();
  };

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>
            {fmtTime(d.deployed_at)} {d.version && <span className="pill mono">{d.version}</span>}
          </h2>
          <div className="muted small">
            {d.target || "대상 서버 미기재"} · {d.artifact || "배포 파일 없음"}
          </div>
        </div>
        <div className="row">
          <span className={"pill" + (done === d.checklist.length ? " on" : "")}>
            체크 {done}/{d.checklist.length}
          </span>
          <button
            className="link small"
            onClick={async () => {
              if (confirm("이 배포 기록을 삭제할까요?")) {
                await api.del(`/api/deployments/${d.id}`);
                onChange();
              }
            }}
          >
            삭제
          </button>
        </div>
      </div>
      <div className="grid2">
        <div>
          <h3>체크리스트</h3>
          {d.checklist.map((c, i) => (
            <label key={i} className="check">
              <input
                type="checkbox"
                checked={c.done}
                onChange={() => save({ checklist: d.checklist.map((x, j) => (j === i ? { ...x, done: !x.done } : x)) })}
              />
              <span className={c.done ? "muted strike" : ""}>{c.text}</span>
            </label>
          ))}
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              if (newItem.trim()) save({ checklist: [...d.checklist, { text: newItem.trim(), done: false }] });
              setNewItem("");
            }}
          >
            <input className="grow small" placeholder="항목 추가" value={newItem} onChange={(e) => setNewItem(e.target.value)} />
          </form>
        </div>
        <div>
          <h3>적용한 SQL</h3>
          {d.sqls.length ? d.sqls.map((s) => <div key={s} className="mono small">{s.split("/").pop()}</div>) : <div className="muted small">없음</div>}
          <h3>실행한 스크립트</h3>
          {d.scripts.length ? d.scripts.map((s) => <div key={s} className="mono small">{s}</div>) : <div className="muted small">없음</div>}
        </div>
      </div>
      <h3>메모</h3>
      <textarea rows={2} value={memo} onChange={(e) => setMemo(e.target.value)} />
      {memo !== d.memo && (
        <div className="row end">
          <button className="btn small primary" onClick={() => save({ memo })}>
            메모 저장
          </button>
        </div>
      )}
    </div>
  );
}
