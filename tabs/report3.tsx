// 광고 표현 검토 결과 — 확장 내부 탭 (Plasmo 가 tabs/report3.tsx → tabs/report3.html 로 빌드).
//   호출 흐름: 오버레이 ViolationPanel 의 "보고서 자세히 보기"
//     → background 가 chrome.tabs.create("tabs/report3.html?v=<영상ID>")
//     → 이 페이지가 ?v= 로 영상ID 를 받아 storage 자막을 읽고 룰 스캔(1차) 재실행 →
//       위반·의심 문장을 /api/classify 로 정밀 검사 → 결과를 엔진에 합쳐(attachModelResult) 위험도 재계산 →
//       영상 위험도(calculateVideoRisk) + 보고서 조립(buildFinalReport) → 렌더.
//   왜 report/report2 와 분리: 1차=룰 근거, 2차=모델 동작, 3차=점수·법령·모델 결과를 합친 사용자용 화면.

import { useEffect, useState } from "react"

import { calculateVideoRisk, scanCaptions, type ScannedLine } from "~lib/adScan"
import { attachModelResult } from "~lib/matchingEngine"
import type { ClassifyVerdict } from "~lib/messages"
import {
  buildFinalReport,
  type FinalReport,
  type SentenceReport
} from "~lib/reportBuilder"
import { formatTime, STATUS_VIEW } from "~lib/scanView"
import { getStoredCaption } from "~lib/storage"

// 서버 주소 — report2 와 동일 (확장 페이지는 host_permissions 로 cross-origin 호출 가능)
const SERVER = "http://localhost:3000"

type StoredEntry = Awaited<ReturnType<typeof getStoredCaption>>

// 페이지 단계 — 자막→룰→AI→조립이 비동기라 명시적 전이로 관리
//   ready 에 flagged 를 같이 둠: 보고서 항목(sentenceReports)과 1:1 순서라 타임스탬프 점프 링크에 zip
type ViewState =
  | { phase: "loading"; message: string }
  | { phase: "problem"; message: string }
  | { phase: "ready"; videoId: string; report: FinalReport; flagged: ScannedLine[] }

function getVideoIdFromQuery(): string | null {
  return new URLSearchParams(window.location.search).get("v")
}

// 위험 등급 → 배너 색 (요약 가독성용). 표시 없음/낮음은 차분한 색, 중간/높음은 경고색
function gradeColor(grade: FinalReport["videoRiskSummary"]["riskGrade"]): string {
  if (grade === "높음") return "#e5484d"
  if (grade === "중간") return "#f5a623"
  if (grade === "낮음") return "#b8860b"
  return "#1f7a34"
}

function Report3() {
  const [state, setState] = useState<ViewState>({
    phase: "loading",
    message: "자막을 불러오는 중…"
  })

  // 마운트 시 1회: ?v= → storage → 룰 재스캔 → flagged → /api/classify → 머지 → 영상위험도 → 보고서 조립
  useEffect(() => {
    const videoId = getVideoIdFromQuery()
    if (!videoId) {
      setState({ phase: "problem", message: "영상 ID(?v=)가 없습니다." })
      return
    }

    void (async () => {
      const entry: StoredEntry | null = await getStoredCaption(videoId)
      // 성공 자막이 아니면 분석 입력이 없으므로 사유만 표기 (report2 와 동일한 가드)
      if (!entry) {
        setState({ phase: "problem", message: `영상 ${videoId} 의 저장된 자막이 없습니다.` })
        return
      }
      if (entry.ok === "pending") {
        setState({ phase: "problem", message: `자막 추출이 진행 중입니다 (${entry.data.stage}).` })
        return
      }
      if (entry.ok === false) {
        setState({ phase: "problem", message: `자막 추출 실패: ${entry.data.reason}` })
        return
      }

      // 성공 자막 → 룰 재스캔 → 위반·의심만 추림 (AI 검증 대상)
      const scanned = scanCaptions(entry.data.segments, {
        productName: entry.data.productName,
        videoTitle: entry.data.videoTitle
      })
      const flaggedLines = scanned.filter((l) => l.status !== "Rule-Negative")

      // 위반·의심이 0건이면 classify 생략 → merged=scanned (영상 위험도는 '표시 없음'으로 단락)
      let merged = scanned
      if (flaggedLines.length > 0) {
        setState({ phase: "loading", message: `정밀 검사 중… (${flaggedLines.length}문장)` })
        try {
          const res = await fetch(`${SERVER}/api/classify`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ texts: flaggedLines.map((l) => l.text) })
          })
          if (!res.ok) {
            const body = (await res.json().catch(() => null)) as { error?: string } | null
            throw new Error(body?.error ?? `http ${res.status}`)
          }
          const data = (await res.json()) as { results: ClassifyVerdict[] }
          // flagged 와 results 는 입력 순서가 같아 "flagged 내 인덱스 f"로 zip.
          //   flagged 줄에만 verdict 를 합쳐(attachModelResult) sentenceRisk/userFacingDecision 재계산.
          let f = 0
          merged = scanned.map((l) => {
            if (l.status === "Rule-Negative") return l
            const result = attachModelResult(l.result, data.results[f++])
            // 모델 병합으로 finalStatus 가 바뀔 수 있어(Route→판정) status 도 같이 갱신
            return { ...l, status: result.finalStatus, result }
          })
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e)
          setState({
            phase: "problem",
            message: `정밀 검사 실패: ${reason} (infer 서버 :8000 / Next :3000 켜졌는지 확인)`
          })
          return
        }
      }

      // 영상 위험도는 반드시 merged 전체로 — Route-to-Model 은 병합 후에야 riskScore 가 채워짐
      const videoRisk = calculateVideoRisk(merged)
      const report = buildFinalReport(merged, videoRisk)
      // sentenceReports 와 같은 필터(=위반·의심)로 flagged 를 만들어 인덱스 zip 의 정합 보장
      const flagged = merged.filter((l) => l.status !== "Rule-Negative")
      setState({ phase: "ready", videoId, report, flagged })
    })()
  }, [])

  if (state.phase === "loading") return <Shell>{state.message}</Shell>
  if (state.phase === "problem") return <Shell>{state.message}</Shell>

  const { videoId, report, flagged } = state
  const vrs = report.videoRiskSummary
  const modelSummary = report.modelInspectionSummary

  return (
    <Shell>
      <section style={styles.hero}>
        <h1 style={styles.h1}>광고 표현 검토 결과</h1>
        <p style={styles.meta}>
          영상{" "}
          <a
            style={styles.link}
            href={`https://www.youtube.com/watch?v=${videoId}`}
            target="_blank"
            rel="noreferrer">
            {videoId}
          </a>{" "}
          · 확인 문장 {report.sentenceReports.length}건
        </p>

        {/* 첫 화면 요약 — 사용자가 먼저 봐야 하는 핵심 지표만 숫자 카드로 모은다. */}
        <section style={styles.metricGrid}>
          <Metric
            label="종합 위험도"
            value={`${vrs.riskScore}점`}
            sub={vrs.riskGrade}
            color={gradeColor(vrs.riskGrade)}
          />
          <Metric
            label="확인 문장 수"
            value={`${report.sentenceReports.length}문장`}
            sub="룰·트리거 기준"
          />
          <Metric
            label="정밀 검사 결과"
            value={modelSummary.resultText}
            sub={`${modelSummary.inspectedSentenceCount}문장 검사`}
          />
          <Metric
            label="평균 신뢰도"
            value={modelSummary.averageConfidenceText}
            sub="모델 결과 기준"
          />
        </section>

        {/* 영상 단위 요약 — 계산된 위험도와 주의 문구만 노출 */}
        <section style={{ ...styles.summary, borderLeft: `5px solid ${gradeColor(vrs.riskGrade)}` }}>
          <div style={styles.summaryHead}>
            <span style={{ ...styles.grade, color: gradeColor(vrs.riskGrade) }}>
              {vrs.riskGrade}
            </span>
            <span style={styles.score}>종합 위험도 {vrs.riskScore}점</span>
            <span style={styles.levelText}>{vrs.riskLevelText}</span>
          </div>
          <p style={styles.summaryText}>{vrs.summary}</p>
          <p style={styles.caution}>{vrs.caution}</p>
        </section>
      </section>

      {/* 문장별 근거 — 기본은 닫힌 요약, 사용자가 원할 때만 자세한 근거를 펼친다. */}
      {report.sentenceReports.length === 0 ? (
        <p style={styles.meta}>위반·의심으로 분류된 문장이 없습니다.</p>
      ) : (
        report.sentenceReports.map((sr, i) => (
          <SentenceCard
            key={i}
            videoId={videoId}
            start={flagged[i]?.start ?? 0}
            report={sr}
          />
        ))
      )}

      <p style={styles.overall}>{report.overallCaution}</p>
    </Shell>
  )
}

function Metric({
  label,
  value,
  sub,
  color
}: {
  label: string
  value: string
  sub: string
  color?: string
}) {
  return (
    <div style={styles.metric}>
      <div style={styles.metricLabel}>{label}</div>
      <div style={{ ...styles.metricValue, ...(color ? { color } : {}) }}>{value}</div>
      <div style={styles.metricSub}>{sub}</div>
    </div>
  )
}

function formatList(items: string[], emptyText: string): string {
  return items.length > 0 ? items.join(", ") : emptyText
}

function modelVerdictText(report: SentenceReport): string {
  if (!report.modelInspection) return "검사 결과 없음"
  return report.modelInspection.isViolation ? "위법 의심" : "추가 의심 낮음"
}

// 문장 1개 요약 카드 — 기본은 핵심 판정만 보이고, 상세 근거는 사용자가 펼칠 때만 렌더한다.
function SentenceCard({
  videoId,
  start,
  report
}: {
  videoId: string
  start: number
  report: SentenceReport
}) {
  const [open, setOpen] = useState(false)
  const statusView = STATUS_VIEW[report.finalStatus]
  const sec = Math.floor(start)
  const modelInspection = report.modelInspection

  return (
    <section style={{ ...styles.card, borderLeft: `4px solid ${statusView.color}` }}>
      {/* 헤더: 타임스탬프(영상 점프) + 문장 + 사용자용 판정 */}
      <div style={styles.cardHead}>
        <a
          style={styles.ts}
          href={`https://www.youtube.com/watch?v=${videoId}&t=${sec}s`}
          target="_blank"
          rel="noreferrer">
          {formatTime(start)}
        </a>
        <span style={styles.lineText}>{report.sentence}</span>
      </div>

      {/* 판정 요약: 사용자용 결정 + 문장 위험도 % */}
      <div style={styles.decisionRow}>
        <span style={{ ...styles.decision, color: statusView.color }}>
          {report.userFacingDecision}
        </span>
        <span style={styles.riskPct}>위험도 {report.sentenceRiskPercent}%</span>
        {modelInspection && (
          <span style={styles.statusTag}>
            정밀 검사 {modelInspection.confidencePercent}%
          </span>
        )}
      </div>
      <p style={styles.plainConclusion}>{report.plainConclusion}</p>

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={styles.detailButton}
        aria-expanded={open}>
        {open ? "근거 접기" : "근거 자세히 보기"}
      </button>

      {open && (
        <div style={styles.detail}>
          <DetailRow label="근거 문장">{report.sentence}</DetailRow>
          <DetailRow label="위법 유형">
            {formatList(report.violationTypes, "직접 위반 룰 없음")}
          </DetailRow>
          <DetailRow label="판단 이유">
            <p style={styles.detailText}>{report.riskExplanation}</p>
            {report.detectedReasons.map((reason, i) => (
              <ReasonRow key={i} reason={reason} />
            ))}
          </DetailRow>
          <DetailRow label="관련 법률">
            <LegalList label="직접 근거" items={report.directLegalBasis} />
            <LegalList label="관련 후보" items={report.relatedLegalBasisCandidates} />
            {report.directLegalBasis.length === 0 &&
              report.relatedLegalBasisCandidates.length === 0 && (
                <span style={styles.emptyText}>표시할 법률 근거 없음</span>
              )}
          </DetailRow>
          <DetailRow label="트리거 유형">
            {formatList(report.triggerTypes, "트리거 없음")}
          </DetailRow>
          <DetailRow label="모델 검사 결과">{modelVerdictText(report)}</DetailRow>
          <DetailRow label="모델 신뢰도">
            {modelInspection ? `${modelInspection.confidencePercent}%` : "검사 결과 없음"}
          </DetailRow>

          {report.triggerExplanation && (
            <p style={styles.sub}>{report.triggerExplanation}</p>
          )}
          {report.modelExplanation && (
            <p style={styles.sub}>{report.modelExplanation}</p>
          )}
          {report.healthFoodExplanation && (
            <p style={styles.sub}>
              {report.healthFoodExplanation}
              {report.healthFoodVerificationUrl && (
                <>
                  {" "}
                  <a
                    style={styles.link}
                    href={report.healthFoodVerificationUrl}
                    target="_blank"
                    rel="noreferrer">
                    확인하기
                  </a>
                </>
              )}
            </p>
          )}

          {report.appliedExceptions.length > 0 && (
            <div style={styles.block}>
              <div style={styles.blockTitle}>적용된 예외</div>
              {report.appliedExceptions.map((e, i) => (
                <p key={i} style={styles.sub}>
                  {e.exceptionType}: {e.explanation}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function DetailRow({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div style={styles.detailRow}>
      <div style={styles.detailLabel}>{label}</div>
      <div style={styles.detailValue}>{children}</div>
    </div>
  )
}

// 근거 1개 — 출처(rule/trigger) 배지 + 유형 + 근거 표현 + 설명
function ReasonRow({ reason }: { reason: SentenceReport["detectedReasons"][number] }) {
  const isRule = reason.source === "rule"
  return (
    <div style={styles.reason}>
      <div style={styles.reasonHead}>
        <span
          style={{
            ...styles.srcBadge,
            background: isRule ? "#fde8e8" : "#fff4e0",
            color: isRule ? "#e5484d" : "#b8860b"
          }}>
          {isRule ? "룰(직접)" : "트리거(후보)"}
        </span>
        <span style={styles.reasonType}>{reason.type}</span>
      </div>
      <p style={styles.evidence}>“{reason.evidenceText}”</p>
      {reason.explanation && <p style={styles.reasonExp}>{reason.explanation}</p>}
    </div>
  )
}

// 법령 문구 목록 — 비어있으면 렌더 자체를 생략해 계산되지 않은 정보처럼 보이지 않게 한다.
function LegalList({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null
  return (
    <div style={styles.legalWrap}>
      <span style={styles.legalLabel}>{label}</span>
      <ul style={styles.legalUl}>
        {items.map((t, i) => (
          <li key={i} style={styles.legalLi}>
            {t}
          </li>
        ))}
      </ul>
    </div>
  )
}

// 공통 페이지 골격 — report/report2 와 같은 밝은 톤
function Shell({ children }: { children: React.ReactNode }) {
  return <div style={styles.page}>{children}</div>
}

// 인라인 스타일 — 글이 많아 가독성 우선(밝은 배경/검은 글씨), report2 와 톤 통일
const styles: Record<string, React.CSSProperties> = {
  page: {
    maxWidth: 1040,
    margin: "0 auto",
    padding: "36px 24px 48px",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    color: "#1a1a1a",
    fontSize: 14,
    lineHeight: 1.6,
    background: "#f6f8fb",
    minHeight: "100vh",
    boxSizing: "border-box"
  },
  hero: {
    background: "#fff",
    border: "1px solid #dde3ea",
    borderTop: "6px solid #496f9d",
    borderRadius: 12,
    padding: "24px 26px 6px",
    marginBottom: 20,
    boxShadow: "0 10px 28px rgba(20, 32, 50, 0.08)"
  },
  h1: { fontSize: 28, lineHeight: 1.2, margin: "0 0 8px", letterSpacing: 0 },
  meta: { color: "#555", margin: "0 0 12px" },
  link: { color: "#1a73e8", textDecoration: "none" },
  metricGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
    gap: 10,
    margin: "18px 0"
  },
  metric: {
    background: "#f9fbfd",
    border: "1px solid #e4e9f0",
    borderRadius: 8,
    padding: "12px 14px",
    minHeight: 88
  },
  metricLabel: { fontSize: 12, color: "#666", marginBottom: 6 },
  metricValue: { fontSize: 22, fontWeight: 800, color: "#1f2937", lineHeight: 1.2 },
  metricSub: { fontSize: 12, color: "#777", marginTop: 6 },
  summary: {
    background: "#fff",
    border: "1px solid #e4e9f0",
    borderRadius: 8,
    padding: "16px 18px",
    marginBottom: 18,
    boxShadow: "none"
  },
  summaryHead: { display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" },
  grade: { fontSize: 20, fontWeight: 800 },
  score: { fontSize: 15, fontWeight: 700, color: "#333" },
  levelText: { fontSize: 13, color: "#666" },
  summaryText: { margin: "8px 0 6px", color: "#333" },
  caution: { margin: 0, fontSize: 12, color: "#888" },
  card: {
    background: "#fff",
    border: "1px solid #dde3ea",
    borderRadius: 8,
    padding: "16px 18px",
    marginBottom: 14,
    boxShadow: "0 4px 14px rgba(20, 32, 50, 0.06)"
  },
  cardHead: {
    display: "flex",
    alignItems: "baseline",
    gap: 10,
    marginBottom: 10,
    paddingBottom: 10,
    borderBottom: "1px solid #edf1f5"
  },
  ts: {
    color: "#1a73e8",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 13,
    textDecoration: "none",
    flexShrink: 0
  },
  lineText: { fontWeight: 700, wordBreak: "break-word", lineHeight: 1.5 },
  decisionRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginBottom: 6,
    flexWrap: "wrap"
  },
  decision: { fontWeight: 700, fontSize: 15 },
  riskPct: {
    fontSize: 13,
    fontWeight: 700,
    color: "#333",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
  },
  statusTag: { fontSize: 11, color: "#999" },
  plainConclusion: {
    margin: "4px 0 10px",
    padding: "10px 12px",
    background: "#f8fbff",
    border: "1px solid #d8e4f2",
    borderRadius: 8,
    fontSize: 14,
    color: "#1f2937"
  },
  detailButton: {
    marginTop: 8,
    border: "1px solid #cfd8e3",
    background: "#f9fbfd",
    color: "#1f2937",
    borderRadius: 6,
    padding: "6px 10px",
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer"
  },
  detail: {
    marginTop: 12,
    padding: "12px 14px",
    border: "1px solid #e5eaf0",
    borderRadius: 8,
    background: "#fbfcfe"
  },
  detailRow: {
    display: "grid",
    gridTemplateColumns: "120px minmax(0, 1fr)",
    gap: 12,
    padding: "8px 0",
    borderBottom: "1px solid #edf1f5"
  },
  detailLabel: { fontSize: 12, fontWeight: 800, color: "#555" },
  detailValue: { minWidth: 0, fontSize: 13, color: "#333" },
  detailText: { margin: "0 0 8px", color: "#333" },
  emptyText: { color: "#888" },
  riskExp: { margin: "0 0 10px", fontSize: 13, color: "#555" },
  block: { marginTop: 8, paddingTop: 10, borderTop: "1px dashed #e0e0e0" },
  blockTitle: { fontSize: 12, fontWeight: 700, color: "#444", marginBottom: 8 },
  reason: {
    padding: "7px 0",
    borderTop: "1px dashed #e5e7eb"
  },
  reasonHead: { display: "flex", alignItems: "center", gap: 8, marginBottom: 4 },
  srcBadge: {
    fontSize: 11,
    fontWeight: 700,
    padding: "2px 6px",
    borderRadius: 4
  },
  reasonType: { fontSize: 13, fontWeight: 600, color: "#333" },
  evidence: { margin: "2px 0", fontSize: 13, color: "#1a1a1a" },
  reasonExp: { margin: "2px 0 6px", fontSize: 12, color: "#666" },
  legalWrap: { marginTop: 4 },
  legalLabel: { fontSize: 11, fontWeight: 700, color: "#888" },
  legalUl: { margin: "2px 0 0", paddingLeft: 18 },
  legalLi: { fontSize: 12, color: "#555", marginBottom: 2 },
  sub: { margin: "6px 0 0", fontSize: 13, color: "#555" },
  overall: {
    marginTop: 20,
    paddingTop: 14,
    borderTop: "1px solid #e3e3e3",
    fontSize: 12,
    color: "#888"
  }
}

export default Report3
