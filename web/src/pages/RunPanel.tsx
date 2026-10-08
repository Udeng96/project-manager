import { useEffect, useMemo, useRef, useState } from "react";
import { api, type LogLine, type Project, type RunStatus } from "../api";

export default function RunPanel({ project, onChange }: { project: Project; onChange: () => void }) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [status, setStatus] = useState<RunStatus>(project.status);
  const [filter, setFilter] = useState("");
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [follow, setFollow] = useState(true);
  const [error, setError] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const es = new EventSource(`/api/projects/${project.id}/logs/stream`);
    es.addEventListener("lines", (e) => {
      const add = JSON.parse((e as MessageEvent).data) as LogLine[];
      setLines((prev) => {
        const last = prev.at(-1)?.seq ?? 0;
        const next = [...prev, ...add.filter((l) => l.seq > last)];
        return next.length > 3000 ? next.slice(-3000) : next;
      });
    });
    es.addEventListener("status", (e) => {
      setStatus(JSON.parse((e as MessageEvent).data));
      onChange();
    });
    return () => es.close();
  }, [project.id, onChange]);

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return lines.filter(
      (l) =>
        (!onlyErrors || l.stream === "err" || /error|exception|fail/i.test(l.text)) &&
        (!f || l.text.toLowerCase().includes(f)),
    );
  }, [lines, filter, onlyErrors]);

  useEffect(() => {
    if (follow && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [shown, follow]);

  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="card run">
      <div className="card-head">
        <h2>실행 · 로그</h2>
        <span className={"pill" + (status.running ? " on" : "")}>
          {status.running ? `${status.task === "build" ? "빌드" : "실행"} 중 (PID ${status.pid})` : status.exitCode != null ? `종료 (코드 ${status.exitCode})` : "중지됨"}
        </span>
      </div>
      <div className="row">
        <button className="btn primary" disabled={status.running} onClick={() => act(() => api.post(`/api/projects/${project.id}/run`, { task: "run" }))} title={project.run_cmd}>
          ▶ 실행
        </button>
        <button className="btn" disabled={status.running} onClick={() => act(() => api.post(`/api/projects/${project.id}/run`, { task: "build" }))} title={project.build_cmd}>
          빌드
        </button>
        <button className="btn danger" disabled={!status.running} onClick={() => act(() => api.post(`/api/projects/${project.id}/stop`))}>
          ■ 중지
        </button>
        <button
          className="btn ghost"
          onClick={() =>
            act(async () => {
              await api.del(`/api/projects/${project.id}/logs`);
              setLines([]);
            })
          }
        >
          로그 지우기
        </button>
        <span className="muted small mono cmd">{project.run_cmd}</span>
      </div>
      <div className="row">
        <input className="grow" placeholder="로그 검색" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={onlyErrors} onChange={(e) => setOnlyErrors(e.target.checked)} /> 오류만
        </label>
        <label className="check">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> 자동 스크롤
        </label>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="log" ref={boxRef}>
        {shown.length === 0 && <div className="muted">로그가 없습니다. 실행 버튼을 눌러 보세요.</div>}
        {shown.map((l) => (
          <div key={l.seq} className={"log-line " + l.stream + (/\b(ERROR|Exception)\b/.test(l.text) ? " bad" : /\bWARN\b/.test(l.text) ? " warn" : "")}>
            {l.text || " "}
          </div>
        ))}
      </div>
    </div>
  );
}
