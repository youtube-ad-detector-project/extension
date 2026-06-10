import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const rootDir = path.resolve(path.dirname(__filename), "..")
const inferDir = path.join(rootDir, "infer")
const serverDir = path.join(rootDir, "server")

const isWindows = process.platform === "win32"
const venvPython = isWindows
  ? path.join(inferDir, ".venv", "Scripts", "python.exe")
  : path.join(inferDir, ".venv", "bin", "python")
const python = existsSync(venvPython) ? venvPython : "python3"
const pnpm = isWindows ? "pnpm.cmd" : "pnpm"
const localInferUrl = process.env.HF_CLASSIFY_URL || "http://127.0.0.1:8000/classify"

const children = []
let shuttingDown = false

function pipeWithPrefix(stream, prefix, writer) {
  let buffer = ""

  stream.on("data", (chunk) => {
    buffer += chunk.toString()
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ""

    for (const line of lines) {
      if (line.length > 0) writer.write(`[${prefix}] ${line}\n`)
    }
  })

  stream.on("end", () => {
    if (buffer.length > 0) writer.write(`[${prefix}] ${buffer}\n`)
  })
}

function startProcess({ name, command, args, cwd, env }) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  })

  children.push({ name, child })
  pipeWithPrefix(child.stdout, name, process.stdout)
  pipeWithPrefix(child.stderr, name, process.stderr)

  child.on("error", (error) => {
    console.error(`[dev] ${name} 실행 실패: ${error.message}`)
    stopAll(1)
  })

  child.on("exit", (code, signal) => {
    if (shuttingDown) return
    const reason = signal ? `signal ${signal}` : `exit ${code ?? 0}`
    console.error(`[dev] ${name} 프로세스 종료됨 (${reason})`)
    stopAll(code && code > 0 ? code : 1)
  })
}

function stopAll(exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true

  for (const { child } of children) {
    if (!child.killed) child.kill("SIGTERM")
  }

  setTimeout(() => {
    for (const { child } of children) {
      if (!child.killed) child.kill("SIGKILL")
    }
    process.exit(exitCode)
  }, 1500).unref()
}

process.on("SIGINT", () => stopAll(0))
process.on("SIGTERM", () => stopAll(0))

console.log("[dev] Next 서버: http://localhost:3000")
console.log("[dev] AI 추론 서버: http://127.0.0.1:8000")
console.log(`[dev] Next HF_CLASSIFY_URL=${localInferUrl}`)

startProcess({
  name: "infer",
  command: python,
  args: ["-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", "8000"],
  cwd: inferDir
})

startProcess({
  name: "next",
  command: pnpm,
  args: ["dev"],
  cwd: serverDir,
  env: {
    HF_CLASSIFY_URL: localInferUrl
  }
})
