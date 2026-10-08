import { useCallback, useEffect, useState } from "react";
import { api, fmtTime, type Commit, type GitStatus, type Project } from "../api";

const LABEL: Record<string, string> = { M: "수정", A: "추가", D: "삭제", R: "이름변경", "?": "새 파일", U: "충돌" };

function changeLabel(f: { index: string; worktree: string; untracked: boolean }) {
  if (f.untracked) return "새 파일";
  const c = f.worktree.trim() || f.index.trim();
  return LABEL[c] ?? c;
}

export default function GitPanel({ project }: { project: Project }) {
  const [st, setSt] = useState<GitStatus | null>(null);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [diffFile, setDiffFile] = useState<string | null>(null);
  const [diff, setDiff] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [output, setOutput] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = useCallback(async () => {
    const s = await api.get<GitStatus>(`/api/projects/${project.id}/git/status`);
    setSt(s);
    if (s.repo) {
      setSelected((prev) => {
        const paths = new Set(s.files.map((f) => f.path));
        // 처음엔 전부 선택, 이후엔 사용자가 고른 것 유지
        return prev.size ? new Set([...prev].filter((p) => paths.has(p))) : paths;
      });
      setCommits(await api.get<Commit[]>(`/api/projects/${project.id}/git/log`));
    }
  }, [project.id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const showDiff = async (file: string) => {
    setDiffFile(file);
    setDiff("불러오는 중…");
    const r = await api.get<{ diff: string }>(`/api/projects/${project.id}/git/diff?file=${encodeURIComponent(file)}`);
    setDiff(r.diff);
  };

  const run = async (label: string, fn: () => Promise<{ output: string }>) => {
    setBusy(label);
    setOutput(null);
    try {
      const r = await fn();
      setOutput({ ok: true, text: r.output });
      await refresh();
    } catch (e) {
      setOutput({ ok: false, text: (e as Error).message });
    } finally {
      setBusy("");
    }
  };

  if (!st) return <div className="card">불러오는 중…</div>;
  if (!st.repo) return <div className="card">이 폴더는 git 저장소가 아닙니다.</div>;

  const allSelected = st.files.length > 0 && st.files.every((f) => selected.has(f.path));

  return (
    <div className="card git">
      <div className="card-head">
        <h2>형상관리</h2>
        <span className="pill mono">
          {st.branch}
          {st.upstream ? ` → ${st.upstream}` : " (원격 미연결)"}
          {st.ahead ? ` ↑${st.ahead}` : ""}
          {st.behind ? ` ↓${st.behind}` : ""}
        </span>
      </div>
      <div className="row">
        <button className="btn ghost" onClick={refresh}>
          새로고침
        </button>
        <button className="btn" disabled={!!busy} onClick={() => run("pull", () => api.post(`/api/projects/${project.id}/git/pull`))}>
          {busy === "pull" ? "받는 중…" : "↓ 받기 (pull)"}
        </button>
        <button className="btn" disabled={!!busy} onClick={() => run("push", () => api.post(`/api/projects/${project.id}/git/push`))}>
          {busy === "push" ? "올리는 중…" : `↑ 푸쉬${st.ahead ? ` (${st.ahead})` : ""}`}
        </button>
      </div>

      <div className="files">
        <div className="files-head">
          <label className="check">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={(e) => setSelected(e.target.checked ? new Set(st.files.map((f) => f.path)) : new Set())}
            />
            변경 파일 {st.files.length}개
          </label>
        </div>
        {st.files.length === 0 && <div className="muted small pad">변경된 파일이 없습니다.</div>}
        {st.files.map((f) => (
          <div key={f.path} className={"file" + (diffFile === f.path ? " active" : "")}>
            <input
              type="checkbox"
              checked={selected.has(f.path)}
              onChange={(e) => {
                const n = new Set(selected);
                if (e.target.checked) n.add(f.path);
                else n.delete(f.path);
                setSelected(n);
              }}
            />
            <span className={"tag t-" + changeLabel(f)}>{changeLabel(f)}</span>
            <button className="link mono" onClick={() => showDiff(f.path)}>
              {f.path}
            </button>
          </div>
        ))}
      </div>

      {diffFile && (
        <div className="diff">
          <div className="diff-head">
            <span className="mono small">{diffFile}</span>
            <button className="link" onClick={() => setDiffFile(null)}>
              닫기
            </button>
          </div>
          <pre>
            {diff.split("\n").map((l, i) => (
              <div key={i} className={l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : l.startsWith("@@") ? "hunk" : ""}>
                {l || " "}
              </div>
            ))}
          </pre>
        </div>
      )}

      <div className="commit-box">
        <textarea rows={3} placeholder="커밋 메시지" value={message} onChange={(e) => setMessage(e.target.value)} />
        <div className="row end">
          <button
            className="btn primary"
            disabled={!!busy || !message.trim() || selected.size === 0}
            onClick={() =>
              run("commit", async () => {
                const r = await api.post<{ output: string }>(`/api/projects/${project.id}/git/commit`, {
                  files: [...selected],
                  message,
                });
                setMessage("");
                setSelected(new Set());
                setDiffFile(null);
                return r;
              })
            }
          >
            {busy === "commit" ? "커밋 중…" : `선택한 ${selected.size}개 커밋`}
          </button>
        </div>
      </div>
      {output && <pre className={"output " + (output.ok ? "ok" : "bad")}>{output.text}</pre>}

      <h3>최근 커밋</h3>
      <div className="commits">
        {commits.map((c) => (
          <div key={c.hash} className="commit">
            <span className="mono hash">{c.hash.slice(0, 7)}</span>
            <span className="grow">{c.subject}</span>
            <span className="muted small">
              {c.author} · {fmtTime(c.date)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
