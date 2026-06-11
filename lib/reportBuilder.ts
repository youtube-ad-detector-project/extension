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
  RuleHit,
  TriggerHit,
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

export type ModelInspectionResult = {
  resultLabel: string
  confidence: number
  confidencePercent: number
  isViolation: boolean
  explanation: string
}

export type ModelInspectionSummary = {
  inspectedSentenceCount: number
  violationSentenceCount: number
  averageConfidencePercent: number | null
  resultText: string
  averageConfidenceText: string
}

export type SentenceReport = {
  sentence: string
  finalStatus: FinalStatus
  userFacingDecision: UserFacingDecision
  violationTypes: string[]
  triggerTypes: string[]
  plainConclusion: string
  sentenceRiskPercent: number
  riskExplanation: string
  detectedReasons: DetectedReason[]
  directLegalBasis: string[]
  relatedLegalBasisCandidates: string[]
  triggerExplanation: string | null
  modelExplanation: string | null
  modelInspection: ModelInspectionResult | null
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
  modelInspectionSummary: ModelInspectionSummary
  sentenceReports: SentenceReport[]
  overallCaution: string
}

// 고정 주의 문구 — 단정 표현 방지 문구를 코드 상수로 고정해 기본 보고서에서 흔들리지 않게 한다.
const VIDEO_RISK_CAUTION =
  "높게 나왔다면, 구매 전에 한 번 더 확인해 보세요."
const OVERALL_CAUTION =
  "이 결과는 자동 탐지 기준에 따른 검토 안내입니다. 법적 판단이나 위법 확정은 관계 기관 또는 전문가 검토가 필요합니다."

// 영상 단위 요약 문장 — videoRisk(이미 계산됨)를 사람이 읽을 한 줄로 풀어 쓴다 (점수 재계산 아님)
function buildVideoSummary(vr: VideoRisk): string {
  // 의심 문장이 없으면 "표시 없음" — 단정 대신 '신호 없음'으로 표현
  if (vr.riskGrade === "표시 없음") {
    return "현재 기준에서는 크게 주의할 만한 표현이 확인되지 않았습니다."
  }
  return `구매 판단에 영향을 줄 수 있는 표현 ${vr.suspiciousSentenceCount}개를 찾았습니다.`
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
  return `트리거 신호(${names})가 감지되어 정밀 검사 대상으로 분류되었습니다. 트리거는 확정 근거가 아니라 검토 신호입니다.`
}

// 모델 결과가 합쳐진 경우(attachModelResult 거침)만 설명, 아니면 null
function buildModelExplanation(r: AnalysisResult): string | null {
  const m = r.modelResult
  if (!m) return null
  const verdict =
    m.prediction === 1 ? "주의가 필요한 표현" : "추가 의심이 낮은 표현"
  return `정밀 검사 결과, 현재 기준에서 ${verdict}으로 예측되었습니다.`
}

function unique(items: string[]): string[] {
  return Array.from(new Set(items.filter(Boolean)))
}

function buildViolationTypes(r: AnalysisResult): string[] {
  return unique((r.ruleAnalysis?.hits ?? []).map((h) => h.subCategory))
}

function buildTriggerTypes(r: AnalysisResult): string[] {
  return unique((r.triggerAnalysis?.hits ?? []).map((h) => h.categoryName))
}

function buildModelInspectionResult(
  r: AnalysisResult
): ModelInspectionResult | null {
  const m = r.modelResult
  if (!m) return null

  return {
    resultLabel: m.predictionLabel,
    confidence: m.confidence,
    confidencePercent: Math.round(m.confidence * 100),
    isViolation: m.prediction === 1,
    explanation:
      m.prediction === 1
        ? "정밀 검사 결과, 현재 기준에서 주의가 필요한 표현으로 예측되었습니다."
        : "정밀 검사 결과, 현재 기준에서는 추가 의심이 낮은 표현으로 예측되었습니다."
  }
}

function buildModelInspectionSummary(
  merged: ScannedLine[]
): ModelInspectionSummary {
  const inspected = merged
    .map((line) => line.result.modelResult)
    .filter((m): m is NonNullable<typeof m> => Boolean(m))
  const inspectedSentenceCount = inspected.length

  if (inspectedSentenceCount === 0) {
    return {
      inspectedSentenceCount: 0,
      violationSentenceCount: 0,
      averageConfidencePercent: null,
      resultText: "검사 대상 없음",
      averageConfidenceText: "계산된 값 없음"
    }
  }

  const violationSentenceCount = inspected.filter((m) => m.prediction === 1).length
  const averageConfidencePercent = Math.round(
    (inspected.reduce((sum, m) => sum + m.confidence, 0) /
      inspectedSentenceCount) *
      100
  )

  return {
    inspectedSentenceCount,
    violationSentenceCount,
    averageConfidencePercent,
    resultText:
      violationSentenceCount > 0
        ? `주의 표현 ${violationSentenceCount}건`
        : "추가 의심 낮음",
    averageConfidenceText: `${averageConfidencePercent}%`
  }
}

function quoteEvidence(value: string | null | undefined): string {
  return value ? `“${value}”` : "해당 표현"
}

function joinNatural(items: string[]): string {
  if (items.length === 0) return ""
  if (items.length === 1) return items[0]
  return `${items.slice(0, -1).join(", ")} 및 ${items[items.length - 1]}`
}

function simplifyLegalReference(reference: string): string {
  const actArticle = reference.match(/법률 제8조제1항제(\d+)호/)
  if (actArticle) {
    return `식품표시광고법 제8조제1항제${actArticle[1]}호`
  }

  const appendixItem = reference.match(/\[별표 1\] 제(\d+)호([가-힣])?목?/)
  if (appendixItem) {
    return `식품표시광고법 시행령 별표 1 제${appendixItem[1]}호${appendixItem[2] ?? ""}${appendixItem[2] ? "목" : ""}`
  }

  if (reference.includes("법률 제8조:")) {
    return "식품표시광고법 제8조"
  }
  if (reference.includes("시행령 제3조 및 [별표 1]")) {
    return "식품표시광고법 시행령 제3조 및 별표 1"
  }
  if (reference.includes("식품의약품안전처고시 제2025-79호")) {
    const noticeArticle = reference.match(/제(\d+)조제(\d+)호([가-힣])목/)
    if (noticeArticle) {
      return `식약처 고시 제2025-79호 제${noticeArticle[1]}조제${noticeArticle[2]}호${noticeArticle[3]}목`
    }
    return "식약처 고시 제2025-79호"
  }
  if (reference.includes("식품의약품안전처고시 제2024-62호")) {
    return "식약처 고시 제2024-62호"
  }

  return reference.split(":")[0] ?? reference
}

function summarizeLegalReferences(references: string[]): string | null {
  const labels = unique(references.map(simplifyLegalReference))
  if (labels.length === 0) return null

  const visible = labels.slice(0, 2)
  return `${joinNatural(visible)}${labels.length > visible.length ? " 등" : ""}`
}

function getRulePrimaryPriority(subCategory: string): number {
  if (subCategory.includes("질병") || subCategory.includes("치료")) return 100
  if (subCategory.includes("의약품 대체")) return 95
  if (subCategory.includes("단기간 감량")) return 92
  if (subCategory.includes("감량 수치")) return 90
  if (subCategory.includes("단기간 극적효과")) return 88
  if (subCategory.includes("후기/보장")) return 86
  if (subCategory.includes("지방")) return 84
  if (subCategory.includes("식욕")) return 82
  if (subCategory.includes("요요")) return 80
  if (subCategory.includes("전문가")) return 75
  if (subCategory.includes("비교") || subCategory.includes("최고")) return 70
  return 50
}

function pickPrimaryRuleHit(hits: RuleHit[]): RuleHit | null {
  return [...hits].sort(
    (a, b) =>
      getRulePrimaryPriority(b.subCategory) -
        getRulePrimaryPriority(a.subCategory) ||
      b.weight - a.weight ||
      b.severityCoefficient - a.severityCoefficient
  )[0] ?? null
}

function pickPrimaryTriggerHit(hits: TriggerHit[]): TriggerHit | null {
  return [...hits].sort(
    (a, b) =>
      b.weight - a.weight ||
      b.severityCoefficient - a.severityCoefficient
  )[0] ?? null
}

function getRulePlainRiskText(hit: RuleHit): string {
  const subCategory = hit.subCategory

  if (subCategory.includes("의약품 대체")) {
    return "식품을 의약품이나 의료행위의 대체 수단처럼 인식하게 할 소지가 있어"
  }
  if (subCategory.includes("의약품 유사")) {
    return "식품을 의약품과 비슷한 제품처럼 오인하게 할 소지가 있어"
  }
  if (subCategory.includes("질병") || subCategory.includes("치료")) {
    return "질병의 예방·치료 효과가 있는 식품처럼 인식하게 할 소지가 있어"
  }
  if (subCategory.includes("건강기능식품")) {
    return "일반 식품을 건강기능식품처럼 오인하게 할 소지가 있어"
  }
  if (
    subCategory.includes("감량") ||
    subCategory.includes("식욕") ||
    subCategory.includes("지방") ||
    subCategory.includes("요요") ||
    subCategory.includes("후기/보장")
  ) {
    return "체중감량 효과를 과장하거나 보장하는 표현으로 받아들여질 소지가 있어"
  }
  if (subCategory.includes("전문가")) {
    return "전문가가 제품 효능을 보증하거나 추천하는 것처럼 받아들여질 소지가 있어"
  }
  if (subCategory.includes("비교") || subCategory.includes("최고")) {
    return "객관적 근거 없이 제품이 더 우수하다고 받아들여질 소지가 있어"
  }

  return "소비자가 제품 효과를 실제보다 크게 인식할 소지가 있어"
}

function getTriggerPlainRiskText(hit: TriggerHit): string {
  const categoryName = hit.categoryName

  if (categoryName.includes("의료 회피")) {
    return "식품을 의약품이나 의료행위의 대체 수단처럼 오해하게 할 소지가 있어"
  }
  if (categoryName.includes("증상") || categoryName.includes("신체 변화")) {
    return "질병·증상 개선 효과를 우회적으로 암시할 소지가 있어"
  }
  if (categoryName.includes("감량") || categoryName.includes("체중")) {
    return "체중감량 효과를 우회적으로 강조하는 표현으로 볼 소지가 있어"
  }
  if (categoryName.includes("후기")) {
    return "체험담을 통해 효능을 우회적으로 암시할 소지가 있어"
  }
  if (categoryName.includes("우월성") || categoryName.includes("비교")) {
    return "객관적 근거 없이 제품 우월성을 암시할 소지가 있어"
  }

  return "직접 룰에는 닿지 않지만 소비자 오인을 유발할 수 있는 신호가 있어"
}

function buildRuleConclusion(r: AnalysisResult): string | null {
  const hits = r.ruleAnalysis?.hits ?? []
  const primaryHit = pickPrimaryRuleHit(hits)
  if (!primaryHit) return null

  const legalSummary = summarizeLegalReferences(
    primaryHit.legalReferences.length
      ? primaryHit.legalReferences
      : primaryHit.legalReference
        ? [primaryHit.legalReference]
        : []
  )
  const additionalCount = Math.max(0, hits.length - 1)

  return (
    `문장 내 ${quoteEvidence(primaryHit.matchedText)} 표현은 ` +
    `${getRulePlainRiskText(primaryHit)}, ` +
    `${legalSummary ? `${legalSummary} 관련 ` : ""}` +
    "고위험 의심 신호로 표시됩니다." +
    `${additionalCount > 0 ? ` 추가로 ${additionalCount}개 위험 유형이 함께 감지되었습니다.` : ""}`
  )
}

function buildTriggerConclusion(r: AnalysisResult): string | null {
  const hits = r.triggerAnalysis?.hits ?? []
  const primaryHit = pickPrimaryTriggerHit(hits)
  if (!primaryHit) return null

  const legalSummary = summarizeLegalReferences(primaryHit.candidateLegalReferences)
  const legalPhrase = legalSummary ? `${legalSummary} 관련 후보 신호로 ` : ""
  const prefix =
    `문장 내 ${quoteEvidence(primaryHit.matchedText)} 표현은 ` +
    `${getTriggerPlainRiskText(primaryHit)}, ${legalPhrase}`

  if (r.modelResult?.prediction === 0) {
    return `${prefix}감지되었지만 정밀 검사에서는 추가 의심이 낮게 분류되었습니다. 법적 판단이 아니라 검토 참고 항목입니다.`
  }

  if (r.modelResult?.prediction === 1) {
    return `${prefix}감지되었고 정밀 검사에서도 위법 의심으로 분류되었습니다. 최종 판단은 관계 기관 또는 전문가 검토가 필요합니다.`
  }

  return `${prefix}정밀 검사 대상으로 표시됩니다. 트리거는 최종 판단 근거가 아니라 검토 신호입니다.`
}

function buildPlainConclusion(r: AnalysisResult): string {
  if (r.finalStatus === "Rule-Positive") {
    return (
      buildRuleConclusion(r) ??
      "자동 탐지 기준상 고위험 의심 신호가 감지되었습니다. 최종 판단은 관계 기관 또는 전문가 검토가 필요합니다."
    )
  }

  if (r.finalStatus === "Route-to-Model") {
    return (
      buildTriggerConclusion(r) ??
      "직접 룰에는 도달하지 않았지만 추가 검토가 필요한 의심 신호가 감지되었습니다."
    )
  }

  return "현재 탐지 기준상 뚜렷한 의심 신호가 감지되지 않았습니다."
}

function buildUserFacingRiskExplanation(r: AnalysisResult): string {
  if (r.finalStatus === "Rule-Positive") {
    return "명확한 룰 기반 위험 신호가 감지되어 문장 위험도가 높게 표시됩니다."
  }

  if (r.finalStatus === "Route-to-Model") {
    if (r.modelResult?.prediction === 1) {
      return "우회 표현 신호가 감지되었고 정밀 검사에서도 위법 의심으로 분류되어 문장 위험도가 표시됩니다."
    }
    if (r.modelResult?.prediction === 0) {
      return "우회 표현 신호는 감지되었지만 정밀 검사에서 추가 의심이 낮게 분류되어 문장 위험도는 낮게 표시됩니다."
    }
    return "우회 표현 신호가 감지되어 정밀 검사 대상으로 표시됩니다."
  }

  return "현재 탐지 기준상 문장 위험도가 낮게 표시됩니다."
}

// 문장 1개 → 보고서 항목 — 점수/판정/근거/예외를 엔진이 만든 값에서 그대로 옮긴다 (새 판단 안 함)
function buildSentenceReport(r: AnalysisResult): SentenceReport {
  const detectedReasons = buildDetectedReasons(r)

  return {
    sentence: r.sentence,
    finalStatus: r.finalStatus,
    userFacingDecision: r.userFacingDecision,
    violationTypes: buildViolationTypes(r),
    triggerTypes: buildTriggerTypes(r),
    plainConclusion: buildPlainConclusion(r),
    sentenceRiskPercent: r.sentenceRisk.riskPercent,
    riskExplanation: buildUserFacingRiskExplanation(r),
    detectedReasons,
    directLegalBasis: unique(detectedReasons.flatMap((reason) => reason.legalBasis)),
    relatedLegalBasisCandidates: unique(
      detectedReasons.flatMap((reason) => reason.relatedLegalBasisCandidates)
    ),
    triggerExplanation: buildTriggerExplanation(r),
    modelExplanation: buildModelExplanation(r),
    modelInspection: buildModelInspectionResult(r),
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
    modelInspectionSummary: buildModelInspectionSummary(merged),
    sentenceReports: merged
      .filter((l) => l.status !== "Rule-Negative")
      .map((l) => buildSentenceReport(l.result)),
    overallCaution: OVERALL_CAUTION
  }
}
