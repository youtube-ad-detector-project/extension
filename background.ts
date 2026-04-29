// Service worker. 두 가지 책임:
//  1) content script 가 보낸 CAPTIONS_RESULT/ERROR 를 chrome.storage.local 에 적재
//  2) Plan A 가 실패했을 때 Plan B(폴백: watch HTML refetch) 를 수행

import {
  fetchCaptionTrack,
  pickCaptionTrack
} from "./lib/captions"
import type {
  CaptionsError,
  CaptionsPayload,
  CaptionsResultMessage,
  FallbackRequestMessage,
  RuntimeMessage
} from "./lib/messages"
import { extractPlayerResponse } from "./lib/playerResponse"
import { saveCaption, saveCaptionError } from "./lib/storage"

const TAG = "[yt-cap:bg]"

console.log(TAG, "📌 service worker 시작됨 (background. storage 저장 + Plan B 폴백 담당)")

// 단일 진입점: 모든 메시지를 type 으로 분기
chrome.runtime.onMessage.addListener((msg: RuntimeMessage, sender, sendResponse) => {
  console.log(
    TAG,
    `📨 메시지 수신: 종류=${msg.type}, 보낸 탭=${sender.tab?.id ?? "unknown"}`
  )

  if (msg.type === "CAPTIONS_RESULT") {
    // Plan A 또는 Plan B 의 성공 결과 → storage 저장
    void onResult(msg)
    return false
  }

  if (msg.type === "CAPTIONS_ERROR") {
    // 에러도 같이 기록 (재시도 정책에 활용 가능)
    void onError(msg.payload)
    return false
  }

  if (msg.type === "REQUEST_CAPTIONS_FALLBACK") {
    // bridge 가 요청한 Plan B 진입점
    void runFallback(msg)
    return false
  }

  return false
})

// 성공 결과 저장 + console 에 요약 (background DevTools 에서 확인)
async function onResult(msg: CaptionsResultMessage & { type: "CAPTIONS_RESULT" }): Promise<void> {
  const p = msg.payload
  await saveCaption(p.videoId, p)
  console.log(
    TAG,
    `💾 chrome.storage.local 저장 완료: 영상=${p.videoId}, 출처=${p.source === "main-world" ? "Plan A(MAIN world)" : "Plan B(background)"}, 언어=${p.lang}, 종류=${p.kind === "asr" ? "자동" : "수동"}, 라인수=${p.segments.length}`
  )
}

// 에러 결과를 storage 에 기록
async function onError(err: CaptionsError): Promise<void> {
  await saveCaptionError(err.videoId, err)
  console.log(
    TAG,
    `⚠️ 에러도 storage에 기록: 영상=${err.videoId}, 출처=${err.source}, 사유=${err.reason}`
  )
}

// Plan B: youtube.com/watch?v={id} 를 직접 fetch → playerResponse 추출 → 자막 fetch
async function runFallback(msg: FallbackRequestMessage): Promise<void> {
  const videoId = msg.videoId
  console.log(TAG, `↻ Plan B 시작 - 영상 ID: ${videoId} (Plan A가 실패해서 background에서 재시도)`)

  try {
    // ── B1: watch 페이지 HTML 가져오기 ───────────────────────────
    // credentials 포함해 사용자 세션 활용 (PoToken/연령제한 우회 시도)
    const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
    console.log(TAG, "📥 B1단계 - watch 페이지 HTML 가져오기:", watchUrl)
    const htmlRes = await fetch(watchUrl, { credentials: "include" })
    console.log(TAG, `B1 HTTP 응답: ${htmlRes.status} ${htmlRes.statusText}`)
    if (!htmlRes.ok) {
      await onError({
        videoId,
        reason: `B1 html http ${htmlRes.status}`,
        source: "background-fallback"
      })
      return
    }
    const html = await htmlRes.text()
    console.log(TAG, `B1 HTML 본문 길이: ${html.length} bytes`)

    // ── B2: HTML 안의 ytInitialPlayerResponse JSON 추출 ──────────
    console.log(TAG, "🔍 B2단계 - HTML에서 ytInitialPlayerResponse JSON 추출 (balanced bracket parser)")
    const pr = extractPlayerResponse(html)
    if (!pr) {
      console.log(TAG, "❌ B2 실패 - HTML에 ytInitialPlayerResponse 마커가 없음 (YouTube 응답 변형 가능성)")
      await onError({
        videoId,
        reason: "B2 playerResponse not found in html",
        source: "background-fallback"
      })
      return
    }
    // race 방지: HTML 의 영상 ID 가 우리가 원하는 영상과 같아야 의미가 있다
    const prVideoId = pr?.videoDetails?.videoId
    if (prVideoId && prVideoId !== videoId) {
      console.log(TAG, "⚠️ B2 경고 - HTML 응답의 영상 ID와 요청 ID 불일치", {
        요청영상: videoId,
        실제영상: prVideoId
      })
    }
    console.log(TAG, "✅ B2 성공 - playerResponse JSON 추출 완료")

    // ── B3: 트랙 선택 (Plan A 와 동일 로직) ──────────────────────
    const track = pickCaptionTrack(pr)
    if (!track) {
      console.log(TAG, "❌ B3 실패 - 자막 트랙 없음 (자막 비활성 영상)")
      await onError({
        videoId,
        reason: "no_captions",
        source: "background-fallback"
      })
      return
    }
    console.log(
      TAG,
      `✅ B3 성공 - 트랙 선택: 언어=${track.lang}, 종류=${track.kind === "asr" ? "자동(ASR)" : "수동"}`
    )

    // ── B4: 자막 본문 fetch (json3 → XML 자동 폴백) ──────────────
    console.log(TAG, "📥 B4단계 - 자막 본문 다운로드 (Plan A와 동일한 fetcher 공유)")
    const fetched = await fetchCaptionTrack(track.baseUrl, TAG)
    if ("error" in fetched) {
      console.log(TAG, `❌ B4 실패 - ${fetched.error}`)
      await onError({
        videoId,
        reason: `B4 ${fetched.error}`,
        source: "background-fallback"
      })
      return
    }

    // ── B5: storage 저장 ────────────────────────────────────────
    const payload: CaptionsPayload = {
      videoId,
      lang: track.lang,
      kind: track.kind,
      segments: fetched.segments,
      source: "background-fallback"
    }
    await saveCaption(videoId, payload)
    console.log(
      TAG,
      `🎉 Plan B 성공 - 저장 완료: 영상=${videoId}, 언어=${track.lang}, 종류=${track.kind === "asr" ? "자동" : "수동"}, 포맷=${fetched.format}, 라인수=${fetched.segments.length}`
    )
  } catch (e) {
    // 어떤 단계 예외든 Plan C(silent) 로 수렴 — 에러 사유만 기록
    console.log(TAG, "💥 Plan B 예외 발생:", e)
    await onError({
      videoId,
      reason: `B exception: ${(e as Error).message}`,
      source: "background-fallback"
    })
  }
}
