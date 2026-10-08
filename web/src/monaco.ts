// Monaco 에디터를 인터넷(CDN) 없이 로컬 번들로 쓰도록 설정
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";

self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === "json") return new JsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new CssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new HtmlWorker();
    if (label === "typescript" || label === "javascript") return new TsWorker();
    return new EditorWorker();
  },
};

loader.config({ monaco });

const EXT: Record<string, string> = {
  java: "java", kt: "kotlin", kts: "kotlin", gradle: "groovy", groovy: "groovy",
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", yml: "yaml", yaml: "yaml", xml: "xml", html: "html", css: "css", scss: "scss",
  sql: "sql", sh: "shell", bash: "shell", bat: "bat", cmd: "bat", ps1: "powershell", py: "python",
  md: "markdown", properties: "ini", ini: "ini", conf: "ini", service: "ini", env: "ini", toml: "ini",
  dockerfile: "dockerfile", txt: "plaintext", log: "plaintext",
};

export function languageOf(path: string) {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (name === "dockerfile") return "dockerfile";
  if (name.endsWith(".example")) return languageOf(name.slice(0, -".example".length));
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  return EXT[ext] ?? "plaintext";
}
