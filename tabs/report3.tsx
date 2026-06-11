// 최종 사용자용 분석 리포트.
// 첫 화면은 60~70대 이상 사용자도 바로 이해할 수 있게 결론과 주의 신호를 크게 보여주고,
// 문장별 상세 카드에는 룰 근거·법률·트리거·모델 결과·모델 신뢰도를 빠짐없이 담는다.

import { useEffect, useState, type CSSProperties, type ReactNode } from "react"

import { calculateVideoRisk, scanCaptions, type ScannedLine } from "~lib/adScan"
import { attachModelResult } from "~lib/matchingEngine"
import type { ClassifyVerdict } from "~lib/messages"
import {
  buildFinalReport,
  type FinalReport,
  type SentenceReport
} from "~lib/reportBuilder"
import { formatTime } from "~lib/scanView"
import { getStoredCaption } from "~lib/storage"

const SERVER = "http://localhost:3000"

type StoredEntry = Awaited<ReturnType<typeof getStoredCaption>>

type ViewState =
  | { phase: "loading"; message: string }
  | { phase: "problem"; message: string }
  | { phase: "ready"; videoId: string; report: FinalReport; flagged: ScannedLine[] }

type Tone = {
  accent: string
  accentDeep: string
  soft: string
  border: string
}

function getVideoIdFromQuery(): string | null {
  return new URLSearchParams(window.location.search).get("v")
}

function riskTone(grade: FinalReport["videoRiskSummary"]["riskGrade"]): Tone {
  if (grade === "높음") {
    return {
      accent: "#d92f40",
      accentDeep: "#8f1e29",
      soft: "#fff8f8",
      border: "#f0d7dc"
    }
  }
  if (grade === "중간") {
    return {
      accent: "#b66b16",
      accentDeep: "#70420f",
      soft: "#fff9f0",
      border: "#eadbbf"
    }
  }
  if (grade === "낮음") {
    return {
      accent: "#8f641e",
      accentDeep: "#594014",
      soft: "#fffaf1",
      border: "#e6dcc2"
    }
  }
  return {
    accent: "#24885a",
    accentDeep: "#16633f",
    soft: "#f3fbf7",
    border: "#d7eadf"
  }
}

function reportHeadline(vrs: FinalReport["videoRiskSummary"]): string {
  if (vrs.riskScore > 0) return "구매 전 확인이 필요해요"
  return "크게 걸리는 표현은 적어요"
}

function reportLead(
  vrs: FinalReport["videoRiskSummary"],
  sentenceCount: number
): ReactNode {
  if (vrs.riskScore > 0) {
    return `이 광고에서 구매 판단에 영향을 줄 수 있는 표현 ${sentenceCount}개를 찾았습니다.`
  }
  return "현재 기준에서는 구매 판단을 크게 흔들 만한 표현이 적게 나타났습니다."
}

function formatConfidence(confidence: number): string {
  if (!Number.isFinite(confidence)) return "0"
  return String(Math.round(confidence * 10000) / 10000)
}

function displaySignalScore(score: number): number {
  const normalized = Math.max(0, Math.min(100, Math.round(score)))
  if (normalized === 0) return 0
  if (normalized < 40) return 28
  if (normalized < 70) return 54
  if (normalized < 85) return 76
  return 92
}

function displaySignalLevel(score: number): string {
  const normalized = Math.max(0, Math.min(100, Math.round(score)))
  if (normalized === 0) return "표시 없음"
  if (normalized < 40) return "낮음"
  if (normalized < 70) return "보통"
  if (normalized < 85) return "높음"
  return "매우 높음"
}

function unique(items: string[]): string[] {
  return Array.from(new Set(items.map((item) => item.trim()).filter(Boolean)))
}

function joinItems(items: string[], fallback = "해당 정보 없음"): string {
  const values = unique(items)
  return values.length > 0 ? values.join(", ") : fallback
}

function firstNonEmpty(items: Array<string | null | undefined>): string {
  return items.map((item) => item?.trim()).find(Boolean) ?? ""
}

function sentenceTone(report: SentenceReport): Tone {
  if (report.finalStatus === "Rule-Positive") return riskTone("높음")
  if (report.modelInspection?.isViolation) return riskTone("높음")
  if (report.finalStatus === "Route-to-Model") return riskTone("중간")
  return riskTone("표시 없음")
}

function sentenceResultLabel(report: SentenceReport): string {
  if (report.finalStatus === "Rule-Positive") return "주의 표현"
  if (report.modelInspection) {
    return report.modelInspection.isViolation ? "주의 표현" : "확인 필요"
  }
  if (report.finalStatus === "Route-to-Model") return "확인 필요"
  return "참고"
}

function isCautionExpression(report: SentenceReport): boolean {
  return (
    report.finalStatus === "Rule-Positive" ||
    report.modelInspection?.isViolation === true
  )
}

function closeReport() {
  if (window.history.length > 1) {
    window.history.back()
    return
  }
  window.close()
}

function Report3() {
  const [state, setState] = useState<ViewState>({
    phase: "loading",
    message: "광고 표현을 정리하고 있습니다."
  })

  useEffect(() => {
    const videoId = getVideoIdFromQuery()
    if (!videoId) {
      setState({ phase: "problem", message: "영상 ID가 없어 보고서를 열 수 없습니다." })
      return
    }

    void (async () => {
      const entry: StoredEntry | null = await getStoredCaption(videoId)
      if (!entry) {
        setState({
          phase: "problem",
          message: `영상 ${videoId}의 저장된 자막이 없습니다.`
        })
        return
      }
      if (entry.ok === "pending") {
        setState({
          phase: "problem",
          message: `자막 추출이 아직 진행 중입니다. 현재 단계: ${entry.data.stage}`
        })
        return
      }
      if (entry.ok === false) {
        setState({
          phase: "problem",
          message: `자막 추출에 실패했습니다: ${entry.data.reason}`
        })
        return
      }

      const scanned = scanCaptions(entry.data.segments, {
        productName: entry.data.productName,
        videoTitle: entry.data.videoTitle
      })
      const flaggedLines = scanned.filter((l) => l.status !== "Rule-Negative")

      let merged = scanned
      if (flaggedLines.length > 0) {
        setState({
          phase: "loading",
          message: `정밀 검사를 진행하고 있습니다. ${flaggedLines.length}문장을 확인 중입니다.`
        })
        try {
          const res = await fetch(`${SERVER}/api/classify`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ texts: flaggedLines.map((l) => l.text) })
          })
          if (!res.ok) {
            const body = (await res.json().catch(() => null)) as
              | { error?: string }
              | null
            throw new Error(body?.error ?? `http ${res.status}`)
          }
          const data = (await res.json()) as { results: ClassifyVerdict[] }

          let f = 0
          merged = scanned.map((l) => {
            if (l.status === "Rule-Negative") return l
            const result = attachModelResult(l.result, data.results[f++])
            return { ...l, status: result.finalStatus, result }
          })
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e)
          setState({
            phase: "problem",
            message: `정밀 검사에 실패했습니다: ${reason}`
          })
          return
        }
      }

      const videoRisk = calculateVideoRisk(merged)
      const report = buildFinalReport(merged, videoRisk)
      const flagged = merged.filter((l) => l.status !== "Rule-Negative")
      setState({ phase: "ready", videoId, report, flagged })
    })()
  }, [])

  if (state.phase === "loading") {
    return (
      <Shell>
        <StatusMessage>{state.message}</StatusMessage>
      </Shell>
    )
  }
  if (state.phase === "problem") {
    return (
      <Shell>
        <StatusMessage>{state.message}</StatusMessage>
      </Shell>
    )
  }

  const { videoId, report, flagged } = state
  const vrs = report.videoRiskSummary
  const tone = riskTone(vrs.riskGrade)
  const signalScore = displaySignalScore(vrs.riskScore)
  const signalLevel = displaySignalLevel(vrs.riskScore)
  const cautionExpressionCount = report.sentenceReports.filter(
    isCautionExpression
  ).length

  return (
    <Shell>
      <header style={styles.topbar}>
        <button
          type="button"
          onClick={closeReport}
          style={styles.backButton}
          aria-label="뒤로가기">
          ‹
        </button>
        <h1 style={styles.pageTitle}>광고 표현 분석</h1>
        <span style={styles.countBadge}>
          {report.sentenceReports.length}문장
        </span>
      </header>

      <main style={styles.main}>
        <section
          style={{
            ...styles.alertCard,
            background: "#ffffff",
            borderColor: "#edf0f4"
          }}>
          <div
            style={{
              ...styles.alertIcon,
              background: tone.soft,
              borderColor: tone.border,
              color: tone.accent
            }}>
            주의
          </div>
          <div>
            <h2 style={{ ...styles.alertTitle, color: tone.accentDeep }}>
              {reportHeadline(vrs)}
            </h2>
            <p style={styles.alertCopy}>
              {reportLead(vrs, report.sentenceReports.length)}
            </p>
          </div>
        </section>

        <section style={styles.riskCard}>
          <div style={styles.riskHead}>
            <div style={styles.riskLabel}>주의 신호</div>
            <div style={styles.riskValue}>
              <span style={{ ...styles.percent, color: tone.accent }}>
                {signalScore}
              </span>
              <span
                style={{
                  ...styles.riskPill,
                  color: tone.accent,
                  borderColor: tone.border,
                  background: tone.soft
                }}>
                {signalLevel}
              </span>
            </div>
          </div>
          <div style={styles.barTrack}>
            <div
              style={{
                ...styles.barFill,
                width: `${signalScore}%`,
                background: tone.accent
              }}
            />
          </div>
          <p style={styles.summaryText}>
            높게 나왔다면, 구매 전에 한 번 더 확인해 보세요.
          </p>
          <div style={styles.quickStats}>
            <Stat label="확인 문장" value={`${report.sentenceReports.length}개`} />
            <Stat
              label="정밀 확인"
              value={`${report.modelInspectionSummary.inspectedSentenceCount}개`}
            />
            <Stat label="주의 표현" value={`${cautionExpressionCount}개`} />
          </div>
        </section>

        <SectionTitle>확인된 문장</SectionTitle>
        {report.sentenceReports.length === 0 ? (
          <p style={styles.emptyText}>검토가 필요한 문장이 없습니다.</p>
        ) : (
          report.sentenceReports.map((sr, i) => (
            <SentenceCard
              key={`${sr.sentence}-${i}`}
              videoId={videoId}
              start={flagged[i]?.start ?? 0}
              report={sr}
            />
          ))
        )}

        <SectionTitle>요약</SectionTitle>
        <section style={styles.summaryBox}>
          <p style={styles.summaryBody}>
            검토가 필요한 표현 {report.sentenceReports.length}개를 정리했습니다.
            정밀 검사를 거친 문장은{" "}
            {report.modelInspectionSummary.inspectedSentenceCount}개, 주의 표현으로
            확인된 문장은 {cautionExpressionCount}개입니다.
          </p>
        </section>

        <SectionTitle>구매 전 확인</SectionTitle>
        <Notice>
          질병 치료·완치를 직접 약속하는 광고 표현은 신중히 확인하세요.
        </Notice>
        <Notice>
          후기나 영상 표현보다 제품의 공식 표시 정보를 먼저 확인하세요.
        </Notice>
        <p style={styles.overall}>{report.overallCaution}</p>
      </main>

      <footer style={styles.footer}>
        <button type="button" onClick={closeReport} style={styles.footerButton}>
          돌아가기
        </button>
      </footer>
    </Shell>
  )
}

function SentenceCard({
  videoId,
  start,
  report
}: {
  videoId: string
  start: number
  report: SentenceReport
}) {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const tone = sentenceTone(report)
  const sec = Math.floor(start)
  const ruleReasons = report.detectedReasons.filter((r) => r.source === "rule")
  const triggerReasons = report.detectedReasons.filter(
    (r) => r.source === "trigger"
  )
  const ruleLegalBasis = unique(ruleReasons.flatMap((r) => r.legalBasis))
  const triggerLegalBasis = unique(
    triggerReasons.flatMap((r) => r.relatedLegalBasisCandidates)
  )
  const safeHarborReferences = unique(
    report.detectedReasons.flatMap((r) => r.safeHarborReferences)
  )
  const allTypes = unique(report.detectedReasons.map((r) => r.type))
  const summaryReason = firstNonEmpty([
    ruleReasons[0]?.explanation,
    report.modelInspection?.explanation,
    report.triggerExplanation,
    triggerReasons[0]?.explanation,
    "추가 확인이 필요한 표현입니다."
  ])

  return (
    <article style={{ ...styles.sentenceCard, borderColor: "#edf0f4" }}>
      <div style={styles.cardTopRow}>
        <span
          style={{
            ...styles.sentenceBadge,
            color: tone.accent,
            background: tone.soft,
            borderColor: tone.border
          }}>
          {sentenceResultLabel(report)}
        </span>
        <a
          style={styles.timeLink}
          href={`https://www.youtube.com/watch?v=${videoId}&t=${sec}s`}
          target="_blank"
          rel="noreferrer">
          {formatTime(start)}
        </a>
      </div>

      <p style={styles.quote}>“{report.sentence}”</p>

      <div style={styles.cardSummary}>
        <SummaryItem label="유형">{joinItems(allTypes)}</SummaryItem>
        <SummaryItem label="이유">{summaryReason}</SummaryItem>
      </div>

      <button
        type="button"
        onClick={() => setDetailsOpen((open) => !open)}
        style={{
          ...styles.detailButton,
          color: "#2f3847",
          background: "#f7f8fb",
          borderColor: "#edf0f4"
        }}
        aria-expanded={detailsOpen}>
        {detailsOpen ? "접기" : "근거 자세히 보기"}
      </button>

      {detailsOpen && (
        <div style={styles.detailsPanel}>
          <DetailRow label="근거 문장 전문">{report.sentence}</DetailRow>

          {ruleReasons.length > 0 && (
            <>
              <DetailRow label="감지된 명시적 위법 유형">
                {joinItems(ruleReasons.map((r) => r.type))}
              </DetailRow>
              <DetailRow label="문장 안에서 감지된 표현">
                {joinItems(ruleReasons.map((r) => r.evidenceText))}
              </DetailRow>
              <DetailRow label="위법 가능성이 높다고 본 이유">
                {joinItems(
                  ruleReasons.map((r) => r.explanation),
                  "사전 룰에 의해 주의가 필요한 표현으로 분류되었습니다."
                )}
              </DetailRow>
              <DetailRow label="연결되는 근거 법률">
                <TextList
                  items={ruleLegalBasis}
                  empty="연결된 법률 정보가 없습니다."
                />
              </DetailRow>
            </>
          )}

          {triggerReasons.length > 0 && (
            <>
              <DetailRow label="모델로 보낸 트리거 유형">
                {joinItems(triggerReasons.map((r) => r.type))}
              </DetailRow>
              <DetailRow label="모델 검사가 필요하다고 본 이유">
                {report.triggerExplanation ??
                  joinItems(triggerReasons.map((r) => r.explanation))}
              </DetailRow>
              <DetailRow label="문장 안에서 감지된 표현">
                {joinItems(triggerReasons.map((r) => r.evidenceText))}
              </DetailRow>
              <DetailRow label="관련 법률">
                <TextList
                  items={triggerLegalBasis}
                  empty="연결된 법률 후보 정보가 없습니다."
                />
              </DetailRow>
            </>
          )}

          {report.modelInspection && (
            <>
              <DetailRow label="모델 검사 결과">
                검사 결과는 “{report.modelInspection.resultLabel}”입니다.{" "}
                {report.modelInspection.explanation}
              </DetailRow>
              <DetailRow label="모델 신뢰도">
                {formatConfidence(report.modelInspection.confidence)}
              </DetailRow>
            </>
          )}

          {report.healthFoodExplanation && (
            <DetailRow label="제품 확인 안내">
              {report.healthFoodExplanation}
              {report.healthFoodVerificationUrl && (
                <>
                  {" "}
                  <a
                    style={styles.link}
                    href={report.healthFoodVerificationUrl}
                    target="_blank"
                    rel="noreferrer">
                    제품 정보 확인
                  </a>
                </>
              )}
            </DetailRow>
          )}

          {safeHarborReferences.length > 0 && (
            <DetailRow label="합법 예외 참고">
              <TextList items={safeHarborReferences} />
            </DetailRow>
          )}

          {report.appliedExceptions.length > 0 && (
            <DetailRow label="적용된 예외">
              <TextList
                items={report.appliedExceptions.map(
                  (e) => `${e.exceptionType}: ${e.explanation}`
                )}
              />
            </DetailRow>
          )}
        </div>
      )}
    </article>
  )
}

function SummaryItem({
  label,
  children
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div style={styles.summaryItem}>
      <div style={styles.summaryItemLabel}>{label}</div>
      <div style={styles.summaryItemValue}>{children}</div>
    </div>
  )
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 style={styles.sectionTitle}>{children}</h2>
}

function DetailRow({
  label,
  children
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div style={styles.detailRow}>
      <div style={styles.detailLabel}>{label}</div>
      <div style={styles.detailValue}>{children}</div>
    </div>
  )
}

function TextList({
  items,
  empty = "해당 정보 없음"
}: {
  items: string[]
  empty?: string
}) {
  const values = unique(items)
  if (values.length === 0) return <>{empty}</>
  return (
    <ul style={styles.textList}>
      {values.map((item, i) => (
        <li key={`${item}-${i}`} style={styles.textListItem}>
          {item}
        </li>
      ))}
    </ul>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.stat}>
      <div style={styles.statLabel}>{label}</div>
      <div style={styles.statValue}>{value}</div>
    </div>
  )
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <section style={styles.notice}>
      <div style={styles.noticeIcon}>!</div>
      <p style={styles.noticeText}>{children}</p>
    </section>
  )
}

function StatusMessage({ children }: { children: ReactNode }) {
  return (
    <div style={styles.statusWrap}>
      <p style={styles.statusText}>{children}</p>
    </div>
  )
}

function Shell({ children }: { children: ReactNode }) {
  return <div style={styles.page}>{children}</div>
}

const styles: Record<string, CSSProperties> = {
  page: {
    minHeight: "100vh",
    maxWidth: 520,
    margin: "0 auto",
    background: "#f8fafb",
    color: "#1c2430",
    fontFamily:
      '"Noto Sans KR", "Pretendard Variable", Pretendard, "SUIT", -apple-system, BlinkMacSystemFont, "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif',
    lineHeight: 1.6
  },
  topbar: {
    position: "sticky",
    top: 0,
    zIndex: 10,
    height: 74,
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "15px 20px 10px",
    background: "rgba(248,250,251,0.9)",
    borderBottom: "1px solid rgba(232,235,240,0.72)",
    backdropFilter: "blur(14px)"
  },
  backButton: {
    width: 42,
    height: 42,
    border: "1px solid #e8ebf0",
    borderRadius: 14,
    background: "#ffffff",
    color: "#252b36",
    display: "grid",
    placeItems: "center",
    fontSize: 30,
    lineHeight: 1,
    cursor: "pointer"
  },
  pageTitle: {
    margin: 0,
    fontSize: 21,
    fontWeight: 800,
    letterSpacing: 0
  },
  countBadge: {
    marginLeft: "auto",
    minWidth: 50,
    height: 28,
    padding: "0 10px",
    borderRadius: 999,
    display: "grid",
    placeItems: "center",
    background: "#eff3f7",
    color: "#475161",
    fontSize: 12,
    fontWeight: 700
  },
  main: {
    padding: "16px 18px 104px"
  },
  alertCard: {
    minHeight: 0,
    border: "1px solid",
    borderRadius: 28,
    display: "grid",
    gridTemplateColumns: "auto 1fr",
    gap: 16,
    padding: "24px 20px",
    boxShadow: "0 18px 44px rgba(31,41,55,0.06)"
  },
  alertIcon: {
    width: 48,
    height: 28,
    border: "1px solid",
    borderRadius: 999,
    color: "#fff",
    display: "grid",
    placeItems: "center",
    fontSize: 12,
    fontWeight: 800,
    alignSelf: "start"
  },
  alertTitle: {
    margin: "0 0 8px",
    fontSize: 23,
    lineHeight: 1.3,
    fontWeight: 800,
    letterSpacing: 0,
    wordBreak: "keep-all"
  },
  alertCopy: {
    margin: 0,
    color: "#667085",
    fontSize: 16,
    lineHeight: 1.58,
    wordBreak: "keep-all"
  },
  riskCard: {
    marginTop: 12,
    border: "1px solid #edf0f4",
    borderRadius: 26,
    padding: "20px",
    background: "#fff",
    boxShadow: "0 14px 36px rgba(31,41,55,0.055)"
  },
  riskHead: {
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: 16
  },
  riskLabel: {
    color: "#667085",
    fontSize: 16,
    fontWeight: 700
  },
  riskValue: {
    display: "flex",
    alignItems: "center",
    gap: 6
  },
  percent: {
    fontSize: 44,
    lineHeight: 0.95,
    fontWeight: 800,
    letterSpacing: 0
  },
  percentUnit: {
    marginLeft: -2,
    color: "#8a93a3",
    fontSize: 15,
    fontWeight: 700
  },
  riskPill: {
    marginLeft: 6,
    padding: "7px 12px",
    borderRadius: 999,
    border: "1px solid",
    fontSize: 14,
    fontWeight: 700
  },
  barTrack: {
    height: 10,
    marginTop: 16,
    borderRadius: 999,
    background: "#e7ebf0",
    overflow: "hidden"
  },
  barFill: {
    height: "100%",
    borderRadius: 999,
    background: "#d92f40"
  },
  summaryText: {
    margin: "16px 0 0",
    color: "#5e6979",
    fontSize: 15,
    lineHeight: 1.6,
    wordBreak: "keep-all"
  },
  quickStats: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: 8,
    marginTop: 14
  },
  stat: {
    minWidth: 0,
    borderRadius: 16,
    background: "#f8fafc",
    border: "1px solid #eef1f5",
    padding: "11px 10px"
  },
  statLabel: {
    color: "#68707f",
    fontSize: 12,
    fontWeight: 700
  },
  statValue: {
    marginTop: 2,
    color: "#191d26",
    fontSize: 16,
    fontWeight: 800
  },
  sectionTitle: {
    margin: "26px 0 12px",
    fontSize: 19,
    lineHeight: 1.25,
    fontWeight: 800,
    letterSpacing: 0
  },
  sentenceCard: {
    border: "1px solid",
    borderRadius: 24,
    padding: "19px",
    background: "#fff",
    boxShadow: "0 16px 42px rgba(31,41,55,0.055)",
    marginBottom: 14
  },
  cardTopRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap",
    marginBottom: 12
  },
  sentenceBadge: {
    padding: "6px 10px",
    border: "1px solid",
    borderRadius: 999,
    fontSize: 13,
    fontWeight: 700
  },
  timeLink: {
    marginLeft: "auto",
    color: "#68707f",
    fontSize: 14,
    fontWeight: 700,
    textDecoration: "none"
  },
  quote: {
    margin: "0 0 15px",
    color: "#171b24",
    fontSize: 19,
    lineHeight: 1.42,
    fontWeight: 800,
    wordBreak: "keep-all"
  },
  cardSummary: {
    display: "grid",
    gap: 8,
    padding: 0,
    borderTop: "0"
  },
  summaryItem: {
    display: "grid",
    gap: 4,
    alignItems: "start",
    borderRadius: 16,
    background: "#f8fafc",
    border: "1px solid #eef1f5",
    padding: "11px 12px"
  },
  summaryItemLabel: {
    color: "#7a8494",
    fontSize: 12,
    fontWeight: 700,
    lineHeight: 1.45
  },
  summaryItemValue: {
    color: "#313b4b",
    fontSize: 15,
    lineHeight: 1.55,
    wordBreak: "keep-all"
  },
  detailButton: {
    width: "100%",
    height: 44,
    marginTop: 12,
    border: "1px solid",
    borderRadius: 14,
    fontSize: 15,
    fontWeight: 800,
    cursor: "pointer",
    fontFamily: "inherit"
  },
  detailsPanel: {
    marginTop: 14,
    paddingTop: 2,
    borderTop: "1px solid #eef0f3"
  },
  detailRow: {
    padding: "14px 0",
    borderTop: "1px solid #eef0f3"
  },
  detailLabel: {
    marginBottom: 6,
    color: "#68707f",
    fontSize: 14,
    fontWeight: 700
  },
  detailValue: {
    color: "#303846",
    fontSize: 15,
    lineHeight: 1.65,
    wordBreak: "keep-all",
    whiteSpace: "pre-wrap"
  },
  textList: {
    margin: 0,
    paddingLeft: 20
  },
  textListItem: {
    marginBottom: 6
  },
  link: {
    color: "#1b65d8",
    fontWeight: 800,
    textDecoration: "none"
  },
  summaryBox: {
    border: "1px solid #e0eaf4",
    borderRadius: 22,
    background: "#f6faff",
    padding: "18px 17px"
  },
  summaryBody: {
    margin: 0,
    color: "#4b5b70",
    fontSize: 15,
    lineHeight: 1.68,
    wordBreak: "keep-all"
  },
  notice: {
    display: "grid",
    gridTemplateColumns: "34px 1fr",
    gap: 12,
    alignItems: "start",
    border: "1px solid #eadbbf",
    borderRadius: 20,
    background: "#fffbf4",
    padding: 16,
    marginBottom: 10
  },
  noticeIcon: {
    width: 28,
    height: 28,
    borderRadius: 999,
    background: "#b66b16",
    color: "#fff",
    display: "grid",
    placeItems: "center",
    fontWeight: 800
  },
  noticeText: {
    margin: 0,
    color: "#845012",
    fontSize: 16,
    lineHeight: 1.48,
    fontWeight: 700,
    wordBreak: "keep-all"
  },
  overall: {
    margin: "20px 0 0",
    color: "#68707f",
    fontSize: 14,
    lineHeight: 1.7,
    wordBreak: "keep-all"
  },
  emptyText: {
    margin: 0,
    color: "#68707f",
    fontSize: 17
  },
  footer: {
    position: "fixed",
    left: "50%",
    bottom: 0,
    width: "min(520px, 100%)",
    transform: "translateX(-50%)",
    padding: "18px 20px 24px",
    background: "linear-gradient(180deg, rgba(248,250,251,0), #f8fafb 30%)"
  },
  footerButton: {
    width: "100%",
    height: 56,
    border: 0,
    borderRadius: 16,
    background: "#222832",
    color: "#fff",
    fontSize: 18,
    fontWeight: 800,
    cursor: "pointer"
  },
  statusWrap: {
    minHeight: "100vh",
    display: "grid",
    placeItems: "center",
    padding: 24
  },
  statusText: {
    margin: 0,
    color: "#273040",
    fontSize: 18,
    fontWeight: 700,
    textAlign: "center",
    wordBreak: "keep-all"
  }
}

export default Report3
