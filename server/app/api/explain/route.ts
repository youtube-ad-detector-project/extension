// POST /api/explain — 2차 보고서 페이지가 "모델 동작 과정"(토큰화/로짓/확률)을 그릴 때 부르는 엔드포인트.
//   호출 흐름: tabs/report2.tsx → 여기 → explainTexts(로컬 infer /explain) → ExplainItem[] 반환.
//   왜 /api/classify 와 분리: 일반 검증은 [{label,score}] 면 충분하지만, 보고서는 내부값까지 필요해 무겁다 → 경로를 나눈다.

import { NextResponse } from "next/server"
import { explainTexts } from "@/lib/hfClassify"

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
  if (body.texts.length === 0) {
    return NextResponse.json({ results: [] })
  }

  try {
    // texts[] → ExplainItem[](tokens/logits/probs/label/score/isViolation), 입력 순서 1:1
    const results = await explainTexts(body.texts)
    return NextResponse.json({ results })
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: reason }, { status: 500 })
  }
}
