// Shorts 전용 STT 트리거. 예전 youtube-main(추출)+youtube-bridge(중계)가 하던 일을
//   STT-only 에 맞춰 "감지 후 요청" 한 가지로 줄인 콘텐츠 스크립트.
//   흐름: Shorts URL 진입 감지 → background 로 REQUEST_STT 전송 → 이후는 background 가 STT 잡 처리
//   ISOLATED world(기본) 인 이유: chrome.runtime.sendMessage 를 써야 해서. (MAIN world 는 chrome.* 불가)

import type { PlasmoCSConfig } from "plasmo"

import { getVideoIdFromUrl } from "../lib/captions"
import type { RequestSttMessage } from "../lib/messages"

// youtube.com 전 페이지에 주입하되, 실제 트리거는 아래에서 /shorts/ 경로일 때만 건다
export const config: PlasmoCSConfig = {
  matches: ["https://*.youtube.com/*"],
  run_at: "document_idle"
}

const TAG = "[yt-cap:shorts]"
// 같은 탭 세션에서 같은 Shorts 를 여러 번 요청하지 않도록 (URL 폴링이 1초마다 도므로 중복 방지 필수)
//   background 도 polling 중복은 막지만, 여기서 먼저 걸러 불필요한 메시지 자체를 안 보낸다
const requested = new Set<string>()

console.log(TAG, "📌 Shorts STT 트리거 로드됨 (ISOLATED). 현재 URL:", location.href)

// 현재 URL 이 Shorts 영상이면 background 에 STT 를 1회 요청한다.
//   왜 /shorts/ 만: 사용자가 대상으로 정한 게 Shorts 뿐 — 일반 영상에서 yt-dlp 헛돌리지 않게 경로로 차단
function maybeTriggerStt(): void {
  // /shorts/ 가 아니면 (홈/검색/일반 watch) 아무것도 안 함
  if (!location.pathname.startsWith("/shorts/")) return

  const videoId = getVideoIdFromUrl(location.href)
  if (!videoId) return

  // 이미 이 세션에서 요청한 영상이면 스킵 (스와이프로 돌아와도 재요청 안 함)
  if (requested.has(videoId)) {
    console.log(TAG, `⏭️ 이미 요청한 Shorts 스킵: ${videoId}`)
    return
  }
  requested.add(videoId)

  const videoTitle = getCurrentVideoTitle()

  // background.onMessage 가 REQUEST_STT 를 받아 runPlanE(videoId) 를 직접 호출한다
  const msg: RequestSttMessage = { type: "REQUEST_STT", videoId, videoTitle }
  console.log(
    TAG,
    `🎤 STT 요청 전송: 영상=${videoId}, 제목=${videoTitle ?? "(제목 없음)"}`
  )
  chrome.runtime.sendMessage(msg).catch((e) => {
    console.log(TAG, "❌ STT 요청 전송 실패:", e)
  })
}

function getCurrentVideoTitle(): string | undefined {
  const metaTitle = document
    .querySelector<HTMLMetaElement>('meta[name="title"]')
    ?.content.trim()
  const rawTitle = metaTitle || document.title
  const title = rawTitle.replace(/\s*-\s*YouTube\s*$/i, "").trim()

  return title || undefined
}

// YouTube SPA 라우팅 완료 이벤트 — 페이지 전환 추적에 가장 신뢰할 수 있는 신호
window.addEventListener("yt-navigate-finish", () => {
  console.log(TAG, "🚀 SPA 전환 감지 (yt-navigate-finish). 새 URL:", location.href)
  maybeTriggerStt()
})

// 안전망: yt-navigate-finish 가 안 뜨는 변형/스와이프 대비 1초 URL 폴링
let lastUrl = location.href
setInterval(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href
    console.log(TAG, "🔁 URL 변경 감지 (1초 폴링 백업). 새 URL:", location.href)
    maybeTriggerStt()
  }
}, 1000)

// 첫 로딩 때는 yt-navigate-finish 가 이미 지나갔을 수 있어 한 번 즉시 시도
maybeTriggerStt()
