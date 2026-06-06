// 임시 드라이버(이번 테스트 전용) — 노션 토글의 숏츠 링크들을 /api/scan 에 순차로 던져
//   룰 엔진 결과(scanned, =요청 포맷)를 파일로 떨군다. 기존 파이프라인/룰 코드는 건드리지 않음.
//   호출 흐름: (이 스크립트) → POST /api/scan(다운로드+STT+룰) → 응답의 scanned 만 추려 out/<videoId>.json 저장.
//   왜 별도 파일: scan 라우트나 adScan 을 수정하지 않고 "이번만" 결과를 모으기 위함.

import { mkdir, writeFile } from "node:fs/promises"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

// 결과 저장 위치 — 이 스크립트 옆 out/ 디렉터리
const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(HERE, "out")

// 스캔 대상 — 노션 "6/6 룰 개선 출력" 페이지의 두 섹션 토글에서 그대로 옮겨옴
//   section 은 나중에 어느 토글에 채울지 매핑하는 용도
const LINKS = [
  { section: "normal_candidate", url: "https://youtube.com/shorts/PT2r3DY_2nk" },
  { section: "normal_candidate", url: "https://youtube.com/shorts/c5HzxrpKwbE" },
  { section: "normal_candidate", url: "https://youtube.com/shorts/DIrx6rnviSM" },
  { section: "normal_candidate", url: "https://youtube.com/shorts/jDP99xVHWr8" },
  { section: "normal_candidate", url: "https://youtube.com/shorts/5UHIStIa1wI" },
  { section: "normal_candidate", url: "https://youtube.com/shorts/gl3pW_MyOt4" },
  { section: "normal_candidate", url: "https://youtube.com/shorts/fjqTM5fnSok" },
  { section: "normal_candidate", url: "https://youtube.com/shorts/8TPRgLpy1nA" },
  { section: "normal_candidate", url: "https://youtube.com/shorts/rk5X2QTaFfA" },
  { section: "normal_candidate", url: "https://youtube.com/shorts/S_BLXswv60w" },
  { section: "risk_candidate", url: "https://www.youtube.com/shorts/74v3Oqb5w3U" },
  { section: "risk_candidate", url: "https://youtube.com/shorts/A1MDDnG0Z-Y" },
  { section: "risk_candidate", url: "https://youtube.com/shorts/gbpvgdEyBpE" },
  { section: "risk_candidate", url: "https://youtube.com/shorts/tVnLRD9-kJo" },
  { section: "risk_candidate", url: "https://youtube.com/shorts/2E5IoIEV8j8" },
  { section: "risk_candidate", url: "https://youtube.com/shorts/Xbkcz1M8h-Y" },
  { section: "risk_candidate", url: "https://youtube.com/shorts/1k6qHCUJCVw" }
]

const API = "http://localhost:3000/api/scan"

// 링크 1개 처리 — POST 후 응답에서 videoId/scanned 만 추린다. 실패해도 흐름은 끊지 않고 error 를 기록.
async function scanOne({ section, url }) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url })
  })
  // /api/scan 은 성공/실패 모두 JSON — 그대로 받아서 분기
  const data = await res.json()
  return { section, url, videoId: data.videoId, summary: data.summary, scanned: data.scanned, error: data.error }
}

// 메인: out/ 보장 → 순차 처리(Groq/yt-dlp 동시성 부담 회피) → videoId별 scanned 저장 + 인덱스 1개
async function main() {
  await mkdir(OUT_DIR, { recursive: true })
  const index = []

  // for-of 순차: 한 영상씩 끝까지 기다린다(병렬 시 rate limit/다운로드 충돌 위험)
  for (let i = 0; i < LINKS.length; i++) {
    const item = LINKS[i]
    process.stdout.write(`[${i + 1}/${LINKS.length}] ${item.url} ... `)
    try {
      const r = await scanOne(item)
      if (r.error) {
        console.log(`ERROR: ${r.error}`)
      } else {
        // 요청 포맷 = scanned 배열 그대로. videoId 파일명으로 저장
        await writeFile(resolve(OUT_DIR, `${r.videoId}.json`), JSON.stringify(r.scanned, null, 2))
        console.log(`ok (${r.scanned.length} lines, ${JSON.stringify(r.summary)})`)
      }
      index.push({ section: r.section, url: r.url, videoId: r.videoId, error: r.error ?? null, lines: r.scanned?.length ?? 0, summary: r.summary ?? null })
    } catch (e) {
      console.log(`FETCH FAIL: ${e.message}`)
      index.push({ section: item.section, url: item.url, videoId: null, error: e.message, lines: 0, summary: null })
    }
  }

  // 인덱스 — 어느 링크가 어느 파일/상태인지 한눈에
  await writeFile(resolve(OUT_DIR, "_index.json"), JSON.stringify(index, null, 2))
  console.log(`\nDONE → ${OUT_DIR}`)
}

main()
