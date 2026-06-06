# 로컬 추론 서버 — HF 라우터가 죽은 경로라, 같은 "요청/응답 계약"을 흉내 내 모델을 직접 돌린다.
#   호출 흐름: server 의 /api/classify, /api/explain 이 여기로 POST → transformers 로 분류 → 결과 반환.
#   왜 pipeline 대신 토크나이저+모델 직접: /explain 에서 토큰/로짓 같은 "내부 동작"을 꺼내 보여주려면 중간값에 접근해야 하기 때문.

import torch
from fastapi import FastAPI
from pydantic import BaseModel
from transformers import AutoTokenizer, AutoModelForSequenceClassification

MODEL = "wldn/korean-text-classification-model"

# 모델/토크나이저 로드(프로세스 시작 시 1회) — 공개 모델이라 토큰 불필요, 최초 1회 Hub 에서 ~/.cache 로 자동 다운로드.
#   tok: 문장 → 토큰 id, model: 토큰 id → 로짓(class 별 원시 점수). id2label = {0:안전, 1:의심}
tok = AutoTokenizer.from_pretrained(MODEL)
model = AutoModelForSequenceClassification.from_pretrained(MODEL)
model.eval()  # 추론 모드 — dropout 등 학습 전용 동작 끔
id2label = model.config.id2label
NUM = len(id2label)


# 이 모델의 tokenizer.json 엔 decoder 가 없어(backend decoder: None) decode 가 byte-level 토큰을 못 되돌린다.
#   그래서 GPT-2 표준 byte↔unicode 매핑을 역으로 만들어, 토큰 문자열을 원래 바이트로 복원한 뒤 UTF-8 로 디코딩한다.
def _bytes_to_unicode() -> dict:
    bs = (
        list(range(ord("!"), ord("~") + 1))
        + list(range(ord("¡"), ord("¬") + 1))
        + list(range(ord("®"), ord("ÿ") + 1))
    )
    cs = bs[:]
    n = 0
    for b in range(256):
        if b not in bs:
            bs.append(b)
            cs.append(256 + n)
            n += 1
    # 반환: {표시문자 → 원래 바이트} (예: 'Ġ' → 0x20 공백)
    return {chr(c): b for b, c in zip(bs, cs)}


_BYTE_DECODER = _bytes_to_unicode()


def _readable(token: str) -> str:
    # 토큰의 각 표시문자를 원래 바이트로 되돌려 모은 뒤 UTF-8 디코딩 (부분 바이트면 replace 로 안전 처리)
    return bytearray(_BYTE_DECODER.get(c, 0) for c in token).decode(
        "utf-8", errors="replace"
    )


app = FastAPI()


# 요청 바디 — TS 가 보내는 {inputs, parameters} 와 동일 (parameters 는 받되 안 써도 무방)
class Req(BaseModel):
    inputs: str
    parameters: dict | None = None


# 핵심 forward — 문장 1개를 모델에 통과시켜 중간/최종값을 한 번에 뽑는다.
#   무엇이 들어가 → 처리 → 무엇이 반환: text → (토큰화 → 로짓 → softmax → argmax) → (tokens, logits, probs, top)
def _forward(text: str):
    # 입력 → 토큰화: 문장을 모델이 아는 subword 토큰 id 로 변환 ([CLS]/[SEP] 포함)
    enc = tok(text, return_tensors="pt", truncation=True, max_length=512)
    with torch.no_grad():  # 추론이라 그래디언트 불필요 — 메모리/속도 절약
        logits = model(**enc).logits[0]  # [NUM] class 별 원시 점수(softmax 전)
    probs = torch.softmax(logits, dim=-1)  # 로짓 → 확률(합=1)
    # 모델이 실제로 본 토큰들. 이 모델 tokenizer.json 엔 decoder 가 없어 raw 토큰이 byte-level 표현(Ġ=공백)으로 깨져 나오므로,
    #   _readable 로 GPT-2 byte 매핑을 역적용해 한글로 되돌린다 (진단 결과 이 방법만 동작).
    raw = tok.convert_ids_to_tokens(enc["input_ids"][0])
    tokens = [_readable(t) for t in raw]
    top = int(torch.argmax(probs))  # 확률 최댓값 class = 최종 판정
    return tokens, logits, probs, top


# POST /classify — HF 호환 응답 [{label, score}]. 일반 검증 경로(/api/classify)가 쓴다.
@app.post("/classify")
def classify(req: Req):
    _, _, probs, top = _forward(req.inputs)
    label, score = id2label[top], float(probs[top])
    # 추론 근거 로그 — 어떤 문장이 어떤 라벨/점수를 냈는지 매 요청 기록
    print(f'[infer] "{req.inputs}" → {label} ({score:.4f})', flush=True)
    return [{"label": label, "score": score}]


# POST /explain — "원리적 동작"을 펼친 응답. 2차 보고서 페이지가 토큰화/로짓/확률을 그릴 때 쓴다.
#   반환: tokens(토큰화 결과), logits(softmax 전 원시), probs(softmax 후 확률), label/score(최종)
@app.post("/explain")
def explain(req: Req):
    tokens, logits, probs, top = _forward(req.inputs)
    return {
        "tokens": tokens,
        # class 이름(안전/의심)을 키로 — 프론트가 라벨별로 막대를 그리기 쉽게
        "logits": {id2label[i]: float(logits[i]) for i in range(NUM)},
        "probs": {id2label[i]: float(probs[i]) for i in range(NUM)},
        "label": id2label[top],
        "score": float(probs[top]),
    }
