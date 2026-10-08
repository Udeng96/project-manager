import { useCallback, useEffect, useMemo, useState } from "react";
import { Background, Controls, ReactFlow, type Edge, type Node } from "@xyflow/react";
import { api, fmtTime, type FlowGraph, type FlowKind, type FlowNode, type PredictionItem } from "../api";
import { KIND, NODE_H, NODE_W, chainOf, layout, nodeTypes, type NodeData, type ViewNode } from "./FlowPanel";

const ACTION = { add: "추가", modify: "수정" } as const;

type Props = {
  projectId: number;
  hasApiKey: boolean;
  onOpen: (n: FlowNode, line?: number) => void;
};

/** 기능 추가 예상: 왼쪽 입력·기록, 가운데 겹쳐 그린 흐름, 오른쪽 할 일 */
export default function PredictView({ projectId, hasApiKey, onOpen }: Props) {
  // 다른 프로젝트 화면·API 까지 이어 보려고 전체 그래프를 쓴다
  const [graph, setGraph] = useState<FlowGraph>({ nodes: [], edges: [], unresolved: [], generatedAt: "" });
  useEffect(() => {
    api.get<FlowGraph>("/api/flow").then(setGraph);
  }, []);
  const [items, setItems] = useState<PredictionItem[]>([]);
  const [current, setCurrent] = useState<number | null>(null);
  const [request, setRequest] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    const list = await api.get<PredictionItem[]>(`/api/projects/${projectId}/predictions`);
    setItems(list);
    setCurrent((c) => (c && list.some((x) => x.id === c) ? c : (list.find((x) => x.result)?.id ?? null)));
    return list;
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  // 다른 화면으로 갔다 와도 진행 중인 예상이 끝나면 보이도록
  useEffect(() => {
    if (!items.some((x) => x.pending)) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [items, load]);

  const run = async () => {
    setRunning(true);
    setError("");
    try {
      const r = await api.post<PredictionItem>(`/api/projects/${projectId}/predictions`, { request });
      if (r.error) setError(r.error);
      else setRequest("");
      await load();
      setCurrent(r.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const item = items.find((x) => x.id === current) ?? null;
  const r = graph.nodes.length ? (item?.result ?? null) : null;
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);

  // 겹쳐 그릴 그래프: 바뀌는 노드 + 새 노드 + 그 바로 옆 노드
  const view = useMemo(() => {
    if (!r) return null;
    const plan = new Map<string, "new" | "changed" | "same">();
    const nodes = new Map<string, ViewNode & { note?: string }>();
    for (const c of r.changedNodes) {
      const n = byId.get(c.id);
      if (n) {
        nodes.set(n.id, { ...n, desc: c.change });
        plan.set(n.id, "changed");
      }
    }
    for (const n of r.newNodes) {
      const id = `new:${n.key}`;
      const pid = graph.nodes.find((x) => x.project === n.project)?.projectId ?? null;
      nodes.set(id, { id, projectId: pid, project: n.project, kind: n.kind as FlowKind, label: n.label, desc: n.desc, group: n.group, file: n.file });
      plan.set(id, "new");
    }
    // 바뀌는 노드 둘 사이를 잇는 중간 노드 (A -> X -> B) 만 더한다. 옆 노드를 다 넣으면 너무 넓어진다
    const core = new Set(nodes.keys());
    const out = new Map<string, string[]>();
    for (const e of graph.edges) out.set(e.source, [...(out.get(e.source) ?? []), e.target]);
    for (const a of core)
      for (const x of out.get(a) ?? [])
        if (!core.has(x) && (out.get(x) ?? []).some((b) => core.has(b)) && byId.has(x)) nodes.set(x, { ...byId.get(x)! });
    for (const e of r.newEdges) for (const id of [e.source, e.target]) if (!nodes.has(id) && byId.has(id)) nodes.set(id, { ...byId.get(id)! });
    for (const id of nodes.keys()) if (!plan.has(id)) plan.set(id, "same");
    const edges = [
      ...graph.edges.filter((e) => nodes.has(e.source) && nodes.has(e.target)).map((e) => ({ ...e, isNew: false })),
      ...r.newEdges.map((e, i) => ({ id: `newedge:${i}`, source: e.source, target: e.target, label: e.label, cross: false, isNew: true })),
    ];
    return { nodes: [...nodes.values()], edges, plan };
  }, [r, byId, graph]);

  const positions = useMemo(() => (view ? layout(view.nodes, view.edges, true) : new Map()), [view]);

  const rfNodes: Node<NodeData>[] = useMemo(
    () =>
      (view?.nodes ?? []).map((n) => ({
        id: n.id,
        type: "cls",
        width: NODE_W,
        height: NODE_H,
        position: positions.get(n.id) ?? { x: 0, y: 0 },
        data: { n, dim: false, selected: false, other: n.projectId !== projectId, showProject: true, vertical: true, plan: view!.plan.get(n.id) },
      })),
    [view, positions, projectId],
  );
  const rfEdges: Edge[] = useMemo(
    () =>
      (view?.edges ?? []).map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        label: e.label ? e.label.split("\n")[0] : undefined,
        animated: e.isNew,
        style: { stroke: e.isNew ? "#22c55e" : e.cross ? "#be185d" : "#9aa3b2", strokeWidth: e.isNew ? 2.2 : 1.2, strokeDasharray: e.isNew || e.cross ? "6 4" : undefined },
        labelStyle: { fontSize: 11 },
        labelBgStyle: { fill: "#fff" },
      })),
    [view],
  );


  // 영향 범위: 바뀌는 노드를 (거슬러 올라가며) 쓰는 화면·API 파일, 다른 프로젝트의 노드
  const impact = useMemo(() => {
    if (!r) return [];
    const back = graph.edges.map((e) => ({ source: e.target, target: e.source }));
    const seen = new Map<string, FlowNode>();
    for (const c of r.changedNodes) {
      const owner = byId.get(c.id);
      for (const id of chainOf(c.id, back)) {
        const n = byId.get(id);
        if (!n || id === c.id || r.changedNodes.some((x) => x.id === id)) continue;
        if (n.kind === "screen" || n.kind === "api" || (owner && n.projectId !== owner.projectId && n.projectId != null)) seen.set(id, n);
      }
    }
    return [...seen.values()].sort((a, b) => a.project.localeCompare(b.project) || a.label.localeCompare(b.label));
  }, [r, graph, byId]);

  const addTodo = async (title: string, note: string, pid: number) => {
    await api.post("/api/todos", { projectId: pid, title, kind: "task", note });
  };
  const addTask = async (i: number) => {
    const t = r!.tasks[i];
    await addTodo(`${t.file.split("/").pop()} ${ACTION[t.action]}: ${t.detail}`.slice(0, 200), `[기능 추가 예상] ${item!.request}\n파일: ${t.file}`, t.projectId);
    setNotice(`"${t.file.split("/").pop()}" 할 일을 남은 작업에 추가했습니다.`);
  };
  const addAll = async () => {
    for (let i = 0; i < r!.tasks.length; i++) await addTask(i);
    setNotice(`할 일 ${r!.tasks.length}개를 남은 작업에 추가했습니다.`);
  };
  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(r!.claudeCodePrompt);
      setNotice("Claude Code 프롬프트를 복사했습니다.");
    } catch {
      setNotice("복사하지 못했습니다. 직접 선택해서 복사해 주세요.");
    }
  };

  const openNode = (id: string) => {
    const n = byId.get(id);
    if (n) onOpen(n);
  };

  return (
    <div className="flow-main">
      <aside className="flow-list" style={{ width: 300 }}>
        <div className="predict-form">
          <div className="small muted">추가하려는 기능을 적으면 Claude 가 코드를 읽고 흐름이 어떻게 바뀌는지 그려 줍니다. 코드는 고치지 않습니다.</div>
          <textarea
            placeholder="예: 자동음성 전파 이력을 엑셀로 내려받기"
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            disabled={running}
          />
          <button className="btn primary" onClick={run} disabled={running || !request.trim() || !hasApiKey}>
            {running ? "Claude 가 코드를 읽는 중… (1~3분)" : "예상해 보기"}
          </button>
          {!hasApiKey && <div className="small warn-tag">설정에서 Claude API 키를 넣어 주세요.</div>}
          {error && <div className="error small">{error}</div>}
        </div>
        {items.map((x) => (
          <button key={x.id} className={"pred-item" + (x.id === current ? " on" : "")} onClick={() => setCurrent(x.id)}>
            <div className="req">{x.request}</div>
            <div className="small muted">
              {fmtTime(x.createdAt)}
              {x.pending && " · 진행 중"}
              {x.error && " · 실패"}
              {x.stale && <span className="warn-tag"> 예상 이후 코드 바뀜</span>}
            </div>
          </button>
        ))}
        {!items.length && <div className="muted small pad">아직 해 본 예상이 없습니다.</div>}
      </aside>

      <div className="flow-canvas">
        {r ? (
          <ReactFlow
            key={`${item!.id}-${rfNodes.length}`}
            fitView
            fitViewOptions={{ maxZoom: 1.15, padding: 0.08 }}
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={nodeTypes}
            onNodeDoubleClick={(_, n) => openNode(n.id)}
            minZoom={0.05}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={20} color="#e3e6ec" />
            <Controls showInteractive={false} />
          </ReactFlow>
        ) : (
          <div className="empty" style={{ margin: 16 }}>
            {item?.error ? `예상하지 못했습니다: ${item.error}` : item?.pending ? "Claude 가 코드를 읽고 있습니다…" : "왼쪽에 추가할 기능을 적고 \"예상해 보기\"를 누르세요."}
          </div>
        )}
      </div>

      <aside className="flow-side">
        {r && item ? (
          <div className="node-detail">
            <div className="small muted">{fmtTime(item.createdAt)}</div>
            <h2>{item.request}</h2>
            {item.stale && <p className="warn-tag">이 예상을 만든 뒤 관련 파일이 바뀌었습니다. 다시 예상해 보는 게 좋습니다.</p>}
            <p>{r.summary}</p>
            <div className="row small" style={{ gap: 10 }}>
              <span>
                <span className="plan-tag new">새로</span>
                {r.newNodes.length}
              </span>
              <span>
                <span className="plan-tag changed">변경</span>
                {r.changedNodes.length}
              </span>
            </div>
            {notice && <div className="muted small" style={{ marginTop: 6 }}>{notice}</div>}

            <h3>바뀌는 곳</h3>
            <ul className="plan-list">
              {r.newNodes.map((n) => (
                <li key={n.key}>
                  <span className="plan-tag new">새로</span>
                  <b>{n.label}</b> <span className="muted small">{KIND[n.kind as FlowKind]?.label} · {n.project}</span>
                  <div className="small">{n.desc}</div>
                  {n.endpoints.map((e) => (
                    <div key={e} className="mono small muted">{e}</div>
                  ))}
                </li>
              ))}
              {r.changedNodes.map((c) => (
                <li key={c.id}>
                  <span className="plan-tag changed">변경</span>
                  <button className="linkish" onClick={() => openNode(c.id)}>
                    <b>{byId.get(c.id)?.label}</b>
                  </button>{" "}
                  <span className="muted small">{byId.get(c.id)?.project}</span>
                  <div className="small">{c.change}</div>
                </li>
              ))}
            </ul>

            <div className="card-head" style={{ marginTop: 14, marginBottom: 4 }}>
              <h3 style={{ margin: 0 }}>할 일 {r.tasks.length}</h3>
              {r.tasks.length > 0 && (
                <button className="btn small" onClick={addAll}>
                  전부 남은 작업에 추가
                </button>
              )}
            </div>
            <ul className="plan-list">
              {r.tasks.map((t, i) => (
                <li key={i}>
                  <span className={`plan-tag ${t.action}`}>{ACTION[t.action]}</span>
                  <span className="mono small" style={{ wordBreak: "break-all" }} title={t.file}>
                    {t.project} / {t.file.split("/").pop()}
                  </span>
                  <div className="small">{t.detail}</div>
                  <button className="btn small ghost" onClick={() => addTask(i)}>
                    남은 작업에 추가
                  </button>
                </li>
              ))}
            </ul>

            <h3>영향 범위 {impact.length}</h3>
            {impact.length ? (
              <ul className="rel-list">
                {impact.map((n) => (
                  <li key={n.id}>
                    <button className="linkish" onClick={() => onOpen(n)}>
                      <i className="kdot" style={{ background: KIND[n.kind].color }} />
                      {n.label}
                      <span className="fnode-proj">{n.project}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="muted small">바뀌는 클래스를 쓰는 다른 화면·프로젝트가 없습니다.</div>
            )}

            {r.risks.length > 0 && (
              <>
                <h3>주의할 점</h3>
                <ul className="plan-list">
                  {r.risks.map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              </>
            )}

            <div className="card-head" style={{ marginTop: 14, marginBottom: 4 }}>
              <h3 style={{ margin: 0 }}>Claude Code 프롬프트</h3>
              <button className="btn small" onClick={copyPrompt}>
                복사
              </button>
            </div>
            <div className="prompt-box">{r.claudeCodePrompt}</div>
            <div className="row" style={{ marginTop: 10 }}>
              <span className="grow" />
              <button
                className="btn small danger"
                onClick={async () => {
                  if (!confirm("이 예상을 지울까요?")) return;
                  await api.del(`/api/predictions/${item.id}`);
                  setCurrent(null);
                  load();
                }}
              >
                예상 지우기
              </button>
            </div>
          </div>
        ) : (
          <div className="muted small">
            <p>초록은 새로 생길 것, 노랑은 바뀔 것, 흐린 것은 그대로인 주변 클래스입니다. 초록 점선은 새로 생기는 연결입니다.</p>
            <p>노드를 두 번 누르면 코드 탭에서 엽니다.</p>
          </div>
        )}
      </aside>
    </div>
  );
}
