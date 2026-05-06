// 오디오 다운로더 — yt-dlp 를 child_process 로 띄워 mp3 한 파일을 만든다.
// 입력: jobId(파일명용), videoId(URL 조립용)  →  출력: 만들어진 mp3 절대 경로
//   pipeline.ts 가 이 경로를 받아 whisper.transcribe 로 넘긴다.

import { spawn } from "node:child_process"
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"

// tmp 디렉터리 — server/tmp/ 에 mp3 를 떨어뜨리고 잡 끝나면 unlink (pipeline.ts 의 finally 에서)
//   resolve 의 기준은 Next dev 가 cwd 로 잡는 server/ 디렉터리
const TMP_DIR = resolve(process.cwd(), "tmp")

// yt-dlp 실행 — Promise 로 감싸 stderr 누적 후 exit code 로 성공 여부 판단
//   학습용이라 재시도/타임아웃 없음. 실패 시 stderr 마지막 부분이 reason 으로 전달됨.
export async function downloadAudio(jobId: string, videoId: string): Promise<string> {
  // tmp 디렉터리가 없으면 만든다 (recursive: true 로 이미 있어도 에러 없음)
  await mkdir(TMP_DIR, { recursive: true })

  // -o 템플릿: jobId 를 파일명으로 박아 충돌 방지, 확장자는 yt-dlp 가 채움 (mp3 로 강제 변환되므로 결과물은 .mp3)
  const outTemplate = `${TMP_DIR}/${jobId}.%(ext)s`
  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`

  // yt-dlp 인자 — 오디오만 추출(-x), mp3 변환, 플레이리스트 무시, 로그 최소화
  const args = [
    "-x",
    "--audio-format", "mp3",
    "-o", outTemplate,
    "--no-playlist",
    "--quiet",
    "--no-warnings",
    url
  ]

  // spawn: 자식 프로세스 띄우고 stderr 만 모음 (--quiet 라 stdout 은 거의 비어있음)
  return new Promise((resolveP, rejectP) => {
    const proc = spawn("yt-dlp", args)
    let stderr = ""
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    // 'error' 이벤트 — yt-dlp 자체가 PATH 에 없을 때
    proc.on("error", (err) => {
      rejectP(new Error(`ytdlp_spawn_failed: ${err.message}`))
    })
    // 'close': exit code 0 이면 성공, 그 외엔 stderr 끝부분을 이유로 throw
    proc.on("close", (code) => {
      if (code === 0) {
        // -o 템플릿의 %(ext)s 는 mp3 변환 후 'mp3' 로 치환됨
        resolveP(`${TMP_DIR}/${jobId}.mp3`)
      } else {
        // stderr 가 너무 길면 마지막 줄만 남겨 reason 길이 제어
        const tail = stderr.trim().split("\n").slice(-3).join(" | ")
        rejectP(new Error(`ytdlp_failed (exit ${code}): ${tail || "no stderr"}`))
      }
    })
  })
}
