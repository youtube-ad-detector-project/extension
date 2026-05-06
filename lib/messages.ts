// 자막 한 줄 (timedtext json3 의 event 1개에 해당)
export type CaptionSegment = {
  start: number
  dur: number
  text: string
}

// 추출 성공 시 main-world / background 어디서든 동일한 구조로 흘려보내는 페이로드
//   "stt" 는 Plan E (Whisper) 로 만들어진 자막을 의미 — 유튜브 내장 자동자막(asr)과 구분하려고 별도 값
export type CaptionsPayload = {
  videoId: string
  lang: string
  kind: "manual" | "asr" | "stt"
  segments: CaptionSegment[]
  source: "main-world" | "background-fallback" | "stt-fallback"
}

// 추출 실패 사유 (자막 없음 / 인증 실패 / race / STT 서버 실패 등)
export type CaptionsError = {
  videoId: string
  reason: string
  source: "main-world" | "background-fallback" | "stt-fallback"
}

// Plan E 진행 중 상태를 표현 — 메시지에는 안 쓰고 storage 에만 저장됨
//   stage: queued(잡 생성됨) → downloading(yt-dlp) → transcribing(Whisper)
export type CaptionsPending = {
  videoId: string
  jobId: string
  server: string
  stage: "queued" | "downloading" | "transcribing"
  startedAt: number
}

// content script ↔ background 사이를 오가는 결과 메시지
export type CaptionsResultMessage =
  | { type: "CAPTIONS_RESULT"; payload: CaptionsPayload }
  | { type: "CAPTIONS_ERROR"; payload: CaptionsError }

// Plan A 가 실패했을 때 isolated bridge 가 background 에 폴백을 요청하는 메시지
export type FallbackRequestMessage = {
  type: "REQUEST_CAPTIONS_FALLBACK"
  videoId: string
}

export type RuntimeMessage = CaptionsResultMessage | FallbackRequestMessage

// MAIN world ↔ ISOLATED bridge 가 window.postMessage 로 통신할 때 식별용 태그
export const POSTMSG_TAG = "__yt_cap_ext__"
