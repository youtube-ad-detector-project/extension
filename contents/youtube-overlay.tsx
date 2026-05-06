// 유튜브 영상 우측 상단에 떠있는 토글형 자막 오버레이.
//   호출 흐름: Plasmo 가 watch/shorts 페이지에 자동 주입 → getRootContainer 가 #movie_player 찾기
//                → React 마운트 → useEffect 로 URL 폴링/storage 구독 → 상태별 토글 색
//   닫힌 상태: 작은 원형 토글 (회색=대기/진행/실패, 초록=성공)
//   열린 상태: 헤더 + segments 리스트 (시간 + 텍스트 한 줄씩)

import type { PlasmoCSConfig, PlasmoGetRootContainer } from "plasmo"
import { useEffect, useState } from "react"
import { getVideoIdFromUrl } from "~lib/captions"
import type {
  CaptionsError,
  CaptionsPayload,
  CaptionsPending
} from "~lib/messages"
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

// 상태별 짧은 한국어 라벨 — 헤더와 toggle title (hover) 에서 공통 사용
const STAGE_LABEL: Record<CaptionsPending["stage"], string> = {
  queued: "대기 중",
  downloading: "다운로드 중 (yt-dlp)",
  transcribing: "전사 중 (Whisper)"
}
const SOURCE_LABEL: Record<CaptionsPayload["source"], string> = {
  "main-world": "Plan A",
  "background-fallback": "Plan B",
  "stt-fallback": "Plan E (STT)"
}

function Overlay() {
  // 토글 열림 여부 — 닫힌 상태가 기본 (영상 가리지 않게)
  const [open, setOpen] = useState(false)
  // 현재 영상 ID — URL 폴링으로 SPA 네비게이션 추적
  const [videoId, setVideoId] = useState<string | null>(() =>
    getVideoIdFromUrl(window.location.href)
  )
  // chrome.storage.local 의 해당 영상 entry — null = 아직 기록 없음
  const [entry, setEntry] = useState<StoredEntry | null>(null)

  // YouTube 는 SPA 라 페이지 전환 시 content script 가 재주입되지 않음 → URL 폴링으로 영상 변경 감지
  //   youtube-main.ts 도 같은 1초 폴링 패턴을 쓴다
  useEffect(() => {
    let last = window.location.href
    const id = setInterval(() => {
      if (window.location.href !== last) {
        last = window.location.href
        setVideoId(getVideoIdFromUrl(last))
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
    void getStoredCaption(videoId).then(
      (e) => setEntry(e as StoredEntry | null)
    )

    const key = KEY_PREFIX + videoId
    const onChanged = (
      changes: { [k: string]: chrome.storage.StorageChange },
      area: string
    ) => {
      // 다른 영상의 변경은 무시 — 동시에 여러 탭이 추출 중일 수 있음
      if (area === "local" && changes[key]) {
        setEntry((changes[key].newValue ?? null) as StoredEntry | null)
      }
    }
    chrome.storage.onChanged.addListener(onChanged)
    return () => chrome.storage.onChanged.removeListener(onChanged)
  }, [videoId])

  // 영상 페이지가 아니거나 player 가 없으면 오버레이를 안 그림 (홈/채널로 SPA 이동했을 때)
  if (!videoId) return null

  // 토글 색 — 사용자 명세: 추출 성공만 초록, 그 외(대기/진행/실패)는 회색
  const isSuccess = entry?.ok === true
  const dotColor = isSuccess ? "#1f7a34" : "#888"

  // ── 닫힌 상태: 작은 동그란 토글 버튼 ──────────────────────────────
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{ ...styles.toggleClosed, background: dotColor }}
        title={describeState(entry)}
      >
        CC
      </button>
    )
  }

  // ── 열린 상태: 헤더 + segments 리스트 ─────────────────────────────
  return (
    <div style={styles.panel}>
      <div style={styles.panelHeader}>
        <span style={{ ...styles.dot, background: dotColor }} />
        <span style={styles.headerLabel}>{describeState(entry)}</span>
        <button
          onClick={() => setOpen(false)}
          style={styles.closeBtn}
          title="닫기"
        >
          ×
        </button>
      </div>
      <div style={styles.panelBody}>{renderBody(entry)}</div>
    </div>
  )
}

// 한 줄 상태 요약 — 토글 hover tooltip 과 패널 헤더에서 공유
function describeState(entry: StoredEntry | null): string {
  if (!entry) return "자막 추출 대기 중..."
  if (entry.ok === "pending") return STAGE_LABEL[entry.data.stage]
  if (entry.ok === false) return `실패: ${entry.data.reason}`
  // 성공: "8라인 · 한국어 · Plan E (STT)"
  return `${entry.data.segments.length}라인 · ${entry.data.lang} · ${SOURCE_LABEL[entry.data.source]}`
}

// 패널 본문 — 상태별로 다른 내용
function renderBody(entry: StoredEntry | null) {
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
  // 성공 — Whisper segments 그대로 시간 + 텍스트 형태로 한 줄씩
  return (
    <div>
      {entry.data.segments.map((s, i) => (
        <div key={i} style={styles.segmentRow}>
          <span style={styles.timestamp}>{formatTime(s.start)}</span>
          <span style={styles.text}>{s.text}</span>
        </div>
      ))}
    </div>
  )
}

// 초(float) → mm:ss — Whisper 가 초 단위 float 으로 timestamp 를 줌
function formatTime(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, "0")}`
}

// 인라인 스타일 모음 — Plasmo CSUI 가 shadow DOM 으로 격리하지만 명시적으로 적어둠
//   position: fixed 로 viewport 우상단에 고정 — body 에 붙어있어 어떤 페이지/모드에서도 보장됨
//   top: 72px 는 YouTube masthead(상단바) 아래에 떨어지게 한 값
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
