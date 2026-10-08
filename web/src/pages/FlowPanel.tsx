import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "@dagrejs/dagre";
import { api, fmtTime, type FlowGraph, type FlowKind, type FlowNode } from "../api";

export const KINDS: { key: FlowKind; label: string; color: string }[] = [
  { key: "screen", label: "화면", color: "#8b5cf6" },
  { key: "api", label: "API 호출 파일", color: "#0ea5e9" },
  { key: "controller", label: "Controller", color: "#2f6fed" },
  { key: "service", label: "Service", color: "#1f9d55" },
  { key: "client", label: "외부 호출", color: "#d97706" },
  { key: "scheduler", label: "스케줄러", color: "#b45309" },
  { key: "component", label: "Component", color: "#64748b" },
  { key: "repository", label: "Repository", color: "#0d9488" },
  { key: "entity", label: "Entity", color: "#a16207" },
  { key: "table", label: "DB 테이블", color: "#475569" },
  { key: "external", label: "다른 서비스 · 외부", color: "#be185d" },
];
const GROUP_KIND = { key: "group", label: "기능 묶음", color: "#334155" };
const KIND = { ...Object.fromEntries(KINDS.map((k) => [k.key, k])), group: GROUP_KIND } as unknown as Record<FlowKind | "group", { label: string; color: string }>;
type ViewNode = Omit<FlowNode, "kind"> & { kind: FlowKind | "group"; groupKey?: string; count?: number };

const NODE_W = 230;
const NODE_H = 58;

type NodeData = {
  n: ViewNode;
  dim: boolean;
  selected: boolean;
  other: boolean; // 다른 프로젝트 노드 (프로젝트 화면에서)
  showProject: boolean;
};

const ClassNode = memo(function ClassNode({ data }: NodeProps<Node<NodeData>>) {
  const { n, dim, selected, other, showProject } = data;
  const k = KIND[n.kind];
  return (
    <div
      className={"fnode" + (n.kind === "group" ? " group" : "") + (selected ? " sel" : "") + (other ? " other" : "") + (n.changed ? " changed" : "")}
      style={{ borderLeftColor: k.color, opacity: dim ? 0.18 : 1 }}
      title={n.desc ?? n.label}
    >
      <Handle type="target" position={Position.Left} />
      <div className="fnode-top">
        <span className="fnode-kind" style={{ color: k.color }}>
          {k.label}
          {n.scheduled && n.kind !== "scheduler" ? " · 스케줄" : ""}
        </span>
        {(showProject || other) && n.projectId != null && <span className="fnode-proj">{n.project}</span>}
        {n.kind === "table" && n.schema && <span className="fnode-proj">{n.schema}</span>}
        {n.changed && <span className="fnode-changed">수정됨</span>}
      </div>
      <div className="fnode-label">{n.label}</div>
      {n.desc && <div className="fnode-desc">{n.desc}</div>}
      {n.kind === "group" && <div className="fnode-desc">{n.count}개 · 눌러서 펼치기</div>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
});

const nodeTypes = { cls: ClassNode };

/** 숨긴 종류의 노드는 빼고, 그 노드를 거쳐 가던 연결은 앞뒤를 바로 잇는다 */
function collapse(g: FlowGraph, visible: (n: FlowNode) => boolean) {
  const keep = new Set(g.nodes.filter(visible).map((n) => n.id));
  const out = new Map<string, string[]>();
  for (const e of g.edges) out.set(e.source, [...(out.get(e.source) ?? []), e.target]);
  const edges = new Map<string, { source: string; target: string; label?: string; cross?: boolean }>();
  for (const e of g.edges) {
    if (!keep.has(e.source)) continue;
    // 숨긴 노드를 따라가서 처음 만나는 보이는 노드까지
    const stack = [e.target];
    const seen = new Set<string>();
    while (stack.length) {
      const t = stack.pop()!;
      if (seen.has(t)) continue;
      seen.add(t);
      if (keep.has(t)) {
        const id = `${e.source}->${t}`;
        if (!edges.has(id)) edges.set(id, { source: e.source, target: t, label: t === e.target ? e.label : undefined, cross: e.cross });
      } else stack.push(...(out.get(t) ?? []));
    }
  }
  return { nodes: g.nodes.filter((n) => keep.has(n.id)), edges: [...edges.entries()].map(([id, e]) => ({ id, ...e })) };
}

function layout(nodes: { id: string }[], edges: { source: string; target: string }[]) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 12, ranksep: 70, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of edges) g.setEdge(e.source, e.target);
  dagre.layout(g);
  const pos = new Map<string, { x: number; y: number }>();
  for (const n of nodes) {
    const p = g.node(n.id);
    pos.set(n.id, { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 });
  }
  return pos;
}

/** 기능 묶음(프로젝트 / 패키지·폴더) 단위로 합친다 */
function groupUp(g: { nodes: FlowNode[]; edges: { id: string; source: string; target: string; label?: string; cross?: boolean }[] }, keyOf: (n: FlowNode) => string) {
  const keyById = new Map<string, string>();
  const groups = new Map<string, ViewNode & { kinds: Map<string, number> }>();
  for (const n of g.nodes) {
    const key = keyOf(n);
    keyById.set(n.id, "g:" + key);
    let gn = groups.get(key);
    if (!gn) {
      gn = { id: "g:" + key, projectId: n.projectId, project: n.project, kind: "group", label: n.group ?? "", groupKey: key, count: 0, kinds: new Map() };
      groups.set(key, gn);
    }
    gn.count = (gn.count ?? 0) + 1;
    gn.kinds.set(n.kind, (gn.kinds.get(n.kind) ?? 0) + 1);
    if (n.changed) gn.changed = true;
  }
  for (const gn of groups.values())
    gn.desc = [...gn.kinds.entries()].map(([k, c]) => `${KIND[k as FlowKind].label} ${c}`).join(" · ");
  const edges = new Map<string, { id: string; source: string; target: string; label?: string; cross?: boolean; n: number }>();
  for (const e of g.edges) {
    const a = keyById.get(e.source)!;
    const b = keyById.get(e.target)!;
    if (!a || !b || a === b) continue;
    const id = `${a}->${b}`;
    const ex = edges.get(id);
    if (ex) {
      ex.n++;
      ex.cross ||= e.cross;
    } else edges.set(id, { id, source: a, target: b, cross: e.cross, n: 1 });
  }
  return {
    nodes: [...groups.values()] as ViewNode[],
    edges: [...edges.values()].map((e) => ({ ...e, label: `${e.n}개 연결` })),
  };
}

/** 선택한 노드에서 앞(부르는 쪽)·뒤(불리는 쪽)로 이어진 노드 전부 */
function chainOf(id: string, edges: { source: string; target: string }[]) {
  const fwd = new Map<string, string[]>();
  const back = new Map<string, string[]>();
  for (const e of edges) {
    fwd.set(e.source, [...(fwd.get(e.source) ?? []), e.target]);
    back.set(e.target, [...(back.get(e.target) ?? []), e.source]);
  }
  const res = new Set<string>([id]);
  for (const m of [fwd, back]) {
    const stack = [id];
    const seen = new Set<string>();
    while (stack.length) {
      const x = stack.pop()!;
      if (seen.has(x)) continue;
      seen.add(x);
      res.add(x);
      stack.push(...(m.get(x) ?? []));
    }
  }
  return res;
}

type Props = {
  projectId?: number; // 없으면 울산 전체
  hasApiKey: boolean;
  onOpen: (projectId: number, path: string, line?: number) => void;
};

export default function FlowPanel(props: Props) {
  return (
    <ReactFlowProvider>
      <FlowInner {...props} />
    </ReactFlowProvider>
  );
}

const DEFAULT_HIDDEN: FlowKind[] = [];

function FlowInner({ projectId, hasApiKey, onOpen }: Props) {
  const all = projectId == null;
  const [graph, setGraph] = useState<FlowGraph | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [group, setGroup] = useState("");
  const [hidden, setHidden] = useState<Set<FlowKind>>(() => {
    try {
      const saved = localStorage.getItem("flow.hidden");
      return new Set(saved ? (JSON.parse(saved) as FlowKind[]) : DEFAULT_HIDDEN);
    } catch {
      return new Set(DEFAULT_HIDDEN);
    }
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [focusRoot, setFocusRoot] = useState<string | null>(null);
  const focus = !!focusRoot;
  const [grouped, setGrouped] = useState(projectId == null);
  const [describing, setDescribing] = useState("");
  const rf = useReactFlow();

  const url = all ? "/api/flow" : `/api/projects/${projectId}/flow`;
  const load = useCallback(
    async (refresh = false) => {
      setLoading(true);
      setError("");
      try {
        setGraph(await api.get<FlowGraph>(url + (refresh ? "?refresh=1" : "")));
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [url],
  );

  useEffect(() => {
    setSelected(null);
    setGroup("");
    load();
  }, [load]);

  useEffect(() => {
    try {
      localStorage.setItem("flow.hidden", JSON.stringify([...hidden]));
    } catch {
      /* 저장 안 돼도 동작 */
    }
  }, [hidden]);

  const groupKey = (n: FlowNode) => (all || n.projectId !== projectId ? `${n.project} / ${n.group ?? ""}` : (n.group ?? ""));
  const groups = useMemo(() => {
    if (!graph) return [];
    const own = graph.nodes.filter((n) => (all ? true : n.projectId === projectId));
    return [...new Set(own.map(groupKey))].sort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, all, projectId]);

  // 보이는 노드·연결
  const view = useMemo((): { nodes: ViewNode[]; edges: { id: string; source: string; target: string; label?: string; cross?: boolean }[] } | null => {
    if (!graph) return null;
    let g = collapse(graph, (n) => !hidden.has(n.kind));
    if (grouped && !group) return groupUp(g, (n) => `${n.project} / ${n.group ?? ""}`);
    if (group) {
      // 선택한 묶음 + 바로 연결된 노드
      const inGroup = new Set(g.nodes.filter((n) => groupKey(n) === group).map((n) => n.id));
      const keep = new Set(inGroup);
      for (const e of g.edges) {
        if (inGroup.has(e.source)) keep.add(e.target);
        if (inGroup.has(e.target)) keep.add(e.source);
      }
      g = { nodes: g.nodes.filter((n) => keep.has(n.id)), edges: g.edges.filter((e) => keep.has(e.source) && keep.has(e.target)) };
    }
    if (focusRoot && g.nodes.some((n) => n.id === focusRoot)) {
      const chain = chainOf(focusRoot, g.edges);
      g = { nodes: g.nodes.filter((n) => chain.has(n.id)), edges: g.edges.filter((e) => chain.has(e.source) && chain.has(e.target)) };
    }
    return g;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, hidden, group, focusRoot, grouped]);

  const positions = useMemo(() => (view ? layout(view.nodes, view.edges) : new Map()), [view]);

  const query = q.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!view || !query) return null;
    return new Set(
      view.nodes
        .filter((n) => [n.label, n.desc, n.file, ...(n.endpoints ?? []).map((e) => e.path), ...(n.calls ?? []).map((c) => c.url)].some((x) => x?.toLowerCase().includes(query)))
        .map((n) => n.id),
    );
  }, [view, query]);

  const chain = useMemo(() => (view && selected ? chainOf(selected, view.edges) : null), [view, selected]);

  const rfNodes: Node<NodeData>[] = useMemo(
    () =>
      (view?.nodes ?? []).map((n) => ({
        id: n.id,
        type: "cls",
        width: NODE_W,
        height: NODE_H,
        position: positions.get(n.id) ?? { x: 0, y: 0 },
        data: {
          n,
          selected: n.id === selected,
          dim: matches ? !matches.has(n.id) : chain ? !chain.has(n.id) : false,
          other: !all && n.projectId != null && n.projectId !== projectId,
          showProject: all || n.kind === "group",
        },
        draggable: true,
      })),
    [view, positions, selected, matches, chain, all, projectId],
  );

  const rfEdges: Edge[] = useMemo(
    () =>
      (view?.edges ?? []).map((e) => {
        const on = chain ? chain.has(e.source) && chain.has(e.target) : false;
        const dim = (chain && !on) || (matches && !(matches.has(e.source) || matches.has(e.target)));
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          label: on && e.label ? e.label.split("\n")[0] + (e.label.includes("\n") ? ` 외 ${e.label.split("\n").length - 1}` : "") : undefined,
          animated: !!e.cross && on,
          style: {
            stroke: e.cross ? "#be185d" : on ? "#2f6fed" : "#9aa3b2",
            strokeWidth: on ? 2 : 1.2,
            strokeDasharray: e.cross ? "6 4" : undefined,
            opacity: dim ? 0.12 : 1,
          },
          labelStyle: { fontSize: 11 },
          labelBgStyle: { fill: "#fff" },
        };
      }),
    [view, chain, matches],
  );

  // 검색어에 맞는 노드가 하나면 그쪽으로 이동
  useEffect(() => {
    if (matches && matches.size >= 1 && matches.size <= 3) {
      rf.fitView({ nodes: [...matches].map((id) => ({ id })), duration: 300, maxZoom: 1.3 });
    }
  }, [matches, rf]);

  useEffect(() => {
    const t = setTimeout(() => rf.fitView({ duration: 200, maxZoom: 1.3, padding: 0.06 }), 50);
    return () => clearTimeout(t);
  }, [view, rf]);

  const sel = graph?.nodes.find((n) => n.id === selected) ?? null;
  const drill = (n: ViewNode) => {
    // 묶음 → 그 묶음의 클래스 보기
    const any = graph?.nodes.find((x) => `${x.project} / ${x.group ?? ""}` === n.groupKey);
    if (any) setGroup(groupKey(any));
    setGrouped(false);
    setSelected(null);
    setFocusRoot(null);
  };
  const open = (n: FlowNode, line?: number) => {
    const pid = n.fileProjectId ?? n.projectId;
    if (pid != null && n.file) onOpen(pid, n.file, line ?? n.line);
  };

  const describe = async () => {
    if (projectId == null) return;
    setDescribing("Claude 가 설명을 쓰는 중…");
    try {
      const r = await api.post<{ added: number }>(`/api/projects/${projectId}/flow/describe`);
      setDescribing(r.added ? `${r.added}개에 설명을 붙였습니다.` : "설명이 필요한 항목이 없습니다.");
      await load(true);
    } catch (e) {
      setDescribing((e as Error).message);
    }
  };

  const counts = useMemo(() => {
    const c = new Map<FlowKind, number>();
    for (const n of graph?.nodes ?? []) c.set(n.kind, (c.get(n.kind) ?? 0) + 1);
    return c;
  }, [graph]);

  if (error) return <div className="error">{error}</div>;
  if (!graph) return <div className="empty">{loading ? "코드를 분석하는 중…" : ""}</div>;
  if (!graph.nodes.length)
    return (
      <div className="empty">
        분석할 수 있는 구조를 못 찾았습니다. Spring(src/main/java) 또는 React(src, package.json) 프로젝트만 지원합니다.
      </div>
    );

  return (
    <div className="flow">
      <div className="flow-bar">
        <input placeholder="클래스 · 주소 · 파일 찾기" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} />
        <select value={group} onChange={(e) => setGroup(e.target.value)} disabled={grouped}>
          <option value="">{all ? "전체 프로젝트 · 기능" : "전체 기능"}</option>
          {groups.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
        <label className="check small" title="프로젝트 / 패키지(폴더) 단위로 합쳐서 봅니다">
          <input
            type="checkbox"
            checked={grouped}
            onChange={(e) => {
              setGrouped(e.target.checked);
              setGroup("");
              setSelected(null);
              setFocusRoot(null);
            }}
          />
          기능 묶음으로 보기
        </label>
        <label className="check small" title="선택한 것과 이어진 흐름만 남깁니다">
          <input type="checkbox" checked={focus} onChange={(e) => setFocusRoot(e.target.checked ? selected : null)} disabled={!selected || grouped} />
          선택한 흐름만
        </label>
        <span className="grow" />
        {!all && (
          <button className="btn small" onClick={describe} disabled={!hasApiKey || !!describing.endsWith("…")} title={hasApiKey ? "주석이 없는 항목에 Claude 가 한 줄 설명을 붙입니다" : "설정에서 API 키를 넣어 주세요"}>
            Claude 설명 채우기
          </button>
        )}
        <button className="btn small" onClick={() => load(true)} disabled={loading}>
          {loading ? "분석 중…" : "다시 분석"}
        </button>
      </div>
      <div className="flow-kinds">
        {KINDS.filter((k) => counts.get(k.key)).map((k) => (
          <button
            key={k.key}
            className={"kind-chip" + (hidden.has(k.key) ? " off" : "")}
            onClick={() =>
              setHidden((h) => {
                const s = new Set(h);
                if (s.has(k.key)) s.delete(k.key);
                else s.add(k.key);
                return s;
              })
            }
          >
            <i style={{ background: k.color }} />
            {k.label} {counts.get(k.key)}
          </button>
        ))}
        <span className="kind-chip legend">
          <i className="dash" /> 프로젝트 사이 호출
        </span>
        <span className="kind-chip legend">
          <i className="chg" /> git 수정됨
        </span>
        {describing && <span className="muted small">{describing}</span>}
      </div>

      <div className="flow-main">
        <div className="flow-canvas">
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={nodeTypes}
            onNodeClick={(_, n) => {
              const vn = (n.data as NodeData).n;
              if (vn.kind === "group") drill(vn);
              else setSelected(n.id);
            }}
            onNodeDoubleClick={(_, n) => {
              const fn = graph.nodes.find((x) => x.id === n.id);
              if (fn) open(fn);
            }}
            onPaneClick={() => setSelected(null)}
            minZoom={0.05}
            maxZoom={2}
            onlyRenderVisibleElements
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={20} color="#e3e6ec" />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable nodeColor={(n) => KIND[(n.data as NodeData).n.kind].color} nodeStrokeWidth={0} />
          </ReactFlow>
        </div>

        <aside className="flow-side">
          {sel ? (
            <NodeDetail n={sel} graph={graph} onOpen={open} onSelect={setSelected} />
          ) : (
            <div className="muted small">
              <p>노드를 누르면 이어진 흐름이 강조되고 여기에 자세한 내용이 나옵니다. 두 번 누르면 코드 탭에서 엽니다.</p>
              <p>마우스 휠로 확대·축소, 빈 곳을 끌어서 이동합니다. 위의 종류 버튼으로 숨기면 그 단계는 건너뛰고 연결합니다.</p>
              <p>분석: {fmtTime(graph.generatedAt)}</p>
              {graph.unresolved.length > 0 && (
                <>
                  <h3>연결을 못 찾은 호출 {graph.unresolved.length}개</h3>
                  {graph.unresolved.map((u, i) => (
                    <div key={i} className="unres">
                      <div className="mono">{u.url}</div>
                      <div>
                        {u.project} · {u.file}
                      </div>
                      <div>{u.reason}</div>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function NodeDetail({
  n,
  graph,
  onOpen,
  onSelect,
}: {
  n: FlowNode;
  graph: FlowGraph;
  onOpen: (n: FlowNode, line?: number) => void;
  onSelect: (id: string) => void;
}) {
  const byId = new Map(graph.nodes.map((x) => [x.id, x]));
  const incoming = graph.edges.filter((e) => e.target === n.id);
  const outgoing = graph.edges.filter((e) => e.source === n.id);
  const k = KIND[n.kind];
  const link = (id: string, label?: string) => {
    const x = byId.get(id);
    if (!x) return null;
    return (
      <li key={id + (label ?? "")}>
        <button className="linkish" onClick={() => onSelect(id)}>
          <i className="kdot" style={{ background: KIND[x.kind].color }} />
          {x.label}
          {x.projectId != null && x.projectId !== n.projectId && <span className="fnode-proj">{x.project}</span>}
        </button>
        {label && <div className="mono small muted pre">{label}</div>}
      </li>
    );
  };
  return (
    <div className="node-detail">
      <div className="small" style={{ color: k.color, fontWeight: 600 }}>
        {k.label}
        {n.scheduled ? " · @Scheduled" : ""}
      </div>
      <h2 style={{ wordBreak: "break-all" }}>{n.label}</h2>
      <div className="muted small">
        {n.project}
        {n.group ? ` · ${n.group}` : ""}
        {n.changed && <span className="fnode-changed"> 수정됨</span>}
      </div>
      {n.desc && (
        <p>
          {n.desc}
          {n.descBy === "claude" && <span className="muted small"> (Claude 설명)</span>}
        </p>
      )}
      {n.folder && <div className="mono small muted">폴더: {n.folder}</div>}
      {n.file && (
        <div className="row" style={{ margin: "8px 0" }}>
          <span className="mono small grow" style={{ wordBreak: "break-all" }}>
            {n.file}
          </span>
          <button className="btn small" onClick={() => onOpen(n)}>
            코드에서 열기
          </button>
        </div>
      )}
      {!!n.endpoints?.length && (
        <>
          <h3>주소 {n.endpoints.length}개</h3>
          <ul className="ep-list">
            {n.endpoints.map((e, i) => (
              <li key={i}>
                <button className="linkish mono small" onClick={() => onOpen(n, e.line)}>
                  <b>{e.method}</b> {e.path}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {!!n.calls?.length && (
        <>
          <h3>부르는 주소 {n.calls.length}개</h3>
          <ul className="ep-list">
            {n.calls.map((c, i) => (
              <li key={i} className="mono small">
                {c.method && <b>{c.method} </b>}
                {c.url}
              </li>
            ))}
          </ul>
        </>
      )}
      {incoming.length > 0 && (
        <>
          <h3>이것을 쓰는 곳 {incoming.length}</h3>
          <ul className="rel-list">{incoming.map((e) => link(e.source, e.label))}</ul>
        </>
      )}
      {outgoing.length > 0 && (
        <>
          <h3>이것이 쓰는 것 {outgoing.length}</h3>
          <ul className="rel-list">{outgoing.map((e) => link(e.target, e.label))}</ul>
        </>
      )}
    </div>
  );
}
