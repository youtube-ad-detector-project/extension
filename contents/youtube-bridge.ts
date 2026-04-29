// ISOLATED world: chrome.* API 사용 가능. MAIN world 가 보낸 결과를 background 로 중계한다.
// 또한 MAIN 의 ERROR 메시지를 받으면 Plan B(background HTML refetch) 를 트리거한다.

import type { PlasmoCSConfig } from "plasmo"

import {
  POSTMSG_TAG,
  type CaptionsResultMessage,
  type FallbackRequestMessage
} from "../lib/messages"

// MAIN 과 동일한 매칭 + run_at, world 는 명시 안 하면 ISOLATED 가 기본
export const config: PlasmoCSConfig = {
  matches: ["https://*.youtube.com/*"],
  run_at: "document_idle"
}

const TAG = "[yt-cap:bridge]"
// Plan B 폴백을 같은 영상에 대해 중복 트리거하지 않도록 추적
const fallbackRequested = new Set<string>()

console.log(TAG, "📌 ISOLATED bridge 로드됨 (chrome.* API 사용 가능). 현재 URL:", location.href)

// MAIN world 의 window.postMessage 를 수신 — 같은 window 객체를 공유함
window.addEventListener("message", (ev: MessageEvent) => {
  // 다른 origin/스크립트가 보낸 메시지는 즉시 무시 (보안상 중요)
  if (ev.source !== window) return
  if (ev.origin !== location.origin) return
  const data = ev.data
  if (!data || data.tag !== POSTMSG_TAG || !data.msg) return

  const msg = data.msg as CaptionsResultMessage
  console.log(
    TAG,
    `📨 MAIN world 메시지 수신: 종류=${msg.type}, 영상ID=${msg.payload?.videoId}`
  )

  if (msg.type === "CAPTIONS_RESULT") {
    // 성공 → 사용자에게 보이는 console 요약 + background 로 전달해 storage 저장 위임
    const p = msg.payload
    console.log(
      `%c[yt-cap] ✅ 자막 추출 성공! 영상=${p.videoId} 언어=${p.lang} 종류=${p.kind === "asr" ? "자동" : "수동"} 라인수=${p.segments.length}`,
      "color:#4caf50;font-weight:bold"
    )
    console.log(TAG, "📤 background로 결과 전달 (chrome.runtime.sendMessage)")
    chrome.runtime.sendMessage(msg).catch((e) => {
      console.log(TAG, "❌ background 결과 전송 실패:", e)
    })
    return
  }

  if (msg.type === "CAPTIONS_ERROR") {
    const { videoId, reason } = msg.payload
    // 다음 사유들은 Plan B(background fetch) 로 폴백해도 동일하게 차단되므로 폴백 스킵:
    //   - no_captions: 자막 자체가 없는 영상
    //   - all main-world paths failed: PoToken 차단 — background fetch 도 같은 차단을 받음
    const skipFallback =
      reason === "no_captions" || reason === "all main-world paths failed"
    if (skipFallback) {
      console.log(
        `%c[yt-cap] ⚠️ ${videoId} - ${reason} (Plan B 폴백해도 동일 차단이라 스킵)`,
        "color:#ff9800"
      )
      chrome.runtime.sendMessage(msg).catch(() => {})
      return
    }
    // 그 외 에러는 Plan B(background HTML refetch) 로 폴백 시도
    if (fallbackRequested.has(videoId)) {
      console.log(TAG, "⏭️ Plan B 이미 요청됨 - 중복 방지로 스킵")
      return
    }
    fallbackRequested.add(videoId)
    console.log(
      `%c[yt-cap] ↻ ${videoId} - Plan A 실패 (사유: ${reason}). Plan B(background HTML 재취득)로 폴백`,
      "color:#ff9800"
    )
    const req: FallbackRequestMessage = {
      type: "REQUEST_CAPTIONS_FALLBACK",
      videoId
    }
    chrome.runtime.sendMessage(req).catch((e) => {
      console.log(TAG, "❌ Plan B 폴백 요청 전송 실패:", e)
    })
  }
})
