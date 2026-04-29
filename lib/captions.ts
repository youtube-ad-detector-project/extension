import type { CaptionSegment } from "./messages"

// 선택된 자막 트랙의 fetch에 필요한 최소 정보
export type PickedTrack = {
  baseUrl: string
  lang: string
  kind: "manual" | "asr"
}

// playerResponse 에서 가장 적절한 자막 트랙을 고른다 (영상 원어 우선 → 수동 → 자동)
export function pickCaptionTrack(playerResponse: any): PickedTrack | null {
  // YouTube가 자막 메타를 박아두는 경로
  const renderer =
    playerResponse?.captions?.playerCaptionsTracklistRenderer
  const tracks: any[] | undefined = renderer?.captionTracks
  // 트랙 자체가 없으면 자막 비활성 영상
  if (!tracks?.length) return null

  // 영상 기본 오디오 언어에 매칭되는 자막을 1순위로 시도
  const audioTracks = renderer?.audioTracks
  const defaultIdx = renderer?.defaultAudioTrackIndex ?? 0
  const preferredIdx = audioTracks?.[defaultIdx]?.captionTrackIndices?.[0]
  const preferred = preferredIdx != null ? tracks[preferredIdx] : null

  // 수동 자막이 있으면 ASR 보다 우선
  const manual = tracks.find((t) => t.kind !== "asr")

  // 우선순위: (영상 원어 + 수동) > 수동 > 영상 원어 > 첫 트랙
  const chosen =
    preferred && preferred.kind !== "asr"
      ? preferred
      : (manual ?? preferred ?? tracks[0])

  // baseUrl 이 없으면 fetch 자체가 불가능하므로 실패 처리
  if (!chosen?.baseUrl) return null
  return {
    baseUrl: chosen.baseUrl,
    lang: chosen.languageCode ?? "unknown",
    kind: chosen.kind === "asr" ? "asr" : "manual"
  }
}

// timedtext json3 응답을 우리 내부 segment 배열로 변환
export function parseJson3(json: any): CaptionSegment[] {
  // json3 의 자막 라인은 events[] 에 들어있고 segs[] 가 실제 텍스트 조각
  const events: any[] = json?.events ?? []
  return events
    .filter((e) => e?.segs)
    .map((e) => ({
      // ms → s 단위로 정규화 (광고 탐지 단계에서 다루기 쉽게)
      start: (e.tStartMs ?? 0) / 1000,
      dur: (e.dDurationMs ?? 0) / 1000,
      // 한 라인의 segs 를 합치고 줄바꿈은 공백으로 정리
      text: e.segs
        .map((s: any) => s?.utf8 ?? "")
        .join("")
        .replace(/\n+/g, " ")
        .trim()
    }))
    // 실제 텍스트가 없는 빈 라인은 제거 (json3 에는 빈 cue 가 종종 섞임)
    .filter((s) => s.text.length > 0)
}

// XML(srv3 기본) 자막을 정규식으로 파싱 — service worker 에서도 동작 (DOMParser 없이)
export function parseXml(xml: string): CaptionSegment[] {
  // 한 라인의 자막은 <text start="..." dur="...">내용</text> 형식
  const re = /<text\s+([^>]*)>([\s\S]*?)<\/text>/g
  const out: CaptionSegment[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    // 속성 부분에서 start/dur 추출
    const attrs = m[1]
    const startStr = /start="([^"]+)"/.exec(attrs)?.[1]
    const durStr = /dur="([^"]+)"/.exec(attrs)?.[1]
    if (!startStr) continue
    // HTML/XML 엔티티 복원 후 줄바꿈 정리
    const text = decodeXmlEntities(m[2]).replace(/\n+/g, " ").trim()
    if (!text) continue
    out.push({
      start: parseFloat(startStr),
      dur: durStr ? parseFloat(durStr) : 0,
      text
    })
  }
  return out
}

// 자막 텍스트 안의 일반적인 XML/HTML 엔티티 복원
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
}

// baseUrl 에 fmt 파라미터가 이미 있으면 교체, 없으면 추가 — 중복 fmt 로 인한 빈 응답 방지
function buildUrlWithFmt(baseUrl: string, fmt: string): string {
  if (/[?&]fmt=/.test(baseUrl)) {
    return baseUrl.replace(/([?&])fmt=[^&]*/, `$1fmt=${fmt}`)
  }
  return baseUrl + (baseUrl.includes("?") ? "&" : "?") + "fmt=" + fmt
}

// baseUrl 에서 fmt 파라미터를 제거 (기본 XML 응답 받기 위해)
function stripFmt(baseUrl: string): string {
  return baseUrl.replace(/([?&])fmt=[^&]*&?/, (_, sep) => (sep === "?" ? "?" : "")).replace(/[?&]$/, "")
}

// 실제 fetch 결과
export type FetchedCaptions = {
  segments: CaptionSegment[]
  format: "json3" | "xml"
}

// json3 → XML 순으로 시도하는 통합 fetcher (Plan A 와 Plan B 가 공유)
//   - 200 + 빈 body 케이스를 XML 폴백으로 자동 회복
//   - 호출 흐름이 어디서 끊기는지 보이도록 단계마다 console.log
export async function fetchCaptionTrack(
  baseUrl: string,
  logTag: string
): Promise<FetchedCaptions | { error: string }> {
  // ── 시도 1: json3 포맷 ─────────────────────────────────────
  // 광고 탐지 단계에서 다루기 가장 쉬운 포맷이라 우선 시도
  const json3Url = buildUrlWithFmt(baseUrl, "json3")
  console.log(logTag, "  └ 시도 1: json3 포맷으로 fetch (최우선 포맷)")
  try {
    const res = await fetch(json3Url, { credentials: "include" })
    console.log(logTag, `  └ json3 HTTP 응답: ${res.status} ${res.statusText}`)
    if (res.ok) {
      const text = await res.text()
      console.log(logTag, `  └ json3 본문 길이: ${text.length} bytes`)
      // YouTube 가 200 + 빈 body 를 주는 케이스가 있어 길이로 판정
      if (text.length >= 50) {
        try {
          const segments = parseJson3(JSON.parse(text))
          if (segments.length) {
            console.log(logTag, `  └ ✅ json3 파싱 성공: ${segments.length}개 라인`)
            return { segments, format: "json3" }
          }
          console.log(logTag, "  └ ⚠️ json3 파싱은 됐으나 자막 라인 0개 → XML 폴백 진행")
        } catch (e) {
          console.log(logTag, "  └ ⚠️ json3 JSON.parse 실패 → XML 폴백 진행:", (e as Error).message)
        }
      } else {
        console.log(logTag, "  └ ⚠️ json3 본문이 너무 짧음(빈 응답) → XML 폴백 진행")
      }
    } else {
      console.log(logTag, "  └ ⚠️ json3 HTTP 실패 → XML 폴백 진행")
    }
  } catch (e) {
    console.log(logTag, "  └ ⚠️ json3 네트워크 에러 → XML 폴백 진행:", (e as Error).message)
  }

  // ── 시도 2: XML(srv3 기본) 폴백 ───────────────────────────
  // fmt 파라미터를 빼고 같은 baseUrl 재요청 — YouTube 기본 포맷이 XML
  const xmlUrl = stripFmt(baseUrl)
  console.log(logTag, "  └ 시도 2: XML 포맷으로 fetch (fmt 파라미터 제거, json3 폴백)")
  try {
    const res = await fetch(xmlUrl, { credentials: "include" })
    console.log(logTag, `  └ XML HTTP 응답: ${res.status} ${res.statusText}`)
    if (!res.ok) return { error: `xml http ${res.status}` }
    const text = await res.text()
    console.log(logTag, `  └ XML 본문 길이: ${text.length} bytes`)
    if (text.length < 50) return { error: "xml empty response" }
    const segments = parseXml(text)
    if (!segments.length) return { error: "xml parsed but 0 segments" }
    console.log(logTag, `  └ ✅ XML 파싱 성공: ${segments.length}개 라인`)
    return { segments, format: "xml" }
  } catch (e) {
    return { error: `xml fetch error: ${(e as Error).message}` }
  }
}

// /watch?v=... 와 /shorts/... 두 가지 URL 형태에서 영상 ID 추출
export function getVideoIdFromUrl(href: string): string | null {
  try {
    const u = new URL(href)
    // 일반 영상
    const v = u.searchParams.get("v")
    if (v) return v
    // Shorts
    const m = u.pathname.match(/\/shorts\/([^/?#]+)/)
    if (m) return m[1]
    return null
  } catch {
    return null
  }
}
