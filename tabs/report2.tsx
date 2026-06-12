// 2차 AI 검증 보고서 — 확장 내부 탭 (Plasmo 가 tabs/report2.tsx → tabs/report2.html 로 빌드).
//   호출 흐름: 오버레이 ViolationPanel 의 "📋 2차 AI 보고서 열기"
//     → background 가 chrome.tabs.create("tabs/report2.html?v=<영상ID>")
//     → 이 페이지가 ?v= 로 영상ID 를 받아 storage 자막을 읽고 룰 스캔(1차) 재실행 →
//       위반·의심 문장만 추려 서버 /api/explain 으로 보내 모델 내부 동작(토큰/로짓/확률)을 받아 렌더.
//   왜 1차 보고서(report.tsx)와 분리: 1차는 "룰이 왜 걸렀나", 2차는 "AI 가 그 문장을 어떻게 판정했나"로 관심사가 다르다.

import { useEffect, useState } from "react"

import { scanCaptions, type ScannedLine } from "~lib/adScan"
import type { AiExplainItem } from "~lib/messages"
import { formatTime, STATUS_VIEW } from "~lib/scanView"
import { getStoredCaption } from "~lib/storage"

// 서버 주소 — background 의 STT_SERVER 와 동일 (확장 페이지는 host_permissions 로 cross-origin 호출 가능)
const SERVER = "http://localhost:3000"
// 모델의 비위법 라벨 — 막대 색(안전=초록 / 그 외=빨강) 판단에 사용
const SAFE_LABEL = "안전"

type StoredEntry = Awaited<ReturnType<typeof getStoredCaption>>

// 줄 1개 = 룰 결과(line) + 그 문장의 AI 내부 동작(explain). explain 은 인덱스로 1:1 매핑
type Row = { line: ScannedLine; explain: AiExplainItem | null }

// 페이지 단계 — 데이터 로드(자막→룰→AI)가 비동기라 명시적 전이로 관리
type ViewState =
  | { phase: "loading"; message: string }
  | { phase: "problem"; message: string }
  | { phase: "ready"; videoId: string; rows: Row[] }

// URL ?v= 에서 영상ID — background 가 그 형식으로만 넘긴다
function getVideoIdFromQuery(): string | null {
  return new URLSearchParams(window.location.search).get("v")
}

function Report2() {
  const [state, setState] = useState<ViewState>({
    phase: "loading",
    message: "자막을 불러오는 중…"
  })

  // 마운트 시 1회: ?v= → storage → 룰 재스캔 → flagged → /api/explain → rows
  useEffect(() => {
    const videoId = getVideoIdFromQuery()
    if (!videoId) {
      setState({ phase: "problem", message: "영상 ID(?v=)가 없습니다." })
      return
    }

    // async 작업을 effect 안에서 정의해 실행 (자막 조회 → 룰 → AI 순차)
    void (async () => {
      const entry: StoredEntry | null = await getStoredCaption(videoId)
      // 자막이 성공 저장된 상태가 아니면 분석 입력이 없으므로 사유만 표기 (1차 보고서와 동일한 가드)
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
      const flagged = scanned.filter((l) => l.status !== "Rule-Negative")
      if (flagged.length === 0) {
        setState({ phase: "ready", videoId, rows: [] })
        return
      }

      // 룰에서 걸린 문장들을 서버로 → 모델 내부 동작(토큰/로짓/확률) 수신
      setState({ phase: "loading", message: `AI 검증 중… (${flagged.length}문장)` })
      try {
        const res = await fetch(`${SERVER}/api/explain`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ texts: flagged.map((l) => l.text) })
        })
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null
          throw new Error(body?.error ?? `http ${res.status}`)
        }
        const data = (await res.json()) as { results: AiExplainItem[] }
        // flagged 와 results 는 입력 순서가 같아 인덱스로 zip
        const rows: Row[] = flagged.map((line, i) => ({
          line,
          explain: data.results[i] ?? null
        }))
        setState({ phase: "ready", videoId, rows })
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e)
        setState({ phase: "problem", message: `AI 검증 실패: ${reason} (infer 서버 :8000 / Next :3000 켜졌는지 확인)` })
      }
    })()
  }, [])

  if (state.phase === "loading") return <Shell>{state.message}</Shell>
  if (state.phase === "problem") return <Shell>{state.message}</Shell>

  // ready — 위법 확정/정상 기각 집계
  const { videoId, rows } = state
  const confirmed = rows.filter((r) => r.explain?.isViolation).length

  return (
    <Shell>
      <h1 style={styles.h1}>2차 AI 검증 보고서</h1>
      <p style={styles.meta}>
        영상{" "}
        <a
          style={styles.link}
          href={`https://www.youtube.com/watch?v=${videoId}`}
          target="_blank"
          rel="noreferrer">
          {videoId}
        </a>{" "}
        · 룰 {rows.length} → 위법 확정 {confirmed} · 정상 기각 {rows.length - confirmed}
      </p>
      <p style={styles.note}>
        룰 엔진이 1차로 걸러낸 문장을, 파인튜닝 분류 모델이{" "}
        <b>입력 → 토큰화 → 로짓 → softmax → argmax</b> 순으로 어떻게 판정했는지 보여줍니다.
      </p>

      {rows.length === 0 ? (
        <p style={styles.meta}>룰에서 걸린 위반·의심 문장이 없습니다 ✅</p>
      ) : (
        rows.map((row, i) => <Card key={i} videoId={videoId} row={row} />)
      )}
    </Shell>
  )
}

// 줄 1개 카드 — 위: 자막+1차 룰 / 아래: 2차 AI 동작 과정(토큰→로짓→확률→판정)
function Card({ videoId, row }: { videoId: string; row: Row }) {
  const { line, explain } = row
  const ruleView = STATUS_VIEW[line.status]
  const sec = Math.floor(line.start)
  const confirmed = explain?.isViolation
  // 최종 판정색 — 위법 확정=빨강, 정상 기각=초록 (AI 결과 없으면 회색)
  const finalColor = !explain ? "#888" : confirmed ? "#e5484d" : "#1f7a34"

  return (
    <section style={{ ...styles.card, borderLeft: `4px solid ${finalColor}` }}>
      {/* 헤더: 타임스탬프(영상 점프) + 문장 */}
      <div style={styles.cardHead}>
        <a
          style={styles.ts}
          href={`https://www.youtube.com/watch?v=${videoId}&t=${sec}s`}
          target="_blank"
          rel="noreferrer">
          {formatTime(line.start)}
        </a>
        <span style={styles.lineText}>{line.text}</span>
      </div>

      {/* 1차 룰 — 왜 후보가 됐는지 한 줄 (위반=룰 점수 / 의심=트리거 점수) */}
      <div style={styles.stage}>
        <span style={styles.stageTag}>1차 룰</span>
        <span style={{ color: ruleView.color, fontWeight: 600 }}>
          {ruleView.tag}
        </span>
        <span style={styles.stageNote}>{ruleEvidence(line)}</span>
      </div>

      {line.status === "Route-to-Model" && line.result.triggerAnalysis && (
        <TriggerRouteEvidence analysis={line.result.triggerAnalysis} />
      )}

      {/* 2차 AI — 모델 내부 동작. explain 이 있어야 그릴 수 있음 */}
      {explain ? (
        <div style={styles.aiBox}>
          <div style={styles.aiTitle}>2차 AI — 모델 동작 과정</div>

          {/* ① 토큰화 — 모델이 문장을 어떤 subword 단위로 쪼개 보는지 */}
          <div style={styles.step}>
            <div style={styles.stepLabel}>① 토큰화 (모델이 보는 단위)</div>
            <div style={styles.tokens}>
              {explain.tokens.map((t, i) => (
                <span key={i} style={styles.token}>
                  {t.trim() === "" ? "␣" : t.trim()}
                </span>
              ))}
            </div>
          </div>

          {/* ② 로짓 — softmax 전 원시 점수 (클수록 그 class) */}
          <div style={styles.step}>
            <div style={styles.stepLabel}>② 로짓 (softmax 전 원시 점수)</div>
            <div style={styles.bars}>
              {Object.entries(explain.logits).map(([label, v]) => (
                <ScoreBar
                  key={label}
                  label={label}
                  value={v}
                  text={v.toFixed(2)}
                  ratio={logitRatio(v)}
                  safe={label === SAFE_LABEL}
                />
              ))}
            </div>
          </div>

          {/* ③ softmax 확률 — 로짓을 합=1 확률로. "의심 1.00"이 어디서 왔는지 */}
          <div style={styles.step}>
            <div style={styles.stepLabel}>③ softmax → 확률 (합 = 1)</div>
            <div style={styles.bars}>
              {Object.entries(explain.probs).map(([label, p]) => (
                <ScoreBar
                  key={label}
                  label={label}
                  value={p}
                  text={`${(p * 100).toFixed(1)}%`}
                  ratio={p}
                  safe={label === SAFE_LABEL}
                />
              ))}
            </div>
          </div>

          {/* ④ argmax — 확률 최댓값 class 채택 */}
          <div style={styles.step}>
            <div style={styles.stepLabel}>④ argmax → 판정</div>
            <span style={{ color: finalColor, fontWeight: 700 }}>
              {explain.label} ({explain.score.toFixed(4)})
            </span>
          </div>

          {/* 최종 — isViolation('안전' 아니면 위법) */}
          <div style={styles.final}>
            <span style={{ color: finalColor, fontWeight: 700 }}>
              {confirmed ? "🔴 위법 확정" : "⚪ 정상 기각 (룰은 걸렀으나 AI가 안전 판정)"}
            </span>
          </div>
        </div>
      ) : (
        <p style={styles.stageNote}>AI 결과를 받지 못했습니다.</p>
      )}
    </section>
  )
}

// 트리거는 룰 위반 확정 근거가 아니라 모델 검토로 보내는 라우팅 사유다.
function TriggerRouteEvidence({
  analysis
}: {
  analysis: NonNullable<ScannedLine["result"]["triggerAnalysis"]>
}) {
  return (
    <div style={styles.routeBox}>
      <div style={styles.routeTitle}>모델 검토로 보낸 트리거</div>
      <div style={styles.routeSummary}>
        트리거 합계 {analysis.weightSum}점. 이 근거는 룰 위반 확정이 아니라
        2차 AI 검토 후보로 보낸 이유입니다.
      </div>
      <ul style={styles.routeList}>
        {analysis.hits.map((hit, index) => (
          <li key={`${hit.category}-${index}`} style={styles.routeItem}>
            <b>{hit.categoryName}</b>
            <span>{hit.level}</span>
            <span>매칭: {hit.matchedText}</span>
            {hit.candidateLegalReferences.length > 0 && (
              <span>법률 후보: {hit.candidateLegalReferences.join(", ")}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

// label + 점수 막대 한 줄 — 안전=초록 / 그 외=빨강. ratio(0~1)로 막대 폭 결정
function ScoreBar({
  label,
  text,
  ratio,
  safe
}: {
  label: string
  value: number
  text: string
  ratio: number
  safe: boolean
}) {
  const color = safe ? "#1f7a34" : "#e5484d"
  return (
    <div style={styles.barRow}>
      <span style={styles.barLabel}>{label}</span>
      <div style={styles.barTrack}>
        <div
          style={{
            ...styles.barFill,
            width: `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`,
            background: color
          }}
        />
      </div>
      <span style={styles.barValue}>{text}</span>
    </div>
  )
}

// 1차 룰 근거 한 줄 — 위반은 룰 가중치, 의심은 트리거 가중치 (1차 보고서와 같은 수치)
function ruleEvidence(line: ScannedLine): string {
  const r = line.result
  if (line.status === "Rule-Positive")
    return `룰 ${r.ruleAnalysis?.weightSum ?? "?"}점`
  if (line.status === "Route-to-Model")
    return `트리거 ${r.triggerAnalysis?.weightSum ?? "?"}점`
  return ""
}

// 로짓(음수 가능)을 막대 폭(0~1)으로 — tanh 로 부드럽게 압축해 시각화만 (정확한 값은 옆 숫자로 표기)
function logitRatio(v: number): number {
  return (Math.tanh(v / 4) + 1) / 2
}

// 공통 페이지 골격 — 1차 보고서와 같은 밝은 톤
function Shell({ children }: { children: React.ReactNode }) {
  return <div style={styles.page}>{children}</div>
}

// 인라인 스타일 — 글이 많아 가독성 우선(밝은 배경/검은 글씨), 1차 보고서와 톤 통일
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
  meta: { color: "#555", margin: "0 0 8px" },
  note: { color: "#777", fontSize: 13, margin: "0 0 20px" },
  link: { color: "#1a73e8", textDecoration: "none" },
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
  stage: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 13,
    paddingBottom: 8
  },
  stageTag: {
    background: "#eee",
    color: "#555",
    fontSize: 11,
    fontWeight: 700,
    padding: "2px 6px",
    borderRadius: 4
  },
  stageNote: { color: "#888", fontSize: 12 },
  routeBox: {
    margin: "2px 0 10px",
    padding: "10px 12px",
    border: "1px solid #f1d9b5",
    borderRadius: 8,
    background: "#fffaf2"
  },
  routeTitle: {
    fontSize: 13,
    fontWeight: 700,
    color: "#8a520f",
    marginBottom: 4
  },
  routeSummary: {
    color: "#795b35",
    fontSize: 12,
    marginBottom: 8
  },
  routeList: {
    display: "grid",
    gap: 6,
    margin: 0,
    paddingLeft: 18,
    color: "#4a3a26",
    fontSize: 12
  },
  routeItem: {
    display: "grid",
    gap: 2
  },
  aiBox: {
    marginTop: 4,
    paddingTop: 12,
    borderTop: "1px dashed #e0e0e0"
  },
  aiTitle: { fontSize: 13, fontWeight: 700, color: "#444", marginBottom: 10 },
  step: { marginBottom: 12 },
  stepLabel: { fontSize: 12, fontWeight: 600, color: "#666", marginBottom: 6 },
  tokens: { display: "flex", flexWrap: "wrap", gap: 4 },
  token: {
    background: "#f0f4ff",
    border: "1px solid #d4e0ff",
    borderRadius: 4,
    padding: "2px 6px",
    fontSize: 12,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
  },
  bars: { display: "flex", flexDirection: "column", gap: 6 },
  barRow: { display: "flex", alignItems: "center", gap: 8 },
  barLabel: {
    minWidth: 36,
    fontSize: 12,
    color: "#444",
    flexShrink: 0,
    textAlign: "right"
  },
  barTrack: {
    flex: 1,
    height: 14,
    background: "#f0f0f0",
    borderRadius: 7,
    overflow: "hidden"
  },
  barFill: { height: "100%", borderRadius: 7 },
  barValue: {
    minWidth: 56,
    fontSize: 12,
    color: "#333",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    flexShrink: 0
  },
  final: { marginTop: 6, paddingTop: 8, borderTop: "1px solid #f0f0f0" }
}

export default Report2
