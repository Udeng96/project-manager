// 여러 프로젝트 코드를 읽으며 일하고, 마지막에 정해진 형식(submit 도구)으로 결과를 내는 Claude 실행기.
// 예상 흐름도, 개선 제안에서 쓴다. 코드는 읽기만 한다.
import type Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import { client, MODEL, fileTree, grep, safeJoin, friendlyError } from "./ai.js";
import { httpError, type Project } from "./projects.js";

const MAX_FILE = 200 * 1024;

const projectProp = (names: string[]) => ({ type: "string", enum: names, description: "프로젝트 이름" });

function readTools(names: string[]): Anthropic.Beta.BetaTool[] {
  return [
    {
      name: "list_files",
      description: "프로젝트 안 폴더의 파일 목록을 본다. dir 은 프로젝트 기준 상대 경로 (루트는 .).",
      input_schema: {
        type: "object",
        properties: { project: projectProp(names), dir: { type: "string" } },
        required: ["project", "dir"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      name: "read_file",
      description: "프로젝트 안 파일 내용을 읽는다 (줄 번호 포함). path 는 프로젝트 기준 상대 경로.",
      input_schema: {
        type: "object",
        properties: { project: projectProp(names), path: { type: "string" } },
        required: ["project", "path"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      name: "search",
      description: "프로젝트 전체에서 정규식(대소문자 무시)으로 검색한다. 최대 80건.",
      input_schema: {
        type: "object",
        properties: { project: projectProp(names), pattern: { type: "string" } },
        required: ["project", "pattern"],
        additionalProperties: false,
      },
      strict: true,
    },
  ];
}

function runRead(projects: Project[], name: string, input: Record<string, string>) {
  const p = projects.find((x) => x.name === input.project);
  if (!p) return `없는 프로젝트: ${input.project}`;
  if (name === "list_files") return fileTree(safeJoin(p.path, input.dir), 300) || "(비어 있음)";
  if (name === "read_file") {
    const abs = safeJoin(p.path, input.path);
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return "파일이 없습니다.";
    if (fs.statSync(abs).size > MAX_FILE) return "파일이 너무 큽니다 (200KB 초과).";
    return fs
      .readFileSync(abs, "utf8")
      .split("\n")
      .map((l, i) => `${i + 1}\t${l}`)
      .join("\n");
  }
  if (name === "search") return grep(p.path, input.pattern);
  return `알 수 없는 도구: ${name}`;
}

/**
 * system/user 로 시작해서 코드를 읽게 하고, submit 도구를 부르면 그 입력을 결과로 돌려준다.
 * submitSchema 는 strict JSON schema (모든 객체 additionalProperties: false, 모든 속성 required).
 */
export async function runAgent<T>(opts: {
  projects: Project[];
  system: string;
  user: string;
  submitDescription: string;
  submitSchema: Record<string, unknown>;
  effort?: "low" | "medium" | "high";
  maxTurns?: number;
}): Promise<T> {
  const c = client();
  const names = opts.projects.map((p) => p.name);
  const tools: Anthropic.Beta.BetaTool[] = [
    ...readTools(names),
    {
      name: "submit",
      description: opts.submitDescription,
      input_schema: opts.submitSchema as Anthropic.Beta.BetaTool.InputSchema,
      strict: true,
    },
  ];
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: opts.user }];
  const maxTurns = opts.maxTurns ?? 30;

  for (let turn = 0; turn < maxTurns; turn++) {
    const last = turn === maxTurns - 1;
    const res = await c.beta.messages
      .stream({
        model: MODEL,
        max_tokens: 32000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: opts.effort ?? "medium" },
        system: opts.system,
        tools,
        // 마지막 차례에는 반드시 결과를 내게 한다
        tool_choice: last ? { type: "tool", name: "submit" } : { type: "auto" },
        messages,
      })
      .finalMessage()
      .catch((e) => {
        throw friendlyError(e);
      });

    if (res.stop_reason === "refusal") throw httpError(502, "Claude가 이 요청에 답하지 않았습니다.");
    messages.push({ role: "assistant", content: res.content });

    const uses = res.content.filter((b) => b.type === "tool_use") as Anthropic.Beta.BetaToolUseBlock[];
    const submit = uses.find((u) => u.name === "submit");
    if (submit) return submit.input as T;
    if (!uses.length) {
      // 도구 없이 글로만 끝냈으면 submit 을 부르라고 한 번 더 요청
      messages.push({ role: "user", content: "결과를 submit 도구로 제출해 주세요." });
      continue;
    }
    messages.push({
      role: "user",
      content: uses.map((u) => {
        try {
          return { type: "tool_result" as const, tool_use_id: u.id, content: runRead(opts.projects, u.name, u.input as Record<string, string>) };
        } catch (e) {
          return { type: "tool_result" as const, tool_use_id: u.id, content: String((e as Error).message), is_error: true };
        }
      }),
    });
  }
  throw httpError(500, "결과를 만드는 데 너무 많은 단계가 필요했습니다. 요청을 좁혀 주세요.");
}
