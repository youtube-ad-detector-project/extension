// 룰 기반 광고 의심신호 탐지 엔진 (사용자 설계 — 구조 변경 없이 그대로 이식).
//   우리 파이프라인에서의 위치: lib/adScan.ts 가 자막 한 줄(text)마다 analyzeSentence 를 호출 →
//   반환된 finalStatus 를 youtube-overlay.tsx 가 상태별 색으로 렌더한다.
//   즉 "자막 문장 1개 in → AnalysisResult out" 의 순수 함수. 네트워크/chrome.* 의존 없음.

/**
 * matchingEngine.ts
 * 허위·과장 광고 의심신호 탐지 — 1차 룰 기반 매칭 엔진
 *
 * 흐름:
 *   자막 문장 입력
 *     → (NEW) 문장 내 건기식 제품명 자동 탐색
 *     → 키워드 룰 매칭 (keyword_dict.json)
 *     → 예외처리 적용 (해당 룰 가중치 해제)
 *     → 최종 룰 가중치 합 ≥ 8점? → 위반 확정 (Rule-Positive)
 *     → 아니오 → 트리거 매칭 (trigger_dict.json)
 *     → 트리거 가중치 합 ≥ 1.5점? → 모델 추가 검증 (Route-to-Model)
 *     → 아니오 → 정상 통과 (Rule-Negative)
 */

// 데이터·로직 분리: 사전 3종을 import 시점에 1회 로드 (resolveJsonModule 로 번들됨)
import keywordDict from './data/keyword_dict.json';
import triggerDict from './data/trigger_dict.json';
import healthFoodsList from './data/health_foods.json';

// ────────────────────────────────────────
// 타입 정의
// ────────────────────────────────────────

type FinalStatus = 'Rule-Positive' | 'Route-to-Model' | 'Rule-Negative';

interface RuleHit {
  mainCategory: string;
  subCategory: string;
  matchedText: string;
  weight: number;
}

interface ExceptionHit {
  mainCategory: string;
  subCategory: string;
  matchedText: string;
}

interface TriggerHit {
  category: string;
  categoryName: string;
  level: string;
  matchedText: string;
  weight: number;
}

interface RuleAnalysis {
  weightSum: number;
  hits: RuleHit[];
  exceptionsHit: ExceptionHit[];
  removedByException: number;
}

interface TriggerAnalysis {
  weightSum: number;
  categoriesHit: string[];
  hits: TriggerHit[];
}

interface AnalysisResult {
  sentence: string;
  productName: string;
  isHealthFood: boolean;
  finalStatus: FinalStatus;
  warningMessage: string | null;
  verificationUrl: string | null;
  ruleAnalysis: RuleAnalysis | null;
  triggerAnalysis: TriggerAnalysis | null;
}

interface CompiledRule {
  main_category: string;
  sub_category: string;
  regex: string;
  weight: number;
  is_exception: boolean;
  pattern: RegExp;
}

interface CompiledTrigger {
  categoryId: string;
  categoryName: string;
  level: string;
  pattern: RegExp;
  weight: number;
}

// ────────────────────────────────────────
// 초기화: 건기식 제품명 자동 탐색을 위한 전처리
// ────────────────────────────────────────

// ⭐️ 꺾쇠(< >) 제거 완료
const HEALTH_FOOD_VERIFY_URL =
  'https://www.foodsafetykorea.go.kr/portal/healthyfoodlife/searchHomeHF.do';

function normalizeHealthFoodText(value: string): string {
  return value.replace(/[^a-zA-Z0-9가-힣]/g, '').toLowerCase();
}

// 자동 탐색용 배열: 짧은 단어 오작동 방지(길이 4 이상) & 긴 이름부터 매칭(길이 역순 정렬)
const normalizedHealthFoods = (healthFoodsList as string[])
  .map((name) => ({
    original: name,
    normalized: normalizeHealthFoodText(name),
  }))
  .filter((item) => item.normalized.length >= 4)
  .sort((a, b) => b.normalized.length - a.normalized.length);

const healthFoodSet = new Set(
  (healthFoodsList as string[]).map((name) => normalizeHealthFoodText(name))
);

function isRegisteredHealthFood(productName: string): boolean {
  if (!productName) return false;
  return healthFoodSet.has(normalizeHealthFoodText(productName));
}

// 자막 문장에서 건기식 제품명이 포함되어 있는지 검사하는 함수
function findRegisteredHealthFoodInSentence(sentence: string): string {
  const normalizedSentence = normalizeHealthFoodText(sentence);
  if (!normalizedSentence) return '';

  const matched = normalizedHealthFoods.find((item) =>
    normalizedSentence.includes(item.normalized)
  );

  return matched?.original ?? '';
}

// ────────────────────────────────────────
// 초기화: 룰·예외·트리거 정규식 컴파일
// ────────────────────────────────────────

const compiledRules: CompiledRule[] = [];
const compiledExceptions: CompiledRule[] = [];

for (const rule of (keywordDict as any).rules) {
  const compiled: CompiledRule = {
    ...rule,
    pattern: new RegExp(rule.regex),
  };
  if (rule.is_exception) {
    compiledExceptions.push(compiled);
  } else {
    compiledRules.push(compiled);
  }
}

const compiledTriggers: CompiledTrigger[] = (
  triggerDict as any
).categories.flatMap((cat: any) =>
  cat.strengths.map((s: any) => ({
    categoryId: cat.id,
    categoryName: cat.name,
    level: s.level,
    pattern: new RegExp(s.regex),
    weight: (triggerDict as any).weight_by_strength[s.level],
  }))
);

const ENGINE_TAG = '[yt-cap:engine]';
console.log(
  ENGINE_TAG,
  `📌 룰 엔진 로드됨 - 룰 ${compiledRules.length} / 예외 ${compiledExceptions.length} / 트리거 ${compiledTriggers.length} (정규식 컴파일 성공)`
);

// ────────────────────────────────────────
// 메인 분석 함수
// ────────────────────────────────────────

function analyzeSentence(
  sentence: string,
  productName: string = ''
): AnalysisResult {
  // 빈 문장 가드
  if (!sentence || !sentence.trim()) {
    return {
      sentence,
      productName,
      isHealthFood: false,
      finalStatus: 'Rule-Negative',
      warningMessage: null,
      verificationUrl: null,
      ruleAnalysis: null,
      triggerAnalysis: null,
    };
  }

  // 외부에서 제품명이 안 들어오면 자막 문장 안에서 자동 탐색
  const detectedProductName =
    productName.trim() || findRegisteredHealthFoodInSentence(sentence);
  const isHealthFood = isRegisteredHealthFood(detectedProductName);

  // ──────────────────────────────────
  // 1단계: 키워드 룰 매칭
  // ──────────────────────────────────

  const ruleHits: RuleHit[] = [];
  const seenSubCategories = new Set<string>();

  for (const rule of compiledRules) {
    if (seenSubCategories.has(rule.sub_category)) continue;

    const match = sentence.match(rule.pattern);
    if (match) {
      ruleHits.push({
        mainCategory: rule.main_category,
        subCategory: rule.sub_category,
        matchedText: match[0],
        weight: rule.weight,
      });
      seenSubCategories.add(rule.sub_category);
    }
  }

  // ──────────────────────────────────
  // 예외처리 적용: 매칭된 예외 → 해당 룰 가중치 해제
  // ──────────────────────────────────

  const exceptionsHit: ExceptionHit[] = [];

  for (const exc of compiledExceptions) {
    const match = sentence.match(exc.pattern);
    if (match) {
      exceptionsHit.push({
        mainCategory: exc.main_category,
        subCategory: exc.sub_category,
        matchedText: match[0],
      });
    }
  }

  const exemptedMainCategories = new Set(
    exceptionsHit.map((e) => e.mainCategory)
  );

  let effectiveRuleHits = ruleHits;

  // 1. 건기식 등록 제품이면 1.4(건기식 오인·사칭) 룰 해제
  if (isHealthFood) {
    effectiveRuleHits = effectiveRuleHits.filter(
      (h) => !h.mainCategory.startsWith('1.4')
    );
  }

  // 2. 2.4(미인정 기능성)는 현재 자동 판정에서 제외
  effectiveRuleHits = effectiveRuleHits.filter(
    (h) => !h.mainCategory.startsWith('2.4')
  );

  // 예외 처리 전 상태를 저장하여 순수 예외 제거 건수만 계산
  const hitsBeforeExceptionFilter = effectiveRuleHits;

  // 예외 매칭된 main_category 룰 해제
  effectiveRuleHits = effectiveRuleHits.filter(
    (h) => !exemptedMainCategories.has(h.mainCategory)
  );

  const removedByExceptionCount =
    hitsBeforeExceptionFilter.length - effectiveRuleHits.length;

  const ruleWeightSum = effectiveRuleHits.reduce((sum, h) => sum + h.weight, 0);

  // ──────────────────────────────────
  // 룰 판정: ≥ 8점이면 Rule-Positive (즉시 반환)
  // ──────────────────────────────────

  if (ruleWeightSum >= 8) {
    let warningMessage: string | null = null;
    let verificationUrl: string | null = null;

    // 3. Rule-Positive 중 1.1/1.2 + 건기식일 때만 허가 기능성 URL 제공
    const hasDiseaseRelatedHit = effectiveRuleHits.some(
      (h) =>
        h.mainCategory.startsWith('1.1') || h.mainCategory.startsWith('1.2')
    );

    if (isHealthFood && hasDiseaseRelatedHit) {
      warningMessage =
        `해당 제품('${detectedProductName}')은 건강기능식품으로 등재되어 있으나, ` +
        `질병 치료·질병 연관 표현이 감지되었습니다. ` +
        `해당 표현이 허가 기능성 범위에 해당하는지 직접 확인해보세요.`;
      verificationUrl = HEALTH_FOOD_VERIFY_URL;
    }

    return {
      sentence,
      productName: detectedProductName,
      isHealthFood,
      finalStatus: 'Rule-Positive',
      warningMessage,
      verificationUrl,
      ruleAnalysis: {
        weightSum: ruleWeightSum,
        hits: effectiveRuleHits,
        exceptionsHit,
        removedByException: removedByExceptionCount,
      },
      triggerAnalysis: null,
    };
  }

  // ──────────────────────────────────
  // 2단계: 트리거 매칭 (룰에서 확정 안 된 경우만)
  // ──────────────────────────────────

  const triggerHits: TriggerHit[] = [];
  const seenTriggerCategories = new Set<string>();

  for (const trigger of compiledTriggers) {
    if (seenTriggerCategories.has(trigger.categoryId)) continue;

    const match = sentence.match(trigger.pattern);
    if (match) {
      triggerHits.push({
        category: trigger.categoryId,
        categoryName: trigger.categoryName,
        level: trigger.level,
        matchedText: match[0],
        weight: trigger.weight,
      });
      seenTriggerCategories.add(trigger.categoryId);
    }
  }

  const triggerWeightSum = triggerHits.reduce((sum, h) => sum + h.weight, 0);

  // ──────────────────────────────────
  // 트리거 판정: ≥ 1.5점이면 Route-to-Model
  // ──────────────────────────────────

  let finalStatus: FinalStatus;

  if (triggerWeightSum >= 1.5) {
    finalStatus = 'Route-to-Model';
  } else {
    finalStatus = 'Rule-Negative';
  }

  let warningMessage: string | null = null;
  let verificationUrl: string | null = null;

  return {
    sentence,
    productName: detectedProductName, // ⭐️ 탐색된 이름으로 반환
    isHealthFood,
    finalStatus,
    warningMessage,
    verificationUrl,
    ruleAnalysis: {
      weightSum: ruleWeightSum,
      hits: effectiveRuleHits,
      exceptionsHit,
      removedByException: removedByExceptionCount,
    },
    triggerAnalysis: {
      weightSum: triggerWeightSum,
      categoriesHit: Array.from(seenTriggerCategories),
      hits: triggerHits,
    },
  };
}

// findRegisteredHealthFoodInSentence: adScan 이 자막 전체에서 "영상 단위 제품명"을 1회 찾을 때 사용.
//   analyzeSentence 전체를 돌리면 룰·트리거 매칭까지 같이 실행되어 비용이 두 배가 되므로, 이름 탐색만 분리해서 노출한다.
export { analyzeSentence, findRegisteredHealthFoodInSentence };
export type { AnalysisResult, FinalStatus };
