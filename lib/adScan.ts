// 글루 모듈: 저장된 자막(CaptionSegment[]) 과 룰 엔진(analyzeSentence) 을 잇는다.
//   호출 흐름: youtube-overlay.tsx 가 entry.ok===true 일 때 scanCaptions(segments) 호출 →
//   여기서 전체 자막에서 건기식 제품명을 1차 탐색 →
//   자막 줄마다 엔진을 1회씩 돌려 ScannedLine[] 로 변환 → 오버레이가 상태별 색으로 렌더.
//   "자막 줄 = 문장 1개" 결정에 따라, 세그먼트 텍스트를 그대로 엔진에 넘긴다 (문장 재구성 없음).
//   단, 제품명이 한 줄에만 등장하고 이후 줄에는 생략될 수 있으므로,
//   scanCaptions 단계에서 전체 자막 기준으로 감지된 제품명을 각 줄 분석에 함께 전달한다.

// analyzeSentence: 줄별 분석(룰/예외/트리거 매칭 전부) — 메인 루프에서만 사용
// findRegisteredHealthFoodInSentence: 정규식 1회만 돌려 건기식 제품명을 찾는 가벼운 함수 — 영상 단위 1차 탐색에 사용
import { analyzeSentence, findRegisteredHealthFoodInSentence } from './matchingEngine';
import type { AnalysisResult, FinalStatus } from './matchingEngine';
import type { CaptionSegment } from './messages';

// 콘텐츠 스크립트(오버레이)에서 실행 → YouTube 페이지 F12 콘솔에 찍힘 ([yt-cap:bridge] 와 같은 창)
const TAG = '[yt-cap:scan]';

// 엔진 결과에 타임스탬프를 붙인 형태 — 오버레이가 "몇 초 줄이 무슨 상태"인지 그릴 수 있어야 하므로
//   데이터 형태 변화: CaptionSegment{start,dur,text} → ScannedLine{...+status, result}
export type ScannedLine = {
  start: number;
  dur: number;
  text: string;
  status: FinalStatus;
  result: AnalysisResult; // 매칭 근거(ruleAnalysis/triggerAnalysis)까지 보존 — 상세/디버그용
};

// 상태별 개수 요약 — 오버레이 헤더가 "위반 N · 의심 M · 정상 K" 한 줄로 쓰기 위함
export type ScanSummary = {
  positive: number; // Rule-Positive (위반 확정)
  route: number; // Route-to-Model (의심)
  negative: number; // Rule-Negative (정상)
};

// 영상 1편 단위 위험도 요약 — 보고서 상단에 "이 영상 위험도 N점/등급" 한 줄로 쓰기 위함
export type VideoRisk = {
  riskScore: number;
  riskGrade: '높음' | '중간' | '낮음' | '표시 없음';
  riskLevelText: string;
  riskSource: 'max_sentence_risk_with_count_bonus' | 'none';
  suspiciousSentenceCount: number;
  maxSentenceRiskPercent: number;
  countBonus: number;
  calculationNote: string;
};

// 전체 자막에서 영상 단위 제품명을 1회 탐색한다.
// 왜 findRegisteredHealthFoodInSentence 를 직접 호출하는지: analyzeSentence 를 쓰면 줄마다 룰/예외/트리거 매칭까지 같이 돌아
//   메인 루프와 합쳐 자막당 분석이 2회씩 실행되므로, 이름 탐색만 하는 가벼운 함수로 분리해 1차 패스 비용을 정규식 1회로 줄인다.
// productName 이 외부에서 전달되면 그 값을 우선 사용한다.
function detectVideoProductName(
  segments: CaptionSegment[],
  productName: string = ''
): string {
  const normalizedProductName = productName.trim();

  if (normalizedProductName) {
    return normalizedProductName;
  }

  // 가장 먼저 등장한 등록 건기식 이름을 영상 단위 제품명으로 채택 (보통 인트로/타이틀에 한 번 노출되는 패턴 기준)
  for (const seg of segments) {
    const found = findRegisteredHealthFoodInSentence(seg.text);
    if (found) return found;
  }

  return '';
}

// 무엇이 들어가 → 처리 → 무엇이 반환되는지:
//   segments(자막 줄 배열), productName(선택) → 전체 자막에서 영상 단위 제품명 탐색
//   → 줄마다 analyzeSentence(text, detectedProductName) 1회
//   → ScannedLine[] (입력과 1:1, 순서 유지)
//   productName 이 외부에서 전달되면 그 값을 우선 사용한다.
//   productName 이 없으면 전체 자막에서 건기식 DB 제품명 포함 여부를 먼저 탐색한다.
export function scanCaptions(
  segments: CaptionSegment[],
  productName: string = ''
): ScannedLine[] {
  const detectedProductName = detectVideoProductName(segments, productName);

  // 🟢 스캔 진입 — 입력 줄 수와 제품명 탐색 결과를 먼저 찍어 흐름을 확인할 수 있게 함
  console.log(
    TAG,
    `🟢 룰 스캔 시작 - 자막 ${segments.length}줄 (줄=문장 단위로 엔진 실행) / 건기식 제품명: ${
      detectedProductName || '미탐지'
    }`
  );

  // map: 줄 N개 → 결과 N개. 줄 누락/병합 없이 1:1 유지해야 타임라인 대응이 단순함
  // detectedProductName 을 모든 줄에 넘겨, 제품명이 한 번만 등장하고 이후 줄에서 생략되어도
  // 건기식 분기(1.4 제외, 1.1/1.2 URL 안내)가 일관되게 적용되도록 한다.
  const lines = segments.map((seg) => {
    const result = analyzeSentence(seg.text, detectedProductName);

    // 정상이 아닌 줄만 "왜 걸렸는지" 근거를 남긴다 (정상까지 찍으면 콘솔이 시끄러워 디버깅 방해)
    if (result.finalStatus === 'Rule-Positive') {
      console.log(
        TAG,
        `❌ [위반] ${seg.start.toFixed(1)}s "${seg.text}" — 룰 ${result.ruleAnalysis?.weightSum}점 (${result.ruleAnalysis?.hits
          .map((h) => h.subCategory)
          .join(', ')})`
      );
    } else if (result.finalStatus === 'Route-to-Model') {
      // 트리거 카테고리가 비어 있어도 빈 괄호 "()" 대신 "없음" 으로 찍어 로그 형식을 안정화
      const triggerCategories = result.triggerAnalysis?.categoriesHit ?? [];
      const categoryLabel =
        triggerCategories.length > 0 ? triggerCategories.join(', ') : '없음';
      console.log(
        TAG,
        `⚠️ [의심] ${seg.start.toFixed(1)}s "${seg.text}" — 트리거 ${result.triggerAnalysis?.weightSum}점 (${categoryLabel})`
      );
    }

    return {
      start: seg.start,
      dur: seg.dur,
      text: seg.text,
      status: result.finalStatus,
      result,
    };
  });

  // ✅ 스캔 종료 — 상태별 집계로 한눈 요약 (오버레이 헤더와 같은 수치)
  const s = summarize(lines);
  console.log(
    TAG,
    `✅ 룰 스캔 완료 - 위반 ${s.positive} · 의심 ${s.route} · 정상 ${s.negative}`
  );

  return lines;
}

// ScannedLine[] → 상태별 카운트. 한 번 순회하며 분류 누적
export function summarize(lines: ScannedLine[]): ScanSummary {
  const s: ScanSummary = { positive: 0, route: 0, negative: 0 };

  for (const l of lines) {
    // 3분류 중 하나로만 떨어지므로 분기 누적이면 충분
    if (l.status === 'Rule-Positive') s.positive++;
    else if (l.status === 'Route-to-Model') s.route++;
    else s.negative++;
  }

  return s;
}

// 문장별 sentenceRisk 를 영상 1편 단위 점수로 합산한다 (보고서 상단 요약용).
//   무엇이 들어가 → 처리 → 무엇이 반환: ScannedLine[] → (최대 문장위험 + 의심문장 수 보너스) → VideoRisk
//   ⚠️ 아직 호출부를 배선하지 않음 — 화면 노출은 다음 단계(보고서 연결)에서 진행.
export function calculateVideoRisk(lines: ScannedLine[]): VideoRisk {
  // 각 줄의 문장 위험도(0~1). 새 엔진의 sentenceRisk 가 없으면 0 으로 간주
  const risks = lines.map((line) => line.result.sentenceRisk?.riskScore ?? 0);
  const sMax = Math.max(...risks, 0);
  const suspiciousSentenceCount = risks.filter((risk) => risk > 0).length;

  // 의심 문장이 하나도 없으면 "표시 없음" 으로 단락 (점수/등급 계산 불필요)
  if (suspiciousSentenceCount === 0) {
    return {
      riskScore: 0,
      riskGrade: '표시 없음',
      riskLevelText: '현재 탐지 기준상 뚜렷한 의심 신호 없음',
      riskSource: 'none',
      suspiciousSentenceCount: 0,
      maxSentenceRiskPercent: 0,
      countBonus: 0,
      calculationNote:
        '현재 탐지 기준상 뚜렷한 위법 의심 신호가 감지되지 않았습니다.',
    };
  }

  // 의심 문장이 많을수록 가산점(최대 15) — 한 문장만 위험한 경우와 여러 문장이 위험한 경우를 구분
  const countBonus = Math.min(15, suspiciousSentenceCount * 5);
  const riskScore = Math.min(100, Math.round(sMax * 100 + countBonus));

  let riskGrade: VideoRisk['riskGrade'];
  let riskLevelText: string;

  // 점수 구간별 등급 — 화면 색/문구를 다르게 보여주기 위한 분기
  if (riskScore >= 70) {
    riskGrade = '높음';
    riskLevelText = '위법 의심 신호 높음';
  } else if (riskScore >= 40) {
    riskGrade = '중간';
    riskLevelText = '일부 위법 의심 신호 감지';
  } else {
    riskGrade = '낮음';
    riskLevelText = '약한 의심 신호 감지';
  }

  return {
    riskScore,
    riskGrade,
    riskLevelText,
    riskSource: 'max_sentence_risk_with_count_bonus',
    suspiciousSentenceCount,
    maxSentenceRiskPercent: Math.round(sMax * 100),
    countBonus,
    calculationNote:
      '위험도 점수는 실제 위법 확률이 아니라 Rule 탐지, 모델 신뢰도, 표현 유형 심각도를 종합한 자동 탐지 기준 점수입니다.',
  };
}
