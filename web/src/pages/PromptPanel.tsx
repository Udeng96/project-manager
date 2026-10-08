import { useEffect, useState } from "react";
import { api, fmtTime, type Project, type Prompt } from "../api";

export default function PromptPanel({ project, hasApiKey, onOpenInCode }: { project: Project; hasApiKey: boolean; onOpenInCode: (path: string, line?: number) => void }) {
  const [items, setItems] = useState<Prompt[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.get<Prompt[]>(`/api/projects/${project.id}/prompts`).then(setItems);
  }, [project.id]);

  const submit = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setError("");
    try {
      const p = await api.post<Prompt>(`/api/projects/${project.id}/prompts`, { question: text });
      setItems((prev) => [p, ...prev]);
      setText("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="prompt-page">
      <div className="card">
        <h2>프롬프트</h2>
        <p className="muted small">
          이 프로젝트에 대해 질문하거나 하고 싶은 작업을 적어 주세요. Claude가 코드를 읽고 답하고, 코드 수정이 필요하면 Claude Code에 붙여넣을 요청
          프롬프트를 만들어 줍니다. 여기 적은 글은 날짜별 작업 기록에도 쓰입니다.
        </p>
        {!hasApiKey && <div className="warn">Claude API 키가 없어 답변은 생성되지 않고 기록만 저장됩니다. 설정에서 키를 입력해 주세요.</div>}
        <textarea
          rows={5}
          value={text}
          placeholder="예: 방송 장비 상태 조회 API에 타임아웃 처리를 추가하고 싶어. 어디를 고치면 돼?"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit();
          }}
        />
        <div className="row end">
          <span className="muted small">Ctrl+Enter 로 보내기</span>
          <button className="btn primary" disabled={busy || !text.trim()} onClick={submit}>
            {busy ? "코드 읽고 답하는 중…" : "보내기"}
          </button>
        </div>
        {error && <div className="error">{error}</div>}
      </div>

      {items.map((p) => (
        <PromptItem
          key={p.id}
          p={p}
          projectId={project.id}
          onOpenInCode={onOpenInCode}
          onDelete={async () => {
            await api.del(`/api/prompts/${p.id}`);
            setItems((prev) => prev.filter((x) => x.id !== p.id));
          }}
        />
      ))}
    </div>
  );
}

function PromptItem({ p, projectId, onDelete, onOpenInCode }: { p: Prompt; projectId: number; onDelete: () => void; onOpenInCode: (path: string, line?: number) => void }) {
  const [copied, setCopied] = useState(false);
  const [todoAdded, setTodoAdded] = useState(false);

  return (
    <div className="card qa">
      <div className="qa-head">
        <span className="muted small">{fmtTime(p.created_at)}</span>
        <button className="link small" onClick={onDelete}>
          삭제
        </button>
      </div>
      <div className="question">{p.question}</div>
      {p.error && <div className="error">답변 실패: {p.error}</div>}
      {p.answer && <div className="answer"><LinkedText text={p.answer} onOpen={onOpenInCode} /></div>}
      {p.claude_code_prompt && (
        <div className="cc-prompt">
          <div className="cc-head">
            <strong>Claude Code 요청 프롬프트</strong>
            <div className="row">
              <button
                className="btn small"
                onClick={async () => {
                  await navigator.clipboard.writeText(p.claude_code_prompt);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? "복사됨" : "복사"}
              </button>
              <button
                className="btn small"
                disabled={todoAdded}
                onClick={async () => {
                  await api.post("/api/todos", {
                    projectId,
                    title: p.question.split("\n")[0].slice(0, 80),
                    kind: "task",
                    note: p.claude_code_prompt,
                  });
                  setTodoAdded(true);
                }}
              >
                {todoAdded ? "추가됨" : "남은 작업에 추가"}
              </button>
            </div>
          </div>
          <pre>{p.claude_code_prompt}</pre>
        </div>
      )}
    </div>
  );
}

// 답변 안의 "src/main/.../Foo.java:42" 같은 경로를 눌러서 코드 탭으로 열 수 있게 한다
const PATH_RE = /([\w.\-]+(?:\/[\w.\-]+)+\.[A-Za-z]{1,10})(?::(\d+))?/g;

function LinkedText({ text, onOpen }: { text: string; onOpen: (path: string, line?: number) => void }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(PATH_RE)) {
    const i = m.index ?? 0;
    if (i > last) parts.push(text.slice(last, i));
    const path = m[1].replace(/^\.\//, "");
    const line = m[2] ? Number(m[2]) : undefined;
    parts.push(
      <button key={i} className="link mono" onClick={() => onOpen(path, line)}>
        {m[0]}
      </button>,
    );
    last = i + m[0].length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}
