// 유튜브 영상 우측 상단에 떠있는 토글형 오버레이 2종.
//   호출 흐름: Plasmo 가 watch/shorts 페이지에 자동 주입 → getRootContainer 가 #movie_player 찾기
//                → React 마운트 → 부모 Overlay 가 URL 폴링/storage 구독으로 자막 1회 스캔
//                → 자식 패널 둘(자막 / 위반)이 같은 스캔 결과를 나눠 렌더
//   왜 부모-자식 구조: storage 구독·룰 스캔을 패널마다 따로 돌리면 두 번 계산되므로,
//                      부모에서 한 번만 계산해 props 로 내려준다 (두 토글은 각자 open 상태만 가짐)
//   닫힌 상태: 작은 원형 토글 (회색=대기/진행/실패, 색=결과)
//   열린 상태: 헤더 + 리스트 — 자막 패널은 전체 줄, 위반 패널은 위반·의심 줄만

import type { PlasmoCSConfig, PlasmoGetRootContainer } from "plasmo"
import { useEffect, useMemo, useState } from "react"
import {
  scanCaptions,
  summarize,
  type ScanSummary,
  type ScannedLine
} from "~lib/adScan"
import { getVideoIdFromUrl } from "~lib/captions"
import type {
  CaptionsError,
  CaptionsPayload,
  CaptionsPending,
  ClassifyRequestMessage,
  ClassifyResponse,
  ClassifyVerdict,
  OpenReportMessage
} from "~lib/messages"
import { formatTime, STATUS_VIEW } from "~lib/scanView"
import { getStoredCaption } from "~lib/storage"

// YouTube 전 페이지에 주입 — SPA 네비게이션(홈→영상)도 한 번의 주입으로 커버됨
//   영상 페이지가 아니면 컴포넌트가 null 을 반환해 안 보이게 처리
export const config: PlasmoCSConfig = {
  matches: ["https://*.youtube.com/*"]
}

// Plasmo CSUI mount point — body 에 직접 anchor 하면 host element 가 viewport 를 덮어버리는 사례가 있어
//   우리만의 0×0 wrapper div 를 body 에 만들고 그 안에 Plasmo shadow root 가 들어가게 한다
//   이러면 Plasmo 기본 host 스타일이 페이지 레이아웃에 영향 안 줌
const MOUNT_ID = "__yt_cap_overlay_mount__"
export const getRootContainer: PlasmoGetRootContainer = () => {
  let mount = document.getElementById(MOUNT_ID)
  if (!mount) {
    mount = document.createElement("div")
    mount.id = MOUNT_ID
    // 0×0 으로 만들어 페이지 흐름에 영향 주지 않음 — 자식의 position:fixed 는 viewport 기준이라 그대로 동작
    mount.style.cssText =
      "position: fixed; top: 0; left: 0; width: 0; height: 0; pointer-events: none; z-index: 2147483647;"
    document.body.appendChild(mount)
  }
  return mount
}

// storage entry 모양 — lib/storage.ts 의 StoredEntry 와 동일 (export 안 되어있어 재선언)
type StoredEntry =
  | { ok: true; data: CaptionsPayload; savedAt: number }
  | { ok: false; data: CaptionsError; savedAt: number }
  | { ok: "pending"; data: CaptionsPending; savedAt: number }

// AI 2차 검증의 상태 기계 — 룰 결과(scanned)와 background 응답으로 전이한다.
//   idle: 아직 룰 결과 없음(STT 전/진행/실패) · skip: 걸린 줄 0건이라 검증 불필요
//   running: background 로 검증 요청 보냄 · done: verdicts 수신(입력 flagged 와 1:1 순서) · error: 실패
type AiState =
  | { phase: "idle" }
  | { phase: "skip" }
  | { phase: "running"; total: number }
  | { phase: "done"; verdicts: ClassifyVerdict[] }
  | { phase: "error"; reason: string }

const KEY_PREFIX = "caption:"

// 두 패널이 겹치지 않도록 가로 슬롯을 분리 — 자막 패널은 right:12, 위반 패널은 그 왼쪽
//   자막 패널 최대 폭(12 + 340)을 넘어선 지점에 둬야 자막이 열려 있어도 위반 토글이 안 가려진다
const SLOT_SUBTITLE_RIGHT = 12
const SLOT_VIOLATION_RIGHT = 364
// 진행 패널은 위반 패널(364~704) 왼쪽 슬롯 — 세 패널이 동시에 열려도 안 겹치게 다음 칸에 둔다
const SLOT_PROGRESS_RIGHT = 716

// 상태별 짧은 한국어 라벨 — 헤더와 toggle title (hover) 에서 공통 사용
const STAGE_LABEL: Record<CaptionsPending["stage"], string> = {
  queued: "대기 중",
  downloading: "다운로드 중 (yt-dlp)",
  transcribing: "전사 중 (Whisper)"
}

// STATUS_VIEW(상태→색·태그)·formatTime 은 보고서 탭(tabs/report.tsx)과 같은 표기를
//   써야 해 ~lib/scanView 로 옮겨 공유한다 (위 import 참고)

// 콘텐츠 스크립트(오버레이)에서 실행 → YouTube 페이지 F12 콘솔에 찍힘 (adScan 과 같은 창)
const TAG = "[yt-cap:overlay]"
console.log(TAG, "📌 자막 오버레이 로드됨 (URL 폴링 + storage 구독 + 룰 스캔 렌더)")

// 부모 컴포넌트 — 공유 상태(영상ID·storage entry·스캔 결과)를 한 번만 계산해 두 패널에 내려준다.
//   Plasmo 가 이 default export 를 mount 하므로, 여기가 전체 트리의 루트.
function Overlay() {
  // 현재 영상 ID — URL 폴링으로 SPA 네비게이션 추적
  const [videoId, setVideoId] = useState<string | null>(() =>
    getVideoIdFromUrl(window.location.href)
  )
  // chrome.storage.local 의 해당 영상 entry — null = 아직 기록 없음
  const [entry, setEntry] = useState<StoredEntry | null>(null)
  // AI 2차 검증 상태 — 룰 결과가 나오면 effect 가 background 로 검증을 띄워 이 값을 전이시킨다
  const [ai, setAi] = useState<AiState>({ phase: "idle" })

  // YouTube 는 SPA 라 페이지 전환 시 content script 가 재주입되지 않음 → URL 폴링으로 영상 변경 감지
  //   youtube-shorts.ts(STT 트리거)도 같은 1초 폴링 패턴을 쓴다
  useEffect(() => {
    let last = window.location.href
    const id = setInterval(() => {
      if (window.location.href !== last) {
        last = window.location.href
        const next = getVideoIdFromUrl(last)
        // SPA 전환 추적 — 어떤 영상으로 바뀌었는지(또는 영상 아닌 페이지인지) 가시화
        console.log(TAG, `🔁 영상 전환 감지 - 새 영상ID=${next ?? "(영상 아님)"}`)
        setVideoId(next)
      }
    }, 1000)
    return () => clearInterval(id)
  }, [])

  // videoId 가 정해지면: storage 첫 조회 + onChanged 구독으로 실시간 갱신
  //   Plan E pending → done 전이가 화면에 자동 반영되게 하려고 구독 필요
  useEffect(() => {
    if (!videoId) {
      setEntry(null)
      return
    }
    void getStoredCaption(videoId).then((e) => {
      // 첫 조회 — 자막 기록이 이미 있는지/어떤 상태(성공·대기·실패)인지 확인용
      console.log(
        TAG,
        `📨 storage 첫 조회: 영상=${videoId}, 상태=${e ? (e as StoredEntry).ok : "기록없음"}`
      )
      setEntry(e as StoredEntry | null)
    })

    const key = KEY_PREFIX + videoId
    const onChanged = (
      changes: { [k: string]: chrome.storage.StorageChange },
      area: string
    ) => {
      // 다른 영상의 변경은 무시 — 동시에 여러 탭이 추출 중일 수 있음
      if (area === "local" && changes[key]) {
        const next = (changes[key].newValue ?? null) as StoredEntry | null
        // Plan E pending→done 같은 전이가 보이도록 변경 시점마다 상태를 찍는다
        console.log(
          TAG,
          `💾 storage 변경 반영: 영상=${videoId}, 상태=${next ? next.ok : "삭제됨"}`
        )
        setEntry(next)
      }
    }
    chrome.storage.onChanged.addListener(onChanged)
    return () => chrome.storage.onChanged.removeListener(onChanged)
  }, [videoId])

  // 자막이 성공 저장된 경우에만 룰 엔진을 돌린다.
  //   useMemo: 토글 열고닫기 같은 리렌더마다 자막 전체를 재스캔하지 않도록 entry 기준 캐시
  const scanned = useMemo<ScannedLine[] | null>(() => {
    // 성공 자막일 때만 스캔 트리거. 그 외(없음/대기/실패)는 스캔 자체를 건너뜀
    if (entry?.ok !== true) {
      if (entry)
        console.log(TAG, `🟡 스캔 스킵 - entry 상태=${entry.ok} (성공 자막 아님)`)
      return null
    }
    console.log(TAG, "🟢 성공 자막 감지 - 룰 스캔 호출 (adScan.scanCaptions)")
    return scanCaptions(entry.data.segments, {
      productName: entry.data.productName,
      videoTitle: entry.data.videoTitle
    })
  }, [entry])
  const summary: ScanSummary | null = scanned ? summarize(scanned) : null

  // 룰에서 걸린 줄(위반·의심)만 추림 — AI 검증의 입력이자, done 응답을 인덱스로 되돌려 매핑할 기준
  //   useMemo: scanned 가 그대로면 같은 배열을 유지해 effect 가 불필요하게 재실행되지 않게
  const flagged = useMemo<ScannedLine[]>(
    () => (scanned ? scanned.filter((l) => l.status !== "Rule-Negative") : []),
    [scanned]
  )

  // 룰 결과가 확정되면 flagged 문장을 background(CLASSIFY)로 보내 AI 2차 검증을 돌린다.
  //   왜 effect: 룰 스캔(동기) 이후의 비동기 네트워크 작업이라 렌더 바깥에서 부수효과로 처리해야 함
  //   데이터 형태: ScannedLine[] → texts(string[]) → (background→서버→HF) → ClassifyVerdict[]
  useEffect(() => {
    // 아직 룰 결과 없음(STT 전/진행/실패) → 검증 대기로 리셋
    if (!scanned) {
      setAi({ phase: "idle" })
      return
    }
    // 걸린 줄이 없으면 검증할 게 없음 → 건너뜀
    if (flagged.length === 0) {
      setAi({ phase: "skip" })
      return
    }

    // 검증 시작 — 텍스트만 배열로 추려 background 에 요청
    setAi({ phase: "running", total: flagged.length })
    const msg: ClassifyRequestMessage = {
      type: "CLASSIFY",
      texts: flagged.map((l) => l.text)
    }
    // cancelled: 영상 전환 등으로 scanned 가 바뀌면 이전 요청의 응답은 stale 이라 버린다
    let cancelled = false
    void chrome.runtime
      .sendMessage(msg)
      .then((res: ClassifyResponse | undefined) => {
        if (cancelled) return
        // 성공(ok:true)일 때만 verdicts 채택 — else 는 실패/응답없음을 reason 으로 표기
        if (res && res.ok) {
          setAi({ phase: "done", verdicts: res.verdicts })
          return
        }
        const reason = res && res.ok === false ? res.reason : "unknown"
        setAi({ phase: "error", reason })
      })
      .catch((e) => {
        if (!cancelled) setAi({ phase: "error", reason: String(e) })
      })
    return () => {
      cancelled = true
    }
  }, [scanned, flagged])

  // 영상 페이지가 아니거나 player 가 없으면 오버레이를 안 그림 (홈/채널로 SPA 이동했을 때)
  //   주의: 모든 훅(useMemo/useEffect) 뒤에 둬야 훅 순서가 안정적 (early return 이 훅보다 앞서면 안 됨)
  if (!videoId) return null

  // 세 패널을 형제로 렌더 — 각자 open 상태를 따로 들고, 위치 슬롯이 달라 동시에 떠도 안 겹침
  return (
    <>
      {/* videoId 는 위 `if (!videoId) return null` 가드를 지나 string 으로 좁혀짐 → ViolationPanel 의 보고서 URL 키 */}
      <SubtitlePanel
        entry={entry}
        scanned={scanned}
        summary={summary}
      />
      {/* 위법 패널: 표시는 룰이 아니라 AI 검증(ai) 기준. 사용자 진입점은 최종 보고서 하나만 노출 */}
      <ViolationPanel
        flagged={flagged}
        ai={ai}
        summary={summary}
        videoId={videoId}
      />
      {/* 진행 패널: 영상추출 → 룰엔진 → AI검증 3단계를 실시간으로 보여줌 */}
      <ProgressPanel
        entry={entry}
        scanned={scanned}
        summary={summary}
        ai={ai}
      />
    </>
  )
}

// summary → 토글/헤더 점 색. 위반(빨강) > 의심(주황) > 정상(초록), 스캔 전이면 회색
//   두 패널이 같은 규칙을 쓰므로 헬퍼로 분리 (중복 제거)
function statusDot(summary: ScanSummary | null): string {
  if (!summary) return "#888"
  if (summary.positive > 0) return "#e5484d"
  if (summary.route > 0) return "#f5a623"
  return "#1f7a34"
}

// 최종 보고서 진입 링크 — 클릭 시 background 가 report3.html(점수·법령·모델 결과를 합친 화면) 탭을 연다.
//   무엇이 들어가 → 처리 → 무엇이 반환: videoId+summary → 위반·의심이 있을 때 최종 보고서 버튼.
function FinalReportLink({
  videoId,
  summary
}: {
  videoId: string
  summary: ScanSummary | null
}) {
  if (!summary || (summary.positive === 0 && summary.route === 0)) return null

  const open = () => {
    // kind:"final" → background 가 report3.html 로 분기해 연다
    const msg: OpenReportMessage = { type: "OPEN_REPORT", videoId, kind: "final" }
    void chrome.runtime.sendMessage(msg)
  }

  return (
    <button
      onClick={open}
      style={styles.reportLink}
      title="주의 신호와 문장별 근거를 자세히 보기">
      보고서 자세히 보기
    </button>
  )
}

// ── 자막 패널: 전체 자막 줄을 상태색으로 렌더 (기존 동작 그대로, 위치도 right:12 유지) ──
//   props 로 부모가 계산한 entry/scanned/summary 를 받는다 (자체 storage 구독 없음)
function SubtitlePanel({
  entry,
  scanned,
  summary
}: {
  entry: StoredEntry | null
  scanned: ScannedLine[] | null
  summary: ScanSummary | null
}) {
  // 토글 열림 여부 — 닫힌 상태가 기본 (영상 가리지 않게)
  const [open, setOpen] = useState(false)
  const dotColor = statusDot(summary)

  // 닫힌 상태: 작은 동그란 토글 버튼
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{
          ...styles.toggleClosed,
          right: SLOT_SUBTITLE_RIGHT,
          background: dotColor
        }}
        title={describeState(entry, summary)}>
        CC
      </button>
    )
  }

  // 열린 상태: 헤더 + 전체 segments 리스트.
  //   사용자용 보고서 진입은 ViolationPanel(⚠) 한 곳으로 일원화했으므로 여기엔 액션을 두지 않는다.
  return (
    <div style={{ ...styles.panel, right: SLOT_SUBTITLE_RIGHT }}>
      <div style={styles.panelHeader}>
        <span style={{ ...styles.dot, background: dotColor }} />
        <span style={styles.headerLabel}>{describeState(entry, summary)}</span>
        <button
          onClick={() => setOpen(false)}
          style={styles.closeBtn}
          title="닫기">
          ×
        </button>
      </div>
      <div style={styles.panelBody}>{renderBody(entry, scanned)}</div>
    </div>
  )
}

// ── 위법 패널: 이제 "AI 검증을 통과한" 위법 줄만 보여주는 독립 토글 (자막 패널 왼쪽 슬롯) ──
//   왜 바뀌었나: 룰 엔진만으로는 위법 UI 를 띄우지 않고, AI(ai)까지 위법으로 확정한 줄만 표시한다.
//   flagged: 룰이 거른 위반·의심 줄(검증 입력) / ai: 검증 결과 / summary·scanned: 1차(룰) 기준 도구(보고서·JSON)에만 사용
function ViolationPanel({
  flagged,
  ai,
  summary,
  videoId
}: {
  flagged: ScannedLine[]
  ai: AiState
  summary: ScanSummary | null
  videoId: string // 보고서 탭 URL(?v=) 키 — 어떤 영상의 근거를 펼칠지 식별
}) {
  // 자막 패널과 별개의 open 상태 — 둘을 동시에 띄울 수 있어야 하므로 독립적으로 관리
  const [open, setOpen] = useState(false)
  // 토글/헤더 색은 AI 상태 기준 (검증 중=파랑, 위법 있음=빨강, 없음=초록)
  const dotColor = aiDot(ai)

  // 닫힌 상태: ⚠ 토글 (위치 슬롯만 다르고 색 규칙은 패널 헤더와 동일)
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{
          ...styles.toggleClosed,
          right: SLOT_VIOLATION_RIGHT,
          background: dotColor
        }}
        title={aiHeader(ai)}>
        ⚠
      </button>
    )
  }

  // 열린 상태: 헤더(AI 위법 개수) + AI 가 위법으로 확정한 줄 리스트
  return (
    <div style={{ ...styles.panel, right: SLOT_VIOLATION_RIGHT }}>
      <div style={styles.panelHeader}>
        <span style={{ ...styles.dot, background: dotColor }} />
        <span style={styles.headerLabel}>{aiHeader(ai)}</span>
        <button
          onClick={() => setOpen(false)}
          style={styles.closeBtn}
          title="닫기">
          ×
        </button>
      </div>
      {/* 사용자에게는 최종 보고서 하나만 노출한다. */}
      <FinalReportLink videoId={videoId} summary={summary} />
      <div style={styles.panelBody}>{renderAiBody(ai, flagged)}</div>
    </div>
  )
}

// ── 진행 패널: 영상추출 → 룰엔진 → AI검증 3단계를 실시간으로 보여주는 독립 토글 ──
//   왜 기본 펼침(open=true): "실시간 진행 표시"가 이 패널의 핵심 목적이라, 켜는 수고 없이 바로 보이게 한다.
//   입력(entry/scanned/summary/ai)에서 파생만 하므로 자체 상태는 open 토글뿐
function ProgressPanel({
  entry,
  scanned,
  summary,
  ai
}: {
  entry: StoredEntry | null
  scanned: ScannedLine[] | null
  summary: ScanSummary | null
  ai: AiState
}) {
  const [open, setOpen] = useState(true)
  // 세 단계 뷰로 변환 — 각 단계의 status(대기/진행/완료/실패)와 한 줄 설명
  const stages = buildStages(entry, scanned, summary, ai)
  // 닫힌 토글 색: 가장 우선되는 상태(실패>진행>완료>대기)로 전체 진행을 한 점으로 요약
  const dotColor = overallColor(stages)

  // 닫힌 상태: ⚙ 토글 (진행 색을 그대로 입혀 닫아둬도 흐름이 보이게)
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{
          ...styles.toggleClosed,
          right: SLOT_PROGRESS_RIGHT,
          background: dotColor
        }}
        title="실시간 분석 진행 상황">
        ⚙
      </button>
    )
  }

  // 열린 상태: 헤더 + 단계 리스트 (단계마다 상태칩 + 이름 + 상세)
  return (
    <div style={{ ...styles.panel, right: SLOT_PROGRESS_RIGHT }}>
      <div style={styles.panelHeader}>
        <span style={{ ...styles.dot, background: dotColor }} />
        <span style={styles.headerLabel}>실시간 분석 진행</span>
        <button
          onClick={() => setOpen(false)}
          style={styles.closeBtn}
          title="닫기">
          ×
        </button>
      </div>
      <div style={styles.panelBody}>
        {/* 단계 N개 → 행 N개. 순서(추출→룰→AI)가 곧 파이프라인 순서라 인덱스로 번호를 붙인다 */}
        {stages.map((s, i) => (
          <div key={i} style={styles.stageRow}>
            <span
              style={{
                ...styles.stageChip,
                background: STAGE_STATUS_COLOR[s.status]
              }}>
              {STAGE_STATUS_LABEL[s.status]}
            </span>
            <div style={styles.stageMeta}>
              <div style={styles.stageName}>{`${i + 1}. ${s.name}`}</div>
              <div style={styles.stageDetail}>{s.detail}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// 한 줄 상태 요약 — 자막 토글 hover tooltip 과 자막 패널 헤더에서 공유
function describeState(
  entry: StoredEntry | null,
  summary: ScanSummary | null
): string {
  if (!entry) return "자막 추출 대기 중..."
  if (entry.ok === "pending") return STAGE_LABEL[entry.data.stage]
  if (entry.ok === false) return `실패: ${entry.data.reason}`
  // 성공: 룰 엔진 요약 — 위반/의심/정상 개수 (요약 없으면 추출 라인 수만)
  if (summary)
    return `위반 ${summary.positive} · 의심 ${summary.route} · 정상 ${summary.negative}`
  return `${entry.data.segments.length}라인 추출됨`
}

// AI 상태 → 위법 토글/헤더 점 색. 검증 중=파랑, 위법 있음=빨강, 위법 없음/건너뜀=초록, 그 외=회색
function aiDot(ai: AiState): string {
  if (ai.phase === "running") return "#4a90e2"
  if (ai.phase === "done")
    return ai.verdicts.some((v) => v.isViolation) ? "#e5484d" : "#1f7a34"
  if (ai.phase === "skip") return "#1f7a34"
  return "#888" // idle / error — 헤더 텍스트로 상태를 구분
}

// AI 상태 → 위법 패널 헤더/툴팁 한 줄 문구
function aiHeader(ai: AiState): string {
  switch (ai.phase) {
    case "idle":
      return "AI 검증 대기 중…"
    case "skip":
      return "위반·의심 없음 — AI 검증 불필요"
    case "running":
      return `AI 검증 중… (${ai.total}문장)`
    case "done": {
      // verdicts 중 isViolation 만 세서 "AI 가 확정한 위법" 개수만 강조
      const pos = ai.verdicts.filter((v) => v.isViolation).length
      return `AI 위법 확정 ${pos}건`
    }
    case "error":
      return "AI 검증 실패"
  }
}

// AI 상태 + flagged → 위법 패널 본문. done 일 때만 위법 줄 리스트, 그 외엔 상태 안내 문구
//   데이터 형태: flagged(룰이 거른 줄) 와 ai.verdicts 를 같은 인덱스로 zip → isViolation 인 줄만 남김
function renderAiBody(ai: AiState, flagged: ScannedLine[]) {
  if (ai.phase === "idle") {
    return <p style={styles.muted}>자막 분석 후 AI 검증을 시작합니다.</p>
  }
  if (ai.phase === "running") {
    return (
      <p style={styles.muted}>
        룰 엔진이 거른 {ai.total}문장을 AI 모델로 검증 중입니다…
      </p>
    )
  }
  if (ai.phase === "skip") {
    return (
      <p style={styles.muted}>
        룰 엔진에서 위반·의심 신호가 없어 AI 검증을 건너뜁니다 ✅
      </p>
    )
  }
  if (ai.phase === "error") {
    return (
      <p style={styles.muted}>
        AI 검증 실패: <code style={styles.code}>{ai.reason}</code>
      </p>
    )
  }
  // done — flagged 와 verdicts 는 검증 요청 시점의 같은 배열에서 나와 순서가 1:1 이므로 인덱스로 매핑
  const pairs = flagged
    .map((line, i) => ({ line, verdict: ai.verdicts[i] }))
    .filter((p) => p.verdict?.isViolation)
  if (pairs.length === 0) {
    return <p style={styles.muted}>AI 검증 결과 위법 문장이 없습니다 ✅</p>
  }
  return (
    <div>
      {pairs.map(({ line, verdict }, i) => (
        <div key={i} style={styles.segmentRow}>
          <span style={styles.timestamp}>{formatTime(line.start)}</span>
          <span style={{ ...styles.text, color: "#e5484d" }}>
            {`[위법] `}
            {line.text}
            {/* 어떤 라벨로 몇 점에 걸렸는지 근거를 살짝 곁들임 (AI:라벨 점수) */}
            <span style={styles.aiTag}>{` · AI:${verdict.label} ${verdict.score.toFixed(2)}`}</span>
          </span>
        </div>
      ))}
    </div>
  )
}

// 자막 패널 본문 — 상태별로 다른 내용
function renderBody(entry: StoredEntry | null, scanned: ScannedLine[] | null) {
  if (!entry) {
    return (
      <p style={styles.muted}>
        자막 추출이 시작되지 않았거나 페이지 로드 직후입니다.
      </p>
    )
  }
  if (entry.ok === "pending") {
    return (
      <p style={styles.muted}>
        잡 ID: <code style={styles.code}>{entry.data.jobId}</code>
        <br />
        서버: <code style={styles.code}>{entry.data.server}</code>
      </p>
    )
  }
  if (entry.ok === false) {
    return (
      <p style={styles.muted}>
        출처: <code style={styles.code}>{entry.data.source}</code>
        <br />
        사유: <code style={styles.code}>{entry.data.reason}</code>
      </p>
    )
  }
  // 성공 — 자막 줄마다 룰 엔진 상태를 색으로 표시 (위반=빨강, 의심=주황, 정상=기본)
  //   scanned 는 entry.ok===true 일 때만 채워지므로 여기선 항상 배열이지만, 타입상 null 가드
  const lines = scanned ?? []
  return (
    <div>
      {lines.map((l, i) => {
        // 상태→색·태그 매핑. 정상이 아닌 줄만 [위반]/[의심] 접두 태그를 붙인다
        const view = STATUS_VIEW[l.status]
        const flagged = l.status !== "Rule-Negative"
        return (
          <div key={i} style={styles.segmentRow}>
            <span style={styles.timestamp}>{formatTime(l.start)}</span>
            <span style={{ ...styles.text, color: view.color }}>
              {flagged ? `[${view.tag}] ` : ""}
              {l.text}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ── 진행 패널용 단계 모델 ──
//   파이프라인 상태를 화면에 그릴 3개의 단계로 환산하는 순수 변환 계층 (네트워크/부수효과 없음)
type StageStatus = "idle" | "active" | "done" | "error"
type Stage = { name: string; status: StageStatus; detail: string }

// 단계 상태 → 칩 색/라벨. 대기=회색, 진행=파랑, 완료=초록, 실패=빨강
const STAGE_STATUS_COLOR: Record<StageStatus, string> = {
  idle: "#888",
  active: "#4a90e2",
  done: "#1f7a34",
  error: "#e5484d"
}
const STAGE_STATUS_LABEL: Record<StageStatus, string> = {
  idle: "대기",
  active: "진행",
  done: "완료",
  error: "실패"
}

// (entry, scanned, summary, ai) → [영상추출, 룰엔진, AI검증] 3단계 뷰.
//   각 단계는 앞 단계 결과를 원천으로 상태가 정해진다 (추출=storage, 룰=scanned, AI=ai 상태기계)
function buildStages(
  entry: StoredEntry | null,
  scanned: ScannedLine[] | null,
  summary: ScanSummary | null,
  ai: AiState
): Stage[] {
  return [sttStage(entry), ruleStage(entry, scanned, summary), aiStageView(ai)]
}

// 1단계: 영상 추출(STT) — storage entry 가 진행 상태의 원천 (queued→downloading→transcribing→done/실패)
function sttStage(entry: StoredEntry | null): Stage {
  if (!entry) return { name: "영상 추출", status: "idle", detail: "대기 중" }
  if (entry.ok === "pending")
    return { name: "영상 추출", status: "active", detail: STAGE_LABEL[entry.data.stage] }
  if (entry.ok === false)
    return { name: "영상 추출", status: "error", detail: `실패: ${entry.data.reason}` }
  return {
    name: "영상 추출",
    status: "done",
    detail: `전사 완료 · ${entry.data.segments.length}줄`
  }
}

// 2단계: 룰 엔진 — STT 완료(entry.ok===true) 후에야 동기 스캔이 돌므로, 그 전엔 대기
function ruleStage(
  entry: StoredEntry | null,
  scanned: ScannedLine[] | null,
  summary: ScanSummary | null
): Stage {
  if (!entry || entry.ok !== true)
    return { name: "룰 엔진", status: "idle", detail: "대기 중" }
  if (!scanned || !summary)
    return { name: "룰 엔진", status: "active", detail: "분석 중" }
  return {
    name: "룰 엔진",
    status: "done",
    detail: `위반 ${summary.positive} · 의심 ${summary.route} · 정상 ${summary.negative}`
  }
}

// 3단계: AI 검증 — ai 상태 기계를 그대로 단계 뷰로 옮긴다
function aiStageView(ai: AiState): Stage {
  switch (ai.phase) {
    case "idle":
      return { name: "AI 검증", status: "idle", detail: "대기 중" }
    case "skip":
      return { name: "AI 검증", status: "done", detail: "검증 대상 없음 (위반·의심 0)" }
    case "running":
      return { name: "AI 검증", status: "active", detail: `검증 중… ${ai.total}문장` }
    case "done": {
      const pos = ai.verdicts.filter((v) => v.isViolation).length
      return {
        name: "AI 검증",
        status: "done",
        detail: `위법 확정 ${pos}건 / ${ai.verdicts.length}`
      }
    }
    case "error":
      return { name: "AI 검증", status: "error", detail: `실패: ${ai.reason}` }
  }
}

// 3단계 중 가장 우선되는 상태로 닫힌 토글 한 점의 색을 정함 (실패>진행>모두완료>대기)
function overallColor(stages: Stage[]): string {
  if (stages.some((s) => s.status === "error")) return "#e5484d"
  if (stages.some((s) => s.status === "active")) return "#4a90e2"
  if (stages.every((s) => s.status === "done")) return "#1f7a34"
  return "#888"
}

// 인라인 스타일 모음 — Plasmo CSUI 가 shadow DOM 으로 격리하지만 명시적으로 적어둠
//   position: fixed 로 viewport 우상단에 고정 — body 에 붙어있어 어떤 페이지/모드에서도 보장됨
//   top: 72px 는 YouTube masthead(상단바) 아래에 떨어지게 한 값
//   right 는 패널별로 SLOT_* 상수를 인라인 override (자막=12, 위반=364) 해 동시에 떠도 안 겹침
const styles: Record<string, React.CSSProperties> = {
  toggleClosed: {
    position: "fixed",
    top: 72,
    right: 12,
    zIndex: 2147483647,
    pointerEvents: "auto",
    width: 36,
    height: 36,
    borderRadius: 18,
    border: "none",
    color: "white",
    fontSize: 11,
    fontWeight: 700,
    cursor: "pointer",
    boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
  },
  panel: {
    position: "fixed",
    top: 72,
    right: 12,
    zIndex: 2147483647,
    pointerEvents: "auto",
    width: 340,
    maxHeight: 480,
    background: "rgba(20, 20, 20, 0.92)",
    color: "#eee",
    borderRadius: 8,
    boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
    fontSize: 12,
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    display: "flex",
    flexDirection: "column",
    overflow: "hidden"
  },
  panelHeader: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 10px",
    borderBottom: "1px solid rgba(255,255,255,0.1)"
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    flexShrink: 0,
    display: "inline-block"
  },
  headerLabel: { flex: 1, fontSize: 12, lineHeight: 1.4 },
  closeBtn: {
    background: "transparent",
    border: "none",
    color: "#aaa",
    fontSize: 18,
    cursor: "pointer",
    padding: 0,
    lineHeight: 1,
    width: 20,
    height: 20
  },
  reportLink: {
    // 헤더와 본문 사이 가로 막대형 링크 — 패널 폭을 꽉 채워 눈에 띄게
    display: "block",
    width: "100%",
    textAlign: "left",
    background: "rgba(229,72,77,0.15)",
    color: "#ff8a8d",
    border: "none",
    borderBottom: "1px solid rgba(255,255,255,0.1)",
    padding: "8px 10px",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit"
  },
  panelBody: {
    overflowY: "auto",
    padding: "6px 10px",
    flex: 1
  },
  segmentRow: {
    display: "flex",
    gap: 8,
    padding: "4px 0",
    borderBottom: "1px solid rgba(255,255,255,0.05)"
  },
  timestamp: {
    color: "#888",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    flexShrink: 0,
    minWidth: 38,
    fontSize: 11
  },
  text: {
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    lineHeight: 1.5,
    flex: 1
  },
  muted: { color: "#aaa", fontSize: 12, lineHeight: 1.6, padding: "8px 0" },
  code: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    color: "#ddd",
    fontSize: 11
  },
  // 진행 패널: 단계 한 행 — 좌측 상태칩 + 우측 이름/상세
  stageRow: {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    padding: "8px 0",
    borderBottom: "1px solid rgba(255,255,255,0.05)"
  },
  stageChip: {
    flexShrink: 0,
    minWidth: 34,
    textAlign: "center",
    color: "white",
    fontSize: 11,
    fontWeight: 700,
    padding: "2px 6px",
    borderRadius: 4,
    lineHeight: 1.5
  },
  stageMeta: { flex: 1, minWidth: 0 },
  stageName: { fontWeight: 600, fontSize: 12, lineHeight: 1.4 },
  stageDetail: { color: "#aaa", fontSize: 11, lineHeight: 1.5, marginTop: 2 },
  // 위법 줄 끝에 붙는 AI 근거 태그 (라벨·점수) — 본문보다 옅게
  aiTag: { color: "#ff8a8d", fontSize: 11, opacity: 0.85 }
}

export default Overlay
