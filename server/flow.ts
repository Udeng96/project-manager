// 구조 흐름도: 코드 정적 분석으로 클래스 단위 그래프를 만든다.
//   Spring: 화면에서 부른 API → Controller → Service → Repository → Entity → 테이블, 외부 호출(Client)
//   React : 화면(기능 폴더) → API 파일 → (vite 프록시 기준) 백엔드 Controller
// 프로젝트 사이 연결은 vite.config 의 proxy 대상 포트, application.yml 의 server.port / context-path,
// @ConfigurationProperties 로 읽는 base-url + path 를 맞춰서 찾는다.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { db } from "./db.js";
import type { Project } from "./projects.js";
import * as git from "./git.js";
import * as ai from "./ai.js";

export type NodeKind =
  | "screen"
  | "api"
  | "controller"
  | "service"
  | "repository"
  | "client"
  | "scheduler"
  | "component"
  | "entity"
  | "table"
  | "external";

export type Endpoint = { method: string; path: string; line: number };

export type FlowNode = {
  id: string;
  projectId: number | null; // 테이블·외부 시스템은 null
  project: string;
  kind: NodeKind;
  label: string;
  file?: string; // 프로젝트 기준 상대 경로
  fileProjectId?: number; // file 이 속한 프로젝트 (테이블은 마이그레이션 SQL 이 있는 프로젝트)
  folder?: string; // 화면 묶음 폴더
  line?: number;
  desc?: string;
  descBy?: "code" | "claude";
  group?: string; // 기능 묶음 (패키지 / 기능 폴더)
  endpoints?: Endpoint[];
  calls?: { method: string; url: string }[];
  scheduled?: boolean;
  changed?: boolean;
  schema?: string;
};

export type FlowEdge = { id: string; source: string; target: string; label?: string; cross?: boolean };
export type Unresolved = { projectId: number; project: string; file: string; url: string; reason: string };
export type Graph = { nodes: FlowNode[]; edges: FlowEdge[]; unresolved: Unresolved[]; generatedAt: string };

const SKIP_DIRS = new Set([".git", "node_modules", "build", "dist", "target", ".gradle", ".idea", "bin", "out", ".vscode", ".next", "test"]);

function walk(root: string, sub: string, exts: string[], out: string[] = []) {
  const dir = path.join(root, sub);
  let ents: fs.Dirent[];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    const rel = sub ? `${sub}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(root, rel, exts, out);
    } else if (exts.some((x) => e.name.endsWith(x))) out.push(rel);
  }
  return out;
}

const read = (root: string, rel: string) => {
  try {
    return fs.readFileSync(path.join(root, rel), "utf8");
  } catch {
    return "";
  }
};

const lineOf = (src: string, idx: number) => src.slice(0, idx).split("\n").length;

/** 주석 첫 문장만 (설명용) */
function firstSentence(comment: string) {
  const text = comment
    .replace(/^\/\*\*?|\*\/$/g, "")
    .split("\n")
    .map((l) => l.replace(/^\s*(\*|\/\/)\s?/, "").trim())
    .filter((l) => l && !l.startsWith("@"))
    .join(" ")
    .replace(/<[^>]+>/g, "")
    .replace(/\{@\w+\s+([^}]*)\}/g, "$1")
    .trim();
  const m = text.match(/^(.+?[.。])(\s|$)/);
  return (m ? m[1] : text).slice(0, 120);
}

// ---------------- 아주 단순한 yml 읽기 (key: value 만) ----------------
export function flattenYaml(text: string) {
  const out = new Map<string, string>();
  const stack: { indent: number; key: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith("#") || raw.trim().startsWith("-") || raw.trim() === "---") continue;
    const m = raw.match(/^(\s*)([\w.\-"']+)\s*:(.*)$/);
    if (!m) continue;
    const indent = m[1].length;
    const key = m[2].replace(/["']/g, "");
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const full = [...stack.map((s) => s.key), key].join(".");
    let value = m[3].replace(/\s+#.*$/, "").trim();
    if (value === "" || value === "|" || value === ">") {
      stack.push({ indent, key });
      continue;
    }
    value = value.replace(/^["']|["']$/g, "");
    // ${ENV:default} → default
    value = value.replace(/\$\{[^:}]+:([^}]*)\}/g, "$1");
    out.set(full, value);
  }
  return out;
}

/** 프로젝트의 application*.yml (application.yml 우선) */
function loadYaml(root: string) {
  const dir = "src/main/resources";
  let names: string[] = [];
  try {
    names = fs.readdirSync(path.join(root, dir)).filter((n) => /^application.*\.ya?ml$/.test(n));
  } catch {
    return new Map<string, string>();
  }
  names.sort((a, b) => (a.startsWith("application.") ? -1 : b.startsWith("application.") ? 1 : a.localeCompare(b)));
  const merged = new Map<string, string>();
  for (const n of names) for (const [k, v] of flattenYaml(read(root, `${dir}/${n}`))) if (!merged.has(k)) merged.set(k, v);
  return merged;
}

const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

// ---------------- URL 경로 맞추기 ----------------
const joinPath = (...parts: string[]) => {
  const p = parts
    .filter(Boolean)
    .join("/")
    .replace(/\/{2,}/g, "/");
  const s = p.startsWith("/") ? p : "/" + p;
  return s.length > 1 ? s.replace(/\/$/, "") : s;
};

function pathMatches(pattern: string, url: string) {
  const a = pattern.split("/").filter(Boolean);
  const b = url.split("?")[0].split("/").filter(Boolean);
  if (a.length !== b.length) return false;
  return a.every((seg, i) => seg === b[i] || seg.startsWith("{") || b[i].startsWith("{") || seg === "*");
}

// ---------------- Java (Spring) ----------------
type JavaClass = {
  name: string;
  file: string;
  line: number;
  pkg: string;
  annotations: string;
  body: string;
  isInterface: boolean;
  desc?: string;
};

const HTTP_CLIENT = /\b(RestClient|RestTemplate|WebClient|HttpClient|FeignClient|OkHttpClient)\b/;

function parseJava(file: string, src: string): JavaClass | null {
  const pkg = src.match(/^\s*package\s+([\w.]+)\s*;/m)?.[1] ?? "";
  const decl = /^((?:\s*@[\w.]+(?:\([^)]*(?:\([^)]*\)[^)]*)*\))?\s*)*)\s*(?:public\s+)?(?:abstract\s+|final\s+|sealed\s+)*(class|interface|record|enum|@interface)\s+(\w+)/m.exec(
    src,
  );
  if (!decl) return null;
  const before = src.slice(0, decl.index);
  const javadoc = before.match(/\/\*\*([\s\S]*?)\*\/\s*$/);
  return {
    name: decl[3],
    file,
    line: lineOf(src, decl.index + decl[0].lastIndexOf(decl[3])),
    pkg,
    annotations: decl[1],
    body: src.slice(decl.index),
    isInterface: decl[2] === "interface",
    desc: javadoc ? firstSentence(javadoc[0]) : undefined,
  };
}

/** @XxxMapping("a") / (value = {"a","b"}) / (path = "a") 의 경로들 */
function mappingPaths(args: string | undefined) {
  if (!args) return [""];
  const named = args.match(/\b(?:value|path)\s*=\s*(\{[^}]*\}|"[^"]*")/);
  const src = named ? named[1] : /^\s*(\{[^}]*\}|"[^"]*")/.test(args) ? args.match(/^\s*(\{[^}]*\}|"[^"]*")/)![1] : "";
  const paths = [...src.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  return paths.length ? paths : [""];
}

function endpointsOf(c: JavaClass, src: string, contextPath: string): Endpoint[] {
  const cls = c.annotations.match(/@RequestMapping\s*(?:\(([^)]*)\))?/);
  const bases = cls ? mappingPaths(cls[1]) : [""];
  const out: Endpoint[] = [];
  const re = /@(Get|Post|Put|Delete|Patch|Request)Mapping\s*(?:\(((?:[^()]|\([^()]*\))*)\))?/g;
  // 클래스 선언 뒤(본문)만 본다 — 클래스에 붙은 @RequestMapping 은 위에서 따로 읽음
  const declEnd = c.body.search(new RegExp(`\\b(?:class|interface)\\s+${c.name}\\b`));
  const inner = c.body.slice(Math.max(0, declEnd));
  const bodyStart = src.indexOf(c.body) + Math.max(0, declEnd);
  for (const m of inner.matchAll(re)) {
    let method = m[1].toUpperCase();
    if (method === "REQUEST") method = m[2]?.match(/RequestMethod\.(\w+)/)?.[1] ?? "ALL";
    for (const b of bases)
      for (const p of mappingPaths(m[2])) out.push({ method, path: joinPath(contextPath, b, p), line: lineOf(src, bodyStart + (m.index ?? 0)) });
  }
  return out;
}

type ProjectScan = {
  project: Project;
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** 다른 프로젝트·외부로 나가는 호출 (나중에 한꺼번에 연결) */
  out: { from: string; file: string; method: string; url: string; viaProxy?: { port?: string; host?: string; path: string } }[];
  port?: string;
  contextPath: string;
};

function nodeId(p: Project, kind: string, key: string) {
  return `${p.id}:${kind}:${key}`;
}

function tableId(schema: string | undefined, name: string) {
  return `table:${(schema ? schema + "." : "") + name}`.toLowerCase();
}

function scanSpring(p: Project): ProjectScan {
  const root = p.path;
  const yml = loadYaml(root);
  const contextPath = yml.get("server.servlet.context-path") ?? yml.get("server.servlet.contextPath") ?? "";
  const port = yml.get("server.port");
  const files = walk(root, "src/main/java", [".java"]);
  const classes: (JavaClass & { src: string })[] = [];
  for (const f of files) {
    const src = read(root, f);
    const c = parseJava(f, src);
    if (c) classes.push({ ...c, src });
  }

  // 기본 패키지 (공통 접두어) → 기능 묶음 이름
  const pkgs = classes.map((c) => c.pkg.split("."));
  let basePkg: string[] = pkgs[0] ?? [];
  for (const parts of pkgs) {
    let i = 0;
    while (i < basePkg.length && basePkg[i] === parts[i]) i++;
    basePkg = basePkg.slice(0, i);
  }
  const groupOf = (pkg: string) => {
    const rest = pkg.split(".").slice(basePkg.length);
    return rest.slice(0, 2).join("/") || "(기본)";
  };

  // @ConfigurationProperties(prefix=...) 클래스
  const propPrefix = new Map<string, string>();
  for (const c of classes) {
    const m = c.annotations.match(/@ConfigurationProperties\s*\(\s*(?:prefix\s*=\s*|value\s*=\s*)?"([^"]+)"/);
    if (m) propPrefix.set(c.name, m[1]);
  }

  const nodes: FlowNode[] = [];
  const byName = new Map<string, FlowNode>();
  const tables = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];
  const out: ProjectScan["out"] = [];

  for (const c of classes) {
    const a = c.annotations;
    let kind: NodeKind | null = null;
    if (/@(Rest)?Controller\b/.test(a)) kind = "controller";
    else if (/@Service\b/.test(a)) kind = "service";
    else if (/@Repository\b/.test(a) || (c.isInterface && /extends\s+\w*Repository\s*</.test(c.body))) kind = "repository";
    else if (/@Entity\b/.test(a)) kind = "entity";
    else if (/@(Component|Configuration)\b/.test(a)) {
      if (HTTP_CLIENT.test(c.src)) kind = "client";
      else if (/@Scheduled\b/.test(c.body)) kind = "scheduler";
      else if (/@Component\b/.test(a)) kind = "component";
    } else if (/@Mapper\b/.test(a)) kind = "repository";
    if (!kind) continue;
    const n: FlowNode = {
      id: nodeId(p, "java", c.name),
      projectId: p.id,
      project: p.name,
      kind,
      label: c.name,
      file: c.file,
      line: c.line,
      desc: c.desc,
      descBy: c.desc ? "code" : undefined,
      group: groupOf(c.pkg),
    };
    if (kind === "controller") n.endpoints = endpointsOf(c, c.src, contextPath);
    if (/@Scheduled\b/.test(c.body)) n.scheduled = true;
    nodes.push(n);
    byName.set(c.name, n);
  }

  const impls = new Map<string, string[]>();
  for (const c of classes) {
    const head = c.body.match(new RegExp(`\\b(?:class|record|enum)\\s+${c.name}\\b[^{]*`))?.[0] ?? "";
    const m = head.match(/\bimplements\s+([\w\s,<>.]+)$/);
    if (m)
      for (const i of m[1].replace(/<[^>]*>/g, "").split(",").map((x) => x.trim().split(".").pop()!))
        if (i) impls.set(i, [...(impls.get(i) ?? []), c.name]);
  }

  const addEdge = (source: string, target: string, label?: string) => {
    const id = `${source}->${target}`;
    if (source !== target && !edges.some((e) => e.id === id)) edges.push({ id, source, target, label });
  };

  for (const c of classes) {
    const n = byName.get(c.name);
    if (!n) continue;
    // 주입받는 클래스: final 필드, @Autowired 필드, 생성자 파라미터
    const deps = new Set<string>();
    for (const m of c.body.matchAll(/(?:private|protected)\s+final\s+([A-Z]\w*)(?:<[^;=]*>)?\s+\w+\s*;/g)) deps.add(m[1]);
    for (const m of c.body.matchAll(/@Autowired\s+(?:private|protected)?\s*([A-Z]\w*)/g)) deps.add(m[1]);
    for (const m of c.body.matchAll(new RegExp(`\\b${c.name}\\s*\\(([^)]*)\\)\\s*\\{`, "g")))
      for (const t of m[1].matchAll(/([A-Z]\w*)(?:<[^>]*>)?\s+\w+\s*(?:,|$)/g)) deps.add(t[1]);
    for (const d of deps) {
      const target = byName.get(d);
      if (target) addEdge(n.id, target.id);
      // 인터페이스로 주입받으면 구현 클래스로 잇는다
      else for (const impl of impls.get(d) ?? []) if (byName.has(impl)) addEdge(n.id, byName.get(impl)!.id);
    }

    // Repository → Entity
    if (n.kind === "repository") {
      const m = c.body.match(/extends\s+\w*Repository\s*<\s*(\w+)/);
      const target = m && byName.get(m[1]);
      if (target) addEdge(n.id, target.id);
    }

    // Entity → 테이블
    if (n.kind === "entity") {
      const t = c.annotations.match(/@Table\s*\(([^)]*)\)/);
      const name = t?.[1].match(/name\s*=\s*"([^"]+)"/)?.[1] ?? snake(c.name);
      const schema = t?.[1].match(/schema\s*=\s*"([^"]+)"/)?.[1];
      const id = tableId(schema, name);
      if (!tables.has(id))
        tables.set(id, { id, projectId: null, project: "DB", kind: "table", label: name, schema, group: schema ?? "(기본)" });
      addEdge(n.id, id);
    }

    // 외부 호출: @ConfigurationProperties 의 base-url + path, @Value("${...}"), 문자열 URL
    if (HTTP_CLIENT.test(c.src) && n.kind !== "entity") {
      const bases: string[] = [];
      const paths: string[] = [];
      const take = (v: string | undefined) => {
        if (!v) return;
        if (/^https?:\/\//.test(v)) bases.push(v);
        else if (v.startsWith("/")) paths.push(v);
      };
      for (const d of deps) {
        const prefix = propPrefix.get(d);
        if (!prefix) continue;
        for (const [k, v] of yml) if (k.startsWith(prefix + ".") && !k.slice(prefix.length + 1).includes(".")) take(v);
      }
      for (const m of c.src.matchAll(/@Value\s*\(\s*"\$\{([^}:]+)(?::([^}]*))?\}"\s*\)/g)) take(yml.get(m[1]) ?? m[2]);
      for (const m of c.src.matchAll(/"(https?:\/\/[^"\s]+)"/g)) take(m[1]);
      const urls = bases.length ? bases.flatMap((b) => (paths.length ? paths.map((x) => b.replace(/\/$/, "") + x) : [b])) : [];
      for (const u of urls) {
        try {
          const url = new URL(u.replace(/\{[^}]*\}/g, "x"));
          out.push({
            from: n.id,
            file: c.file,
            method: "",
            url: u,
            viaProxy: { host: url.hostname, port: url.port || (url.protocol === "https:" ? "443" : "80"), path: url.pathname },
          });
        } catch {
          /* 주소 형식이 아니면 건너뜀 */
        }
      }
      if (urls.length) n.calls = urls.map((url) => ({ method: "", url }));
    }
  }

  // Flyway 마이그레이션: 테이블을 만든 SQL 파일을 테이블에 붙인다
  for (const f of walk(root, "src/main/resources", [".sql"])) {
    const src = read(root, f);
    for (const m of src.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?(\w+)"?\.)?"?(\w+)"?/gi)) {
      const t = tables.get(tableId(m[1], m[2]));
      if (t && !t.file) Object.assign(t, { file: f, fileProjectId: p.id, desc: `${path.basename(f)} 에서 생성`, descBy: "code" });
    }
  }

  return { project: p, nodes: [...nodes, ...tables.values()], edges, out, port, contextPath };
}

// ---------------- React / TS ----------------
/** 함수 호출 인자 하나를 읽는다 (따옴표·괄호 짝 맞춤). end 는 멈춘 문자 (',' 또는 ')') */
function scanArg(src: string, start: number) {
  let depth = 0;
  const quotes: string[] = [];
  let i = start;
  for (; i < src.length; i++) {
    const ch = src[i];
    const q = quotes[quotes.length - 1];
    if (q) {
      if (ch === "\\") i++;
      else if (ch === q) quotes.pop();
      else if (q === "`" && ch === "$" && src[i + 1] === "{") {
        quotes.push("}");
        i++;
      } else if (q === "}" && (ch === "'" || ch === '"' || ch === "`")) quotes.push(ch);
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") quotes.push(ch);
    else if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) {
      if (depth === 0) break;
      depth--;
    } else if (ch === "," && depth === 0) break;
  }
  return { text: src.slice(start, i), end: src[i], next: i + 1 };
}

/** 템플릿 문자열의 ${...} 를 바꾼다 (안쪽 중괄호·백틱 짝 맞춤) */
function replaceTemplateExprs(s: string, fn: (inner: string) => string) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "$" && s[i + 1] === "{") {
      let depth = 1;
      let j = i + 2;
      for (; j < s.length && depth; j++) {
        if (s[j] === "{") depth++;
        else if (s[j] === "}") depth--;
      }
      out += fn(s.slice(i + 2, j - 1));
      i = j - 1;
    } else out += s[i];
  }
  return out;
}

type Proxy = { prefix: string; port?: string; host?: string; strip: boolean };

function parseViteProxy(src: string): Proxy[] {
  const i = src.indexOf("proxy");
  if (i < 0) return [];
  const body = src.slice(i);
  const out: Proxy[] = [];
  const keys = [...body.matchAll(/['"](\/[\w\-./]*)['"]\s*:\s*(['"]([^'"]+)['"]|\{)/g)];
  keys.forEach((k, idx) => {
    const chunk = body.slice(k.index, keys[idx + 1]?.index ?? body.length);
    const target = k[3] ?? chunk.match(/target\s*:\s*['"]([^'"]+)['"]/)?.[1];
    let port: string | undefined;
    let host: string | undefined;
    try {
      const u = new URL(target!);
      host = u.hostname;
      port = u.port || (u.protocol === "https:" || u.protocol === "wss:" ? "443" : "80");
    } catch {
      /* target 없음 */
    }
    out.push({ prefix: k[1], port, host, strip: /rewrite\s*:/.test(chunk) });
  });
  return out.sort((a, b) => b.prefix.length - a.prefix.length);
}

function scanFront(p: Project): ProjectScan & { proxies: Proxy[] } {
  const root = p.path;
  const files = walk(root, "src", [".ts", ".tsx", ".js", ".jsx"]).filter((f) => !/\.(test|spec|d)\.[tj]sx?$/.test(f));
  const fileSet = new Set(files);
  const viteFile = ["vite.config.ts", "vite.config.js", "vite.config.mts"].find((f) => fs.existsSync(path.join(root, f)));
  const proxies = viteFile ? parseViteProxy(read(root, viteFile)) : [];

  const resolveImport = (from: string, spec: string) => {
    let base: string;
    if (spec.startsWith("@/")) base = "src/" + spec.slice(2);
    else if (spec.startsWith(".")) base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
    else return null;
    for (const ext of ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js"])
      if (fileSet.has(base + ext)) return base + ext;
    return null;
  };

  // 화면 묶음: src/features/<a>/<b>, src/routes/<파일>, src/pages/<a>
  const screenOf = (f: string) => {
    const parts = f.split("/");
    if (parts[1] === "features" || parts[1] === "pages") {
      const isDir = (n: number) => parts.length > n + 1;
      if (parts[1] === "features" && isDir(3)) return parts.slice(0, 4).join("/");
      if (isDir(2)) return parts.slice(0, 3).join("/");
      return f.replace(/\.[tj]sx?$/, "");
    }
    if (parts[1] === "routes") return f.replace(/\.[tj]sx?$/, "");
    if (/^src\/(App|main|router)\.[tj]sx?$/.test(f)) return "src/app";
    return null;
  };

  const imports = new Map<string, string[]>();
  const calls = new Map<string, { method: string; url: string; line: number }[]>();
  const firstComment = new Map<string, string>();

  for (const f of files) {
    const src = read(root, f);
    imports.set(
      f,
      [...src.matchAll(/(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)]
        .map((m) => resolveImport(f, m[1] ?? m[2]))
        .filter((x): x is string => !!x),
    );
    const head = src.match(/^\s*((?:\/\/[^\n]*\n)+|\/\*[\s\S]*?\*\/)/);
    if (head) firstComment.set(f, firstSentence(head[1]));

    // 파일 안 상수 (const BASE = '/api/...')
    const consts = new Map<string, string>();
    for (const m of src.matchAll(/const\s+(\w+)\s*(?::\s*\w+)?\s*=\s*(['"`])([^'"`]*)\2/g)) consts.set(m[1], m[3]);
    const evalExpr = (expr: string): string | null => {
      expr = expr.trim();
      const lit = expr.match(/^(['"`])([\s\S]*)\1$/);
      let s: string;
      if (lit) s = lit[2];
      else if (consts.has(expr)) s = consts.get(expr)!;
      else return null;
      return replaceTemplateExprs(s, (inner) => {
        const v = inner.trim();
        if (consts.has(v) && consts.get(v)!.startsWith("/")) return consts.get(v)!;
        if (/^\w+$/.test(v)) return `{${v}}`;
        return v.includes("?") || /qs|query|params|search/i.test(v) ? "" : "{x}";
      });
      return s;
    };
    const found: { method: string; url: string; line: number }[] = [];
    const re = /\b(fetch|new\s+EventSource|new\s+WebSocket|axios(?:\.(get|post|put|delete|patch))?|(?:http|api|client|request)\.(get|post|put|delete|patch))\s*\(/g;
    for (const m of src.matchAll(re)) {
      // 첫 번째 인자와 (있으면) 두 번째 인자(옵션) 꺼내기
      const first = scanArg(src, (m.index ?? 0) + m[0].length);
      const arg = first.text;
      const opts = first.end === "," ? scanArg(src, first.next).text : "";
      const url = evalExpr(arg);
      if (!url || !url.startsWith("/")) continue;
      const method =
        (m[2] ?? m[3])?.toUpperCase() ??
        (m[1].includes("EventSource") ? "SSE" : m[1].includes("WebSocket") ? "WS" : opts.match(/method\s*:\s*['"](\w+)['"]/)?.[1]?.toUpperCase() ?? "GET");
      found.push({ method, url: url.split("?")[0], line: lineOf(src, m.index ?? 0) });
    }
    // 다른 파일에서 쓰는 주소 상수 (export const XXX_URL = '/...')
    for (const m of src.matchAll(/export\s+const\s+(\w*(?:URL|PATH|BASE)\w*)\s*=\s*['"`](\/[^'"`]*)['"`]/g))
      if (!found.some((x) => x.url === m[2])) found.push({ method: /STREAM/.test(m[1]) ? "SSE" : "", url: m[2], line: lineOf(src, m.index ?? 0) });
    if (found.length) calls.set(f, found);
  }

  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const out: ProjectScan["out"] = [];
  const apiNodes = new Map<string, FlowNode>();

  for (const [f, list] of calls) {
    const uniq = new Map(list.map((c) => [`${c.method} ${c.url}`, c]));
    const n: FlowNode = {
      id: nodeId(p, "file", f),
      projectId: p.id,
      project: p.name,
      kind: "api",
      label: path.posix.basename(f),
      file: f,
      desc: firstComment.get(f),
      descBy: firstComment.get(f) ? "code" : undefined,
      group: f.split("/").slice(1, -1).join("/") || "src",
      calls: [...uniq.values()].map((c) => ({ method: c.method, url: c.url })),
    };
    nodes.push(n);
    apiNodes.set(f, n);
    for (const c of uniq.values()) {
      const proxy = proxies.find((x) => c.url === x.prefix || c.url.startsWith(x.prefix + "/"));
      out.push({
        from: n.id,
        file: f,
        method: c.method,
        url: c.url,
        viaProxy: proxy ? { host: proxy.host, port: proxy.port, path: proxy.strip ? c.url.slice(proxy.prefix.length) || "/" : c.url } : undefined,
      });
    }
  }

  // 화면 → API 파일 (화면이 아닌 파일(hooks, components 등)을 거쳐 가는 것도 따라간다)
  const screens = new Map<string, FlowNode>();
  for (const f of files) {
    const s = screenOf(f);
    if (!s) continue;
    const seen = new Set<string>([f]);
    const queue = [...(imports.get(f) ?? [])];
    const reached = new Set<string>();
    if (apiNodes.has(f)) reached.add(f);
    while (queue.length) {
      const g = queue.shift()!;
      if (seen.has(g)) continue;
      seen.add(g);
      if (apiNodes.has(g)) reached.add(g);
      const gs = screenOf(g);
      if (gs && gs !== s) continue; // 다른 화면 안으로는 들어가지 않는다
      queue.push(...(imports.get(g) ?? []));
    }
    if (!reached.size) continue;
    const id = nodeId(p, "screen", s);
    if (!screens.has(id)) {
      const label = s === "src/app" ? "앱 시작 (App/router)" : s.replace(/^src\/(features|pages|routes)\//, "");
      const inGroup = files.filter((x) => screenOf(x) === s);
      const entry =
        inGroup.find((x) => /(Panel|Page|Route|Dashboard|index)\.tsx$/.test(x)) ?? inGroup.find((x) => x.endsWith(".tsx")) ?? f;
      screens.set(id, { id, projectId: p.id, project: p.name, kind: "screen", label, file: entry, folder: s, group: s.split("/").slice(1, 3).join("/") });
    }
    for (const r of reached) {
      const target = apiNodes.get(r)!;
      const eid = `${id}->${target.id}`;
      if (id !== target.id && !edges.some((e) => e.id === eid)) edges.push({ id: eid, source: id, target: target.id });
    }
  }
  for (const s of screens.values()) if (s.file && firstComment.has(s.file)) Object.assign(s, { desc: firstComment.get(s.file), descBy: "code" });

  return { project: p, nodes: [...screens.values(), ...nodes], edges, out, contextPath: "", proxies };
}

// ---------------- 전체 묶기 ----------------
function scanProject(p: Project) {
  if (fs.existsSync(path.join(p.path, "src/main/java"))) return scanSpring(p);
  if (fs.existsSync(path.join(p.path, "package.json")) && fs.existsSync(path.join(p.path, "src"))) return scanFront(p);
  return null;
}

const LOCAL = new Set(["localhost", "127.0.0.1", "0.0.0.0", "host.docker.internal"]);

function link(scans: ProjectScan[]) {
  const nodes = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];
  const unresolved: Unresolved[] = [];
  for (const s of scans) {
    for (const n of s.nodes) {
      const prev = nodes.get(n.id);
      if (!prev) nodes.set(n.id, { ...n });
      else if (n.kind === "table" && !prev.file && n.file) nodes.set(n.id, { ...prev, ...n });
    }
    edges.push(...s.edges);
  }
  const controllers = [...nodes.values()].filter((n) => n.kind === "controller");
  const byPort = new Map<string, ProjectScan>();
  for (const s of scans) if (s.port) byPort.set(s.port, s);

  const addEdge = (e: FlowEdge) => {
    const ex = edges.find((x) => x.id === e.id);
    if (!ex) edges.push(e);
    else if (e.label && ex.label && !ex.label.split("\n").includes(e.label)) ex.label += "\n" + e.label;
  };

  for (const s of scans) {
    for (const o of s.out) {
      const v = o.viaProxy;
      const callPath = v?.path ?? o.url;
      // 1) 포트로 프로젝트를 찾고 그 안의 엔드포인트와 맞춘다 2) 포트 정보가 없으면 전체에서 경로로 찾는다
      let candidates = controllers;
      let target: ProjectScan | undefined;
      if (v?.port && (!v.host || LOCAL.has(v.host))) {
        target = byPort.get(v.port);
        candidates = target ? controllers.filter((c) => c.projectId === target!.project.id) : [];
      } else if (v?.host && !LOCAL.has(v.host)) candidates = [];
      const methodOk = (m: string) =>
        !o.method || m === "ALL" || (["GET", "SSE", "WS"].includes(o.method) ? m === "GET" : m === o.method);
      const hits = candidates.filter((c) => c.endpoints?.some((e) => pathMatches(e.path, callPath) && methodOk(e.method)));
      const loose = hits.length ? hits : candidates.filter((c) => c.endpoints?.some((e) => pathMatches(e.path, callPath)));
      const label = `${o.method ? o.method + " " : ""}${o.url.startsWith("/") ? o.url : callPath}`;
      if (loose.length) {
        for (const c of loose) addEdge({ id: `${o.from}->${c.id}`, source: o.from, target: c.id, label, cross: c.projectId !== s.project.id });
        continue;
      }
      // 연결 못 찾음 → 등록 안 된 서비스 / 외부 시스템 노드
      const proxy = (s as ProjectScan & { proxies?: Proxy[] }).proxies?.find((x) => o.url === x.prefix || o.url.startsWith(x.prefix + "/"));
      let extKey: string;
      let extLabel: string;
      if (target) {
        unresolved.push({ projectId: s.project.id, project: s.project.name, file: o.file, url: `${o.method} ${o.url}`.trim(), reason: `${target.project.name} 에서 이 주소의 Controller 를 못 찾음` });
        continue;
      } else if (proxy) {
        extKey = `proxy:${proxy.prefix}`;
        extLabel = `${proxy.prefix} (${proxy.host && !LOCAL.has(proxy.host) ? proxy.host : ":" + proxy.port})`;
      } else if (v?.host) {
        extKey = `host:${v.host}${LOCAL.has(v.host) ? ":" + v.port : ""}`;
        extLabel = LOCAL.has(v.host) ? `localhost:${v.port}` : v.host;
      } else {
        unresolved.push({ projectId: s.project.id, project: s.project.name, file: o.file, url: `${o.method} ${o.url}`.trim(), reason: "연결할 프로젝트를 못 찾음 (프록시 설정 없음)" });
        continue;
      }
      const id = `ext:${extKey}`;
      if (!nodes.has(id))
        nodes.set(id, { id, projectId: null, project: "외부", kind: "external", label: extLabel, desc: "등록되지 않은 서비스 또는 외부 시스템", descBy: "code", group: "외부" });
      addEdge({ id: `${o.from}->${id}`, source: o.from, target: id, label, cross: true });
    }
  }
  return { nodes: [...nodes.values()], edges, unresolved };
}

// ---------------- 설명 캐시 (Claude) ----------------
db.exec(`CREATE TABLE IF NOT EXISTS flow_desc (
  project_id INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (project_id, node_id)
)`);

function applyClaudeDesc(nodes: FlowNode[]) {
  const rows = db.prepare("SELECT node_id, text FROM flow_desc").all() as { node_id: string; text: string }[];
  const map = new Map(rows.map((r) => [r.node_id, r.text]));
  for (const n of nodes) if (!n.desc && map.has(n.id)) Object.assign(n, { desc: map.get(n.id), descBy: "claude" });
}

// ---------------- 공개 함수 ----------------
let cache: { key: string; at: number; graph: Graph } | null = null;

async function markChanged(projects: Project[], nodes: FlowNode[]) {
  for (const p of projects) {
    let changed: string[] = [];
    try {
      const st = await git.status(p.path);
      if (st.repo) changed = st.files.map((f) => f.path);
    } catch {
      continue;
    }
    if (!changed.length) continue;
    for (const n of nodes) {
      const pid = n.fileProjectId ?? n.projectId;
      const file = n.file;
      if (pid !== p.id || !file) continue;
      if (changed.some((c) => c === file || c.startsWith(file + "/"))) n.changed = true;
    }
  }
}

/** 등록된 모든 프로젝트를 분석해서 서로 연결한 전체 그래프 */
export async function buildAll(projects: Project[], force = false): Promise<Graph> {
  const key = projects.map((p) => `${p.id}:${p.path}`).join("|");
  if (!force && cache && cache.key === key && Date.now() - cache.at < 15_000) return structuredClone(cache.graph);
  const scans = projects.map(scanProject).filter((s): s is ProjectScan => !!s);
  const { nodes, edges, unresolved } = link(scans);
  applyClaudeDesc(nodes);
  await markChanged(projects, nodes);
  const graph: Graph = { nodes, edges, unresolved, generatedAt: new Date().toISOString() };
  cache = { key, at: Date.now(), graph };
  return structuredClone(graph);
}

/** 한 프로젝트의 그래프 + 바로 연결된 다른 프로젝트의 노드 (흐리게 표시) */
export async function buildProject(projects: Project[], projectId: number, force = false): Promise<Graph> {
  const all = await buildAll(projects, force);
  const own = new Set(all.nodes.filter((n) => n.projectId === projectId).map((n) => n.id));
  // 이 프로젝트 Entity 가 쓰는 테이블
  for (const e of all.edges) if (own.has(e.source) && all.nodes.find((n) => n.id === e.target)?.kind === "table") own.add(e.target);
  const keep = new Set(own);
  const edges = all.edges.filter((e) => {
    if (own.has(e.source) && own.has(e.target)) return true;
    if (e.cross && (own.has(e.source) || own.has(e.target))) {
      keep.add(e.source);
      keep.add(e.target);
      return true;
    }
    return false;
  });
  return {
    nodes: all.nodes.filter((n) => keep.has(n.id)),
    edges,
    unresolved: all.unresolved.filter((u) => u.projectId === projectId),
    generatedAt: all.generatedAt,
  };
}

/** 설명이 없는 노드에 Claude 가 한 줄 설명을 붙인다 (결과는 저장해 두고 재사용) */
export async function describe(projects: Project[], projectId: number) {
  const g = await buildProject(projects, projectId, true);
  const p = projects.find((x) => x.id === projectId)!;
  const all = g.nodes.filter((n) => n.projectId === projectId && !n.desc && n.file).slice(0, 80);
  if (!all.length) return { added: 0 };
  const snippet = (n: FlowNode) => {
    const head = (rel: string) => {
      try {
        return fs
          .readFileSync(path.join(p.path, rel), "utf8")
          .split("\n")
          .filter((l) => !/^\s*(import|package)\b/.test(l) && l.trim())
          .slice(0, 40)
          .join("\n");
      } catch {
        return "";
      }
    };
    if (!n.folder) return head(n.file!);
    let list = "";
    try {
      list = fs.readdirSync(path.join(p.path, n.folder)).slice(0, 30).join(", ");
    } catch {
      /* 읽기 실패 */
    }
    return `폴더 파일: ${list}\n${head(n.file!)}`;
  };
  let added = 0;
  for (let i = 0; i < all.length; i += 20) {
    const batch = all.slice(i, i + 20);
    const user = batch
      .map((n, j) => `### ${j + 1}. [${n.kind}] ${n.label} (${n.file})\n${snippet(n).slice(0, 1500)}`)
      .join("\n\n");
    const text = await ai.ask(
      "너는 코드 구조 흐름도에 붙일 짧은 설명을 쓴다. 각 항목이 하는 일을 한국어로 25자 안팎 한 줄로 쓴다. " +
        "반드시 `번호. 설명` 형식으로 항목 수만큼만 줄을 출력하고 다른 말은 하지 않는다.",
      user,
    );
    const lines = new Map<number, string>();
    for (const l of text.split("\n")) {
      const m = l.match(/^\s*(\d+)\.\s*(.+)$/);
      if (m) lines.set(Number(m[1]), m[2].trim());
    }
    const stmt = db.prepare("INSERT OR REPLACE INTO flow_desc(project_id, node_id, hash, text) VALUES(?, ?, ?, ?)");
    batch.forEach((n, j) => {
      const t = lines.get(j + 1);
      if (!t) return;
      stmt.run(projectId, n.id, crypto.createHash("sha1").update(n.id).digest("hex"), t);
      added++;
    });
  }
  cache = null;
  return { added };
}
