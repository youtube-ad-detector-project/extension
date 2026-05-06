// Groq Whisper API 어댑터
// 입력: mp3 파일 경로  →  출력: { lang, segments } (확장이 그대로 쓸 수 있는 모양)
//   pipeline.ts 가 ytdlp.downloadAudio 결과를 여기로 넘긴다.

import { readFile } from "node:fs/promises"
import { basename } from "node:path"
import type { Segment } from "./jobs"

// Whisper verbose_json 응답에서 우리가 쓰는 부분만 좁힌 타입
//   segments[*].end 가 들어오는데 확장 측 형식은 dur 라서 변환이 필요 (toSegments 에서 처리)
type WhisperVerboseJson = {
  language: string
  segments: { start: number; end: number; text: string }[]
}

const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions"

// Groq 호출 → JSON 파싱 → (lang, segments) 반환
//   학습용이라 재시도/streaming 없음. 키는 process.env.GROQ_API_KEY 에서.
export async function transcribe(mp3Path: string): Promise<{ lang: string; segments: Segment[] }> {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) {
    // 키 없으면 즉시 실패 — 환경 설정 누락은 학습용에서도 명시적으로 알리는 게 낫다
    throw new Error("groq_api_key_missing")
  }

  // mp3 → Buffer → Blob: Node 20+ 의 fetch 가 multipart 를 처리하려면 Blob/File 필요
  const buf = await readFile(mp3Path)
  const blob = new Blob([buf], { type: "audio/mpeg" })

  // FormData: Groq 가 OpenAI 호환이라 필드명도 같다 — file/model/response_format
  //   language 는 일부러 생략 (사용자가 자동 감지 선택)
  const form = new FormData()
  form.append("file", blob, basename(mp3Path))
  form.append("model", "whisper-large-v3-turbo")
  form.append("response_format", "verbose_json")
  form.append("timestamp_granularities[]", "segment")

  // fetch — Authorization 헤더만, Content-Type 은 FormData 가 boundary 와 함께 자동 설정
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  })

  if (!res.ok) {
    // status 코드를 reason 에 박아 어디서 막혔는지 즉시 판별 가능 (401/429 등)
    const body = await res.text().catch(() => "")
    throw new Error(`whisper_http_${res.status}: ${body.slice(0, 200)}`)
  }

  // 응답이 verbose_json 이 아니면 segments 가 없을 수 있음 — 모양 검증 후 좁힌다
  const data = (await res.json()) as Partial<WhisperVerboseJson>
  if (!data || !Array.isArray(data.segments) || typeof data.language !== "string") {
    throw new Error("whisper_bad_response")
  }

  // 데이터 모양 변환점: Whisper {start,end,text} → 확장 {start,dur,text}
  //   start/dur 는 초 단위 그대로, dur = end - start, text 는 앞뒤 공백 정리
  const segments: Segment[] = data.segments.map((s) => ({
    start: s.start,
    dur: s.end - s.start,
    text: s.text.trim()
  }))

  return { lang: data.language, segments }
}
