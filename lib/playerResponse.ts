// Plan B 폴백에서 watch HTML 에 박혀있는 ytInitialPlayerResponse JSON 을 추출한다.
// 정규식 한 방은 escape 된 문자열 안의 } 때문에 fragile → balanced-bracket 파서 사용.

// HTML 안에서 player response 가 시작하는 식별자 (변형 두 가지 모두 지원)
const MARKERS = [
  "var ytInitialPlayerResponse = ",
  "ytInitialPlayerResponse = "
]

// 마커를 찾고 그 뒤의 JSON 객체 끝을 정확히 짚어 JSON.parse
export function extractPlayerResponse(html: string): any | null {
  for (const marker of MARKERS) {
    // 마커 위치 탐색 — 없으면 다음 변형으로
    const idx = html.indexOf(marker)
    if (idx === -1) continue
    // 마커 뒤의 첫 '{' 가 JSON 시작
    const start = html.indexOf("{", idx + marker.length)
    if (start === -1) continue
    // 매칭되는 '}' 위치를 balanced 로 찾는다
    const end = findJsonEnd(html, start)
    if (end === -1) continue
    const slice = html.slice(start, end + 1)
    try {
      return JSON.parse(slice)
    } catch {
      // parse 실패 시 다음 마커 후보로 넘어간다
      continue
    }
  }
  return null
}

// 문자열/escape 를 인지하는 brace counter — 따옴표 안의 }는 무시
function findJsonEnd(s: string, start: number): number {
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (inString) {
      // 문자열 안에서는 escape 된 다음 글자 1개만 통과시키고, 닫는 따옴표만 인지
      if (escape) {
        escape = false
      } else if (c === "\\") {
        escape = true
      } else if (c === '"') {
        inString = false
      }
      continue
    }
    if (c === '"') {
      // 문자열 시작
      inString = true
      continue
    }
    // 일반 코드 영역에서만 brace 카운팅
    if (c === "{") depth++
    else if (c === "}") {
      depth--
      // depth 가 0이 되는 순간이 최외곽 객체의 닫힘
      if (depth === 0) return i
    }
  }
  return -1
}
