// Plan A: MAIN world 에 주입. 다중 경로로 자막을 추출한다.
//   1) window.fetch 후킹 — YouTube player 가 내부적으로 자막을 fetch 할 때 응답을 가로챈다.
//      (YouTube 가 외부 직접 fetch 에 200+빈 body 로 응답하는 PoToken 차단을 우회)
//   2) player.setOption() 으로 자막 로드 강제 트리거 → 1)의 후킹이 응답을 잡음
//   3) 옛날식 직접 fetch 도 백업으로 시도 (차단되지 않는 영상에선 빠르게 성공)
// 이 컨텍스트는 chrome.* API 를 못 쓰므로, 결과는 window.postMessage 로 ISOLATED bridge 에 넘긴다.

import type { PlasmoCSConfig } from "plasmo"

import {
  fetchCaptionTrack,
  getVideoIdFromUrl,
  parseJson3,
  parseXml,
  pickCaptionTrack
} from "../lib/captions"
import {
  POSTMSG_TAG,
  type CaptionSegment,
  type CaptionsResultMessage
} from "../lib/messages"

// Plasmo 설정: youtube.com 전 페이지에 MAIN world 로 주입, DOM 안정화 후 실행
export const config: PlasmoCSConfig = {
  matches: ["https://*.youtube.com/*"],
  run_at: "document_idle",
  world: "MAIN"
}

const TAG = "[yt-cap:main]"
// 같은 세션에서 동일 videoId 중복 처리 방지 (탭 닫으면 자동 초기화)
const processed = new Set<string>()

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// 후킹이 잡은 자막을 추출 흐름이 받을 수 있도록 영상별 대기 Promise 보관
type HijackResult = { segments: CaptionSegment[]; format: string }
type PendingExtraction = {
  resolve: (v: HijackResult | null) => void
  resolved: boolean
}
const pending = new Map<string, PendingExtraction>()

// ── window.fetch 후킹 설치 (PoToken 차단 우회의 핵심) ───────────────────
// YouTube player 가 자막을 가져오는 모든 fetch 를 가로채서 본문을 복제 → 우리 파이프라인에 주입.
// 원본 fetch 동작은 그대로 유지 (player 에는 영향 없음).
const __origFetch = window.fetch
window.fetch = async function (this: any, input: any, init?: any) {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input?.url
  const res = await __origFetch.apply(this, [input, init])
  // /api/timedtext 경로면 자막 응답이 거의 확실
  if (url && /\/api\/timedtext\b/.test(url) && res.ok) {
    try {
      // 원본 응답을 소비하지 않도록 clone() 후 본문 추출
      const body = await res.clone().text()
      if (body.length >= 50) {
        console.log(
          TAG,
          `🪝 fetch 후킹 - YouTube player 가 자막 받음 (${body.length} bytes)`
        )
        onHijackedCaption(body)
      }
    } catch (e) {
      console.log(TAG, "🪝 후킹 본문 읽기 실패:", (e as Error).message)
    }
  }
  return res
}
console.log(TAG, "🪝 window.fetch 후킹 설치 완료 - YouTube 내부 자막 요청 대기")

// 후킹이 받은 body 를 json3/xml 어느 쪽이든 파싱해 대기 중인 추출 흐름을 깨움
function onHijackedCaption(body: string): void {
  const videoId = getVideoIdFromUrl(location.href)
  if (!videoId) return
  // 응답 첫 글자로 포맷 판별 (json3 는 '{', xml/srv3 는 '<')
  const trimmed = body.trimStart()
  let segments: CaptionSegment[] = []
  let format = "unknown"
  if (trimmed.startsWith("{")) {
    try {
      segments = parseJson3(JSON.parse(body))
      format = "json3"
    } catch {
      // JSON 아니면 XML 로도 시도
    }
  }
  if (!segments.length && trimmed.startsWith("<")) {
    segments = parseXml(body)
    format = "xml"
  }
  if (!segments.length) {
    console.log(TAG, "🪝 후킹 응답을 json3/xml 둘 다 파싱 못 함")
    return
  }
  // 같은 영상에 대해 추출이 진행 중이면 그 Promise 를 즉시 결과로 깨움
  const p = pending.get(videoId)
  if (p && !p.resolved) {
    p.resolved = true
    p.resolve({ segments, format })
  }
}

// YouTube player API 를 호출해 자막 로드를 강제 트리거 → 후킹이 그 fetch 응답을 잡음
function triggerPlayerCaptionLoad(track: {
  lang: string
  kind: string
}): boolean {
  const player = document.querySelector("#movie_player") as any
  if (!player) {
    console.log(TAG, "🎬 movie_player 엘리먼트 없음 (player 미로드 상태)")
    return false
  }
  let triggered = false
  // 방법 1: 자막 모듈 로드 강제 (player 가 자막 트랙을 fetch 시작)
  try {
    if (typeof player.loadModule === "function") {
      player.loadModule("captions")
      triggered = true
      console.log(TAG, '🎬 player.loadModule("captions") 호출 완료')
    }
  } catch (e) {
    console.log(TAG, "🎬 loadModule 실패:", (e as Error).message)
  }
  // 방법 2: 특정 언어 트랙 명시 + reload 플래그로 캐시 무시하고 재요청
  try {
    if (typeof player.setOption === "function") {
      player.setOption("captions", "reload", true)
      player.setOption("captions", "track", { languageCode: track.lang })
      triggered = true
      console.log(TAG, `🎬 player.setOption track lang=${track.lang} 호출 완료`)
    }
  } catch (e) {
    // setOption 은 첫 호출 시 throw 가 종종 있음 — 정상 동작에 영향 없음
    console.log(TAG, "🎬 setOption 일부 실패 (정상 가능):", (e as Error).message)
  }
  return triggered
}

// SPA 전환 직후 ytInitialPlayerResponse 가 아직 이전 영상 데이터일 수 있어 폴링이 필요.
// 단 Shorts 는 스와이프 전환 시 ytInitialPlayerResponse 가 절대 갱신되지 않으므로,
// 짧은 타임아웃으로 시도하고 안 맞으면 null 반환 (호출 측에서 후킹 경로로 폴백)
async function pollPlayerResponseMatching(
  targetVideoId: string,
  timeoutMs: number = 1500
): Promise<any | null> {
  const start = Date.now()
  // videoId 가 일치할 때까지 100ms 간격으로 재확인
  while (Date.now() - start < timeoutMs) {
    const pr = (window as any).ytInitialPlayerResponse
    if (pr?.videoDetails?.videoId === targetVideoId) return pr
    await sleep(100)
  }
  // 타임아웃 — Shorts 거나 SPA race 가 길어진 경우. 호출자가 후킹 경로로 fallback.
  const pr = (window as any).ytInitialPlayerResponse
  const isShorts = location.pathname.startsWith("/shorts/")
  console.log(
    TAG,
    `⚠️ playerResponse 매칭 실패 (${timeoutMs}ms) — ${isShorts ? "Shorts 스와이프(정상)" : "race 가능성"}, 후킹 경로로 폴백`,
    { 원하는영상: targetVideoId, 현재영상: pr?.videoDetails?.videoId }
  )
  return null
}

// MAIN → ISOLATED 로 결과를 흘려보내는 단일 게이트 (origin 명시로 외부 페이지 leak 방지)
function dispatch(msg: CaptionsResultMessage): void {
  window.postMessage({ tag: POSTMSG_TAG, msg }, location.origin)
}

// videoId 한 건에 대한 추출 파이프라인 — 단계별로 console.log 남겨 디버깅 용이
async function extractAndDispatch(videoId: string): Promise<void> {
  // ── 1단계: 추출 진입 ──────────────────────────────────────────
  console.log(TAG, "🟢 1단계 시작 - 영상 ID:", videoId, "(자막 추출 파이프라인 진입)")
  // 같은 탭 내 재방문은 skip — 광고 탐지 단계에서 storage 만 다시 조회하면 됨
  if (processed.has(videoId)) {
    console.log(TAG, "⏭️ 1단계 스킵 - 이 영상은 같은 탭 세션에서 이미 처리됨:", videoId)
    return
  }
  processed.add(videoId)

  // ── 후킹 대기 등록 ───────────────────────────────────────────
  // playerResponse 가 있든 없든 후킹 경로는 항상 가능하게 미리 등록한다 (Shorts 대응)
  let hijackResolveFn: (v: HijackResult | null) => void = () => {}
  const hijackPromise = new Promise<HijackResult | null>((r) => {
    hijackResolveFn = r
  })
  pending.set(videoId, { resolve: hijackResolveFn, resolved: false })

  // ── 2단계: playerResponse 매칭 시도 (선택사항) ────────────────
  // 일반 영상은 보통 매칭됨, Shorts 스와이프는 매칭 실패가 정상 — 어느 쪽이든 후킹으로 진행
  console.log(TAG, "🔄 2단계 - playerResponse 매칭 시도 (Shorts 는 실패가 정상, 후킹으로 폴백)")
  const pr = await pollPlayerResponseMatching(videoId, 1500)

  // ── 3단계: 트랙 정보 추출 (있으면 player 트리거 + 직접 fetch, 없으면 후킹 only) ──
  let track: ReturnType<typeof pickCaptionTrack> = null
  let directPromise: Promise<HijackResult | null> = Promise.resolve(null)

  if (pr) {
    track = pickCaptionTrack(pr)
    if (track) {
      console.log(
        TAG,
        `✅ 3단계 성공 - 트랙: 언어=${track.lang}, 종류=${track.kind === "asr" ? "자동(ASR)" : "수동"}`
      )
      // player API 로 자막 로드 강제 → 후킹이 그 응답을 잡음
      triggerPlayerCaptionLoad(track)
      // 직접 fetch 도 동시 시도 (PoToken 차단 안 된 영상에선 이게 더 빠름)
      directPromise = fetchCaptionTrack(track.baseUrl, TAG).then((r) =>
        "error" in r ? null : { segments: r.segments, format: r.format }
      )
    } else {
      console.log(TAG, "⚠️ 3단계 - playerResponse는 매칭됐으나 자막 트랙 메타 없음. 후킹만 대기")
    }
  } else {
    // Shorts 또는 SPA race — 트랙 메타 없이 후킹에 의존
    // YouTube Shorts 는 자동재생 시 자막을 자동 fetch 하므로 후킹이 잡을 가능성 높음
    console.log(TAG, "🪝 3단계 스킵 - 후킹 only 모드 (Shorts 또는 metadata 부재)")
  }

  // ── 4단계: 후킹 / 직접fetch / 타임아웃 race ───────────────────
  console.log(TAG, "📥 4단계 - 자막 응답 대기 (후킹 우선, 8초 타임아웃)")
  const winner = await Promise.race([
    // 직접 fetch 가 성공하면 채택, 실패면 영원히 pending (race 탈락)
    directPromise.then(
      (r) => r || new Promise<HijackResult | null>(() => {})
    ),
    // 후킹이 성공하면 채택, 실패면 영원히 pending (race 탈락)
    hijackPromise.then(
      (r) => r || new Promise<HijackResult | null>(() => {})
    ),
    // 어느 것도 8초 내 안 오면 null 로 종료
    sleep(8000).then(() => null as HijackResult | null)
  ])

  // 어떤 결과든 pending 정리 (메모리 누수 방지)
  pending.delete(videoId)

  if (!winner) {
    // 후킹도 못 잡으면 자막 없거나 사용자가 자막을 한 번도 안 켠 상태
    console.log(
      TAG,
      "❌ 4단계 실패 - 8초 내 응답 없음. 자막 없는 영상이거나 player 가 자막을 fetch 하지 않음 (CC 버튼 클릭 시도 권장)"
    )
    dispatch({
      type: "CAPTIONS_ERROR",
      payload: {
        videoId,
        reason: track ? "all main-world paths failed" : "no_captions",
        source: "main-world"
      }
    })
    return
  }
  const segments = winner.segments
  console.log(
    TAG,
    `✅ 4단계 성공 - 사용 포맷: ${winner.format}, 자막 라인 수: ${segments.length}`
  )

  // ── 5단계: 결과 전달 ─────────────────────────────────────────
  // 최종 결과를 ISOLATED bridge 로 흘려보낸다 (이후 background 가 storage 저장)
  // track 메타가 없을 수 있음(Shorts) — 그 경우 후킹 응답에서 추정하거나 unknown 으로 표기
  const lang = track?.lang ?? "unknown"
  const kind = track?.kind ?? "manual"
  dispatch({
    type: "CAPTIONS_RESULT",
    payload: {
      videoId,
      lang,
      kind,
      segments,
      source: "main-world"
    }
  })
  console.log(TAG, "🎉 5단계 완료 - 결과를 bridge로 전달함:", {
    영상ID: videoId,
    언어: lang,
    종류: kind === "asr" ? "자동(ASR)" : "수동",
    자막라인수: segments.length,
    출처: track ? "playerResponse+후킹" : "후킹only(Shorts)"
  })
}

// URL 이 영상/Shorts 페이지면 추출 트리거
function onLocationMaybeChanged(): void {
  const videoId = getVideoIdFromUrl(location.href)
  // 홈/검색 등 영상 아닌 페이지는 무시
  if (!videoId) return
  void extractAndDispatch(videoId)
}

console.log(TAG, "📌 MAIN world 스크립트 로드됨 (페이지 컨텍스트). 현재 URL:", location.href)

// YouTube 가 SPA 라우팅 완료 시점에 발생시키는 커스텀 이벤트 — 가장 신뢰할 수 있는 트리거
window.addEventListener("yt-navigate-finish", () => {
  console.log(TAG, "🚀 SPA 전환 감지 (yt-navigate-finish 이벤트). 새 URL:", location.href)
  onLocationMaybeChanged()
})

// 안전망: yt-navigate-finish 가 발화하지 않는 변형 페이지 대비 URL 변경 폴링
let lastUrl = location.href
setInterval(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href
    console.log(TAG, "🔁 URL 변경 감지 (1초 폴링 백업). 새 URL:", location.href)
    onLocationMaybeChanged()
  }
}, 1000)

// 첫 로딩 시점에는 yt-navigate-finish 가 이미 지나갔을 수 있으므로 한 번 즉시 시도
onLocationMaybeChanged()
