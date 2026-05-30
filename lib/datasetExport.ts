// AI 파인튜닝용 데이터셋 빌더 — 룰 엔진이 위반(Rule-Positive) 또는 의심(Route-to-Model)으로 판정한
//   자막 줄의 텍스트와 status 를 모아 JSON 으로 변환.
//   호출 흐름: tabs/report.tsx 의 "JSON 복사/다운로드" 버튼 → buildDataset(scanned) →
//   clipboard 복사 또는 Blob 다운로드 → 사용자가 노션에 붙여넣어 학습 데이터셋 누적.
//
//   왜 별도 모듈: 변환 로직은 순수 함수(브라우저 API 의존 없음)라 UI 와 분리해 테스트·재사용을 쉽게 한다.
//   왜 위반·의심 모두 포함: 사람이 노션에서 humanLabel 을 확정할 때 둘을 함께 검토하는 워크플로우.
//   왜 status 도 함께 내보내는지: 위반/의심 구분이 JSON 만 봐도 가능해야 사람이 노션에서 분류·라벨링하기 쉽다.
//   왜 status 를 'violation' / 'suspect' 로 매핑하는지: 내부 enum (Rule-Positive / Route-to-Model)은
//     파이프라인 용어라 외부 사용자가 의미를 알기 어렵다. JSON export 시점에만 노션 워크플로우용 라벨로 변환.

import type { ScannedLine } from './adScan';

// JSON 으로 내보내는 외부 라벨 — 'violation' = 위반 확정, 'suspect' = 의심(추가 검토 필요)
export type DatasetStatus = 'violation' | 'suspect';

// 학습 샘플 1개 = {text, status}. status 는 외부 라벨(DatasetStatus) 둘 중 하나만.
export type DatasetItem = { text: string; status: DatasetStatus };

// 내부 enum → 외부 라벨 매핑. Rule-Negative(정상) 은 학습 후보가 아니므로 buildDataset 의 filter 단계에서 제외된다.
//   Rule-Positive → 'violation' (룰 ≥ 8점, 위반 확정)
//   Route-to-Model → 'suspect' (트리거 ≥ 1.5점, 다음 단계 검토 대상)
function toDatasetStatus(status: ScannedLine['status']): DatasetStatus | null {
  if (status === 'Rule-Positive') return 'violation';
  if (status === 'Route-to-Model') return 'suspect';
  return null;
}

// 무엇이 들어가 → 처리 → 무엇이 반환:
//   scanned(전체 스캔 결과) → Rule-Negative(정상) 제외 → 각 줄에서 text 와 외부 라벨 status 만 뽑아 객체 배열로
//   데이터 형태 변화: ScannedLine[] → Array<{text: string, status: 'violation' | 'suspect'}>
export function buildDataset(scanned: ScannedLine[]): DatasetItem[] {
  const items: DatasetItem[] = [];

  // for-of + 매핑 결과 분기: filter+map 으로 분리하면 toDatasetStatus 가 두 번 돌아 비효율이라 한 번에 처리
  for (const line of scanned) {
    const status = toDatasetStatus(line.status);
    if (status === null) continue; // 정상(Rule-Negative)은 학습 후보 아님
    items.push({ text: line.text, status });
  }

  return items;
}
