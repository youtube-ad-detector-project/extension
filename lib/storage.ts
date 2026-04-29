import type { CaptionsError, CaptionsPayload } from "./messages"

// chrome.storage.local 키는 영상별로 충돌하지 않도록 prefix 부여
const KEY_PREFIX = "caption:"

// 성공/실패 두 가지를 한 형태로 묶어 저장 (광고 탐지 단계에서 일관 조회)
type StoredEntry =
  | { ok: true; data: CaptionsPayload; savedAt: number }
  | { ok: false; data: CaptionsError; savedAt: number }

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

// 단일 영상의 저장된 결과 조회 (없으면 null)
export async function getStoredCaption(
  videoId: string
): Promise<StoredEntry | null> {
  const key = KEY_PREFIX + videoId
  const obj = await chrome.storage.local.get(key)
  return (obj[key] as StoredEntry) ?? null
}

// 24h 이내에 성공적으로 저장된 자막이 있는지 — 같은 영상 중복 fetch 회피용
export async function hasFreshCaption(
  videoId: string,
  maxAgeMs: number = 24 * 60 * 60 * 1000
): Promise<boolean> {
  const entry = await getStoredCaption(videoId)
  if (!entry || !entry.ok) return false
  return Date.now() - entry.savedAt < maxAgeMs
}
