import { useCallback, useEffect, useState } from "react";
import { api, fmtTime, type Project, type Todo } from "../api";

/** projectId 가 있으면 그 프로젝트만, 없으면 전체 프로젝트의 남은 작업 */
export default function TodoPanel({ projectId, projects }: { projectId?: number; projects: Project[] }) {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<"task" | "check">("task");
  const [target, setTarget] = useState<number | "">(projectId ?? projects[0]?.id ?? "");
  const [showDone, setShowDone] = useState(false);
  const [open, setOpen] = useState<number | null>(null);

  const load = useCallback(async () => {
    setTodos(await api.get<Todo[]>(`/api/todos${projectId ? `?projectId=${projectId}` : ""}`));
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || target === "") return;
    await api.post("/api/todos", { projectId: target, title, kind });
    setTitle("");
    load();
  };

  const update = async (t: Todo, patch: Partial<Todo>) => {
    await api.patch(`/api/todos/${t.id}`, patch);
    load();
  };

  const openItems = todos.filter((t) => t.status === "open");
  const doneItems = todos.filter((t) => t.status === "done");

  const groups: { label: string; items: Todo[] }[] = [
    { label: "남은 작업", items: openItems.filter((t) => t.kind === "task") },
    { label: "확인할 것", items: openItems.filter((t) => t.kind === "check") },
  ];

  return (
    <div className="todo-page">
      {!projectId && <h1>전체 남은 작업</h1>}
      <form className="card row" onSubmit={add}>
        {!projectId && (
          <select value={target} onChange={(e) => setTarget(Number(e.target.value))}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <select value={kind} onChange={(e) => setKind(e.target.value as "task" | "check")}>
          <option value="task">남은 작업</option>
          <option value="check">확인할 것</option>
        </select>
        <input className="grow" placeholder="할 일을 입력하고 Enter" value={title} onChange={(e) => setTitle(e.target.value)} />
        <button className="btn primary" disabled={!title.trim()}>
          추가
        </button>
      </form>

      <div className="todo-cols">
        {groups.map((g) => (
          <div key={g.label} className="card">
            <h2>
              {g.label} <span className="count">{g.items.length}</span>
            </h2>
            {g.items.length === 0 && <div className="muted small">없습니다.</div>}
            {g.items.map((t) => (
              <div key={t.id} className="todo">
                <input type="checkbox" checked={false} onChange={() => update(t, { status: "done" })} title="완료" />
                <div className="grow">
                  <button className="link todo-title" onClick={() => setOpen(open === t.id ? null : t.id)}>
                    {t.title}
                  </button>
                  <div className="muted small">
                    {!projectId && <span className="proj">{t.project_name}</span>}
                    {fmtTime(t.created_at)} 추가
                    {t.note && " · 메모 있음"}
                  </div>
                  {open === t.id && <NoteEditor todo={t} onSave={(note) => update(t, { note })} />}
                </div>
                <button
                  className="link small"
                  onClick={() => update(t, { kind: t.kind === "task" ? "check" : "task" })}
                  title="분류 바꾸기"
                >
                  {t.kind === "task" ? "→확인" : "→작업"}
                </button>
                <button
                  className="link small"
                  onClick={async () => {
                    if (confirm("삭제할까요?")) {
                      await api.del(`/api/todos/${t.id}`);
                      load();
                    }
                  }}
                >
                  삭제
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="card">
        <button className="link" onClick={() => setShowDone(!showDone)}>
          완료한 항목 {doneItems.length}개 {showDone ? "접기" : "보기"}
        </button>
        {showDone &&
          doneItems.map((t) => (
            <div key={t.id} className="todo done">
              <input type="checkbox" checked onChange={() => update(t, { status: "open" })} title="되돌리기" />
              <div className="grow">
                {t.title}
                <div className="muted small">
                  {!projectId && <span className="proj">{t.project_name}</span>}
                  {t.done_at && `${fmtTime(t.done_at)} 완료`}
                </div>
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}

function NoteEditor({ todo, onSave }: { todo: Todo; onSave: (note: string) => void }) {
  const [note, setNote] = useState(todo.note);
  return (
    <div className="note">
      <textarea rows={Math.min(14, Math.max(3, note.split("\n").length + 1))} value={note} onChange={(e) => setNote(e.target.value)} placeholder="메모" />
      <div className="row end">
        {todo.note && (
          <button className="btn small" type="button" onClick={() => navigator.clipboard.writeText(note)}>
            복사
          </button>
        )}
        <button className="btn small primary" type="button" disabled={note === todo.note} onClick={() => onSave(note)}>
          저장
        </button>
      </div>
    </div>
  );
}
