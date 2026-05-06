// Service worker. 세 가지 책임:
//  1) content script 가 보낸 CAPTIONS_RESULT/ERROR 를 chrome.storage.local 에 적재
//  2) Plan A 가 실패했을 때 Plan B(폴백: watch HTML refetch) 를 수행
//  3) Plan E (Whisper STT) — Plan A/B 가 자막을 못 만든 영상에 대해 로컬 STT 서버 호출

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
import {
  saveCaption,
  saveCaptionError,
  saveCaptionPending
} from "./lib/storage"

const TAG = "[yt-cap:bg]"

// Plan E 서버 주소 — 학습용이라 하드코딩 (host_permissions 에 동일 값이 있어야 함)
const STT_SERVER = "http://localhost:3000"

// 동일 영상 중복 폴링 방지용 — 같은 videoId 로 두 번째 요청이 와도 setInterval 한 개만 돌게
const planEIntervals = new Map<string, ReturnType<typeof setInterval>>()

console.log(
  TAG,
  "📌 service worker 시작됨 (background. storage 저장 + Plan B/E 폴백 담당)"
)

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

// 사람이 읽기 쉬운 라벨로 출처/종류를 매핑 (Plan E 추가로 분기가 늘어 객체로 정리)
const SOURCE_LABEL: Record<CaptionsPayload["source"], string> = {
  "main-world": "Plan A(MAIN world)",
  "background-fallback": "Plan B(background)",
  "stt-fallback": "Plan E(Whisper STT)"
}
const KIND_LABEL: Record<CaptionsPayload["kind"], string> = {
  manual: "수동",
  asr: "자동",
  stt: "STT"
}

// 성공 결과 저장 + console 에 요약 (background DevTools 에서 확인)
async function onResult(msg: CaptionsResultMessage & { type: "CAPTIONS_RESULT" }): Promise<void> {
  const p = msg.payload
  await saveCaption(p.videoId, p)
  console.log(
    TAG,
    `💾 chrome.storage.local 저장 완료: 영상=${p.videoId}, 출처=${SOURCE_LABEL[p.source]}, 언어=${p.lang}, 종류=${KIND_LABEL[p.kind]}, 라인수=${p.segments.length}`
  )
}

// 에러 결과를 storage 에 기록 + Plan E 트리거 분기
//   Plan E 트리거 조건은 "자막 트랙 자체가 없거나(no_captions)" / "PoToken 차단으로 본문이 안 잡혔을 때(all main-world paths failed)"
//   이 두 사유는 Plan B 로도 못 풀리므로 STT 로 우회한다.
const PLAN_E_TRIGGER_REASONS = new Set([
  "no_captions",
  "all main-world paths failed"
])
async function onError(err: CaptionsError): Promise<void> {
  await saveCaptionError(err.videoId, err)
  console.log(
    TAG,
    `⚠️ 에러도 storage에 기록: 영상=${err.videoId}, 출처=${err.source}, 사유=${err.reason}`
  )
  // 트리거 조건 충족 시 Plan E 시작 — 비동기로 떠서 onError 자체는 막지 않는다
  if (PLAN_E_TRIGGER_REASONS.has(err.reason)) {
    void runPlanE(err.videoId)
  }
}

// Plan E: 로컬 Next.js 서버에 STT 잡 등록 → 5초 폴링 → 결과를 saveCaption/saveCaptionError 로 수렴
//   호출 흐름: onError(트리거 사유) → runPlanE → POST /api/transcribe → setInterval(poll)
async function runPlanE(videoId: string): Promise<void> {
  // 같은 영상에 대해 이미 폴링이 돌고 있으면 중복 잡 만들지 않음
  if (planEIntervals.has(videoId)) {
    console.log(TAG, `🔁 Plan E 중복 호출 무시: 영상=${videoId} (이미 폴링 중)`)
    return
  }
  console.log(TAG, `🎤 Plan E 시작: 영상=${videoId}, 서버=${STT_SERVER}`)

  // 1) 잡 생성 — POST /api/transcribe { videoId } → { jobId }
  let jobId: string
  try {
    const res = await fetch(`${STT_SERVER}/api/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoId })
    })
    if (!res.ok) {
      // 서버는 떠 있는데 400/500 → bad_response 로 단순화
      throw new Error(`http ${res.status}`)
    }
    const body = (await res.json()) as { jobId?: string }
    if (typeof body.jobId !== "string") {
      throw new Error("missing jobId in response")
    }
    jobId = body.jobId
  } catch (e) {
    // 서버 자체가 안 떠있거나 응답이 이상한 경우 — 학습용이라 재시도 없이 에러 기록 후 종료
    const reason =
      e instanceof TypeError
        ? "stt: server_unreachable"
        : `stt: ${e instanceof Error ? e.message : String(e)}`
    console.log(TAG, `❌ Plan E 잡 생성 실패: ${reason}`)
    await saveCaptionError(videoId, { videoId, reason, source: "stt-fallback" })
    return
  }
  console.log(TAG, `📥 STT 잡 생성됨: jobId=${jobId}`)

  // 잡 생성 직후 storage 를 'pending(queued)' 로 마킹 — 팝업/UI 가 진행 상태 인식 가능
  await saveCaptionPending(videoId, {
    videoId,
    jobId,
    server: STT_SERVER,
    stage: "queued",
    startedAt: Date.now()
  })

  // 2) 5초마다 GET 으로 잡 상태 조회 — 결과/실패 시 interval 정리
  //    setInterval 이라 service worker 가 idle 로 죽으면 폴링도 끊김 (학습용 감수)
  const intervalId = setInterval(() => {
    void pollPlanE(videoId, jobId)
  }, 5000)
  planEIntervals.set(videoId, intervalId)
}

// 단발 폴링 호출 — runPlanE 의 setInterval 이 5초마다 부른다
//   응답 status 별로 분기: pending/processing → 진행 상태 갱신, done → 성공 저장 + 정리, failed → 에러 저장 + 정리
async function pollPlanE(videoId: string, jobId: string): Promise<void> {
  let body: {
    status: "pending" | "processing" | "done" | "failed"
    stage?: "downloading" | "transcribing"
    lang?: string
    segments?: { start: number; dur: number; text: string }[]
    reason?: string
  }
  try {
    const res = await fetch(`${STT_SERVER}/api/transcribe/${jobId}`)
    if (!res.ok) {
      // 404(잡 없음) 등 — 정상 폴링 흐름이 아니므로 폴링 종료
      throw new Error(`http ${res.status}`)
    }
    body = await res.json()
  } catch (e) {
    // fetch 실패 = 서버 다운 등 — 즉시 종료 (재시도 없음)
    const reason =
      e instanceof TypeError
        ? "stt: server_unreachable"
        : `stt: poll ${e instanceof Error ? e.message : String(e)}`
    console.log(TAG, `❌ Plan E 폴링 실패: 영상=${videoId}, ${reason}`)
    await saveCaptionError(videoId, { videoId, reason, source: "stt-fallback" })
    stopPlanE(videoId)
    return
  }

  // status 분기
  if (body.status === "pending") {
    // 아직 파이프라인 시작 전 — storage 상태는 그대로 두고 다음 5초 대기
    return
  }
  if (body.status === "processing") {
    // stage 가 바뀌었으면 storage 갱신 (UI 가 "다운로드 중 → 전사 중" 보여줄 수 있게)
    const stage: "downloading" | "transcribing" = body.stage ?? "downloading"
    await saveCaptionPending(videoId, {
      videoId,
      jobId,
      server: STT_SERVER,
      stage,
      startedAt: Date.now()
    })
    return
  }
  if (body.status === "done") {
    // 성공 — segments 를 CaptionsPayload 로 감싸 저장
    if (
      !Array.isArray(body.segments) ||
      typeof body.lang !== "string"
    ) {
      // 응답이 done 인데 모양이 깨졌으면 bad_response 로 처리
      await saveCaptionError(videoId, {
        videoId,
        reason: "stt: bad_response",
        source: "stt-fallback"
      })
      stopPlanE(videoId)
      return
    }
    const payload: CaptionsPayload = {
      videoId,
      lang: body.lang,
      kind: "stt",
      segments: body.segments,
      source: "stt-fallback"
    }
    await saveCaption(videoId, payload)
    console.log(
      TAG,
      `🎉 Plan E 성공: 영상=${videoId}, 언어=${body.lang}, 라인수=${body.segments.length}`
    )
    stopPlanE(videoId)
    return
  }
  if (body.status === "failed") {
    // 서버에서 yt-dlp 또는 Whisper 가 터진 케이스 — reason 을 그대로 prefix 붙여 저장
    const reason = `stt: ${body.reason ?? "unknown"}`
    console.log(TAG, `❌ Plan E 잡 실패: 영상=${videoId}, ${reason}`)
    await saveCaptionError(videoId, { videoId, reason, source: "stt-fallback" })
    stopPlanE(videoId)
    return
  }
}

// 폴링 정리 — interval 멈추고 Map 에서 제거 (다음 트리거 시 새 잡 만들 수 있게)
function stopPlanE(videoId: string): void {
  const id = planEIntervals.get(videoId)
  if (id !== undefined) {
    clearInterval(id)
    planEIntervals.delete(videoId)
  }
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
