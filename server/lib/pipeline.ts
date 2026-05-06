// 잡 오케스트레이터 — POST 라우트가 fire-and-forget 으로 호출한다.
//   호출 흐름: createJob (라우트) → runPipeline (여기) → updateJob (각 단계)
//   잡 상태가 pending → processing(downloading) → processing(transcribing) → done|failed 로 전이.

import { unlink } from "node:fs/promises"
import { updateJob } from "./jobs"
import { downloadAudio } from "./ytdlp"
import { transcribe } from "./whisper"

// 비동기로 떠서 끝까지 달리는 함수 — 라우트에서 await 하지 않음
//   에러는 절대 throw 하지 않는다 (호출 측이 받지 않으니 unhandled rejection 만 남음).
//   대신 잡을 failed 로 마킹하고 mp3 정리.
export async function runPipeline(jobId: string, videoId: string): Promise<void> {
  const createdAt = Date.now()
  let mp3Path: string | null = null

  try {
    // 1단계: 다운로드 시작 알림 — 폴링 측이 stage 를 보고 진행도 표시 가능
    updateJob(jobId, {
      id: jobId,
      videoId,
      status: "processing",
      createdAt,
      stage: "downloading"
    })
    mp3Path = await downloadAudio(jobId, videoId)

    // 2단계: 전사 — Groq 호출이 여기서 가장 오래 걸림 (수십 초 ~ 분 단위 가능)
    updateJob(jobId, {
      id: jobId,
      videoId,
      status: "processing",
      createdAt,
      stage: "transcribing"
    })
    const { lang, segments } = await transcribe(mp3Path)

    // 3단계: done — 확장이 GET 으로 받아갈 최종 결과
    updateJob(jobId, {
      id: jobId,
      videoId,
      status: "done",
      createdAt,
      finishedAt: Date.now(),
      result: { lang, segments }
    })
  } catch (e) {
    // 어떤 단계에서 터졌는지는 reason 문자열에 그대로 노출 (학습용 — 가공 안 함)
    const reason = e instanceof Error ? e.message : String(e)
    updateJob(jobId, {
      id: jobId,
      videoId,
      status: "failed",
      createdAt,
      finishedAt: Date.now(),
      reason
    })
  } finally {
    // mp3 정리 — 다운로드까지 성공했을 때만 파일이 존재하므로 mp3Path 가 null 이 아닐 때만 삭제 시도
    //   cleanup 실패는 잡 결과(done/failed)에 영향을 주면 안 되므로 throw 하지 않고 stderr 로 알린다
    if (mp3Path) {
      try {
        await unlink(mp3Path)
      } catch (e) {
        console.error(
          `[stt] tmp 정리 실패 (잡=${jobId}, 경로=${mp3Path}):`,
          e instanceof Error ? e.message : e
        )
      }
    }
  }
}
