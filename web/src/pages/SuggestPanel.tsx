import { useCallback, useEffect, useMemo, useState } from "react";
import { api, fmtTime, type Project, type Suggestion, type SuggestionList } from "../api";

const CATEGORY: Record<string, string> = {
  tech: "기술",
  logic: "로직",
  performance: "성능",
  security: "보안",
  structure: "구조",
  ops: "운영·배포",
};
const PRIORITY: Record<string, string> = { high: "높음", normal: "보통", low: "낮음" };
const DIFFICULTY: Record<string, string> = { easy: "쉬움", normal: "보통", hard: "어려움" };
const STATUS_VIEW = [
  { key: "open", label: "확인할 것" },
  { key: "todo", label: "남은 작업으로 보냄" },
  { key: "ignored", label: "무시함" },
] as const;

type Props = { project: Project; hasApiKey: boolean; onOpenInCode: (path: string, line?: number) => void };

export default function SuggestPanel({ project, hasApiKey, onOpenInCode }: Props) {
  const [data, setData] = useState<SuggestionList | null>(null);
  const [error, setError] = useState("");
  const [group, setGroup] = useState("");
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState("");
  const [status, setStatus] = useState<"open" | "todo" | "ignored">("open");
  const [cats, setCats] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const d = await api.get<SuggestionList>(`/api/projects/${project.id}/suggestions`);
      setData(d);
      setGroup((g) => g || d.groups[0] || "");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [project.id]);

  useEffect(() => {
    load();
  }, [load]);

  const analyze = async () => {
    setRunning(true);
    setNotice("");
    setError("");
    try {
      const r = await api.post<{ added: number }>(`/api/projects/${project.id}/suggestions/analyze`, { group });
      setNotice(`"${group || "프로젝트 전체"}" 분석 끝: ${r.added}개 항목`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const update = async (s: Suggestion, next: Suggestion["status"]) => {
    await api.patch(`/api/suggestions/${s.id}`, { status: next });
    await load();
  };

  const toTodo = async (s: Suggestion) => {
    await api.post("/api/todos", {
      projectId: project.id,
      title: `[${CATEGORY[s.category]}] ${s.title}`.slice(0, 200),
      kind: "task",
      note: `${s.file}${s.line ? `:${s.line}` : ""}\n문제: ${s.problem}\n제안: ${s.suggestion}`,
    });
    await update(s, "todo");
    setNotice(`"${s.title}" 을(를) 남은 작업에 추가했습니다.`);
  };

  const copyPrompt = async (s: Suggestion) => {
    const text =
      `${project.name} 프로젝트에서 다음 개선을 해 주세요.\n\n` +
      `제목: ${s.title}\n위치: ${s.file}${s.line ? `:${s.line}` : ""}\n지금 문제: ${s.problem}\n바꿀 방법: ${s.suggestion}\n이유: ${s.reason}\n\n` +
      `기존 코드 스타일과 패키지 구조를 지키고, 고친 뒤 빌드와 테스트가 통과하는지 확인해 주세요.`;
    try {
      await navigator.clipboard.writeText(text);
      setNotice("Claude Code 프롬프트를 복사했습니다.");
    } catch {
      setNotice("복사하지 못했습니다.");
    }
  };

  const items = useMemo(
    () => (data?.items ?? []).filter((s) => s.status === status && (!cats.size || cats.has(s.category))),
    [data, status, cats],
  );
  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const s of data?.items ?? []) if (s.status === status) c.set(s.category, (c.get(s.category) ?? 0) + 1);
    return c;
  }, [data, status]);

  if (error && !data) return <div className="error">{error}</div>;
  if (!data) return <div className="empty">코드를 검사하는 중…</div>;

  const lastRun = (g: string) => data.runs.find((r) => r.group_name === g && !r.error);

  return (
    <div className="suggest">
      <div className="card">
        <div className="card-head">
          <h2>Claude 로 분석하기</h2>
          <span className="muted small">기능 묶음 하나씩 나눠서 분석합니다 (코드를 많이 읽을수록 비용이 듭니다)</span>
        </div>
        <div className="row">
          <select value={group} onChange={(e) => setGroup(e.target.value)} disabled={running}>
            {data.groups.map((g) => (
              <option key={g} value={g}>
                {g}
                {lastRun(g) ? ` · ${fmtTime(lastRun(g)!.created_at)} 분석함` : ""}
              </option>
            ))}
            <option value="">프로젝트 전체 (비용 큼)</option>
          </select>
          <button className="btn primary" onClick={analyze} disabled={running || !hasApiKey}>
            {running ? "Claude 가 코드를 읽는 중… (1~3분)" : "분석하기"}
          </button>
          {!hasApiKey && <span className="warn-tag">설정에서 Claude API 키를 넣어 주세요.</span>}
        </div>
        {error && <div className="error small">{error}</div>}
        {notice && <div className="muted small" style={{ marginTop: 6 }}>{notice}</div>}
      </div>

      <div className="row" style={{ marginBottom: 10, flexWrap: "wrap" }}>
        <div className="seg">
          {STATUS_VIEW.map((s) => (
            <button key={s.key} className={status === s.key ? "on" : ""} onClick={() => setStatus(s.key)}>
              {s.label} {data.items.filter((x) => x.status === s.key).length}
            </button>
          ))}
        </div>
        {Object.entries(CATEGORY).map(([k, label]) => (
          <button
            key={k}
            className={"kind-chip" + (cats.size && !cats.has(k) ? " off" : "")}
            onClick={() =>
              setCats((c) => {
                const n = new Set(c);
                if (n.has(k)) n.delete(k);
                else n.add(k);
                return n;
              })
            }
          >
            {label} {counts.get(k) ?? 0}
          </button>
        ))}
      </div>

      {items.map((s) => (
        <div key={s.id} className={`card sug pri-${s.priority}`}>
          <div className="sug-tags">
            <span className={`tag pri-${s.priority}`}>중요도 {PRIORITY[s.priority]}</span>
            <span className="tag">{CATEGORY[s.category]}</span>
            <span className="tag">난이도 {DIFFICULTY[s.difficulty]}</span>
            <span className="tag light">{s.source === "static" ? "자동 검사" : `Claude · ${s.group_name || "전체"}`}</span>
          </div>
          <h2 style={{ margin: "6px 0" }}>{s.title}</h2>
          {s.file && (
            <button className="linkish mono small" onClick={() => onOpenInCode(s.file, s.line ?? undefined)}>
              {s.file}
              {s.line ? `:${s.line}` : ""}
            </button>
          )}
          <div className="sug-body">
            <div>
              <b>문제</b> {s.problem}
            </div>
            <div>
              <b>제안</b> {s.suggestion}
            </div>
            {s.reason && (
              <div className="muted">
                <b>이유</b> {s.reason}
              </div>
            )}
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            {s.status !== "todo" && (
              <button className="btn small" onClick={() => toTodo(s)}>
                남은 작업에 추가
              </button>
            )}
            <button className="btn small" onClick={() => copyPrompt(s)}>
              Claude Code 프롬프트 복사
            </button>
            <span className="grow" />
            {s.status === "open" ? (
              <button className="btn small ghost" onClick={() => update(s, "ignored")}>
                무시
              </button>
            ) : (
              <button className="btn small ghost" onClick={() => update(s, "open")}>
                다시 확인할 것으로
              </button>
            )}
          </div>
        </div>
      ))}
      {!items.length && <div className="empty">{status === "open" ? "확인할 항목이 없습니다. 위에서 기능 묶음을 골라 Claude 로 분석해 보세요." : "항목이 없습니다."}</div>}
    </div>
  );
}
