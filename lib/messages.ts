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

// overlay 가 "상세 위반 보고서 탭 열어줘" 라고 background 에 요청 (콘텐츠 스크립트엔 chrome.tabs 없음)
export type OpenReportMessage = {
  type: "OPEN_REPORT"
  videoId: string
}

// background.onMessage 가 받는 메시지 합집합 — 두 종류뿐
export type RuntimeMessage = RequestSttMessage | OpenReportMessage
