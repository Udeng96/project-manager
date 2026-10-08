import { useState } from "react";
import { api, type Settings } from "../api";

export default function SettingsPage({ settings, onSaved }: { settings: Settings | null; onSaved: () => void }) {
  const [key, setKey] = useState("");
  const [msg, setMsg] = useState("");

  return (
    <div>
      <h1>설정</h1>
      <div className="card">
        <h2>Claude API 키</h2>
        <p className="muted small">
          프롬프트 답변과 작업 기록 요약에 사용합니다. 키는 이 PC의 데이터 폴더({settings?.dataDir})에만 저장됩니다.
        </p>
        <div className="muted small">
          현재 상태:{" "}
          {settings?.hasApiKey ? (settings.apiKeySource === "env" ? "환경변수 ANTHROPIC_API_KEY 사용 중" : "입력된 키 사용 중") : "키 없음"}
        </div>
        <div className="row">
          <input className="grow mono" type="password" placeholder="sk-ant-..." value={key} onChange={(e) => setKey(e.target.value)} />
          <button
            className="btn primary"
            disabled={!key.trim()}
            onClick={async () => {
              await api.put("/api/settings/api-key", { apiKey: key });
              setKey("");
              setMsg("저장했습니다.");
              onSaved();
            }}
          >
            저장
          </button>
          {settings?.apiKeySource === "settings" && (
            <button
              className="btn ghost"
              onClick={async () => {
                await api.put("/api/settings/api-key", { apiKey: "" });
                setMsg("삭제했습니다.");
                onSaved();
              }}
            >
              삭제
            </button>
          )}
        </div>
        {msg && <div className="muted small">{msg}</div>}
      </div>
    </div>
  );
}
