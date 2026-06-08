// HuggingFace Inference 분류 어댑터 — 룰 엔진이 1차로 걸러낸 "위반·의심" 문장을 파인튜닝 모델로 2차 검증한다.
//   호출 흐름: /api/classify 라우트가 texts[] 를 넘기면 → 문장마다 HF 라우터를 1회씩 호출 →
//   {label, score} 를 받아 "정상이 아니면 위법" 규칙으로 isViolation 을 붙여 Verdict[] 로 반환.
//   왜 문장마다 1회: 명세 예시가 inputs=단일 문자열 → [{label,score}] 단일 응답 모양이라, 그 계약에 정확히 맞춘다.

// 기본 모델/provider — 환경변수가 없을 때만 쓰는 학습용 기본값이다.
const DEFAULT_HF_MODEL = "wldn/korean-text-classification-model"
const DEFAULT_HF_PROVIDER = "hf-inference"

// HF 호출 URL 결정 — 같은 payload 를 쓰되, 모델/provider 또는 전용 Endpoint 를 .env 에서 바꿀 수 있게 한다.
function getHfUrl(): string {
  // 전용 Inference Endpoint 를 만든 경우 provider 라우터를 거치면 안 되므로 URL 을 그대로 우선 사용한다.
  const directUrl = process.env.HF_CLASSIFY_URL?.trim()
  if (directUrl) {
    return directUrl
  }

  // provider 라우터는 "모든 Hub 모델"이 아니라 "provider 가 지원하는 모델"만 받기 때문에 설정으로 드러낸다.
  const provider = process.env.HF_CLASSIFY_PROVIDER?.trim() || DEFAULT_HF_PROVIDER
  const model = process.env.HF_CLASSIFY_MODEL?.trim() || DEFAULT_HF_MODEL
  const encodedModel = model.split("/").map(encodeURIComponent).join("/")
  return `https://router.huggingface.co/${encodeURIComponent(provider)}/models/${encodedModel}`
}

// 모델 라벨 집합은 id2label={0:안전, 1:의심}. "안전"만 비위법, 그 외(의심)는 위법으로 본다 (결정: '안전' 아니면 위법)
const SAFE_LABEL = "안전"

// 한 문장에 대한 최종 판정 모양 — 라우트가 그대로 JSON 으로 확장에 돌려준다
export type Verdict = {
  text: string
  label: string
  score: number
  isViolation: boolean
}

// 문장 1개 → HF 호출 → {label, score} → isViolation 부착.
//   무엇이 들어가 → 처리 → 무엇이 반환: text(string)+token → HF top-1 분류 → Verdict 1개
async function classifyOne(text: string, token: string | undefined): Promise<Verdict> {
  // 로컬/전용 URL 은 토큰이 필요 없어, 토큰이 있을 때만 Authorization 헤더를 붙인다 (HF 라우터로 갈 때만 필수)
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (token) headers.Authorization = `Bearer ${token}`

  // 명세 바디: inputs=문장, top_k=1(최상위 라벨만), softmax(점수를 확률로)
  const res = await fetch(getHfUrl(), {
    method: "POST",
    headers,
    body: JSON.stringify({
      inputs: text,
      parameters: { top_k: 1, function_to_apply: "softmax" }
    })
  })

  if (!res.ok) {
    // 상태코드를 reason 에 박아 어디서 막혔는지 즉시 판별 (401 토큰 / 503 모델 로딩 등)
    const body = await res.text().catch(() => "")
    if (res.status === 400 && body.includes("Model not supported by provider")) {
      throw new Error(
        `hf_model_not_supported: ${body.slice(0, 160)} | set HF_CLASSIFY_URL or change HF_CLASSIFY_MODEL/HF_CLASSIFY_PROVIDER`
      )
    }
    throw new Error(`hf_http_${res.status}: ${body.slice(0, 200)}`)
  }

  // 응답 모양: [{label, score}] — top_k=1 이라 길이 1 배열. 깨졌으면 명시적으로 실패시킨다
  const data = (await res.json()) as { label: string; score: number }[]
  const top = Array.isArray(data) ? data[0] : undefined
  if (!top || typeof top.label !== "string") {
    throw new Error("hf_bad_response")
  }

  // 데이터 형태 변화: {label, score} → Verdict (isViolation 규칙 적용)
  return {
    text,
    label: top.label,
    score: top.score,
    isViolation: top.label !== SAFE_LABEL
  }
}

// texts[] → 문장마다 classifyOne → Verdict[].
//   왜 순차 await: 학습용 최소 구조 — 동시성/재시도 없이 입력 순서를 그대로 1:1 유지해, 확장이 인덱스로 줄에 매핑할 수 있게.
//   키는 process.env.HF_TOKEN 에서 읽는다 (whisper.ts 의 GROQ_API_KEY 와 같은 규칙).
export async function classifyTexts(texts: string[]): Promise<Verdict[]> {
  const token = process.env.HF_TOKEN
  // 토큰은 HF 라우터(공개 인프라)로 갈 때만 필수. HF_CLASSIFY_URL(로컬/전용 Endpoint)이면 토큰 없이 호출 가능.
  if (!token && !process.env.HF_CLASSIFY_URL?.trim()) {
    throw new Error("hf_token_missing")
  }

  // 입력 순서 보존이 핵심이라 for 루프로 누적 (map+Promise.all 은 순서는 같지만 동시 호출이라 최소 구조에서 제외)
  const verdicts: Verdict[] = []
  for (const text of texts) {
    verdicts.push(await classifyOne(text, token))
  }
  return verdicts
}

// ── 2차 보고서용 "원리 분해" — 로컬 infer 서버의 /explain 만 제공(HF 라우터는 토큰/로짓을 안 줌) ──

// 한 문장의 모델 내부 동작 — 토큰화/로짓/확률까지 펼친 모양
export type ExplainItem = {
  text: string
  tokens: string[] // 모델이 본 토큰들 (사람이 읽게 디코딩된 한글)
  logits: Record<string, number> // softmax 전 class 별 원시 점수 {안전, 의심}
  probs: Record<string, number> // softmax 후 확률
  label: string
  score: number
  isViolation: boolean
}

// /explain URL — HF_CLASSIFY_URL(.../classify) 끝을 /explain 으로 치환해 같은 로컬 서버를 가리킨다.
//   왜 로컬 전용: 토큰/로짓 같은 내부값은 HF 라우터가 주지 않으므로, HF_CLASSIFY_URL 이 없으면 설명 자체가 불가하다.
function getExplainUrl(): string {
  const url = process.env.HF_CLASSIFY_URL?.trim()
  if (!url) {
    throw new Error("explain_requires_local_infer: HF_CLASSIFY_URL 미설정")
  }
  return url.replace(/\/classify$/, "/explain")
}

// texts[] → 문장마다 /explain 호출 → ExplainItem[] (입력 순서 1:1 유지).
export async function explainTexts(texts: string[]): Promise<ExplainItem[]> {
  const explainUrl = getExplainUrl()
  const items: ExplainItem[] = []
  for (const text of texts) {
    const res = await fetch(explainUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inputs: text })
    })
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw new Error(`explain_http_${res.status}: ${body.slice(0, 200)}`)
    }
    // 응답 모양: {tokens, logits, probs, label, score} — isViolation 만 여기서 붙인다
    const d = (await res.json()) as Omit<ExplainItem, "text" | "isViolation">
    items.push({ text, ...d, isViolation: d.label !== SAFE_LABEL })
  }
  return items
}
