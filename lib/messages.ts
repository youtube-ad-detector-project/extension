// 확장 안에서 오가는 타입 한곳 모음. 이제 경로가 STT(Plan E) 하나라 타입도 그만큼 단순해졌다.
//   흐름: youtube-shorts.ts(Shorts 감지) → REQUEST_STT → background → STT 결과를 CaptionsPayload 로 storage 저장
//        → overlay/report 가 storage 를 읽어 렌더

// 자막 한 줄 — STT 세그먼트 1개(시작/길이/텍스트). 룰 스캔(adScan)도 이 단위로 돈다.
export type CaptionSegment = {
  start: number
  dur: number
  text: string
}

// STT 추출 성공 결과 — storage 에 저장되고 overlay/report 가 그대로 읽는다.
//   source/kind 가 단일 리터럴인 이유: Plan A/B 를 들어내 STT 경로만 남았으므로 다른 값이 나올 수 없다.
export type CaptionsPayload = {
  videoId: string
  lang: string
  kind: "stt"
  segments: CaptionSegment[]
  source: "stt-fallback"
}

// STT 실패 사유 (서버 다운 / yt-dlp·Whisper 실패 / 응답 깨짐 등)
export type CaptionsError = {
  videoId: string
  reason: string
  source: "stt-fallback"
}

// STT 진행 중 상태 — 메시지엔 안 쓰고 storage 에만 저장돼 overlay 가 진행도를 보여줌
//   stage: queued(잡 생성) → downloading(yt-dlp) → transcribing(Whisper)
export type CaptionsPending = {
  videoId: string
  jobId: string
  server: string
  stage: "queued" | "downloading" | "transcribing"
  startedAt: number
}

// Shorts 감지 콘텐츠 스크립트 → background 로 "이 영상 STT 돌려라" 직접 요청.
//   예전엔 Plan A 실패 에러를 타고 간접 트리거됐지만, 이제 STT 가 유일 경로라 독립 진입점이 필요하다.
export type RequestSttMessage = {
  type: "REQUEST_STT"
  videoId: string
}

// overlay 가 "상세 보고서 탭 열어줘" 라고 background 에 요청 (콘텐츠 스크립트엔 chrome.tabs 없음)
//   kind: rule=1차(룰 근거, report.html) · ai=2차(AI 동작 과정, report2.html). 기본은 rule.
export type OpenReportMessage = {
  type: "OPEN_REPORT"
  videoId: string
  kind?: "rule" | "ai"
}

// 2차 보고서(report2.tsx)가 /api/explain 에서 받는 한 문장의 모델 내부 동작 — 서버 ExplainItem 과 같은 모양
export type AiExplainItem = {
  text: string
  tokens: string[] // 모델이 본 토큰들(디코딩된 한글)
  logits: Record<string, number> // softmax 전 원시 점수 {안전, 의심}
  probs: Record<string, number> // softmax 후 확률
  label: string
  score: number
  isViolation: boolean
}

// AI 2차 검증 요청 — 오버레이가 룰 엔진에서 걸린(위반·의심) 문장 배열을 background 에 넘긴다.
//   왜 background 경유: 콘텐츠 스크립트의 cross-origin fetch 는 CORS 에 막히지만 service worker 는
//   host_permissions(localhost:3000)로 서버를 직접 부를 수 있어, background 가 /api/classify 로 프록시한다.
export type ClassifyRequestMessage = {
  type: "CLASSIFY"
  texts: string[]
}

// 문장 1개에 대한 AI 판정 — 서버 Verdict 와 같은 모양 (label/score + 위법 여부)
export type ClassifyVerdict = {
  text: string
  label: string
  score: number
  isViolation: boolean
}

// CLASSIFY 응답(요청/응답 메시지) — 성공 시 verdicts(입력과 1:1 순서), 실패 시 reason
export type ClassifyResponse =
  | { ok: true; verdicts: ClassifyVerdict[] }
  | { ok: false; reason: string }

// background.onMessage 가 받는 메시지 합집합 — STT 트리거 / 보고서 열기 / AI 검증 세 종류
export type RuntimeMessage =
  | RequestSttMessage
  | OpenReportMessage
  | ClassifyRequestMessage
