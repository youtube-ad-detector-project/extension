// AI 파인튜닝용 데이터셋 빌더 — 룰 엔진이 위반(Rule-Positive)으로 판정한 자막 줄의 텍스트만 모아 JSON 으로 변환.
//   호출 흐름: tabs/report.tsx 의 "JSON 복사/다운로드" 버튼 → buildDataset(scanned) →
//   clipboard 복사 또는 Blob 다운로드 → 사용자가 노션에 붙여넣어 학습 데이터셋 누적.
//   왜 별도 모듈: 변환 로직은 순수 함수(브라우저 API 의존 없음)라 UI 와 분리해 테스트·재사용을 쉽게 한다.
//   왜 Route-to-Model(의심) 제외: 의심 단계는 다음 단계의 AI 모델이 재검증할 대상이므로, 학습 라벨로 쓰면 라벨 오염이 된다.
//   왜 {text} 객체 배열만 반환: 학습은 문장 텍스트만 필요하고 메타(videoId/exportedAt 등)는 사용자가 노션에 옮길 때 불필요하다고 결정.

import type { ScannedLine } from './adScan';

// 학습 샘플 1개 = {text} 한 객체. 배열 자체가 페이로드.
export type DatasetItem = { text: string };

// 무엇이 들어가 → 처리 → 무엇이 반환:
//   scanned(전체 스캔 결과) → Rule-Positive 줄만 필터 → 각 줄의 text 만 뽑아 {text} 객체 배열로
//   데이터 형태 변화: ScannedLine[] → Array<{text: string}>
export function buildDataset(scanned: ScannedLine[]): DatasetItem[] {
  // 위반만 거른다 — 의심·정상은 학습 라벨로 부적합 (위 파일 헤더의 "왜" 참고)
  return scanned
    .filter((l) => l.status === 'Rule-Positive')
    .map((l) => ({ text: l.text }));
}
