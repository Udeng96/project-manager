import { useState } from "react";
import { api, type Project } from "../api";

export default function ProjectSettings({ project, onSaved, onDeleted }: { project: Project; onSaved: () => void; onDeleted: () => void }) {
  const [name, setName] = useState(project.name);
  const [runCmd, setRunCmd] = useState(project.run_cmd);
  const [buildCmd, setBuildCmd] = useState(project.build_cmd);
  const [cleanCmd, setCleanCmd] = useState(project.clean_cmd);
  const [msg, setMsg] = useState("");

  return (
    <div className="card form">
      <h2>프로젝트 설정</h2>
      <label>
        이름
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        실행 명령
        <input className="mono" value={runCmd} onChange={(e) => setRunCmd(e.target.value)} />
      </label>
      <label>
        빌드 명령
        <input className="mono" value={buildCmd} onChange={(e) => setBuildCmd(e.target.value)} />
      </label>
      <label>
        클린 빌드 명령
        <input className="mono" value={cleanCmd} onChange={(e) => setCleanCmd(e.target.value)} />
      </label>
      <p className="muted small">
        명령은 프로젝트 폴더에서 실행됩니다. 예: <code>gradlew.bat bootRun --args=--spring.profiles.active=dev</code>
      </p>
      <div className="row">
        <button
          className="btn primary"
          onClick={async () => {
            await api.patch(`/api/projects/${project.id}`, { name, run_cmd: runCmd, build_cmd: buildCmd, clean_cmd: cleanCmd });
            setMsg("저장했습니다.");
            onSaved();
          }}
        >
          저장
        </button>
        <button
          className="btn ghost"
          onClick={async () => {
            const d = await api.get<{ run_cmd: string; build_cmd: string; clean_cmd: string }>(`/api/projects/${project.id}/redetect`);
            setRunCmd(d.run_cmd);
            setBuildCmd(d.build_cmd);
            setCleanCmd(d.clean_cmd);
          }}
        >
          기본값으로
        </button>
        <span className="grow" />
        <button
          className="btn danger"
          onClick={async () => {
            if (!confirm(`'${project.name}' 을(를) 목록에서 지울까요? (폴더와 파일은 그대로 남습니다. 이 프로젝트의 프롬프트·할 일·작업 기록은 삭제됩니다.)`)) return;
            await api.del(`/api/projects/${project.id}`);
            onDeleted();
          }}
        >
          목록에서 삭제
        </button>
      </div>
      {msg && <div className="muted small">{msg}</div>}
    </div>
  );
}
