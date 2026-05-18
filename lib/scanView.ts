// 스캔 결과를 "화면에 어떻게 보일지"만 모은 표현 계층 (로직 없음, 순수 매핑/포맷).
//   왜 분리: 오버레이(youtube-overlay.tsx)와 보고서 탭(tabs/report.tsx)이 같은 색·라벨·시간
//   표기를 써야 하는데, 각자 복붙하면 한쪽만 바뀌어 어긋난다 → 단일 소스로 묶는다.
//   호출 맥락: 두 React 트리(콘텐츠 스크립트 / 확장 탭)가 각자 import 해서 렌더에 사용.

import type { FinalStatus } from "./matchingEngine"

// 룰 엔진 최종 상태 → 화면 표현(색·태그). 정상은 색 강조 없이 기본 텍스트(빈 태그)
//   데이터 형태: FinalStatus(문자열 enum) → { color, tag }(렌더용 값)
export const STATUS_VIEW: Record<
  FinalStatus,
  { color: string; tag: string }
> = {
  "Rule-Positive": { color: "#e5484d", tag: "위반" },
  "Route-to-Model": { color: "#f5a623", tag: "의심" },
  "Rule-Negative": { color: "#ddd", tag: "" }
}

// 초(float) → mm:ss — Whisper 가 timestamp 를 초 단위 float 으로 주므로 분/초로 환산
export function formatTime(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, "0")}`
}
