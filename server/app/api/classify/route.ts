// POST /api/classify — 룰 엔진이 1차로 걸러낸 위반·의심 문장 배열을 AI 모델로 2차 검증하는 엔드포인트.
//   호출 흐름: 오버레이가 flagged 문장 추출 → background(CLASSIFY 메시지) → 여기 → classifyTexts(HF) → Verdict[] 반환.
//   왜 서버에 두는지: HF_TOKEN 을 .env 에 숨겨 확장 번들에 노출되지 않게 한다 (사용자 결정: 서버 프록시).

import { NextResponse } from "next/server"
import { classifyTexts } from "@/lib/hfClassify"

// HF 호출이 문장 수만큼 순차로 누적되면 길어질 수 있어 동적 + 넉넉한 실행시간 확보
export const dynamic = "force-dynamic"
export const maxDuration = 120

export async function POST(req: Request) {
  // 입력 파싱 — texts(string[]) 필수
  const body = (await req.json().catch(() => null)) as { texts?: string[] } | null
  if (!body || !Array.isArray(body.texts)) {
    return NextResponse.json(
      { error: "texts(string[]) required" },
      { status: 400 }
    )
  }
  // 걸린 문장이 0개면 HF 호출 없이 빈 결과로 단락 (불필요한 토큰 소모 방지)
  if (body.texts.length === 0) {
    return NextResponse.json({ results: [] })
  }

  try {
    // texts[] → Verdict[](label/score/isViolation). 입력 순서 그대로 1:1 반환
    const results = await classifyTexts(body.texts)
    return NextResponse.json({ results })
  } catch (e) {
    // 어느 문장/단계에서 터졌는지 reason 그대로 노출 (학습용 — 가공 안 함)
    const reason = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: reason }, { status: 500 })
  }
}
