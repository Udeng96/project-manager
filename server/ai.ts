import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { getSetting } from "./db.js";
import { httpError } from "./projects.js";

const MODEL = "claude-opus-5-5";

/** API 오류를 사용자에게 보여줄 한국어 메시지로 바꾼다 */
export function friendlyError(e: unknown): Error {
  if (e instanceof Anthropic.AuthenticationError) return httpError(400, "Claude API 키가 올바르지 않습니다. 설정에서 다시 입력해 주세요.");
  if (e instanceof Anthropic.RateLimitError) return httpError(429, "Claude API 사용량 한도에 걸렸습니다. 잠시 후 다시 시도해 주세요.");
  if (e instanceof Anthropic.APIConnectionError) return httpError(502, "Claude API에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.");
  if (e instanceof Anthropic.APIError) return httpError(502, `Claude API 오류 (${e.status}): ${e.message}`);
  return e as Error;
}

export function hasApiKey() {
  return !!(getSetting("anthropic_api_key") || process.env.ANTHROPIC_API_KEY);
}

function client() {
  const apiKey = getSetting("anthropic_api_key") || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw httpError(400, "Claude API 키가 없습니다. 설정 화면에서 입력해 주세요.");
  return new Anthropic({ apiKey });
}

/** 한 번 묻고 텍스트로 받기 (작업기록 요약 등) */
export async function ask(system: string, user: string, effort: "low" | "medium" | "high" = "low") {
  const res = await client()
    .beta.messages.create({
    model: MODEL,
    max_tokens: 8000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort },
    system,
    messages: [{ role: "user", content: user }],
  })
    .catch((e) => {
      throw friendlyError(e);
    });
  if (res.stop_reason === "refusal") throw httpError(502, "Claude가 이 요청에 답하지 않았습니다.");
  return res.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("")
    .trim();
}

// ---------- 프로젝트 코드를 읽을 수 있는 도구 (읽기 전용) ----------

const IGNORE = new Set([".git", "node_modules", "build", "dist", "target", ".gradle", ".idea", "bin", "out", "logs", ".vscode"]);
const MAX_FILE = 200 * 1024;

function safeJoin(root: string, rel: string) {
  const abs = path.resolve(root, rel || ".");
  const r = path.relative(root, abs);
  if (r.startsWith("..") || path.isAbsolute(r)) throw new Error("프로젝트 폴더 밖은 볼 수 없습니다.");
  return abs;
}

export function fileTree(root: string, maxEntries = 400) {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (out.length >= maxEntries || depth > 8) return;
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    ents.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of ents) {
      if (IGNORE.has(e.name) || e.name.startsWith(".")) continue;
      const rel = path.relative(root, path.join(dir, e.name)).split(path.sep).join("/");
      out.push(e.isDirectory() ? rel + "/" : rel);
      if (out.length >= maxEntries) {
        out.push("…(이하 생략)");
        return;
      }
      if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);
  return out.join("\n");
}

function grep(root: string, pattern: string) {
  let re: RegExp;
  try {
    re = new RegExp(pattern, "i");
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
  const hits: string[] = [];
  const walk = (dir: string) => {
    if (hits.length >= 80) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (IGNORE.has(e.name) || e.name.startsWith(".")) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (fs.statSync(abs).size < MAX_FILE) {
        const text = fs.readFileSync(abs, "utf8");
        if (text.includes("\u0000")) continue;
        text.split("\n").forEach((line, i) => {
          if (hits.length < 80 && re.test(line)) {
            hits.push(`${path.relative(root, abs).split(path.sep).join("/")}:${i + 1}: ${line.trim().slice(0, 200)}`);
          }
        });
      }
    }
  };
  walk(root);
  return hits.length ? hits.join("\n") : "일치하는 내용이 없습니다.";
}

const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "list_files",
    description: "프로젝트 폴더 안의 하위 폴더 파일 목록을 본다. dir 은 프로젝트 기준 상대 경로.",
    input_schema: {
      type: "object",
      properties: { dir: { type: "string", description: "상대 경로, 루트는 ." } },
      required: ["dir"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "read_file",
    description: "프로젝트 안의 파일 내용을 읽는다. path 는 프로젝트 기준 상대 경로.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "search",
    description: "프로젝트 전체에서 정규식(대소문자 무시)으로 내용을 검색한다. 최대 80건.",
    input_schema: {
      type: "object",
      properties: { pattern: { type: "string" } },
      required: ["pattern"],
      additionalProperties: false,
    },
    strict: true,
  },
];

function runTool(root: string, name: string, input: Record<string, string>): string {
  if (name === "list_files") return fileTree(safeJoin(root, input.dir), 300) || "(비어 있음)";
  if (name === "read_file") {
    const abs = safeJoin(root, input.path);
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return "파일이 없습니다.";
    if (fs.statSync(abs).size > MAX_FILE) return "파일이 너무 큽니다 (200KB 초과).";
    return fs.readFileSync(abs, "utf8");
  }
  if (name === "search") return grep(root, input.pattern);
  return `알 수 없는 도구: ${name}`;
}

const PROMPT_SYSTEM = `당신은 울산 프로젝트 개발자를 돕는 시니어 개발자입니다. 사용자가 등록한 프로젝트 폴더의 코드를 도구로 직접 읽고 답합니다.

- 한국어로, 결론부터 간결하게 답합니다. 근거가 되는 파일은 경로:줄 로 적습니다.
- 추측한 내용은 추측이라고 밝힙니다.
- 이 도구는 코드를 직접 수정하지 않습니다. 코드 수정이 필요한 요청이면, 답변 끝에 사용자가 Claude Code 에 그대로 붙여넣을 수 있는 요청 프롬프트를 <claude_code_prompt> 태그 안에 작성합니다.
  - 그 프롬프트에는 목표, 관련 파일 경로, 지켜야 할 기존 규칙(코드 스타일, 패키지 구조), 완료 기준(빌드/테스트 방법)을 구체적으로 적습니다.
  - 수정이 필요 없는 질문이면 태그를 쓰지 않습니다.`;

export type PromptAnswer = { answer: string; claudeCodePrompt: string };

export async function answerPrompt(
  root: string,
  projectName: string,
  question: string,
  history: { question: string; answer: string }[],
): Promise<PromptAnswer> {
  const c = client();
  const context =
    `프로젝트 이름: ${projectName}\n프로젝트 폴더 구조(일부):\n${fileTree(root, 250)}` +
    (history.length
      ? `\n\n이전 대화(최근):\n` + history.map((h) => `Q: ${h.question}\nA: ${h.answer.slice(0, 1500)}`).join("\n\n")
      : "");

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    { role: "user", content: `${context}\n\n---\n질문:\n${question}` },
  ];

  for (let turn = 0; turn < 25; turn++) {
    const res = await c.beta.messages
      .stream({
        model: MODEL,
        max_tokens: 32000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "medium" },
        system: PROMPT_SYSTEM,
        tools: TOOLS,
        messages,
      })
      .finalMessage()
      .catch((e) => {
        throw friendlyError(e);
      });

    if (res.stop_reason === "refusal") throw httpError(502, "Claude가 이 요청에 답하지 않았습니다.");
    messages.push({ role: "assistant", content: res.content });

    const toolUses = res.content.filter((b) => b.type === "tool_use") as Anthropic.Beta.BetaToolUseBlock[];
    if (res.stop_reason !== "tool_use" || !toolUses.length) {
      const text = res.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("")
        .trim();
      const m = text.match(/<claude_code_prompt>([\s\S]*?)<\/claude_code_prompt>/);
      return {
        answer: text.replace(/<claude_code_prompt>[\s\S]*?<\/claude_code_prompt>/, "").trim(),
        claudeCodePrompt: m?.[1].trim() ?? "",
      };
    }

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = toolUses.map((t) => {
      try {
        return { type: "tool_result", tool_use_id: t.id, content: runTool(root, t.name, t.input as Record<string, string>) };
      } catch (e) {
        return { type: "tool_result", tool_use_id: t.id, content: String((e as Error).message), is_error: true };
      }
    });
    messages.push({ role: "user", content: results });
  }
  throw httpError(500, "답변을 만드는 데 너무 많은 단계가 필요했습니다. 질문을 좁혀 주세요.");
}
