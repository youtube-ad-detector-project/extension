// POST /api/transcribe — 잡 생성 진입점
//   호출 흐름: 확장 background.runPlanE → 여기 → createJob → runPipeline (await 안 함, 즉시 반환)
//   응답 즉시 반환 후 백그라운드에서 다운로드/전사가 진행된다.

import { NextResponse } from "next/server"
import { createJob } from "@/lib/jobs"
import { runPipeline } from "@/lib/pipeline"

export async function POST(req: Request) {
  // 입력 파싱 — videoId 필수, 그 외 필드는 무시
  const body = (await req.json().catch(() => null)) as { videoId?: string } | null
  if (!body || typeof body.videoId !== "string" || body.videoId.length === 0) {
    return NextResponse.json({ error: "videoId required" }, { status: 400 })
  }

  // 잡 등록 → id 받음. 이 시점에 잡 상태는 'pending'.
  const jobId = createJob(body.videoId)

  // 비동기 파이프라인 시작 — 라우트는 응답을 즉시 반환하고, 잡은 모듈 스코프에서 계속 진행
  //   void 로 명시 (Promise 무시 의도)
  void runPipeline(jobId, body.videoId)

  return NextResponse.json({ jobId })
}
