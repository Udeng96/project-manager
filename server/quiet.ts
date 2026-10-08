// node:sqlite 의 "실험적 기능" 경고를 숨긴다 (다른 경고는 그대로 출력)
const original = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning.message;
  if (text.includes("SQLite is an experimental feature")) return;
  return (original as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
