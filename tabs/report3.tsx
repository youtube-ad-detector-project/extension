// 최종 종합 보고서 — 확장 내부 탭 (Plasmo 가 tabs/report3.tsx → tabs/report3.html 로 빌드).
//   호출 흐름: 오버레이 ViolationPanel 의 "🧾 최종 종합 보고서 열기"
//     → background 가 chrome.tabs.create("tabs/report3.html?v=<영상ID>")
//     → 이 페이지가 ?v= 로 영상ID 를 받아 storage 자막을 읽고 룰 스캔(1차) 재실행 →
//       위반·의심 문장을 /api/classify 로 AI 검증 → 결과를 엔진에 합쳐(attachModelResult) 위험도 재계산 →
//       영상 위험도(calculateVideoRisk) + 보고서 조립(buildFinalReport) → 렌더.
//   왜 report/report2 와 분리: 1차=룰 근거, 2차=AI 동작, 3차=점수·법령·AI를 합친 "사용자용 종합 결론".

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
        setState({ phase: "loading", message: `AI 검증 중… (${flaggedLines.length}문장)` })
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
            message: `AI 검증 실패: ${reason} (infer 서버 :8000 / Next :3000 켜졌는지 확인)`
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

  return (
    <Shell>
      <h1 style={styles.h1}>최종 종합 보고서</h1>
      <p style={styles.meta}>
        영상{" "}
        <a
          style={styles.link}
          href={`https://www.youtube.com/watch?v=${videoId}`}
          target="_blank"
          rel="noreferrer">
          {videoId}
        </a>{" "}
        · 위반·의심 문장 {report.sentenceReports.length}건
      </p>

      {/* 영상 단위 요약 — 점수/등급/설명 + 주의 문구 */}
      <section style={{ ...styles.summary, borderLeft: `5px solid ${gradeColor(vrs.riskGrade)}` }}>
        <div style={styles.summaryHead}>
          <span style={{ ...styles.grade, color: gradeColor(vrs.riskGrade) }}>
            {vrs.riskGrade}
          </span>
          <span style={styles.score}>자동 탐지 위험도 {vrs.riskScore}점</span>
          <span style={styles.levelText}>{vrs.riskLevelText}</span>
        </div>
        <p style={styles.summaryText}>{vrs.summary}</p>
        <p style={styles.caution}>⚠ {vrs.caution}</p>
      </section>

      {/* 문장별 보고서 — sentenceReports 와 flagged 는 같은 순서라 i 로 타임스탬프 매핑 */}
      {report.sentenceReports.length === 0 ? (
        <p style={styles.meta}>위반·의심으로 분류된 문장이 없습니다 ✅</p>
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

// 문장 1개 보고서 카드 — 판정/위험도 → 근거(법령) → 트리거/모델/건기식/예외 순으로 쌓는다
function SentenceCard({
  videoId,
  start,
  report
}: {
  videoId: string
  start: number
  report: SentenceReport
}) {
  const statusView = STATUS_VIEW[report.finalStatus]
  const sec = Math.floor(start)

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
        <span style={styles.statusTag}>{report.finalStatus}</span>
      </div>
      <p style={styles.riskExp}>{report.riskExplanation}</p>

      {/* 탐지 근거 — rule(직접)·trigger(후보) 항목별 */}
      {report.detectedReasons.length > 0 && (
        <div style={styles.block}>
          <div style={styles.blockTitle}>탐지 근거</div>
          {report.detectedReasons.map((r, i) => (
            <ReasonRow key={i} reason={r} />
          ))}
        </div>
      )}

      {/* 트리거/모델/건기식 설명 — 있을 때만 */}
      {report.triggerExplanation && (
        <p style={styles.sub}>🔸 {report.triggerExplanation}</p>
      )}
      {report.modelExplanation && (
        <p style={styles.sub}>🤖 {report.modelExplanation}</p>
      )}
      {report.healthFoodExplanation && (
        <p style={styles.sub}>
          💊 {report.healthFoodExplanation}
          {report.healthFoodVerificationUrl && (
            <>
              {" "}
              <a
                style={styles.link}
                href={report.healthFoodVerificationUrl}
                target="_blank"
                rel="noreferrer">
                확인하기 ↗
              </a>
            </>
          )}
        </p>
      )}

      {/* 예외 적용 — 위반 점수에서 제외된 사유 */}
      {report.appliedExceptions.length > 0 && (
        <div style={styles.block}>
          <div style={styles.blockTitle}>적용된 예외</div>
          {report.appliedExceptions.map((e, i) => (
            <p key={i} style={styles.sub}>
              ✔ {e.exceptionType} — {e.explanation}
            </p>
          ))}
        </div>
      )}
    </section>
  )
}

// 근거 1개 — 출처(rule/trigger) 배지 + 유형 + 근거 표현 + 설명 + 법령 목록 3종
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
      <LegalList label="근거 법령" items={reason.legalBasis} />
      <LegalList label="관련 법령 후보" items={reason.relatedLegalBasisCandidates} />
      <LegalList label="합법 예외 참고" items={reason.safeHarborReferences} />
    </div>
  )
}

// 법령 문구 목록 — 비어있으면 렌더 자체를 생략 (빈 칸 노이즈 방지)
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
    maxWidth: 880,
    margin: "0 auto",
    padding: "32px 24px",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    color: "#1a1a1a",
    fontSize: 14,
    lineHeight: 1.6
  },
  h1: { fontSize: 22, margin: "0 0 4px" },
  meta: { color: "#555", margin: "0 0 12px" },
  link: { color: "#1a73e8", textDecoration: "none" },
  summary: {
    background: "#fff",
    border: "1px solid #e3e3e3",
    borderRadius: 8,
    padding: "16px 18px",
    marginBottom: 20,
    boxShadow: "0 1px 3px rgba(0,0,0,0.06)"
  },
  summaryHead: { display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" },
  grade: { fontSize: 20, fontWeight: 800 },
  score: { fontSize: 15, fontWeight: 700, color: "#333" },
  levelText: { fontSize: 13, color: "#666" },
  summaryText: { margin: "8px 0 6px", color: "#333" },
  caution: { margin: 0, fontSize: 12, color: "#888" },
  card: {
    background: "#fff",
    border: "1px solid #e3e3e3",
    borderRadius: 8,
    padding: "14px 16px",
    marginBottom: 14,
    boxShadow: "0 1px 3px rgba(0,0,0,0.06)"
  },
  cardHead: { display: "flex", alignItems: "baseline", gap: 10, marginBottom: 8 },
  ts: {
    color: "#1a73e8",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 13,
    textDecoration: "none",
    flexShrink: 0
  },
  lineText: { fontWeight: 600 },
  decisionRow: { display: "flex", alignItems: "center", gap: 10, marginBottom: 4 },
  decision: { fontWeight: 700, fontSize: 15 },
  riskPct: {
    fontSize: 13,
    fontWeight: 700,
    color: "#333",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
  },
  statusTag: { fontSize: 11, color: "#999" },
  riskExp: { margin: "0 0 10px", fontSize: 13, color: "#555" },
  block: { marginTop: 8, paddingTop: 10, borderTop: "1px dashed #e0e0e0" },
  blockTitle: { fontSize: 12, fontWeight: 700, color: "#444", marginBottom: 8 },
  reason: {
    background: "#fafafa",
    border: "1px solid #eee",
    borderRadius: 6,
    padding: "8px 10px",
    marginBottom: 8
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
