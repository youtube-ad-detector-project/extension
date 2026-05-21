// 예전엔 Plan A/B 의 자막 트랙 선택·파싱·fetch 가 전부 여기 있었지만, STT-only 로 가며 다 들어냈다.
//   지금 남은 책임은 하나 — URL 에서 영상 ID 뽑기. (youtube-shorts.ts 와 overlay 가 SPA 전환 추적에 쓴다)

// /watch?v=... 와 /shorts/... 두 형태에서 영상 ID 추출 (없으면 null)
//   무엇이 들어가 → 처리 → 무엇이 반환: location.href(문자열) → videoId(string|null)
export function getVideoIdFromUrl(href: string): string | null {
  try {
    const u = new URL(href)
    // 일반 영상: ?v= 쿼리
    const v = u.searchParams.get("v")
    if (v) return v
    // Shorts: /shorts/<id> 경로
    const m = u.pathname.match(/\/shorts\/([^/?#]+)/)
    if (m) return m[1]
    return null
  } catch {
    return null
  }
}
