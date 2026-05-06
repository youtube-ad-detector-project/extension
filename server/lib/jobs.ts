// 인메모리 잡 큐 — POST 라우트가 잡을 만들어 넣고, GET 라우트가 상태를 읽어간다.
// 모듈 스코프 Map 이라서 Next dev 서버 한 프로세스 안에서만 공유됨 (학습용, 영속화 X).

// 자막 한 줄 모양 — 확장의 CaptionSegment 와 동일한 형태로 맞춰 응답 변환을 단순화
export type Segment = { start: number; dur: number; text: string }

// 잡의 상태 머신: pending → processing(stage) → done | failed
//   pending    : POST 직후, 파이프라인 함수가 아직 첫 작업 시작 전
//   processing : 파이프라인이 실행 중, stage 로 어느 단계인지 노출
//   done       : 자막 segments 까지 만들어진 최종 성공 상태
//   failed     : 어떤 단계에서든 예외 발생 (reason 에 사유 문자열)
export type Job =
  | { id: string; videoId: string; status: "pending"; createdAt: number }
  | {
      id: string
      videoId: string
      status: "processing"
      createdAt: number
      stage: "downloading" | "transcribing"
    }
  | {
      id: string
      videoId: string
      status: "done"
      createdAt: number
      finishedAt: number
      result: { lang: string; segments: Segment[] }
    }
  | {
      id: string
      videoId: string
      status: "failed"
      createdAt: number
      finishedAt: number
      reason: string
    }

// Next.js App Router dev 모드는 라우트 segment(POST / GET)마다 모듈을 따로 평가하고
// 핫 리로드 시 모듈을 재생성하므로, 단순한 module-scope Map 은 라우트 사이에서 공유되지 않는다.
// globalThis 에 한 번 부착해두면 어떤 모듈 인스턴스에서 import 하든 같은 Map 을 참조하게 된다 (Prisma 등이 쓰는 패턴).
declare global {
  // eslint-disable-next-line no-var
  var __ytcap_jobs: Map<string, Job> | undefined
}
const jobs: Map<string, Job> =
  globalThis.__ytcap_jobs ?? (globalThis.__ytcap_jobs = new Map<string, Job>())

// 잡 생성 → Map 에 pending 으로 넣고 새 id 반환 (Node 20+ 내장 randomUUID)
export function createJob(videoId: string): string {
  const id = crypto.randomUUID()
  jobs.set(id, {
    id,
    videoId,
    status: "pending",
    createdAt: Date.now()
  })
  return id
}

// 단순 lookup — GET 라우트가 호출
export function getJob(id: string): Job | undefined {
  return jobs.get(id)
}

// 파이프라인이 단계 바뀔 때마다 호출 — Map 의 같은 id 값을 통째로 교체
export function updateJob(id: string, next: Job): void {
  jobs.set(id, next)
}
