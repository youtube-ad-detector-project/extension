import type {
  CaptionsError,
  CaptionsPayload,
  CaptionsPending
} from "./messages"

// chrome.storage.local 키는 영상별로 충돌하지 않도록 prefix 부여
const KEY_PREFIX = "caption:"

// 성공/실패/진행중 세 가지를 한 형태로 묶어 저장 (Plan E STT 가 끝나기 전엔 ok:"pending")
//   같은 영상 키를 덮어쓰는 방식 — 마지막 상태만 의미가 있음
type StoredEntry =
  | { ok: true; data: CaptionsPayload; savedAt: number }
  | { ok: false; data: CaptionsError; savedAt: number }
  | { ok: "pending"; data: CaptionsPending; savedAt: number }

// 자막 추출 성공 결과를 storage 에 적재
export async function saveCaption(
  videoId: string,
  payload: CaptionsPayload
): Promise<void> {
  const entry: StoredEntry = { ok: true, data: payload, savedAt: Date.now() }
  await chrome.storage.local.set({ [KEY_PREFIX + videoId]: entry })
}

// 실패 사유도 기록해두면 같은 영상 재방문 시 재시도 여부 판단에 유용
export async function saveCaptionError(
  videoId: string,
  err: CaptionsError
): Promise<void> {
  const entry: StoredEntry = { ok: false, data: err, savedAt: Date.now() }
  await chrome.storage.local.set({ [KEY_PREFIX + videoId]: entry })
}

// Plan E 진행 상태 저장 — 같은 키를 덮어써서 에러 상태 → pending 상태로 전이
//   하나의 잡당 여러 번 호출됨 (queued → downloading → transcribing)
export async function saveCaptionPending(
  videoId: string,
  pending: CaptionsPending
): Promise<void> {
  const entry: StoredEntry = {
    ok: "pending",
    data: pending,
    savedAt: Date.now()
  }
  await chrome.storage.local.set({ [KEY_PREFIX + videoId]: entry })
}

// 단일 영상의 저장된 결과 조회 (없으면 null) — overlay/report 가 storage 를 읽을 때 쓴다
export async function getStoredCaption(
  videoId: string
): Promise<StoredEntry | null> {
  const key = KEY_PREFIX + videoId
  const obj = await chrome.storage.local.get(key)
  return (obj[key] as StoredEntry) ?? null
}
