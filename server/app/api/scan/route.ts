// POST /api/scan — "링크 1개 → 붙여넣을 JSON 1개" 동기 엔드포인트 (자동화 진입점)
//   호출 흐름: 오케스트레이터(Claude/스크립트)가 숏츠 링크마다 여기를 1회 호출 →
//   yt-dlp 다운로드 → Whisper STT → 룰 엔진(scanCaptions) → buildDataset →
//   응답: { videoId, summary, dataset } — dataset 이 지금 손으로 복사하던 그 JSON.
//
//   왜 기존 /api/transcribe(잡+폴링)와 따로 두는지: 그쪽은 확장이 진행도를 보여주려 비동기 폴링 구조다.
//   자동화는 "던지면 최종 JSON 이 한 번에 온다"가 편하므로, 여기선 끝까지 await 하는 동기 응답으로 만든다.

import { unlink } from "node:fs/promises"
import { NextResponse } from "next/server"
import { downloadAudio } from "@/lib/ytdlp"
import { transcribe } from "@/lib/whisper"
// 룰 엔진은 루트 lib/ 에 있다 (확장과 공유). 순수 함수라 서버에서도 그대로 import 가능.
//   scanCaptions: 세그먼트[] → ScannedLine[](상태 부착), buildDataset: ScannedLine[] → [{text,status}]
import { scanCaptions, summarize, pickFlagged } from "../../../../lib/adScan"
import { buildDataset } from "../../../../lib/datasetExport"

// 전사가 수십 초~분 단위라 라우트가 중간에 끊기지 않도록 동적 + 충분한 실행시간 확보
export const dynamic = "force-dynamic"
export const maxDuration = 300

// 입력으로 url 또는 videoId 를 모두 허용 → 항상 videoId 로 정규화
//   허용 형태: 11자리 videoId, youtube.com/shorts/ID, youtu.be/ID, watch?v=ID
function extractVideoId(input: string): string | null {
  const s = input.trim()
  // 이미 순수 videoId 면 그대로 사용 (YouTube id 는 11자, [A-Za-z0-9_-])
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s

  // URL 패턴들에서 11자 id 추출 — shorts / youtu.be / watch?v 순으로 시도
  const patterns = [
    /youtube\.com\/shorts\/([A-Za-z0-9_-]{11})/,
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /[?&]v=([A-Za-z0-9_-]{11})/
  ]
  for (const re of patterns) {
    const m = s.match(re)
    if (m) return m[1]
  }
  return null
}

export async function POST(req: Request) {
  // 입력 파싱 — url 또는 videoId 중 하나는 있어야 함
  const body = (await req.json().catch(() => null)) as
    | { url?: string; videoId?: string }
    | null
  const raw = body?.videoId || body?.url || ""
  const videoId = extractVideoId(raw)
  if (!videoId) {
    return NextResponse.json(
      { error: "url 또는 videoId 가 필요합니다 (유효한 YouTube 링크/ID)" },
      { status: 400 }
    )
  }

  // jobId 대용 식별자 — 동기 처리라 잡 큐는 안 쓰고 tmp 파일명 구분용으로만 쓴다
  const tag = `scan-${videoId}-${process.hrtime.bigint()}`
  let mp3Path: string | null = null

  try {
    // 1단계: 다운로드 → mp3 경로
    mp3Path = await downloadAudio(tag, videoId)

    // 2단계: STT → {lang, segments}. segments 는 {start,dur,text} (룰 엔진 입력 형태와 동일)
    const { lang, segments } = await transcribe(mp3Path)

    // 3단계: 룰 엔진 → 상태 부착 → 두 갈래 출력
    //   데이터 형태 변화: segments → ScannedLine[](status 부착) → ① [{text,status}] 축약본  ② 걸린 줄만(근거 보존)
    const scanned = scanCaptions(segments)
    const dataset = buildDataset(scanned)
    // flagged: rule 출력 형식 그대로(근거 포함) + 정상 줄 제외 — 외부에 "걸린 줄만" 줄 때 사용
    const flagged = pickFlagged(scanned)
    const summary = summarize(scanned)

    // 응답: dataset(축약 학습용) + flagged(걸린 줄만) + scanned(모든 줄, 정상 포함 rule 형식 그대로)
    return NextResponse.json({ videoId, lang, summary, dataset, flagged, scanned })
  } catch (e) {
    // 어느 단계에서 터졌는지 reason 그대로 노출 (학습용 — 가공 안 함)
    const reason = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ videoId, error: reason }, { status: 500 })
  } finally {
    // mp3 정리 — 다운로드 성공 시에만 존재. cleanup 실패는 응답에 영향 주지 않음
    if (mp3Path) {
      try {
        await unlink(mp3Path)
      } catch (e) {
        console.error(
          `[scan] tmp 정리 실패 (${mp3Path}):`,
          e instanceof Error ? e.message : e
        )
      }
    }
  }
}
