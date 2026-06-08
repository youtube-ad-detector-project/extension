// Service worker. STT-only 로 정리 후 책임 두 가지:
//   1) youtube-shorts.ts 가 보낸 REQUEST_STT 를 받아 STT 잡을 띄우고(runPlanE) 결과를 storage 에 적재
//   2) overlay 의 OPEN_REPORT 를 받아 보고서 탭 열기 (콘텐츠 스크립트는 chrome.tabs 불가라 여기서)
//   Plan A(main-world 후킹)·Plan B(HTML refetch)는 Shorts 에서 무용해 통째로 제거됨.

import type {
  CaptionsPayload,
  ClassifyResponse,
  ClassifyVerdict,
  RuntimeMessage
} from "./lib/messages"
import {
  saveCaption,
  saveCaptionError,
  saveCaptionPending
} from "./lib/storage"

const TAG = "[yt-cap:bg]"

// STT 서버 주소 — 학습용이라 하드코딩 (host_permissions 에 동일 값이 있어야 함)
const STT_SERVER = "http://localhost:3000"

// 동일 영상 중복 폴링 방지용 — 같은 videoId 로 두 번째 요청이 와도 setInterval 한 개만 돌게
const planEIntervals = new Map<string, ReturnType<typeof setInterval>>()

console.log(TAG, "📌 service worker 시작됨 (STT 잡 처리 + 보고서 탭 담당)")

// 단일 진입점: 메시지를 type 으로 분기 (STT 트리거 / 보고서 / AI 검증)
//   sendResponse: CLASSIFY 만 응답을 돌려줘야 해서 세 번째 인자로 받는다 (나머지는 fire-and-forget)
chrome.runtime.onMessage.addListener((msg: RuntimeMessage, sender, sendResponse) => {
  console.log(
    TAG,
    `📨 메시지 수신: 종류=${msg.type}, 보낸 탭=${sender.tab?.id ?? "unknown"}`
  )

  if (msg.type === "REQUEST_STT") {
    // Shorts 감지 스크립트가 "이 영상 STT 돌려라" 요청 → STT 잡 시작
    void runPlanE(msg.videoId)
    return false
  }

  if (msg.type === "OPEN_REPORT") {
    // 오버레이 링크 클릭 → 상세 보고서 탭 열기 (kind 로 1차 룰/2차 AI 분기)
    openReport(msg.videoId, msg.kind ?? "rule")
    return false
  }

  if (msg.type === "CLASSIFY") {
    // 오버레이가 룰에서 걸린 문장 배열을 검증 요청 → 서버로 프록시 후 결과를 sendResponse 로 돌려준다.
    //   MV3 Chrome 규칙: 비동기 응답이라 채널을 열어두려면 반드시 true 를 반환해야 한다
    void classifyViaServer(msg.texts).then(sendResponse)
    return true
  }

  return false
})

// videoId → 확장 내부 보고서 탭 1개 생성 (side-effect 만).
//   getURL: tabs/report*.tsx 가 Plasmo 빌드 시 tabs/report*.html 로 떨어지며 확장 절대 URL 로 변환됨
//   kind: rule→report.html(1차 룰 근거) · ai→report2.html(2차 AI 동작) · final→report3.html(최종 종합). ?v= 로 어떤 영상인지 전달.
function openReport(videoId: string, kind: "rule" | "ai" | "final"): void {
  const page =
    kind === "ai"
      ? "tabs/report2.html"
      : kind === "final"
        ? "tabs/report3.html"
        : "tabs/report.html"
  const url = chrome.runtime.getURL(`${page}?v=${encodeURIComponent(videoId)}`)
  console.log(TAG, `📄 보고서 탭 열기: 영상=${videoId}, 종류=${kind}, url=${url}`)
  void chrome.tabs.create({ url })
}

// flagged 문장 배열 → 서버 /api/classify → ClassifyResponse(성공 verdicts / 실패 reason).
//   왜 background 에서 fetch: 콘텐츠 스크립트(오버레이)의 cross-origin 요청은 CORS 에 막히지만,
//   service worker 는 host_permissions(localhost:3000)로 서버를 직접 부를 수 있다 (STT 와 같은 경로).
//   무엇이 들어가 → 처리 → 무엇이 반환: texts(string[]) → HF 프록시 → 입력과 1:1 순서의 verdicts
async function classifyViaServer(texts: string[]): Promise<ClassifyResponse> {
  console.log(TAG, `🤖 AI 검증 요청: ${texts.length}문장 → ${STT_SERVER}/api/classify`)
  try {
    const res = await fetch(`${STT_SERVER}/api/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texts })
    })
    if (!res.ok) {
      // 서버가 실패하면 { error } 를 그대로 붙여 원인(hf_token_missing / hf_http_503 모델 로딩 등)을 가리지 않는다
      const errBody = (await res.json().catch(() => null)) as { error?: string } | null
      throw new Error(
        errBody?.error ? `http ${res.status}: ${errBody.error}` : `http ${res.status}`
      )
    }
    // 응답: { results: Verdict[] } — 서버가 isViolation 까지 계산해 준 상태
    const body = (await res.json()) as { results?: ClassifyVerdict[] }
    if (!Array.isArray(body.results)) {
      throw new Error("bad_response")
    }
    const positives = body.results.filter((v) => v.isViolation).length
    console.log(
      TAG,
      `✅ AI 검증 완료: 위법 ${positives} / 검증 ${body.results.length}`
    )
    return { ok: true, verdicts: body.results }
  } catch (e) {
    // fetch 실패(서버 다운)는 TypeError — 그 외는 메시지 그대로 노출
    const reason =
      e instanceof TypeError
        ? "classify: server_unreachable"
        : `classify: ${e instanceof Error ? e.message : String(e)}`
    console.log(TAG, `❌ AI 검증 실패: ${reason}`)
    return { ok: false, reason }
  }
}

// STT 잡 등록 → 5초 폴링 → 결과를 saveCaption/saveCaptionError 로 수렴
//   호출 흐름: onMessage(REQUEST_STT) → runPlanE → POST /api/transcribe → setInterval(poll)
async function runPlanE(videoId: string): Promise<void> {
  // 같은 영상에 대해 이미 폴링이 돌고 있으면 중복 잡 만들지 않음
  if (planEIntervals.has(videoId)) {
    console.log(TAG, `🔁 STT 중복 호출 무시: 영상=${videoId} (이미 폴링 중)`)
    return
  }
  console.log(TAG, `🎤 STT 시작: 영상=${videoId}, 서버=${STT_SERVER}`)

  // 1) 잡 생성 — POST /api/transcribe { videoId } → { jobId }
  let jobId: string
  try {
    const res = await fetch(`${STT_SERVER}/api/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoId })
    })
    if (!res.ok) {
      // 서버는 떠 있는데 400/500 → http 코드로 단순화
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
    console.log(TAG, `❌ STT 잡 생성 실패: ${reason}`)
    await saveCaptionError(videoId, { videoId, reason, source: "stt-fallback" })
    return
  }
  console.log(TAG, `📥 STT 잡 생성됨: jobId=${jobId}`)

  // 잡 생성 직후 storage 를 'pending(queued)' 로 마킹 — overlay 가 진행 상태 인식 가능
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
//   응답 status 별 분기: pending/processing → 진행 갱신, done → 성공 저장+정리, failed → 에러 저장+정리
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
    console.log(TAG, `❌ STT 폴링 실패: 영상=${videoId}, ${reason}`)
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
    // stage 가 바뀌었으면 storage 갱신 (overlay 가 "다운로드 중 → 전사 중" 보여줄 수 있게)
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
    if (!Array.isArray(body.segments) || typeof body.lang !== "string") {
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
      `🎉 STT 성공: 영상=${videoId}, 언어=${body.lang}, 라인수=${body.segments.length}`
    )
    stopPlanE(videoId)
    return
  }
  if (body.status === "failed") {
    // 서버에서 yt-dlp 또는 Whisper 가 터진 케이스 — reason 을 그대로 prefix 붙여 저장
    const reason = `stt: ${body.reason ?? "unknown"}`
    console.log(TAG, `❌ STT 잡 실패: 영상=${videoId}, ${reason}`)
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
