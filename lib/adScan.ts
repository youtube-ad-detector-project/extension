// 글루 모듈: 저장된 자막(CaptionSegment[]) 과 룰 엔진(analyzeSentence) 을 잇는다.
//   호출 흐름: youtube-overlay.tsx 가 entry.ok===true 일 때 scanCaptions(segments) 호출 →
//   여기서 자막 줄마다 엔진을 1회씩 돌려 ScannedLine[] 로 변환 → 오버레이가 상태별 색으로 렌더.
//   "자막 줄 = 문장 1개" 결정에 따라, 세그먼트 텍스트를 그대로 엔진에 넘긴다 (문장 재구성 없음).

import { analyzeSentence } from "./matchingEngine"
import type { AnalysisResult, FinalStatus } from "./matchingEngine"
import type { CaptionSegment } from "./messages"

// 콘텐츠 스크립트(오버레이)에서 실행 → YouTube 페이지 F12 콘솔에 찍힘 ([yt-cap:bridge] 와 같은 창)
const TAG = "[yt-cap:scan]"

// 엔진 결과에 타임스탬프를 붙인 형태 — 오버레이가 "몇 초 줄이 무슨 상태"인지 그릴 수 있어야 하므로
//   데이터 형태 변화: CaptionSegment{start,dur,text} → ScannedLine{...+status, result}
export type ScannedLine = {
  start: number
  dur: number
  text: string
  status: FinalStatus
  result: AnalysisResult // 매칭 근거(ruleAnalysis/triggerAnalysis)까지 보존 — 상세/디버그용
}

// 상태별 개수 요약 — 오버레이 헤더가 "위반 N · 의심 M · 정상 K" 한 줄로 쓰기 위함
export type ScanSummary = {
  positive: number // Rule-Positive (위반 확정)
  route: number // Route-to-Model (의심)
  negative: number // Rule-Negative (정상)
}

// 무엇이 들어가 → 처리 → 무엇이 반환되는지:
//   segments(자막 줄 배열) → 줄마다 analyzeSentence(text) 1회 → ScannedLine[] (입력과 1:1, 순서 유지)
//   productName 은 자막에서 알 수 없어 엔진 기본값('')로 호출 — 건기식 분기는 자연히 통과
export function scanCaptions(segments: CaptionSegment[]): ScannedLine[] {
  // 🟢 스캔 진입 — 입력 줄 수를 먼저 찍어 "엔진을 몇 번 도는지" 가 보이게
  console.log(
    TAG,
    `🟢 룰 스캔 시작 - 자막 ${segments.length}줄 (줄=문장 단위로 엔진 실행)`
  )

  // map: 줄 N개 → 결과 N개. 줄 누락/병합 없이 1:1 유지해야 타임라인 대응이 단순함
  const lines = segments.map((seg) => {
    const result = analyzeSentence(seg.text)

    // 정상이 아닌 줄만 "왜 걸렸는지" 근거를 남긴다 (정상까지 찍으면 콘솔이 시끄러워 디버깅 방해)
    if (result.finalStatus === "Rule-Positive") {
      console.log(
        TAG,
        `❌ [위반] ${seg.start.toFixed(1)}s "${seg.text}" — 룰 ${result.ruleAnalysis?.weightSum}점 (${result.ruleAnalysis?.hits
          .map((h) => h.subCategory)
          .join(", ")})`
      )
    } else if (result.finalStatus === "Route-to-Model") {
      console.log(
        TAG,
        `⚠️ [의심] ${seg.start.toFixed(1)}s "${seg.text}" — 트리거 ${result.triggerAnalysis?.weightSum}점 (${result.triggerAnalysis?.categoriesHit.join(", ")})`
      )
    }

    return {
      start: seg.start,
      dur: seg.dur,
      text: seg.text,
      status: result.finalStatus,
      result
    }
  })

  // ✅ 스캔 종료 — 상태별 집계로 한눈 요약 (오버레이 헤더와 같은 수치)
  const s = summarize(lines)
  console.log(
    TAG,
    `✅ 룰 스캔 완료 - 위반 ${s.positive} · 의심 ${s.route} · 정상 ${s.negative}`
  )
  return lines
}

// ScannedLine[] → 상태별 카운트. 한 번 순회하며 분류 누적
export function summarize(lines: ScannedLine[]): ScanSummary {
  const s: ScanSummary = { positive: 0, route: 0, negative: 0 }
  for (const l of lines) {
    // 3분류 중 하나로만 떨어지므로 분기 누적이면 충분
    if (l.status === "Rule-Positive") s.positive++
    else if (l.status === "Route-to-Model") s.route++
    else s.negative++
  }
  return s
}
