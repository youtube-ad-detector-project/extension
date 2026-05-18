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
// 초기화: 건기식 제품명 set
// ────────────────────────────────────────

const HEALTH_FOOD_VERIFY_URL =
  'https://www.foodsafetykorea.go.kr/portal/healthyfoodlife/searchHomeHF.do';

const healthFoodSet = new Set(
  (healthFoodsList as string[]).map(
    name => name.replace(/[^a-zA-Z0-9가-힣]/g, '').toLowerCase()
  )
);

function isRegisteredHealthFood(productName: string): boolean {
  if (!productName) return false;
  return healthFoodSet.has(
    productName.replace(/[^a-zA-Z0-9가-힣]/g, '').toLowerCase()
  );
}

// ────────────────────────────────────────
// 초기화: 룰·예외 정규식 컴파일
// ────────────────────────────────────────
// 왜 모듈 로드 시 1회: 자막 줄마다 new RegExp 재컴파일하면 비싸므로 미리 RegExp 객체로 변환해둔다

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

// ────────────────────────────────────────
// 초기화: 트리거 정규식 컴파일
// ────────────────────────────────────────

const compiledTriggers: CompiledTrigger[] =
  (triggerDict as any).categories.flatMap((cat: any) =>
    cat.strengths.map((s: any) => ({
      categoryId: cat.id,
      categoryName: cat.name,
      level: s.level,
      pattern: new RegExp(s.regex),
      weight: (triggerDict as any).weight_by_strength[s.level],
    }))
  );

// 사전 로드/정규식 컴파일 결과 1회 확인 — 이 로그가 안 찍히면 위 for/flatMap 의
//   new RegExp() 에서 깨진 정규식으로 throw 된 것(런타임 RegExp 에러). 디버깅 첫 지점.
const ENGINE_TAG = "[yt-cap:engine]";
console.log(
  ENGINE_TAG,
  `📌 룰 엔진 로드됨 - 룰 ${compiledRules.length} / 예외 ${compiledExceptions.length} / 트리거 ${compiledTriggers.length} (정규식 컴파일 성공)`
);

// ────────────────────────────────────────
// 메인 분석 함수
// ────────────────────────────────────────
// 무엇이 들어가 → 처리 → 무엇이 반환되는지:
//   sentence(자막 한 줄), productName(없으면 '') → 룰/예외/트리거 채점 → AnalysisResult(finalStatus 포함)

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

  const isHealthFood = isRegisteredHealthFood(productName);

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

  // 예외가 해제하는 main_category 수집
  const exemptedMainCategories = new Set(
    exceptionsHit.map(e => e.mainCategory)
  );

  // 건기식 등록 제품이면 1.4 룰 해제
  let effectiveRuleHits = ruleHits;

  if (isHealthFood) {
    effectiveRuleHits = effectiveRuleHits.filter(
      h => !h.mainCategory.startsWith('1.4')
    );
  }

  // 예외 매칭된 main_category 룰 해제
  effectiveRuleHits = effectiveRuleHits.filter(
    h => !exemptedMainCategories.has(h.mainCategory)
  );

  const ruleWeightSum = effectiveRuleHits.reduce(
    (sum, h) => sum + h.weight, 0
  );

  // ──────────────────────────────────
  // 룰 판정: ≥ 8점이면 Rule-Positive (즉시 반환)
  // ──────────────────────────────────
  // 왜 즉시 반환: 룰에서 위반 확정되면 트리거(2차 신호)를 더 볼 필요가 없음

  if (ruleWeightSum >= 8) {
    let warningMessage: string | null = null;
    let verificationUrl: string | null = null;

    if (isHealthFood) {
      warningMessage =
        `해당 제품('${productName}')은 건강기능식품으로 등재되어 있으나, ` +
        `위법 가능성이 있는 표현이 감지되었습니다. ` +
        `허가받은 기능성을 직접 확인해보세요.`;
      verificationUrl = HEALTH_FOOD_VERIFY_URL;
    }

    return {
      sentence,
      productName,
      isHealthFood,
      finalStatus: 'Rule-Positive',
      warningMessage,
      verificationUrl,
      ruleAnalysis: {
        weightSum: ruleWeightSum,
        hits: effectiveRuleHits,
        exceptionsHit,
        removedByException: ruleHits.length - effectiveRuleHits.length,
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

  const triggerWeightSum = triggerHits.reduce(
    (sum, h) => sum + h.weight, 0
  );

  // ──────────────────────────────────
  // 트리거 판정: ≥ 1.5점이면 Route-to-Model
  // ──────────────────────────────────
  // 왜 Route-to-Model: 룰로는 확정 못 하지만 의심 신호가 쌓인 문장 → 다음 단계(모델) 검증 대상

  let finalStatus: FinalStatus;

  if (triggerWeightSum >= 1.5) {
    finalStatus = 'Route-to-Model';
  } else {
    finalStatus = 'Rule-Negative';
  }

  // 건기식 안내 (Route-to-Model인 경우)
  let warningMessage: string | null = null;
  let verificationUrl: string | null = null;

  if (isHealthFood && finalStatus === 'Route-to-Model') {
    warningMessage =
      `해당 제품('${productName}')은 건강기능식품으로 등재되어 있습니다. ` +
      `허가받은 기능성을 직접 확인해보세요.`;
    verificationUrl = HEALTH_FOOD_VERIFY_URL;
  }

  return {
    sentence,
    productName,
    isHealthFood,
    finalStatus,
    warningMessage,
    verificationUrl,
    ruleAnalysis: {
      weightSum: ruleWeightSum,
      hits: effectiveRuleHits,
      exceptionsHit,
      removedByException: ruleHits.length - effectiveRuleHits.length,
    },
    triggerAnalysis: {
      weightSum: triggerWeightSum,
      categoriesHit: Array.from(seenTriggerCategories),
      hits: triggerHits,
    },
  };
}

export { analyzeSentence, isRegisteredHealthFood };
export type { AnalysisResult, RuleHit, TriggerHit, ExceptionHit, FinalStatus };
