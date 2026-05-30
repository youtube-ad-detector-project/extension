// 상세 위반 보고서 — 확장 내부 탭 페이지 (Plasmo 가 tabs/report.tsx → tabs/report.html 로 빌드).
//   호출 흐름: 오버레이 ViolationPanel 의 "상세 보고서" 링크 클릭
//     → background 가 chrome.tabs.create("tabs/report.html?v=<영상ID>")
//     → 이 페이지가 ?v= 로 영상ID 를 받아 storage 자막을 다시 읽고 룰 스캔을 재실행
//     → 위반·의심 줄마다 "어떤 룰/트리거에 왜 걸렸는지 + 실제 자막" 을 근거로 렌더
//   왜 재스캔: analyzeSentence 가 네트워크/DOM 없는 순수 함수라, 오버레이가 계산한 결과를
//   넘겨받지 않고도 같은 입력(저장된 자막)으로 동일 결과를 이 탭에서 그대로 재현할 수 있다.

import { useEffect, useState } from "react"

import { scanCaptions, type ScannedLine } from "~lib/adScan"
import { getStoredCaption } from "~lib/storage"
import { formatTime, STATUS_VIEW } from "~lib/scanView"

// storage entry 모양 — lib/storage.ts 의 StoredEntry 가 export 안 되어 있어 재선언
//   (오버레이도 같은 이유로 동일하게 재선언함 — 두 곳의 모양이 어긋나면 안 됨)
type StoredEntry = Awaited<ReturnType<typeof getStoredCaption>>

// 보고서 화면의 단계 — 데이터 로드 비동기라 "로딩 → (성공/문제)" 전이를 명시적으로 들고 간다
//   ready: 스캔까지 끝나 flagged 줄이 확정된 상태 / problem: 자막 자체가 없거나 진행중·실패
type ViewState =
  | { phase: "loading" }
  | { phase: "ready"; videoId: string; flagged: ScannedLine[] }
  | { phase: "problem"; message: string }

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
      const scanned = scanCaptions(entry.data.segments)
      // 정상(Rule-Negative) 제외 — 보고서는 위반·의심 줄의 "근거"만 다룬다
      const flagged = scanned.filter((l) => l.status !== "Rule-Negative")
      setState({ phase: "ready", videoId, flagged })
    })
  }, [])

  if (state.phase === "loading") {
    return <Shell>자막을 불러와 분석 중…</Shell>
  }
  if (state.phase === "problem") {
    return <Shell>{state.message}</Shell>
  }

  // ready — 위반·의심 줄이 0개일 수도 있음(빈 화면이 버그처럼 보이지 않게 명시)
  const { videoId, flagged } = state
  const positive = flagged.filter((l) => l.status === "Rule-Positive").length
  const route = flagged.filter((l) => l.status === "Route-to-Model").length

  return (
    <Shell>
      <h1 style={styles.h1}>상세 위반 보고서</h1>
      <p style={styles.meta}>
        영상{" "}
        {/* 원본으로 바로 이동 — 보고서에서 실제 영상을 대조 확인할 수 있게 */}
        <a
          style={styles.link}
          href={`https://www.youtube.com/watch?v=${videoId}`}
          target="_blank"
          rel="noreferrer">
          {videoId}
        </a>{" "}
        · 위반 {positive} · 의심 {route}
      </p>

      {/* AI 학습 JSON 복사 액션은 영상 오버레이의 ViolationPanel(⚠) 로 이동됨 —
            영상 보면서 바로 노션에 붙여넣을 수 있게 하기 위함이라, 여기 보고서 화면엔 더 이상 두지 않는다 */}

      {flagged.length === 0 ? (
        <p style={styles.meta}>위반·의심 신호가 발견되지 않았습니다 ✅</p>
      ) : (
        // 줄 N개 → 카드 N개. 줄마다 "자막 + 걸린 근거" 를 한 블록으로 묶어 대조가 쉽게
        flagged.map((line, i) => (
          <LineCard key={i} videoId={videoId} line={line} />
        ))
      )}
    </Shell>
  )
}

// 줄 1개 카드 — 위쪽: 어떤 자막이(타임스탬프+텍스트), 아래쪽: 왜 걸렸는지(룰/트리거 근거)
//   무엇이 들어가 → 처리 → 무엇이 반환: ScannedLine(상태+result) → 근거 표가 붙은 카드 JSX
function LineCard({
  videoId,
  line
}: {
  videoId: string
  line: ScannedLine
}) {
  const view = STATUS_VIEW[line.status]
  const r = line.result
  const sec = Math.floor(line.start)

  return (
    <section style={{ ...styles.card, borderLeft: `4px solid ${view.color}` }}>
      <div style={styles.cardHead}>
        <span style={{ ...styles.tag, background: view.color }}>
          {view.tag}
        </span>
        {/* 타임스탬프를 영상의 해당 시점으로 점프하는 링크로 — "실제 위반 자막" 근거를 즉시 확인 */}
        <a
          style={styles.ts}
          href={`https://www.youtube.com/watch?v=${videoId}&t=${sec}s`}
          target="_blank"
          rel="noreferrer">
          {formatTime(line.start)}
        </a>
        <span style={styles.lineText}>{line.text}</span>
      </div>

      {/* 위반 줄: 룰 근거 — 어떤 룰이 몇 점으로 합산돼 8점 임계를 넘겼는지 */}
      {line.status === "Rule-Positive" && r.ruleAnalysis && (
        <div style={styles.evidence}>
          <div style={styles.evidenceTitle}>
            룰 근거 — 가중치 합계 {r.ruleAnalysis.weightSum}점 (위반 확정 임계 ≥ 8)
          </div>
          <EvidenceTable
            cols={["대분류", "세부 룰", "매칭된 표현", "가중치"]}
            rows={r.ruleAnalysis.hits.map((h) => [
              h.mainCategory,
              h.subCategory,
              h.matchedText,
              String(h.weight)
            ])}
          />
          {/* 예외로 해제된 룰이 있으면 "왜 점수가 깎였는지" 도 근거의 일부라 같이 표기 */}
          {r.ruleAnalysis.exceptionsHit.length > 0 && (
            <p style={styles.note}>
              예외 적용으로 룰 {r.ruleAnalysis.removedByException}건 해제됨 (
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
            트리거 근거 — 가중치 합계 {r.triggerAnalysis.weightSum}점 (의심 임계 ≥
            1.5)
          </div>
          <EvidenceTable
            cols={["카테고리", "강도", "매칭된 표현", "가중치"]}
            rows={r.triggerAnalysis.hits.map((h) => [
              h.categoryName,
              h.level,
              h.matchedText,
              String(h.weight)
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
    </section>
  )
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
  h1: { fontSize: 22, margin: "0 0 4px" },
  meta: { color: "#555", margin: "0 0 20px" },
  link: { color: "#1a73e8", textDecoration: "none" },
  card: {
    background: "#fff",
    border: "1px solid #e3e3e3",
    borderRadius: 8,
    padding: "14px 16px",
    marginBottom: 14,
    boxShadow: "0 1px 3px rgba(0,0,0,0.06)"
  },
  cardHead: { display: "flex", alignItems: "baseline", gap: 10 },
  tag: {
    color: "#fff",
    fontSize: 12,
    fontWeight: 700,
    padding: "2px 8px",
    borderRadius: 4,
    flexShrink: 0
  },
  ts: {
    color: "#1a73e8",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 13,
    textDecoration: "none",
    flexShrink: 0
  },
  lineText: { fontWeight: 600 },
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
    verticalAlign: "top"
  },
  note: { marginTop: 10, color: "#8a6d00", fontSize: 13 }
}

export default Report
