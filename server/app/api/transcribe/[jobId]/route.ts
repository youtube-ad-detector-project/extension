// GET /api/transcribe/[jobId] — 잡 상태/결과 조회 엔드포인트
//   호출 흐름: 확장 background 의 5초 폴링 → 여기 → getJob → 상태별 응답
//   응답 모양은 status 필드로 분기되며, done 일 때만 segments 가 들어 있다.

import { NextResponse } from "next/server"
import { getJob } from "@/lib/jobs"

// 폴링 응답이 캐시되면 잡 상태 전이가 클라이언트에 안 보이므로 강제 동적 — Next 캐시 비활성화
export const dynamic = "force-dynamic"

// Next 15 의 dynamic route param 은 Promise 로 감싸짐 — await 로 풀어야 함
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params
  const job = getJob(jobId)
  if (!job) {
    return NextResponse.json({ error: "job not found" }, { status: 404 })
  }

  // status 별로 응답 모양을 다르게 — 확장은 status 만 보고 분기
  switch (job.status) {
    case "pending":
      return NextResponse.json({ status: "pending" })
    case "processing":
      return NextResponse.json({ status: "processing", stage: job.stage })
    case "done":
      // 확장이 그대로 CaptionsPayload 로 변환할 수 있게 lang/segments 평면화
      return NextResponse.json({
        status: "done",
        videoId: job.videoId,
        lang: job.result.lang,
        segments: job.result.segments
      })
    case "failed":
      return NextResponse.json({ status: "failed", reason: job.reason })
  }
}
