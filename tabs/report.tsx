// 1차 룰 검토 보고서.
//   호출 흐름: report3 의 "룰 검토 보고서" 또는 background OPEN_REPORT(kind:"rule")
//     -> tabs/report.html?v=<videoId>
//     -> storage 에 저장된 STT 자막을 다시 읽고 scanCaptions 로 룰/트리거만 재검토
//     -> 어떤 사전 기준과 법률 근거/후보에 걸렸는지만 표시한다.
//
//   주의: 이 화면은 1차 룰 단독 보고서다.
//   사용자용 종합 판단, 모델 판정, 신뢰도, 종합 위험도는 report3/report2 의 책임이다.

import { useEffect, useState, type ReactNode } from "react"

import { scanCaptions, type ScannedLine } from "~lib/adScan"
import { formatTime } from "~lib/scanView"
import { getStoredCaption } from "~lib/storage"

type StoredEntry = Awaited<ReturnType<typeof getStoredCaption>>

type ViewState =
  | { phase: "loading"; message: string }
  | { phase: "problem"; message: string }
  | {
      phase: "ready"
      videoId: string
      scanned: ScannedLine[]
      ruleLines: ScannedLine[]
    }

type RuleHit = NonNullable<
  ScannedLine["result"]["ruleAnalysis"]
>["hits"][number]
type ExceptionHit = NonNullable<
  ScannedLine["result"]["ruleAnalysis"]
>["exceptionsHit"][number]

function getVideoIdFromQuery(): string | null {
  return new URLSearchParams(window.location.search).get("v")
}

function Report() {
  const [state, setState] = useState<ViewState>({
    phase: "loading",
    message: "룰 검토 보고서를 준비하고 있습니다."
  })

  useEffect(() => {
    const videoId = getVideoIdFromQuery()
    if (!videoId) {
      setState({ phase: "problem", message: "영상 ID가 없어 보고서를 열 수 없습니다." })
      return
    }

    void getStoredCaption(videoId).then((entry: StoredEntry | null) => {
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
      const ruleLines = scanned.filter((line) => line.status === "Rule-Positive")
      setState({ phase: "ready", videoId, scanned, ruleLines })
    })
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

  const { videoId, scanned, ruleLines } = state
  const triggerCandidateCount = scanned.filter(
    (line) => line.status === "Route-to-Model"
  ).length

  return (
    <Shell>
      <header style={styles.header}>
        <div>
          <p style={styles.eyebrow}>1차 검토</p>
          <h1 style={styles.title}>룰 검토 보고서</h1>
          <p style={styles.lead}>
            저장된 자막을 사전 기준으로 다시 검사해, 룰에 직접 걸린
            문장과 근거만 정리합니다.
          </p>
        </div>
        <a
          style={styles.videoLink}
          href={`https://www.youtube.com/watch?v=${videoId}`}
          target="_blank"
          rel="noreferrer">
          영상 {videoId}
        </a>
      </header>

      <section style={styles.stats}>
        <Stat label="전체 자막" value={`${scanned.length}문장`} />
        <Stat label="룰 위반" value={`${ruleLines.length}문장`} tone="#d92f40" />
        <Stat
          label="AI 검토 후보"
          value={`${triggerCandidateCount}문장`}
          tone="#b66b16"
        />
        <Stat
          label="정상 제외"
          value={`${scanned.length - ruleLines.length - triggerCandidateCount}문장`}
        />
      </section>

      <section style={styles.notice}>
        <strong>이 화면은 룰 단독 보고서입니다.</strong>
        <span>
          모델 판정, 신뢰도, 사용자용 종합 결론은 포함하지 않습니다. 트리거로
          잡힌 후보 문장은 2차 AI 정밀 검토 보고서에서 확인합니다.
        </span>
      </section>

      <section style={styles.section}>
        <div style={styles.sectionHead}>
          <h2 style={styles.sectionTitle}>근거 문장</h2>
          <span style={styles.sectionCount}>{ruleLines.length}건</span>
        </div>

        {ruleLines.length === 0 ? (
          <p style={styles.empty}>룰 위반으로 확정된 문장이 없습니다.</p>
        ) : (
          ruleLines.map((line, index) => (
            <LineCard
              key={`${line.start}-${index}`}
              index={index + 1}
              videoId={videoId}
              line={line}
            />
          ))
        )}
      </section>
    </Shell>
  )
}

function LineCard({
  index,
  videoId,
  line
}: {
  index: number
  videoId: string
  line: ScannedLine
}) {
  const [open, setOpen] = useState(false)
  const meta = statusMeta(line)
  const sec = Math.floor(line.start)

  return (
    <article style={{ ...styles.card, borderLeftColor: meta.color }}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        style={styles.cardToggle}
        aria-expanded={open}>
        <span style={styles.index}>{index}</span>
        <span style={{ ...styles.badge, background: meta.color }}>{meta.label}</span>
        <span style={styles.time}>{formatTime(line.start)}</span>
        <span style={styles.sentence}>{line.text}</span>
        <span style={styles.toggleText}>{open ? "접기" : "근거 보기"}</span>
      </button>

      {open && (
        <div style={styles.cardBody}>
          <p style={styles.sourceLine}>
            원본 영상 대조:{" "}
            <a
              style={styles.link}
              href={`https://www.youtube.com/watch?v=${videoId}&t=${sec}s`}
              target="_blank"
              rel="noreferrer">
              {formatTime(line.start)} 지점 열기
            </a>
          </p>

          {line.status === "Rule-Positive" && line.result.ruleAnalysis && (
            <RuleEvidence
              hits={line.result.ruleAnalysis.hits}
              exceptions={line.result.ruleAnalysis.exceptionsHit}
              removedByException={line.result.ruleAnalysis.removedByException}
              weightSum={line.result.ruleAnalysis.weightSum}
            />
          )}

          {line.result.warningMessage && (
            <p style={styles.warning}>
              {line.result.warningMessage}
              {line.result.verificationUrl && (
                <>
                  {" "}
                  <a
                    style={styles.link}
                    href={line.result.verificationUrl}
                    target="_blank"
                    rel="noreferrer">
                    등록 정보 확인
                  </a>
                </>
              )}
            </p>
          )}
        </div>
      )}
    </article>
  )
}

function RuleEvidence({
  hits,
  exceptions,
  removedByException,
  weightSum
}: {
  hits: RuleHit[]
  exceptions: ExceptionHit[]
  removedByException: number
  weightSum: number
}) {
  return (
    <section style={styles.evidenceBlock}>
      <h3 style={styles.evidenceTitle}>룰 근거</h3>
      <p style={styles.explain}>
        사전 룰 가중치 합계가 {weightSum}점입니다. 현재 기준에서는 8점 이상이면
        룰 위반으로 표시합니다.
      </p>
      <EvidenceTable
        columns={["분류", "세부 기준", "매칭 표현", "가중치", "설명", "법률 근거"]}
        rows={hits.map((hit) => [
          hit.mainCategory,
          hit.subCategory,
          hit.matchedText,
          String(hit.weight),
          hit.rationale || "사전 룰에 등록된 표현과 매칭되었습니다.",
          formatLegalBasis(
            legalReferences(hit),
            hit.safeHarborLegalReferences ?? []
          )
        ])}
      />
      {exceptions.length > 0 && (
        <div style={styles.exceptionBox}>
          <strong>예외 적용</strong>
          <p>
            예외 기준에 의해 {removedByException}건의 룰 가중치가 제외되었습니다.
          </p>
          <ul style={styles.list}>
            {exceptions.map((exception, index) => (
              <li key={`${exception.subCategory}-${index}`}>
                {exception.subCategory}: {exception.matchedText}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

function EvidenceTable({
  columns,
  rows
}: {
  columns: string[]
  rows: string[][]
}) {
  return (
    <div style={styles.tableWrap}>
      <table style={styles.table}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} style={styles.th}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} style={styles.td}>
                  {cell || "정보 없음"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function statusMeta(line: ScannedLine): { label: string; color: string } {
  if (line.status === "Rule-Positive") {
    return { label: "룰 위반", color: "#d92f40" }
  }
  return { label: "정상", color: "#667085" }
}

function legalReferences(hit: RuleHit): string[] {
  const refs = hit.legalReferences?.length
    ? hit.legalReferences
    : hit.legalReference
      ? [hit.legalReference]
      : []
  return refs
}

function formatLegalBasis(
  items: Array<string | null | undefined>,
  safeHarborItems: Array<string | null | undefined> = []
): string {
  const refs = unique(items)
  const safeHarbors = unique(safeHarborItems).map(
    (item) => `[허용 표현 참고] ${item}`
  )
  const all = [...refs, ...safeHarbors]
  return all.length > 0 ? all.join("\n") : "연결된 법률 근거 없음"
}

function unique(items: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(items.map((item) => item?.trim()).filter(Boolean) as string[])
  )
}

function Stat({
  label,
  value,
  tone = "#1f2937"
}: {
  label: string
  value: string
  tone?: string
}) {
  return (
    <div style={styles.stat}>
      <span style={styles.statLabel}>{label}</span>
      <strong style={{ ...styles.statValue, color: tone }}>{value}</strong>
    </div>
  )
}

function StatusMessage({ children }: { children: ReactNode }) {
  return <p style={styles.statusMessage}>{children}</p>
}

function Shell({ children }: { children: ReactNode }) {
  return <main style={styles.page}>{children}</main>
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    maxWidth: 980,
    margin: "0 auto",
    padding: "32px 24px 56px",
    color: "#182230",
    background: "#ffffff",
    fontFamily:
      '"Noto Sans KR", "Pretendard Variable", Pretendard, "SUIT", -apple-system, BlinkMacSystemFont, "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif',
    lineHeight: 1.6
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    gap: 24,
    alignItems: "flex-start",
    borderBottom: "1px solid #e5e7eb",
    paddingBottom: 22,
    marginBottom: 22
  },
  eyebrow: {
    margin: "0 0 6px",
    color: "#b66b16",
    fontSize: 13,
    fontWeight: 800
  },
  title: {
    margin: 0,
    fontSize: 34,
    lineHeight: 1.2,
    letterSpacing: 0
  },
  lead: {
    margin: "10px 0 0",
    color: "#536176",
    fontSize: 15
  },
  videoLink: {
    color: "#2563eb",
    textDecoration: "none",
    fontSize: 13,
    whiteSpace: "nowrap",
    marginTop: 8
  },
  stats: {
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    gap: 12,
    marginBottom: 18
  },
  stat: {
    border: "1px solid #e5e7eb",
    borderRadius: 8,
    padding: "14px 16px",
    background: "#f8fafc"
  },
  statLabel: {
    display: "block",
    color: "#667085",
    fontSize: 13,
    marginBottom: 6
  },
  statValue: {
    fontSize: 22,
    lineHeight: 1.2
  },
  notice: {
    display: "grid",
    gap: 4,
    border: "1px solid #fde68a",
    borderRadius: 8,
    background: "#fffbeb",
    padding: "14px 16px",
    color: "#713f12",
    marginBottom: 28
  },
  section: {
    marginTop: 8
  },
  sectionHead: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    marginBottom: 12
  },
  sectionTitle: {
    margin: 0,
    fontSize: 24,
    lineHeight: 1.3
  },
  sectionCount: {
    color: "#64748b",
    fontWeight: 700
  },
  empty: {
    border: "1px solid #e5e7eb",
    borderRadius: 8,
    padding: 18,
    color: "#536176",
    background: "#f8fafc"
  },
  card: {
    border: "1px solid #e5e7eb",
    borderLeft: "5px solid #667085",
    borderRadius: 8,
    marginBottom: 12,
    background: "#ffffff",
    boxShadow: "0 4px 14px rgba(15, 23, 42, 0.05)",
    overflow: "hidden"
  },
  cardToggle: {
    width: "100%",
    display: "grid",
    gridTemplateColumns: "36px auto auto 1fr auto",
    alignItems: "center",
    gap: 12,
    padding: "16px 18px",
    border: "none",
    background: "#ffffff",
    color: "inherit",
    textAlign: "left",
    cursor: "pointer",
    fontFamily: "inherit"
  },
  index: {
    color: "#667085",
    fontVariantNumeric: "tabular-nums"
  },
  badge: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 68,
    color: "#ffffff",
    borderRadius: 6,
    padding: "4px 8px",
    fontSize: 13,
    fontWeight: 800
  },
  time: {
    color: "#475467",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 13
  },
  sentence: {
    minWidth: 0,
    fontWeight: 700,
    overflowWrap: "anywhere"
  },
  toggleText: {
    color: "#2563eb",
    fontWeight: 800,
    whiteSpace: "nowrap"
  },
  cardBody: {
    borderTop: "1px solid #e5e7eb",
    padding: "18px",
    background: "#fbfcfe"
  },
  sourceLine: {
    margin: "0 0 14px",
    color: "#536176"
  },
  link: {
    color: "#2563eb",
    textDecoration: "none",
    fontWeight: 700
  },
  evidenceBlock: {
    marginTop: 16
  },
  evidenceTitle: {
    margin: "0 0 6px",
    fontSize: 18,
    lineHeight: 1.35
  },
  explain: {
    margin: "0 0 12px",
    color: "#536176"
  },
  tableWrap: {
    overflowX: "auto",
    border: "1px solid #e5e7eb",
    borderRadius: 8,
    background: "#ffffff"
  },
  table: {
    width: "100%",
    minWidth: 820,
    borderCollapse: "collapse",
    fontSize: 13
  },
  th: {
    textAlign: "left",
    background: "#f1f5f9",
    color: "#344054",
    padding: "10px 12px",
    borderBottom: "1px solid #e5e7eb",
    whiteSpace: "nowrap"
  },
  td: {
    verticalAlign: "top",
    padding: "10px 12px",
    borderBottom: "1px solid #eef2f7",
    whiteSpace: "pre-wrap"
  },
  exceptionBox: {
    marginTop: 12,
    border: "1px solid #dbe4ee",
    borderRadius: 8,
    padding: "12px 14px",
    background: "#ffffff",
    color: "#344054"
  },
  list: {
    margin: "8px 0 0",
    paddingLeft: 18
  },
  warning: {
    margin: "16px 0 0",
    padding: "12px 14px",
    border: "1px solid #dbeafe",
    borderRadius: 8,
    background: "#eff6ff",
    color: "#1e3a8a"
  },
  statusMessage: {
    margin: "120px auto",
    maxWidth: 520,
    textAlign: "center",
    color: "#536176",
    fontSize: 16
  }
}

export default Report
