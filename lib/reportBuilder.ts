// 보고서 조립 모듈 — 룰/모델 결과를 "사용자용 최종 보고서 JSON"으로 변환하는 순수함수.
//   호출 흐름: tabs/report3.tsx 가 scanCaptions+attachModelResult 로 만든 merged 와 calculateVideoRisk 결과를 넘김 →
//   여기서 FinalReport 를 코드 템플릿으로 조립 → report3 가 그대로 렌더.
//   왜 LLM 없이 코드로: 점수·법령·근거가 이미 엔진/사전에 다 있어, LLM 은 기본 보고서 생성에 쓰지 않는다.
//   prompts/llm-text.md 는 필요할 때만 완성된 보고서 문장을 부드럽게 다듬는 선택 옵션용 가드레일이다.
//   네트워크/chrome.* 의존 없는 in→out 순수함수 (matchingEngine 과 같은 결).

import type { ScannedLine, VideoRisk } from "./adScan"
import type {
  AnalysisResult,
  FinalStatus,
  UserFacingDecision
} from "./matchingEngine"

// 코드 템플릿이 만드는 최종 보고서 JSON 스펙 — 빌더 출력과 report3 렌더가 같은 모양을 공유한다.
export type DetectedReason = {
  source: "rule" | "trigger"
  type: string // 탐지 유형명 (rule=subCategory / trigger=categoryName)
  evidenceText: string // 문장 내 근거 표현 (matchedText)
  explanation: string // 왜 문제가 될 수 있는지 (사전 rationale)
  legalBasis: string[] // rule 직접 근거 법령 문구 (trigger 는 빈 배열)
  relatedLegalBasisCandidates: string[] // trigger 후보 법령 (rule 은 빈 배열)
  safeHarborReferences: string[] // 합법 예외 참고 근거
}

export type AppliedException = {
  exceptionType: string
  explanation: string
}

export type SentenceReport = {
  sentence: string
  finalStatus: FinalStatus
  userFacingDecision: UserFacingDecision
  sentenceRiskPercent: number
  riskExplanation: string
  detectedReasons: DetectedReason[]
  triggerExplanation: string | null
  modelExplanation: string | null
  healthFoodExplanation: string | null
  healthFoodVerificationUrl: string | null
  appliedExceptions: AppliedException[]
}

export type FinalReport = {
  videoRiskSummary: {
    riskScore: number
    riskGrade: VideoRisk["riskGrade"]
    riskLevelText: string
    summary: string
    caution: string
  }
  sentenceReports: SentenceReport[]
  overallCaution: string
}

// 고정 주의 문구 — 단정 표현 방지 문구를 코드 상수로 고정해 기본 보고서에서 흔들리지 않게 한다.
const VIDEO_RISK_CAUTION =
  "이 점수는 실제 위법 확률이 아니라 자동 탐지 기준상의 위험 신호 점수입니다."
const OVERALL_CAUTION =
  "이 결과는 자동 탐지 시스템의 위험 신호 안내이며, 법적 판단이나 위법 확정이 아닙니다. 최종 판단은 관계 기관 또는 전문가 검토가 필요합니다."

// 영상 단위 요약 문장 — videoRisk(이미 계산됨)를 사람이 읽을 한 줄로 풀어 쓴다 (점수 재계산 아님)
function buildVideoSummary(vr: VideoRisk): string {
  // 의심 문장이 없으면 "표시 없음" — 단정 대신 '신호 없음'으로 표현
  if (vr.riskGrade === "표시 없음") {
    return "현재 탐지 기준상 뚜렷한 위법 의심 신호가 감지되지 않았습니다."
  }
  return `자동 탐지 위험도 ${vr.riskScore}점(${vr.riskGrade}). 의심 문장 ${vr.suspiciousSentenceCount}개, 최고 문장 위험도 ${vr.maxSentenceRiskPercent}점.`
}

// rule/trigger hit 을 근거 항목으로 평탄화 — rule 은 직접 근거(legalBasis), trigger 는 후보(candidate)로 분리
//   무엇이 들어가 → 처리 → 무엇이 반환: AnalysisResult → hits 순회 → DetectedReason[]
function buildDetectedReasons(r: AnalysisResult): DetectedReason[] {
  const reasons: DetectedReason[] = []

  // rule hit: 위반 확정 근거라 legalReferences 를 직접 legalBasis 로 사용
  for (const h of r.ruleAnalysis?.hits ?? []) {
    reasons.push({
      source: "rule",
      type: h.subCategory,
      evidenceText: h.matchedText,
      explanation: h.rationale,
      // legalReferences 가 비면(lawKeys 없는 룰) legalReference 단수 텍스트라도 살림
      legalBasis: h.legalReferences.length
        ? h.legalReferences
        : h.legalReference
          ? [h.legalReference]
          : [],
      relatedLegalBasisCandidates: [],
      safeHarborReferences: h.safeHarborLegalReferences
    })
  }

  // trigger hit: 위반 확정 아님 → 직접 근거(legalBasis)는 비우고 후보로만
  for (const t of r.triggerAnalysis?.hits ?? []) {
    reasons.push({
      source: "trigger",
      type: t.categoryName,
      evidenceText: t.matchedText,
      explanation: t.rationale,
      legalBasis: [],
      relatedLegalBasisCandidates: t.candidateLegalReferences,
      safeHarborReferences: t.safeHarborLegalReferences
    })
  }

  return reasons
}

// 트리거가 있으면 "모델 검증으로 넘긴 사유"를 한 줄로, 없으면 null (Rule-Positive 는 트리거 없이 확정되므로 null)
function buildTriggerExplanation(r: AnalysisResult): string | null {
  const hits = r.triggerAnalysis?.hits ?? []
  if (hits.length === 0) return null
  const names = hits.map((t) => t.categoryName).join(", ")
  return `트리거 신호(${names})가 감지되어 모델 추가 검증 대상이 되었습니다. 트리거는 위반 확정 근거가 아니라 의심 신호입니다.`
}

function formatConfidence(confidence: number): string {
  if (!Number.isFinite(confidence)) return "0"
  return String(Math.round(confidence * 10000) / 10000)
}

// 모델 결과가 합쳐진 경우(attachModelResult 거침)만 설명, 아니면 null
function buildModelExplanation(r: AnalysisResult): string | null {
  const m = r.modelResult
  if (!m) return null
  return `AI 분류 모델 예측: ${m.predictionLabel} (신뢰도 ${formatConfidence(m.confidence)}). 이는 법적 판단이 아니라 모델의 자동 예측 결과입니다.`
}

// 문장 1개 → 보고서 항목 — 점수/판정/근거/예외를 엔진이 만든 값에서 그대로 옮긴다 (새 판단 안 함)
function buildSentenceReport(r: AnalysisResult): SentenceReport {
  return {
    sentence: r.sentence,
    finalStatus: r.finalStatus,
    userFacingDecision: r.userFacingDecision,
    sentenceRiskPercent: r.sentenceRisk.riskPercent,
    riskExplanation: r.sentenceRisk.riskExplanation,
    detectedReasons: buildDetectedReasons(r),
    triggerExplanation: buildTriggerExplanation(r),
    modelExplanation: buildModelExplanation(r),
    // 건기식 안내는 엔진이 이미 한국어 문구로 만들어 두었으므로 그대로 사용
    healthFoodExplanation: r.warningMessage,
    healthFoodVerificationUrl: r.verificationUrl,
    appliedExceptions: (r.ruleAnalysis?.exceptionsHit ?? []).map((e) => ({
      exceptionType: e.subCategory,
      explanation: `예외 규칙 '${e.subCategory}'에 해당해 해당 근거가 위반 점수에서 제외되었습니다.`
    }))
  }
}

// 최종 보고서 조립 — 무엇이 들어가 → 처리 → 무엇이 반환:
//   merged(모델 결과까지 합쳐진 전체 줄), videoRisk(영상 점수) → FinalReport
//   sentenceReports 는 위반·의심만 (정상 줄은 근거가 비어 정보량 0). videoRisk 는 호출부에서 전체로 계산해 넘김.
export function buildFinalReport(
  merged: ScannedLine[],
  videoRisk: VideoRisk
): FinalReport {
  return {
    videoRiskSummary: {
      riskScore: videoRisk.riskScore,
      riskGrade: videoRisk.riskGrade,
      riskLevelText: videoRisk.riskLevelText,
      summary: buildVideoSummary(videoRisk),
      caution: VIDEO_RISK_CAUTION
    },
    sentenceReports: merged
      .filter((l) => l.status !== "Rule-Negative")
      .map((l) => buildSentenceReport(l.result)),
    overallCaution: OVERALL_CAUTION
  }
}
