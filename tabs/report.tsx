// 상세 위반 보고서 — 확장 내부 탭 페이지 (Plasmo 가 tabs/report.tsx → tabs/report.html 로 빌드).
//   호출 흐름: 오버레이 ViolationPanel 의 "상세 보고서" 링크 클릭
//     → background 가 chrome.tabs.create("tabs/report.html?v=<영상ID>")
//     → 이 페이지가 ?v= 로 영상ID 를 받아 storage 자막을 다시 읽고 룰 스캔을 재실행
//     → 위반·의심 줄마다 "어떤 룰/트리거에 왜 걸렸는지 + 실제 자막" 을 근거로 렌더
//   왜 재스캔: analyzeSentence 가 네트워크/DOM 없는 순수 함수라, 오버레이가 계산한 결과를
//   넘겨받지 않고도 같은 입력(저장된 자막)으로 동일 결과를 이 탭에서 그대로 재현할 수 있다.

import { useEffect, useState } from "react"

import {
  calculateVideoRisk,
  scanCaptions,
  type ScannedLine,
  type VideoRisk
} from "~lib/adScan"
import { getStoredCaption } from "~lib/storage"
import { formatTime, STATUS_VIEW } from "~lib/scanView"

// storage entry 모양 — lib/storage.ts 의 StoredEntry 가 export 안 되어 있어 재선언
//   (오버레이도 같은 이유로 동일하게 재선언함 — 두 곳의 모양이 어긋나면 안 됨)
type StoredEntry = Awaited<ReturnType<typeof getStoredCaption>>

// 보고서 화면의 단계 — 데이터 로드 비동기라 "로딩 → (성공/문제)" 전이를 명시적으로 들고 간다
//   ready: 스캔까지 끝나 flagged 줄이 확정된 상태 / problem: 자막 자체가 없거나 진행중·실패
type ViewState =
  | { phase: "loading" }
  | {
      phase: "ready"
      videoId: string
      scanned: ScannedLine[]
      flagged: ScannedLine[]
      videoRisk: VideoRisk
    }
  | { phase: "problem"; message: string }

type ReportRiskView = {
  title: string
  label: string
  summary: string
  caution: string
  color: string
}

type GeneratedSentenceReport = {
  summary: string
  basis: string
  model: string | null
  legal: string
  caution: string
  reasonLines: string[]
}

type RuleHitView = NonNullable<
  ScannedLine["result"]["ruleAnalysis"]
>["hits"][number]
type TriggerHitView = NonNullable<
  ScannedLine["result"]["triggerAnalysis"]
>["hits"][number]

// URL 쿼리에서 영상ID 추출 — background 가 ?v=<id> 로만 넘기므로 그 값만 본다
//   무엇이 들어가 → 처리 → 무엇이 반환: window.location.search(문자열) → videoId(string|null)
function getVideoIdFromQuery(): string | null {
  return new URLSearchParams(window.location.search).get("v")
}

// 페이지 루트 — Plasmo 가 이 default export 를 tabs/report.html 에 마운트한다.
function Report() {
  const [state, setState] = useState<ViewState>({ phase: "loading" })

  // 마운트 시 1회: ?v= 읽기 → storage 조회 → (성공이면) 룰 재스캔 → flagged 만 추려 상태 확정
  //   의존성 [] : 영상ID 는 URL 고정값이라 재실행 불필요 (탭이 곧 1영상 1보고서)
  useEffect(() => {
    const videoId = getVideoIdFromQuery()
    // 잘못된 진입(직접 URL 입력 등) — 무엇을 보여줄지 알 수 없으니 안내만
    if (!videoId) {
      setState({ phase: "problem", message: "영상 ID(?v=)가 없습니다." })
      return
    }

    void getStoredCaption(videoId).then((entry: StoredEntry | null) => {
      // 자막 기록 없음/진행중/실패 → 보고서를 만들 입력이 없는 상태이므로 사유만 표기
      if (!entry) {
        setState({
          phase: "problem",
          message: `영상 ${videoId} 의 저장된 자막이 없습니다.`
        })
        return
      }
      if (entry.ok === "pending") {
        setState({
          phase: "problem",
          message: `자막 추출이 아직 진행 중입니다 (${entry.data.stage}). 완료 후 다시 열어주세요.`
        })
        return
      }
      if (entry.ok === false) {
        setState({
          phase: "problem",
          message: `자막 추출 실패: ${entry.data.reason}`
        })
        return
      }

      // 성공 자막 → 오버레이와 동일한 scanCaptions 로 재스캔
      //   데이터 형태: CaptionSegment[] → ScannedLine[](status+근거 result 포함)
      const scanned = scanCaptions(entry.data.segments, {
        productName: entry.data.productName,
        videoTitle: entry.data.videoTitle
      })
      // 정상(Rule-Negative) 제외 — 보고서는 위반·의심 줄의 "근거"만 다룬다
      const flagged = scanned.filter((l) => l.status !== "Rule-Negative")
      const videoRisk = calculateVideoRisk(scanned)
      setState({ phase: "ready", videoId, scanned, flagged, videoRisk })
    })
  }, [])

  if (state.phase === "loading") {
    return <Shell>자막을 불러와 분석 중…</Shell>
  }
  if (state.phase === "problem") {
    return <Shell>{state.message}</Shell>
  }

  // ready — 위반·의심 줄이 0개일 수도 있음(빈 화면이 버그처럼 보이지 않게 명시)
  const { videoId, scanned, flagged, videoRisk } = state
  const positive = flagged.filter((l) => l.status === "Rule-Positive").length
  const route = flagged.filter((l) => l.status === "Route-to-Model").length
  const risk = getReportRiskView(videoRisk)

  return (
    <Shell>
      <section style={{ ...styles.hero, borderTopColor: risk.color }}>
        <div style={styles.heroMetaRow}>
          <span style={{ ...styles.riskPill, background: risk.color }}>
            {risk.label}
          </span>
          <span style={styles.videoMeta}>
            영상{" "}
            {/* 원본으로 바로 이동 — 보고서에서 실제 영상을 대조 확인할 수 있게 */}
            <a
              style={styles.link}
              href={`https://www.youtube.com/watch?v=${videoId}`}
              target="_blank"
              rel="noreferrer">
              {videoId}
            </a>
          </span>
        </div>

        <h1 style={styles.riskTitle}>{risk.title}</h1>
        <p style={styles.riskSummary}>{risk.summary}</p>
        <p style={styles.riskCaution}>{risk.caution}</p>

        <div style={styles.statRow}>
          <Stat label="전체 자막" value={`${scanned.length}문장`} />
          <Stat label="위반 의심" value={`${positive}문장`} tone="#e5484d" />
          <Stat label="추가 검토" value={`${route}문장`} tone="#f5a623" />
          <Stat
            label="최고 문장 점수"
            value={`${videoRisk.maxSentenceRiskPercent}점`}
            tone={risk.color}
          />
        </div>
      </section>

      <section style={styles.section}>
        <div style={styles.sectionHead}>
          <h2 style={styles.h2}>근거 문장</h2>
          <span style={styles.sectionCount}>{flagged.length}건</span>
        </div>

        {flagged.length === 0 ? (
          <p style={styles.meta}>
            현재 탐지 기준상 뚜렷한 의심 신호가 감지되지 않았습니다.
          </p>
        ) : (
          // 줄 N개 → 접이식 근거 N개. 첫 화면은 훑기 쉽게 요약만, 클릭 시 상세 근거를 펼친다.
          flagged.map((line, i) => (
            <LineCard key={i} index={i + 1} videoId={videoId} line={line} />
          ))
        )}
      </section>
    </Shell>
  )
}

function getReportRiskView(videoRisk: VideoRisk): ReportRiskView {
  const colorByGrade: Record<VideoRisk["riskGrade"], string> = {
    높음: "#e5484d",
    중간: "#f5a623",
    낮음: "#b7791f",
    "표시 없음": "#4b5563"
  }

  if (videoRisk.riskScore === 0) {
    return {
      title: "현재 탐지 기준상 뚜렷한 의심 신호 없음",
      label: videoRisk.riskGrade,
      summary: videoRisk.riskLevelText,
      caution: videoRisk.calculationNote,
      color: colorByGrade[videoRisk.riskGrade]
    }
  }

  return {
    title: `자동 탐지 위험도 ${videoRisk.riskScore}점`,
    label: videoRisk.riskGrade,
    summary:
      `${videoRisk.riskLevelText}. 위법 의심 신호가 감지된 문장이 ` +
      `${videoRisk.suspiciousSentenceCount}개 포함되어 있습니다.`,
    caution: videoRisk.calculationNote,
    color: colorByGrade[videoRisk.riskGrade]
  }
}

function buildSentenceReport(line: ScannedLine): GeneratedSentenceReport {
  const r = line.result

  if (line.status === "Rule-Positive" && r.ruleAnalysis) {
    const hits = r.ruleAnalysis.hits
    const { primaryHit, additionalHits } = splitPrimaryRuleHit(hits)
    const primaryLabel = primaryHit
      ? getRuleSignalLabel(primaryHit.subCategory)
      : "룰 기반 위험 신호"
    const additionalLabels = unique(
      additionalHits.map((h) => getRuleSignalLabel(h.subCategory))
    )
    const evidence = joinNatural(
      unique(hits.map((h) => quoteText(h.matchedText)))
    )
    const reasonLines = buildGroupedRuleReasonLines(primaryHit, additionalHits)
    const isComplex = additionalLabels.length > 0
    const lawSummary = getSimpleLawSummaryFromRuleHits(hits)
    const riskText = primaryHit
      ? getRulePlainRiskText(primaryHit)
      : "자동 탐지 기준상 위험 표현으로 볼 여지가 있어"

    return {
      summary:
        isComplex
          ? `영상 내 ${primaryLabel}을 중심으로 여러 위험 신호가 함께 감지되었습니다.`
          : `영상 내 ${primaryLabel}이 감지되었습니다.`,
      basis:
        `문장 내 근거 표현은 ${evidence || "표시된 자막 문장"}이며, ` +
        `${riskText} 자동 탐지 기준상 ${r.userFacingDecision}으로 분류되었습니다.` +
        `${additionalLabels.length > 0 ? ` ${joinNatural(additionalLabels)}도 함께 감지되어 복합 신호로 묶어 표시합니다.` : ""}`,
      model: null,
      legal: lawSummary
        ? `${lawSummary} 관련 위반 소지가 있어 아래 법령 근거로 표시됩니다.`
        : "이 룰에는 표시할 법령 키가 연결되어 있지 않습니다.",
      caution:
        "이 설명은 자동 탐지 기준에 따른 위험 신호 안내이며, 법적 위반 확정 판단이 아닙니다.",
      reasonLines
    }
  }

  if (line.status === "Route-to-Model" && r.triggerAnalysis) {
    const hits = r.triggerAnalysis.hits
    const categories = joinNatural(unique(hits.map((h) => h.categoryName)))
    const evidence = joinNatural(
      unique(hits.map((h) => quoteText(h.matchedText)))
    )
    const reasonLines = hits.map(
      (h) =>
        `${h.categoryName}(${h.level}): ${h.rationale || getTriggerFallbackExplanation(h.categoryName)}`
    )
    const lawSummary = getSimpleLawSummaryFromTriggerHits(hits)
    const triggerText = getTriggerPlainRiskText(hits[0])

    return {
      summary:
        "이 문장은 명시적 룰 위반으로 확정되지는 않았지만, " +
        `${categories || "우회 표현 신호"}가 감지되어 AI 모델 검증 대상으로 분류되었습니다.`,
      basis:
        `문장 내 근거 표현은 ${evidence || "표시된 자막 문장"}이며, ` +
        `${triggerText} 추가 검토가 필요한 우회 표현으로 표시됩니다.`,
      model: buildModelExplanation(r.modelResult),
      legal: lawSummary
        ? `관련 법령 후보는 ${lawSummary}입니다. 이 법령은 트리거 유형에 연결된 검토 후보이며, 위반 확정 근거는 아닙니다.`
        : "현재 트리거에 연결된 법령 후보는 없습니다. 트리거는 위반 확정 근거가 아니라 추가 검토 신호입니다.",
      caution:
        "모델 신뢰도는 자동 분류 신뢰도이며 실제 위법 확률로 해석하지 않습니다.",
      reasonLines
    }
  }

  return {
    summary: "현재 탐지 기준상 뚜렷한 의심 신호가 감지되지 않았습니다.",
    basis: "표시된 문장에서는 Rule-Positive 또는 Route-to-Model 기준에 도달한 근거가 없습니다.",
    model: null,
    legal: "연결된 법령 근거가 없습니다.",
    caution: "자동 탐지 결과는 최종 법적 판단을 대체하지 않습니다.",
    reasonLines: []
  }
}

function buildModelExplanation(
  modelResult: ScannedLine["result"]["modelResult"]
): string {
  if (!modelResult) {
    return (
      "현재 보고서 데이터에는 AI 모델의 최종 예측값이 연결되어 있지 않아, " +
      "트리거 기준의 추가 검토 대상으로만 표시합니다."
    )
  }

  const decision =
    modelResult.prediction === 1
      ? "위험 신호로 분류했습니다"
      : "비위험 신호로 분류했습니다"

  return (
    `AI 모델 검사 결과 이 문장은 ${quoteText(modelResult.predictionLabel)}으로 표시되었고, ` +
    `모델은 ${decision}. 모델 신뢰도는 ${formatConfidence(modelResult.confidence)}입니다. ` +
    "이 값은 법적 위법 확률이 아니라 자동 분류 신뢰도입니다."
  )
}

function splitPrimaryRuleHit(
  hits: NonNullable<ScannedLine["result"]["ruleAnalysis"]>["hits"]
): {
  primaryHit: (typeof hits)[number] | null
  additionalHits: typeof hits
} {
  if (hits.length === 0) {
    return { primaryHit: null, additionalHits: [] }
  }

  const [primaryHit] = [...hits].sort(
    (a, b) =>
      getRulePrimaryPriority(b.subCategory) -
        getRulePrimaryPriority(a.subCategory) ||
      b.weight - a.weight ||
      b.severityCoefficient - a.severityCoefficient
  )

  return {
    primaryHit,
    additionalHits: hits.filter((hit) => hit !== primaryHit)
  }
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

function buildGroupedRuleReasonLines(
  primaryHit: NonNullable<ScannedLine["result"]["ruleAnalysis"]>["hits"][number] | null,
  additionalHits: NonNullable<ScannedLine["result"]["ruleAnalysis"]>["hits"]
): string[] {
  const lines: string[] = []

  if (primaryHit) {
    lines.push(
      `주요 근거: ${getRuleSignalLabel(primaryHit.subCategory)} - ${
        primaryHit.rationale ||
        getRuleFallbackExplanation(primaryHit.subCategory)
      }`
    )
  }

  if (additionalHits.length > 0) {
    lines.push(
      `추가 복합 신호: ${joinNatural(
        unique(additionalHits.map((h) => getRuleSignalLabel(h.subCategory)))
      )}`
    )
  }

  return lines
}

function getRuleSignalLabel(subCategory: string): string {
  if (subCategory.includes("단기간 감량")) return "단기간 감량 표현"
  if (subCategory.includes("감량 수치")) return "구체적 감량 수치 표현"
  if (subCategory.includes("단기간 극적효과")) return "단기간 극적효과 표현"
  if (subCategory.includes("후기/보장")) return "후기·보장형 과장 표현"
  if (subCategory.includes("식욕")) return "식욕 억제 표현"
  if (subCategory.includes("지방")) return "지방 제거·배출 표현"
  if (subCategory.includes("요요")) return "요요 없음·살 안 찜 표현"
  if (subCategory.includes("의약품 대체")) return "의약품·의료행위 대체 표현"
  if (subCategory.includes("의약품 유사")) return "의약품 유사명칭 표현"
  if (subCategory.includes("약효")) return "약효 증대 표현"
  if (subCategory.includes("질병/증상")) return "질병·증상 예방·치료 표현"
  if (subCategory.includes("질병 연관")) return "질병 연관성 표현"
  if (subCategory.includes("건강기능식품")) return "건강기능식품 오인 표현"
  if (subCategory.includes("기능성")) return "기능성 효능 표방 표현"
  if (subCategory.includes("전문가")) return "전문가 권위 활용 표현"
  if (subCategory.includes("비교") || subCategory.includes("최고")) {
    return "입증 어려운 비교·최상급 표현"
  }
  if (subCategory.includes("현혹")) return "소비자 현혹 표현"
  return subCategory
}

function getRuleFallbackExplanation(subCategory: string): string {
  if (subCategory.includes("의약품 대체")) {
    return "식품을 의약품이나 의료행위의 대체 수단처럼 인식하게 할 소지가 있습니다."
  }
  if (subCategory.includes("질병") || subCategory.includes("치료")) {
    return "질병의 예방 또는 치료 효과가 있는 것처럼 인식될 소지가 있습니다."
  }
  if (subCategory.includes("건강기능식품")) {
    return "건강기능식품으로 오인하게 할 수 있는 표현입니다."
  }
  if (subCategory.includes("전문가")) {
    return "전문가 권위를 활용해 제품의 기능성을 보증하거나 추천하는 것처럼 보일 수 있습니다."
  }
  if (subCategory.includes("비교") || subCategory.includes("최고")) {
    return "객관적 근거 없이 우월하거나 유리한 제품으로 인식하게 할 소지가 있습니다."
  }
  return "자동 탐지 사전에 등록된 위험 표현 유형과 매칭되었습니다."
}

function getTriggerFallbackExplanation(categoryName: string): string {
  if (categoryName.includes("의료 회피")) {
    return "의료행위나 의약품을 대신할 수 있다는 인식을 줄 수 있는 우회 표현입니다."
  }
  if (categoryName.includes("후기")) {
    return "체험담 형식으로 효능을 암시할 수 있는 우회 표현입니다."
  }
  if (categoryName.includes("우월성")) {
    return "비교 대상이 명확하지 않은 우월성 표현으로 소비자 오인 가능성이 있습니다."
  }
  return "직접 룰에는 도달하지 않았지만 추가 검토가 필요한 우회 표현 신호입니다."
}

const SIMPLE_LAW_LABELS: Record<string, string> = {
  FOOD_LABEL_AD_ACT_ART8: "식품표시광고법 제8조",
  FOOD_LABEL_AD_ACT_ART8_1_1: "식품표시광고법 제8조제1항제1호",
  FOOD_LABEL_AD_ACT_ART8_1_2: "식품표시광고법 제8조제1항제2호",
  FOOD_LABEL_AD_ACT_ART8_1_3: "식품표시광고법 제8조제1항제3호",
  FOOD_LABEL_AD_ACT_ART8_1_4: "식품표시광고법 제8조제1항제4호",
  FOOD_LABEL_AD_ACT_ART8_1_5: "식품표시광고법 제8조제1항제5호",
  FOOD_LABEL_AD_ACT_ART8_1_6: "식품표시광고법 제8조제1항제6호",
  FOOD_LABEL_AD_ACT_ART8_1_7: "식품표시광고법 제8조제1항제7호",
  FOOD_LABEL_AD_DECREE_ART3_APPENDIX1:
    "식품표시광고법 시행령 제3조 및 별표 1",
  MFDS_NOTICE_2025_79_UNFAIR_LABEL_AD_CONTENT: "식약처 고시 제2025-79호",
  MFDS_NOTICE_2024_62_FUNCTIONAL_LABEL_AD_ALLOWED: "식약처 고시 제2024-62호"
}

function getRulePlainRiskText(hit: RuleHitView): string {
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

function getTriggerPlainRiskText(hit?: TriggerHitView): string {
  const categoryName = hit?.categoryName ?? ""

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

function getSimpleLawSummaryFromRuleHits(hits: RuleHitView[]): string | null {
  return summarizeLawKeys(hits.flatMap((h) => h.lawKeys ?? []))
}

function getSimpleLawSummaryFromTriggerHits(
  hits: TriggerHitView[]
): string | null {
  return summarizeLawKeys(hits.flatMap((h) => h.candidateLawKeys ?? []))
}

function summarizeLawKeys(lawKeys: string[]): string | null {
  const uniqueKeys = unique(lawKeys)
  const detailedActKeys = uniqueKeys.filter((key) =>
    /^FOOD_LABEL_AD_ACT_ART8_1_\d$/.test(key)
  )
  const keysToShow =
    detailedActKeys.length > 0
      ? detailedActKeys
      : uniqueKeys.filter((key) => SIMPLE_LAW_LABELS[key])

  if (keysToShow.length === 0) return null

  const labels = unique(keysToShow.map((key) => SIMPLE_LAW_LABELS[key] ?? key))
  const visibleLabels = labels.slice(0, 3)
  const suffix = labels.length > visibleLabels.length ? " 등" : ""

  return `${visibleLabels.join(", ")}${suffix}`
}

function unique(items: string[]): string[] {
  return Array.from(new Set(items.map((item) => item.trim()).filter(Boolean)))
}

function joinNatural(items: string[]): string {
  if (items.length <= 2) return items.join(", ")
  return `${items.slice(0, -1).join(", ")}, ${items[items.length - 1]}`
}

function quoteText(text: string): string {
  const normalized = text.trim()
  if (!normalized) return ""
  const clipped =
    normalized.length > 80 ? `${normalized.slice(0, 80).trim()}...` : normalized
  return `“${clipped}”`
}

function formatConfidence(confidence: number): string {
  if (!Number.isFinite(confidence)) return "0"
  return String(Math.round(confidence * 10000) / 10000)
}

// 상단 요약 숫자 하나 — 위험도 아래에 핵심 개수를 빠르게 비교하도록 작은 통계 칩으로 분리
function Stat({
  label,
  value,
  tone = "#444"
}: {
  label: string
  value: string
  tone?: string
}) {
  return (
    <div style={styles.stat}>
      <div style={styles.statLabel}>{label}</div>
      <div style={{ ...styles.statValue, color: tone }}>{value}</div>
    </div>
  )
}

// 줄 1개 카드 — 위쪽: 어떤 자막이(타임스탬프+텍스트), 아래쪽: 왜 걸렸는지(룰/트리거 근거)
//   무엇이 들어가 → 처리 → 무엇이 반환: ScannedLine(상태+result) → 근거 표가 붙은 카드 JSX
function LineCard({
  index,
  videoId,
  line
}: {
  index: number
  videoId: string
  line: ScannedLine
}) {
  // 각 근거는 독립적으로 열고 닫는다. 여러 근거를 연속으로 펼쳐 비교할 수 있어야 해서 전역 accordion 으로 묶지 않음.
  const [open, setOpen] = useState(false)
  const view = STATUS_VIEW[line.status]
  const r = line.result
  const sec = Math.floor(line.start)
  const generatedReport = buildSentenceReport(line)

  return (
    <section style={{ ...styles.card, borderLeft: `4px solid ${view.color}` }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={styles.cardToggle}
        aria-expanded={open}>
        <span style={styles.cardIndex}>{index}</span>
        <span style={{ ...styles.tag, background: view.color }}>{view.tag}</span>
        {/* 타임스탬프는 버튼 안에서는 텍스트로 보여주고, 펼친 뒤 실제 영상 점프 링크를 제공한다 */}
        <span style={styles.tsText}>{formatTime(line.start)}</span>
        <span style={styles.lineText}>{line.text}</span>
        <span style={styles.chevron}>{open ? "접기" : "근거 보기"}</span>
      </button>

      {open && (
        <div style={styles.cardBody}>
          <p style={styles.originalLinkRow}>
            실제 영상 대조:{" "}
            <a
              style={styles.link}
              href={`https://www.youtube.com/watch?v=${videoId}&t=${sec}s`}
              target="_blank"
              rel="noreferrer">
              {formatTime(line.start)} 지점 열기 ↗
            </a>
          </p>

          <div style={styles.generatedReport}>
            <div style={styles.generatedTitle}>자동 설명</div>
            <p style={styles.generatedParagraph}>{generatedReport.summary}</p>
            <p style={styles.generatedParagraph}>{generatedReport.basis}</p>
            {generatedReport.reasonLines.length > 0 && (
              <ul style={styles.generatedList}>
                {generatedReport.reasonLines.map((reason, i) => (
                  <li key={i}>{reason}</li>
                ))}
              </ul>
            )}
            {generatedReport.model && (
              <p style={styles.generatedParagraph}>{generatedReport.model}</p>
            )}
            <p style={styles.generatedParagraph}>{generatedReport.legal}</p>
            <p style={styles.generatedCaution}>{generatedReport.caution}</p>
          </div>

          <p style={styles.sentenceRiskNote}>
            문장 위험도 {r.sentenceRisk.riskPercent}점 ·{" "}
            {r.sentenceRisk.riskExplanation}
          </p>

          {/* 위반 줄: 룰 근거 — 어떤 룰이 몇 점으로 합산돼 8점 임계를 넘겼는지 */}
          {line.status === "Rule-Positive" && r.ruleAnalysis && (
            <div style={styles.evidence}>
              <div style={styles.evidenceTitle}>
                세부 룰 근거 — 복합 신호 {r.ruleAnalysis.hits.length}건
                (판정 참고 가중치 {r.ruleAnalysis.weightSum}점)
              </div>
              <EvidenceTable
                cols={[
                  "대분류",
                  "세부 룰",
                  "매칭된 표현",
                  "가중치",
                  "심각도",
                  "설명",
                  "법령 근거"
                ]}
                rows={r.ruleAnalysis.hits.map((h) => [
                  h.mainCategory,
                  h.subCategory,
                  h.matchedText,
                  String(h.weight),
                  `${h.severityLevel} (${h.severityCoefficient})`,
                  h.rationale || getRuleFallbackExplanation(h.subCategory),
                  formatLegalBasis([
                    ...(h.legalReferences ?? []),
                    h.legalReference
                  ], h.safeHarborLegalReferences ?? [])
                ])}
              />
              {/* 예외로 해제된 룰이 있으면 "왜 점수가 깎였는지" 도 근거의 일부라 같이 표기 */}
              {r.ruleAnalysis.exceptionsHit.length > 0 && (
                <p style={styles.note}>
                  예외 적용으로 룰 {r.ruleAnalysis.removedByException}건 해제됨
                  (
                  {r.ruleAnalysis.exceptionsHit
                    .map((e) => e.matchedText)
                    .join(", ")}
                  )
                </p>
              )}
            </div>
          )}

          {/* 의심 줄: 트리거 근거 — 어떤 의심 신호가 1.5점 임계를 넘겨 모델 검증 대상이 됐는지 */}
          {line.status === "Route-to-Model" && r.triggerAnalysis && (
            <div style={styles.evidence}>
              <div style={styles.evidenceTitle}>
                트리거 근거 — 가중치 합계 {r.triggerAnalysis.weightSum}점 (추가
                검토 임계 ≥ 1.5)
              </div>
              <EvidenceTable
                cols={[
                  "카테고리",
                  "강도",
                  "매칭된 표현",
                  "가중치",
                  "심각도",
                  "설명",
                  "관련 법령 후보"
                ]}
                rows={r.triggerAnalysis.hits.map((h) => [
                  h.categoryName,
                  h.level,
                  h.matchedText,
                  String(h.weight),
                  String(h.severityCoefficient),
                  h.rationale || getTriggerFallbackExplanation(h.categoryName),
                  formatLegalBasis(
                    h.candidateLegalReferences ?? [],
                    h.safeHarborLegalReferences ?? []
                  )
                ])}
              />
            </div>
          )}

          {/* 건기식 등재 제품 안내 — 엔진이 채워줄 때만(근거에 곁들이는 추가 확인 경로) */}
          {r.warningMessage && (
            <p style={styles.note}>
              {r.warningMessage}
              {r.verificationUrl && (
                <>
                  {" "}
                  <a
                    style={styles.link}
                    href={r.verificationUrl}
                    target="_blank"
                    rel="noreferrer">
                    확인하기 ↗
                  </a>
                </>
              )}
            </p>
          )}
        </div>
      )}
    </section>
  )
}

// 법령 문구 배열 → 표 셀 한 칸. 같은 문구가 중복 들어오면 제거하고 줄바꿈으로 분리한다.
function formatLegalBasis(
  items: (string | null | undefined)[],
  safeHarborItems: (string | null | undefined)[] = []
): string {
  const uniq = Array.from(
    new Set(items.map((item) => item?.trim()).filter(Boolean) as string[])
  )
  const safeHarbor = Array.from(
    new Set(
      safeHarborItems.map((item) => item?.trim()).filter(Boolean) as string[]
    )
  ).map((item) => `[합법 예외 참고] ${item}`)
  const all = [...uniq, ...safeHarbor]
  return all.length > 0 ? all.join("\n") : "입력된 법령 근거 없음"
}

// 근거 표 — 헤더 cols + 본문 rows(2차원 문자열 배열) 를 단순 table 로. 로직 없음
function EvidenceTable({
  cols,
  rows
}: {
  cols: string[]
  rows: string[][]
}) {
  return (
    <table style={styles.table}>
      <thead>
        <tr>
          {cols.map((c) => (
            <th key={c} style={styles.th}>
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>
            {row.map((cell, j) => (
              <td key={j} style={styles.td}>
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// 공통 페이지 골격 — 어떤 phase 든 같은 여백/배경을 쓰도록 감싸는 래퍼
function Shell({ children }: { children: React.ReactNode }) {
  return <div style={styles.page}>{children}</div>
}

// 인라인 스타일 — 보고서는 글이 많아 가독성 우선(밝은 배경/검은 글씨), 오버레이의 어두운 톤과는 의도적으로 다름
const styles: Record<string, React.CSSProperties> = {
  page: {
    maxWidth: 880,
    margin: "0 auto",
    padding: "32px 24px",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    color: "#1a1a1a",
    fontSize: 14,
    lineHeight: 1.6
  },
  hero: {
    border: "1px solid #e5e7eb",
    borderTop: "6px solid #4b5563",
    borderRadius: 10,
    padding: "22px 24px",
    marginBottom: 24,
    background: "#fff",
    boxShadow: "0 8px 24px rgba(0,0,0,0.06)"
  },
  heroMetaRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 12,
    flexWrap: "wrap"
  },
  riskPill: {
    color: "#fff",
    fontSize: 13,
    fontWeight: 800,
    padding: "4px 10px",
    borderRadius: 999
  },
  videoMeta: { color: "#666", fontSize: 13 },
  riskTitle: {
    fontSize: 34,
    lineHeight: 1.15,
    margin: "0 0 8px",
    letterSpacing: 0
  },
  riskSummary: {
    margin: "0 0 18px",
    color: "#444",
    fontSize: 15
  },
  riskCaution: {
    margin: "-8px 0 18px",
    color: "#666",
    fontSize: 13
  },
  statRow: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
    gap: 10
  },
  stat: {
    border: "1px solid #ececec",
    borderRadius: 8,
    padding: "10px 12px",
    background: "#fafafa"
  },
  statLabel: { color: "#666", fontSize: 12, marginBottom: 2 },
  statValue: { fontSize: 20, fontWeight: 800 },
  section: { marginTop: 8 },
  sectionHead: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 10
  },
  h2: { fontSize: 18, margin: 0 },
  sectionCount: { color: "#666", fontSize: 13 },
  meta: { color: "#555", margin: "0 0 20px" },
  link: { color: "#1a73e8", textDecoration: "none" },
  card: {
    background: "#fff",
    border: "1px solid #e3e3e3",
    borderRadius: 8,
    padding: 0,
    marginBottom: 14,
    boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
    overflow: "hidden"
  },
  cardToggle: {
    width: "100%",
    border: "none",
    background: "#fff",
    color: "inherit",
    display: "grid",
    gridTemplateColumns: "28px auto 54px minmax(0, 1fr) 76px",
    alignItems: "center",
    gap: 10,
    padding: "14px 16px",
    textAlign: "left",
    cursor: "pointer",
    fontFamily: "inherit"
  },
  cardIndex: {
    color: "#777",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 12
  },
  tag: {
    color: "#fff",
    fontSize: 12,
    fontWeight: 700,
    padding: "2px 8px",
    borderRadius: 4,
    flexShrink: 0
  },
  tsText: {
    color: "#555",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 13,
    flexShrink: 0
  },
  lineText: {
    fontWeight: 600,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap"
  },
  chevron: {
    color: "#1a73e8",
    fontSize: 12,
    fontWeight: 700,
    textAlign: "right"
  },
  cardBody: {
    borderTop: "1px solid #eeeeee",
    padding: "12px 16px 16px",
    background: "#fcfcfc"
  },
  originalLinkRow: { margin: "0 0 10px", color: "#555", fontSize: 13 },
  generatedReport: {
    margin: "0 0 10px",
    padding: "10px 12px",
    border: "1px solid #dfe7f3",
    borderRadius: 8,
    background: "#f8fbff",
    color: "#253044",
    fontSize: 13
  },
  generatedTitle: {
    marginBottom: 6,
    color: "#1f4f8f",
    fontSize: 13,
    fontWeight: 800
  },
  generatedParagraph: {
    margin: "0 0 6px"
  },
  generatedList: {
    margin: "0 0 6px 18px",
    padding: 0
  },
  generatedCaution: {
    margin: 0,
    color: "#5f6b7a",
    fontSize: 12
  },
  sentenceRiskNote: {
    margin: "0 0 10px",
    padding: "8px 10px",
    border: "1px solid #ececec",
    borderRadius: 8,
    background: "#fff",
    color: "#444",
    fontSize: 13
  },
  evidence: {
    marginTop: 12,
    paddingTop: 12,
    borderTop: "1px dashed #e0e0e0"
  },
  evidenceTitle: {
    fontSize: 13,
    fontWeight: 700,
    color: "#444",
    marginBottom: 8
  },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: {
    textAlign: "left",
    padding: "6px 8px",
    background: "#f5f5f5",
    borderBottom: "1px solid #e0e0e0",
    color: "#555",
    fontWeight: 600
  },
  td: {
    padding: "6px 8px",
    borderBottom: "1px solid #f0f0f0",
    verticalAlign: "top",
    whiteSpace: "pre-wrap"
  },
  note: { marginTop: 10, color: "#8a6d00", fontSize: 13 }
}

export default Report
