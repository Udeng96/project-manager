import { useEffect, useState } from "react";
import { api, type WorklogDay } from "../api";

export default function WorklogPage() {
  const [days, setDays] = useState<WorklogDay[]>([]);
  const [busy, setBusy] = useState<string>("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api.get<WorklogDay[]>("/api/worklogs").then(setDays);
  }, []);

  const refresh = async (date?: string) => {
    setBusy(date ?? "all");
    setError("");
    try {
      setDays(await api.post<WorklogDay[]>("/api/worklogs/refresh", date ? { date } : {}));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const copyDay = (d: WorklogDay) =>
    navigator.clipboard.writeText(`${d.label}\n` + d.items.map((i) => `[${i.project_name}]\n${i.summary}`).join("\n\n"));

  return (
    <div className="worklog">
      <header className="page-head">
        <div>
          <h1>날짜별 작업 기록</h1>
          <p className="muted small">프롬프트에 쓴 글, git 커밋, 완료한 할 일을 모아 30분마다 자동으로 정리합니다. 직접 고친 기록은 덮어쓰지 않습니다.</p>
        </div>
        <button className="btn primary" disabled={!!busy} onClick={() => refresh()}>
          {busy === "all" ? "정리 중…" : "지금 정리하기"}
        </button>
      </header>
      {error && <div className="error">{error}</div>}
      {days.length === 0 && <div className="empty">아직 기록이 없습니다. 커밋하거나 프롬프트를 쓰면 자동으로 정리됩니다.</div>}
      {days.map((d) => (
        <div key={d.date} className="card day">
          <div className="card-head">
            <h2>{d.label}</h2>
            <div className="row">
              <button className="btn small ghost" onClick={() => copyDay(d)}>
                복사
              </button>
              <button className="btn small ghost" disabled={!!busy} onClick={() => refresh(d.date)}>
                {busy === d.date ? "다시 정리 중…" : "다시 정리"}
              </button>
            </div>
          </div>
          {d.items.map((i) => {
            const key = `${i.date}/${i.project_id}`;
            return (
              <div key={key} className="day-item">
                <div className="day-proj">
                  {i.project_name}
                  {i.edited ? <span className="muted small"> (직접 수정함)</span> : null}
                  {editing !== key && (
                    <button
                      className="link small"
                      onClick={() => {
                        setEditing(key);
                        setDraft(i.summary);
                      }}
                    >
                      수정
                    </button>
                  )}
                </div>
                {editing === key ? (
                  <div>
                    <textarea rows={Math.max(3, draft.split("\n").length + 1)} value={draft} onChange={(e) => setDraft(e.target.value)} />
                    <div className="row end">
                      <button className="btn small ghost" onClick={() => setEditing(null)}>
                        취소
                      </button>
                      <button
                        className="btn small primary"
                        onClick={async () => {
                          await api.put(`/api/worklogs/${i.date}/${i.project_id}`, { summary: draft });
                          setDays((prev) =>
                            prev.map((x) =>
                              x.date !== d.date
                                ? x
                                : { ...x, items: x.items.map((y) => (y.project_id === i.project_id ? { ...y, summary: draft, edited: 1 } : y)) },
                            ),
                          );
                          setEditing(null);
                        }}
                      >
                        저장
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="summary">{i.summary}</div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
