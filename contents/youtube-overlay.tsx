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
import { buildDataset } from "~lib/datasetExport"
import type {
  CaptionsError,
  CaptionsPayload,
  CaptionsPending,
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

const KEY_PREFIX = "caption:"

// 두 패널이 겹치지 않도록 가로 슬롯을 분리 — 자막 패널은 right:12, 위반 패널은 그 왼쪽
//   자막 패널 최대 폭(12 + 340)을 넘어선 지점에 둬야 자막이 열려 있어도 위반 토글이 안 가려진다
const SLOT_SUBTITLE_RIGHT = 12
const SLOT_VIOLATION_RIGHT = 364

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
    return scanCaptions(entry.data.segments)
  }, [entry])
  const summary: ScanSummary | null = scanned ? summarize(scanned) : null

  // 영상 페이지가 아니거나 player 가 없으면 오버레이를 안 그림 (홈/채널로 SPA 이동했을 때)
  //   주의: useMemo 호출 뒤에 둬야 훅 순서가 안정적 (early return 이 훅보다 앞서면 안 됨)
  if (!videoId) return null

  // 두 패널을 형제로 렌더 — 각자 open 상태를 따로 들고, 위치 슬롯이 달라 동시에 떠도 안 겹침
  return (
    <>
      {/* videoId 는 위 `if (!videoId) return null` 가드를 지나 string 으로 좁혀짐 → ViolationPanel 의 보고서 URL 키 */}
      <SubtitlePanel
        entry={entry}
        scanned={scanned}
        summary={summary}
      />
      <ViolationPanel
        scanned={scanned}
        summary={summary}
        videoId={videoId}
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

// 보고서 진입 링크 — ViolationPanel(⚠) 에서만 사용. CC 패널과 함께 두 곳에 두면 같은 진입점이
//   중복돼 헷갈리므로 위반/의심 패널 한쪽으로 일원화한다.
//   무엇이 들어가 → 처리 → 무엇이 반환: videoId+summary → (위반·의심 있으면) 링크 버튼 / 없으면 null
function ReportLink({
  videoId,
  summary
}: {
  videoId: string
  summary: ScanSummary | null
}) {
  // 위반·의심이 하나도 없으면 "펼칠 근거"가 없으므로 링크 자체를 렌더하지 않음
  if (!summary || (summary.positive === 0 && summary.route === 0)) return null

  // 클릭 → background 에 보고서 탭 열기 위임.
  //   왜 직접 안 열까: 콘텐츠 스크립트엔 chrome.tabs 가 없고, web_accessible_resources
  //   없이 확장 페이지를 여는 건 background 의 chrome.tabs.create 만 가능하기 때문.
  const openReport = () => {
    const msg: OpenReportMessage = { type: "OPEN_REPORT", videoId }
    void chrome.runtime.sendMessage(msg)
  }

  return (
    <button
      onClick={openReport}
      style={styles.reportLink}
      title="새 탭에서 상세 근거 보고서 열기">
      📄 상세 위반 보고서 열기 ↗
    </button>
  )
}

// JSON 복사 버튼 — 위반·의심 줄(scanned 중 Rule-Negative 제외) 을 {text, status} JSON 으로 클립보드 복사.
//   왜 오버레이로 이동: 보고서 탭에서 굳이 한 번 더 클릭할 필요 없이, 영상 보면서 바로 노션에 붙여넣을 수 있게.
//   무엇이 들어가 → 처리 → 무엇이 반환:
//     scanned(전체 스캔 결과) → buildDataset 으로 위반·의심만 {text, status} 화 → 들여쓰기 2칸 문자열 → clipboard
function CopyDatasetButton({ scanned }: { scanned: ScannedLine[] | null }) {
  // 클릭 직후 "복사됨 ✓" 라벨로 잠깐 바꿔 사용자에게 "동작했음" 피드백 (2초 후 원복)
  const [copied, setCopied] = useState(false)

  // scanned 가 없거나(분석 전) 위반·의심 줄이 0건이면 복사할 데이터가 없으므로 버튼 비활성
  const flagged = scanned
    ? scanned.filter((l) => l.status !== "Rule-Negative")
    : []
  const disabled = flagged.length === 0

  const onCopy = async () => {
    if (disabled) return
    // buildDataset: ScannedLine[] → [{text, status}] 외부 라벨로 변환 (Rule-Negative 자동 제외)
    //   왜 들여쓰기 2칸: 노션 코드블록에 그대로 붙여도 사람이 읽기 좋게.
    const payload = buildDataset(flagged)
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
    setCopied(true)
    // 한 영상에서 여러 번 복사할 수 있어야 하므로 2초 뒤 라벨 원복
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <button
      onClick={onCopy}
      disabled={disabled}
      style={{
        ...styles.reportLink,
        ...(disabled ? styles.copyBtnDisabled : {})
      }}
      title={
        disabled
          ? "위반·의심 0건 — 복사할 데이터 없음"
          : `위반·의심 ${flagged.length}건을 JSON 으로 클립보드에 복사`
      }>
      {copied ? "복사됨 ✓" : `📋 JSON 복사 (${flagged.length}건)`}
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
  //   보고서/JSON 복사 같은 위반 관련 액션은 ViolationPanel(⚠) 한 곳으로 일원화했으므로
  //   여기엔 따로 진입 링크를 두지 않는다 (중복 제거)
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

// ── 위반 패널: 위반·의심 줄만 모아 보여주는 독립 토글 (자막 패널 왼쪽 슬롯) ──
//   entry 는 안 받는다 — 이 패널은 "분석 결과"만 다루므로 scanned/summary 면 충분
//   왜 별도 패널: 자막 전체에서 문제 줄만 빠르게 훑을 수 있게, 자막 패널과 독립적으로 켜고 끔
function ViolationPanel({
  scanned,
  summary,
  videoId
}: {
  scanned: ScannedLine[] | null
  summary: ScanSummary | null
  videoId: string // 보고서 탭 URL(?v=) 키 — 어떤 영상의 근거를 펼칠지 식별
}) {
  // 자막 패널과 별개의 open 상태 — 둘을 동시에 띄울 수 있어야 하므로 독립적으로 관리
  const [open, setOpen] = useState(false)
  const dotColor = statusDot(summary)

  // 닫힌 상태: ⚠ 토글 (자막 토글과 색 규칙은 같고 위치 슬롯만 다름)
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{
          ...styles.toggleClosed,
          right: SLOT_VIOLATION_RIGHT,
          background: dotColor
        }}
        title={describeViolation(summary)}>
        ⚠
      </button>
    )
  }

  // 열린 상태: 헤더(위반/의심 개수) + 위반·의심 줄만 필터링한 리스트
  return (
    <div style={{ ...styles.panel, right: SLOT_VIOLATION_RIGHT }}>
      <div style={styles.panelHeader}>
        <span style={{ ...styles.dot, background: dotColor }} />
        <span style={styles.headerLabel}>{describeViolation(summary)}</span>
        <button
          onClick={() => setOpen(false)}
          style={styles.closeBtn}
          title="닫기">
          ×
        </button>
      </div>
      {/* 위반·의심 줄에 대한 액션 묶음: 보고서 진입 + AI 학습용 JSON 클립보드 복사
            둘 다 위반·의심 0건일 때는 비활성/숨김 → 데이터 있는 경우만 노출 */}
      <ReportLink videoId={videoId} summary={summary} />
      <CopyDatasetButton scanned={scanned} />
      <div style={styles.panelBody}>{renderViolationBody(scanned)}</div>
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

// 위반 패널 헤더/툴팁 문구 — scanned 가 없으면 분석 전, 있으면 위반·의심 개수만 강조
function describeViolation(summary: ScanSummary | null): string {
  if (!summary) return "자막 분석 대기 중..."
  return `위반 ${summary.positive} · 의심 ${summary.route}`
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

// 위반 패널 본문 — 위반·의심 줄만 추려 (텍스트 + 태그만, 매칭 근거는 표시 안 함)
//   데이터 형태: ScannedLine[] → status 가 Rule-Negative 가 아닌 줄만 남긴 부분집합
function renderViolationBody(scanned: ScannedLine[] | null) {
  // 아직 성공 자막이 아니어서 스캔 결과가 없는 경우 — 자막 패널 쪽에서 진행 상태 확인 유도
  if (!scanned) {
    return (
      <p style={styles.muted}>
        분석할 자막이 아직 없습니다. (자막 추출/전사 완료 후 표시됩니다)
      </p>
    )
  }
  // 정상이 아닌 줄만 필터 — 위반 패널의 핵심 변환 지점
  const flagged = scanned.filter((l) => l.status !== "Rule-Negative")
  // 스캔은 끝났는데 걸린 줄이 0개면 "깨끗함"을 명시 (빈 화면이 버그처럼 보이지 않게)
  if (flagged.length === 0) {
    return <p style={styles.muted}>위반·의심 신호가 발견되지 않았습니다 ✅</p>
  }
  return (
    <div>
      {flagged.map((l, i) => {
        const view = STATUS_VIEW[l.status]
        return (
          <div key={i} style={styles.segmentRow}>
            <span style={styles.timestamp}>{formatTime(l.start)}</span>
            <span style={{ ...styles.text, color: view.color }}>
              {`[${view.tag}] `}
              {l.text}
            </span>
          </div>
        )
      })}
    </div>
  )
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
  copyBtnDisabled: {
    // 위반·의심 0건일 때 — 톤 다운 + cursor 변경으로 "지금은 못 누름" 표시
    background: "rgba(255,255,255,0.06)",
    color: "#888",
    cursor: "not-allowed"
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
  }
}

export default Overlay
