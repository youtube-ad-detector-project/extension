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
 *     → 문장 내 건기식 제품명 자동 탐색 (productName 미전달 시)
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
type UserFacingDecision = '고위험 의심' | '위법 의심' | '탐지 신호 낮음';
type SeverityLevel = '상' | '중상' | '중하' | '하';

interface RuleHit {
  mainCategory: string;
  subCategory: string;
  matchedText: string;
  rationale: string;
  weight: number;
  severityLevel: SeverityLevel;
  severityCoefficient: number;
  lawKeys: string[];
  legalReference: string;
  legalReferences: string[];
  safeHarborLawKeys: string[];
  safeHarborLegalReferences: string[];
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
  rationale: string;
  weight: number;
  severityCoefficient: number;
  candidateLawKeys: string[];
  candidateLegalReferences: string[];
  safeHarborLawKeys: string[];
  safeHarborLegalReferences: string[];
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

interface ModelResult {
  prediction: 0 | 1;
  predictionLabel: string;
  confidence: number;
}

interface HfModelOutput {
  label: string;
  score: number;
  isViolation?: boolean;
}

type RawModelResult = ModelResult | HfModelOutput | HfModelOutput[] | null | undefined;

interface SentenceRisk {
  baseConfidence: number;
  severityCoefficient: number;
  riskScore: number;
  riskPercent: number;
  riskSource:
    | 'rule_score'
    | 'model_confidence'
    | 'route_to_model_pending'
    | 'none';
  riskExplanation: string;
}

interface AnalysisResultBase {
  sentence: string;
  productName: string;
  isHealthFood: boolean;
  finalStatus: FinalStatus;
  warningMessage: string | null;
  verificationUrl: string | null;
  ruleAnalysis: RuleAnalysis | null;
  triggerAnalysis: TriggerAnalysis | null;
  modelResult: ModelResult | null;
}

interface AnalysisResult extends AnalysisResultBase {
  userFacingDecision: UserFacingDecision;
  sentenceRisk: SentenceRisk;
}

interface CompiledRule {
  main_category: string;
  sub_category: string;
  regex: string;
  weight: number;
  is_exception: boolean;
  lawKeys?: string[];
  safeHarborLawKeys?: string[];
  legal_reference?: string;
  rationale?: string;
  pattern: RegExp;
}

interface CompiledTrigger {
  categoryId: string;
  categoryName: string;
  level: string;
  rationale: string;
  pattern: RegExp;
  weight: number;
  severityCoefficient: number;
  candidateLawKeys: string[];
  candidateLegalReferences: string[];
  safeHarborLawKeys: string[];
  safeHarborLegalReferences: string[];
}

// 법령 키 → 사용자 보고서 설명용 문구.
//   최신 법령 문구를 외부 생성기가 추정하지 않도록, 사전에는 key 만 두고 여기서 고정 문구로 풀어준다.
const LAW_REFERENCES: Record<string, string> = {
  FOOD_LABEL_AD_ACT_ART8:
    '식품 등의 표시ㆍ광고에 관한 법률 제8조: 부당한 표시 또는 광고행위의 금지',
  FOOD_LABEL_AD_DECREE_ART3_APPENDIX1:
    '식품 등의 표시ㆍ광고에 관한 법률 시행령 제3조 및 [별표 1]: 부당한 표시 또는 광고의 내용',
  MFDS_NOTICE_2025_79_UNFAIR_LABEL_AD_CONTENT:
    '식품등의 부당한 표시 또는 광고의 내용 기준(식품의약품안전처고시 제2025-79호): 부당한 표시 또는 광고의 구체적 내용',
  MFDS_NOTICE_2024_62_FUNCTIONAL_LABEL_AD_ALLOWED:
    '부당한 표시 또는 광고로 보지 아니하는 식품등의 기능성 표시 또는 광고에 관한 규정(식품의약품안전처고시 제2024-62호): 요건을 충족하는 기능성 표시 또는 광고의 범위',
  FOOD_LABEL_AD_DECREE_APPENDIX1_1_A:
    '식품 등의 표시ㆍ광고에 관한 법률 시행령 제3조제1항 [별표 1] 제1호가목: 질병 또는 질병군의 발생을 예방한다는 내용의 표시ㆍ광고',
  FOOD_LABEL_AD_DECREE_APPENDIX1_1_B:
    '식품 등의 표시ㆍ광고에 관한 법률 시행령 제3조제1항 [별표 1] 제1호나목: 질병 또는 질병군에 치료 효과가 있다는 내용의 표시ㆍ광고',
  FOOD_LABEL_AD_DECREE_APPENDIX1_1_C:
    '식품 등의 표시ㆍ광고에 관한 법률 시행령 제3조제1항 [별표 1] 제1호다목: 질병의 특징적인 징후 또는 증상에 예방ㆍ치료 효과가 있다는 내용의 표시ㆍ광고',
  FOOD_LABEL_AD_DECREE_APPENDIX1_1_D:
    '식품 등의 표시ㆍ광고에 관한 법률 시행령 제3조제1항 [별표 1] 제1호라목: 질병 및 그 징후 또는 증상과 관련된 정보로 질병과의 연관성을 암시하는 표시ㆍ광고',
  FOOD_LABEL_AD_DECREE_APPENDIX1_2_A:
    '식품 등의 표시ㆍ광고에 관한 법률 시행령 제3조제1항 [별표 1] 제2호가목: 의약품에만 사용되는 명칭(한약의 처방명을 포함한다)을 사용하는 표시ㆍ광고',
  FOOD_LABEL_AD_DECREE_APPENDIX1_2_C:
    '식품 등의 표시ㆍ광고에 관한 법률 시행령 제3조제1항 [별표 1] 제2호다목: 의약품을 대체할 수 있다는 내용의 표시ㆍ광고',
  FOOD_LABEL_AD_DECREE_APPENDIX1_2_D:
    '식품 등의 표시ㆍ광고에 관한 법률 시행령 제3조제1항 [별표 1] 제2호라목: 의약품의 효능 또는 질병 치료의 효과를 증대시킨다는 내용의 표시ㆍ광고',
  FOOD_LABEL_AD_DECREE_APPENDIX1_3:
    '식품 등의 표시ㆍ광고에 관한 법률 시행령 제3조제1항 [별표 1] 제3호: 건강기능식품이 아닌 것을 건강기능식품으로 인식할 우려가 있는 표시 또는 광고',
  FOOD_LABEL_AD_DECREE_APPENDIX1_4_D:
    '식품 등의 표시ㆍ광고에 관한 법률 시행령 제3조제1항 [별표 1] 제4호라목: 신체의 일부 또는 신체조직의 기능ㆍ작용ㆍ효과ㆍ효능에 관하여 표현하는 거짓ㆍ과장 표시ㆍ광고',
  FOOD_LABEL_AD_DECREE_APPENDIX1_5_C:
    '식품 등의 표시ㆍ광고에 관한 법률 시행령 제3조제1항 [별표 1] 제5호다목: 감사장ㆍ체험기 또는 한방, 특수제법, 주문쇄도, 단체추천 등과 유사한 표현으로 소비자를 현혹하는 표시ㆍ광고',
  FOOD_LABEL_AD_DECREE_APPENDIX1_5_D:
    '식품 등의 표시ㆍ광고에 관한 법률 시행령 제3조제1항 [별표 1] 제5호라목: 의사ㆍ약사ㆍ교수 등 전문가가 제품의 기능성을 보증ㆍ공인ㆍ추천ㆍ지도 또는 사용한다는 내용의 표시ㆍ광고',
  FOOD_LABEL_AD_DECREE_APPENDIX1_5_CHA:
    '식품 등의 표시ㆍ광고에 관한 법률 시행령 제3조제1항 [별표 1] 제5호차목: 이온수, 생명수, 약수 등 과학적 근거가 없는 추상적인 용어로 표현하는 표시ㆍ광고',
  FOOD_LABEL_AD_DECREE_APPENDIX1_6:
    '식품 등의 표시ㆍ광고에 관한 법률 시행령 제3조제1항 [별표 1] 제6호: 비교 표현으로 다른 업체의 제품을 간접적으로 비방하거나 우수한 것으로 인식될 수 있는 표시ㆍ광고',
  FOOD_LABEL_AD_DECREE_APPENDIX1_7_A:
    '식품 등의 표시ㆍ광고에 관한 법률 시행령 제3조제1항 [별표 1] 제7호가목: 비교대상 및 비교기준이 명확하지 않거나 비교내용ㆍ비교방법이 적정하지 않은 비교 표시ㆍ광고',
  MFDS_NOTICE_2025_79_ART2_4_A:
    '식품등의 부당한 표시 또는 광고의 내용 기준(식품의약품안전처고시 제2025-79호) 제2조제4호가목: 다른 업소의 제품을 비방하거나 비방하는 것으로 의심되는 표시ㆍ광고',
  MFDS_NOTICE_2025_79_ART2_4_B:
    '식품등의 부당한 표시 또는 광고의 내용 기준(식품의약품안전처고시 제2025-79호) 제2조제4호나목: 객관적 근거 없이 경쟁사업자의 것보다 우량 또는 유리하다는 용어로 소비자를 오인시킬 우려가 있는 표시ㆍ광고',
  FOOD_LABEL_AD_ACT_ART8_1_1:
    '식품 등의 표시ㆍ광고에 관한 법률 제8조제1항제1호: 질병의 예방ㆍ치료에 효능이 있는 것으로 인식할 우려가 있는 표시 또는 광고',
  FOOD_LABEL_AD_ACT_ART8_1_2:
    '식품 등의 표시ㆍ광고에 관한 법률 제8조제1항제2호: 식품등을 의약품으로 인식할 우려가 있는 표시 또는 광고',
  FOOD_LABEL_AD_ACT_ART8_1_3:
    '식품 등의 표시ㆍ광고에 관한 법률 제8조제1항제3호: 건강기능식품이 아닌 것을 건강기능식품으로 인식할 우려가 있는 표시 또는 광고',
  FOOD_LABEL_AD_ACT_ART8_1_4:
    '식품 등의 표시ㆍ광고에 관한 법률 제8조제1항제4호: 거짓ㆍ과장된 표시 또는 광고',
  FOOD_LABEL_AD_ACT_ART8_1_5:
    '식품 등의 표시ㆍ광고에 관한 법률 제8조제1항제5호: 소비자를 기만하는 표시 또는 광고',
  FOOD_LABEL_AD_ACT_ART8_1_6:
    '식품 등의 표시ㆍ광고에 관한 법률 제8조제1항제6호: 다른 업체나 다른 업체의 제품을 비방하는 표시 또는 광고',
  FOOD_LABEL_AD_ACT_ART8_1_7:
    '식품 등의 표시ㆍ광고에 관한 법률 제8조제1항제7호: 객관적인 근거 없이 자기 또는 자기의 식품등을 다른 영업자나 다른 영업자의 식품등과 부당하게 비교하는 표시 또는 광고'
};

function legalReferencesFor(lawKeys: string[]): string[] {
  return lawKeys.map(key => LAW_REFERENCES[key]).filter(Boolean);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function isModelResult(value: unknown): value is ModelResult {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ModelResult>;
  return (
    (candidate.prediction === 0 || candidate.prediction === 1) &&
    typeof candidate.predictionLabel === 'string' &&
    typeof candidate.confidence === 'number'
  );
}

function normalizeModelResult(raw: RawModelResult): ModelResult | null {
  if (!raw) return null;

  if (isModelResult(raw)) {
    return {
      prediction: raw.prediction,
      predictionLabel: raw.predictionLabel,
      confidence: clamp01(raw.confidence),
    };
  }

  const top = Array.isArray(raw) ? raw[0] : raw;
  if (!top || typeof top.label !== 'string') return null;

  // 서버 Verdict 가 isViolation 을 계산해 준 경우 그 값을 우선 사용해 라벨명 변화에도 위반 여부가 유지되게 한다.
  const prediction =
    typeof top.isViolation === 'boolean'
      ? top.isViolation
        ? 1
        : 0
      : top.label === '의심'
        ? 1
        : 0;

  return {
    prediction,
    predictionLabel: top.label,
    confidence: clamp01(top.score),
  };
}

function severityFromWeight(weight: number): {
  severityLevel: SeverityLevel;
  severityCoefficient: number;
} {
  if (weight >= 10) {
    return { severityLevel: '상', severityCoefficient: 1.0 };
  }
  if (weight >= 8) {
    return { severityLevel: '중상', severityCoefficient: 0.8 };
  }
  if (weight >= 6) {
    return { severityLevel: '중하', severityCoefficient: 0.6 };
  }
  return { severityLevel: '하', severityCoefficient: 0.4 };
}

function severityCoefficientFromTriggerLevel(level: string): number {
  if (level === '상') return 1.0;
  if (level === '중') return 0.8;
  if (level === '하') return 0.6;
  return 0.6;
}

function getSeverityCoefficient(result: AnalysisResultBase): number {
  const ruleCoefficients =
    result.ruleAnalysis?.hits
      .map(hit => hit.severityCoefficient)
      .filter(v => typeof v === 'number') ?? [];

  if (ruleCoefficients.length > 0) {
    return Math.max(...ruleCoefficients);
  }

  const triggerCoefficients =
    result.triggerAnalysis?.hits
      .map(hit => hit.severityCoefficient)
      .filter(v => typeof v === 'number') ?? [];

  if (triggerCoefficients.length > 0) {
    return Math.max(...triggerCoefficients);
  }

  return 0;
}

function getUserFacingDecision(
  result: AnalysisResultBase
): UserFacingDecision {
  if (result.finalStatus === 'Rule-Positive') {
    return '고위험 의심';
  }

  if (result.finalStatus === 'Route-to-Model') {
    if (result.modelResult?.prediction === 0) {
      return '탐지 신호 낮음';
    }
    return '위법 의심';
  }

  return '탐지 신호 낮음';
}

function calculateSentenceRisk(result: AnalysisResultBase): SentenceRisk {
  const severityCoefficient = getSeverityCoefficient(result);

  if (result.finalStatus === 'Rule-Positive') {
    const riskScore = clamp01(1.0 * severityCoefficient);

    return {
      baseConfidence: 1.0,
      severityCoefficient,
      riskScore,
      riskPercent: Math.round(riskScore * 100),
      riskSource: 'rule_score',
      riskExplanation:
        `Rule 기준상 강한 위험 신호가 감지되어 내부 계산 기준값 1.0에 ` +
        `심각도 보정계수 ${severityCoefficient}를 곱해 계산했습니다.`
    };
  }

  if (result.finalStatus === 'Route-to-Model') {
    if (result.modelResult?.prediction === 1) {
      const baseConfidence = clamp01(result.modelResult.confidence);
      const riskScore = clamp01(baseConfidence * severityCoefficient);

      return {
        baseConfidence,
        severityCoefficient,
        riskScore,
        riskPercent: Math.round(riskScore * 100),
        riskSource: 'model_confidence',
        riskExplanation:
          `AI 모델 분류 결과(${result.modelResult.predictionLabel})의 신뢰도 ${baseConfidence}에 ` +
          `심각도 보정계수 ${severityCoefficient}를 곱해 계산했습니다.`
      };
    }

    return {
      baseConfidence: 0,
      severityCoefficient,
      riskScore: 0,
      riskPercent: 0,
      riskSource: 'route_to_model_pending',
      riskExplanation:
        '모델 검증 전 단계라 자동 탐지 기준상 문장 위험도 점수를 확정 계산하지 않았습니다.'
    };
  }

  return {
    baseConfidence: 0,
    severityCoefficient: 0,
    riskScore: 0,
    riskPercent: 0,
    riskSource: 'none',
    riskExplanation:
      '현재 탐지 기준상 문장 위험도 점수가 계산되지 않았습니다.'
  };
}

function finalizeAnalysis(result: AnalysisResultBase): AnalysisResult {
  return {
    ...result,
    userFacingDecision: getUserFacingDecision(result),
    sentenceRisk: calculateSentenceRisk(result),
  };
}

function attachModelResult(
  result: AnalysisResult,
  rawModelResult: RawModelResult
): AnalysisResult {
  const { userFacingDecision: _decision, sentenceRisk: _risk, ...base } = result;
  return finalizeAnalysis({
    ...base,
    modelResult: normalizeModelResult(rawModelResult),
  });
}

// ────────────────────────────────────────
// 초기화: 건기식 제품명 set
// ────────────────────────────────────────

const HEALTH_FOOD_VERIFY_URL =
  'https://www.foodsafetykorea.go.kr/portal/healthyfoodlife/searchHomeHF.do';

// 건기식 이름 비교용 정규화 — 공백·기호·대소문자 차이를 지워 "같은 제품"을 일관되게 매칭하기 위함
function normalizeHealthFoodText(value: string): string {
  return value.replace(/[^a-zA-Z0-9가-힣]/g, '').toLowerCase();
}

const healthFoodSet = new Set(
  (healthFoodsList as string[]).map(name => normalizeHealthFoodText(name))
);

// 문장 내 자동 탐색용 — 짧은 단어 오작동 방지(길이 4↑) & 긴 이름부터 매칭(역순 정렬)
const normalizedHealthFoods = (healthFoodsList as string[])
  .map(name => ({ original: name, normalized: normalizeHealthFoodText(name) }))
  .filter(item => item.normalized.length >= 4)
  .sort((a, b) => b.normalized.length - a.normalized.length);

function isRegisteredHealthFood(productName: string): boolean {
  if (!productName) return false;
  return healthFoodSet.has(normalizeHealthFoodText(productName));
}

// 자막 문장에서 등록 건기식 제품명을 찾는다(가벼운 1패스). adScan 이 영상 단위 제품명을 1회 찾을 때도 재사용.
//   무엇이 들어가 → 처리 → 무엇이 반환: sentence → 정규화 후 부분일치 탐색 → 매칭된 원본 이름(없으면 '')
function findRegisteredHealthFoodInSentence(sentence: string): string {
  const normalizedSentence = normalizeHealthFoodText(sentence);
  if (!normalizedSentence) return '';
  const matched = normalizedHealthFoods.find(item =>
    normalizedSentence.includes(item.normalized)
  );
  return matched?.original ?? '';
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
      // 보고서의 "왜 모델로 넘겼는지" 설명 원천 — strength 레벨 rationale 을 그대로 실어 보냄
      rationale: s.rationale ?? '',
      pattern: new RegExp(s.regex),
      weight: (triggerDict as any).weight_by_strength[s.level],
      severityCoefficient: severityCoefficientFromTriggerLevel(s.level),
      // Route-to-Model 은 법 위반 확정 근거가 아니라 "관련될 수 있는 법령 후보"만 전달한다
      candidateLawKeys: s.candidateLawKeys ?? cat.candidateLawKeys ?? [],
      candidateLegalReferences: legalReferencesFor(
        s.candidateLawKeys ?? cat.candidateLawKeys ?? []
      ),
      safeHarborLawKeys: s.safeHarborLawKeys ?? cat.safeHarborLawKeys ?? [],
      safeHarborLegalReferences: legalReferencesFor(
        s.safeHarborLawKeys ?? cat.safeHarborLawKeys ?? []
      ),
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
    return finalizeAnalysis({
      sentence,
      productName,
      isHealthFood: false,
      finalStatus: 'Rule-Negative',
      warningMessage: null,
      verificationUrl: null,
      ruleAnalysis: null,
      triggerAnalysis: null,
      modelResult: null,
    });
  }

  // productName 이 외부(adScan 영상 단위 탐색)에서 안 오면 문장 자체에서 등록 건기식 이름을 보강 탐색
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
      const severity = severityFromWeight(rule.weight);
      ruleHits.push({
        mainCategory: rule.main_category,
        subCategory: rule.sub_category,
        matchedText: match[0] || sentence,
        // 보고서 detectedReasons.explanation 원천 — dict 의 rationale 을 그대로 전달
        rationale: rule.rationale ?? '',
        weight: rule.weight,
        severityLevel: severity.severityLevel,
        severityCoefficient: severity.severityCoefficient,
        // Rule-Positive 설명용 근거. 보고서는 이 배열에 있는 법령만 직접 근거로 표시한다.
        lawKeys: rule.lawKeys ?? [],
        legalReference: rule.legal_reference ?? '',
        legalReferences: legalReferencesFor(rule.lawKeys ?? []),
        safeHarborLawKeys: rule.safeHarborLawKeys ?? [],
        safeHarborLegalReferences: legalReferencesFor(
          rule.safeHarborLawKeys ?? []
        ),
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
        matchedText: match[0] || sentence,
      });
    }
  }

  // 건기식 DB 등록 제품이면 1.4 룰 전체를 해제한다.
  let effectiveRuleHits = ruleHits;

  if (isHealthFood) {
    effectiveRuleHits = effectiveRuleHits.filter(
      h => !h.mainCategory.startsWith('1.4')
    );
  }

  // 같은 문장에서 실제 제거 가능한 룰이 있는 예외만 적용 결과에 남겨, 예외 출력과 제거 건수를 일치시킨다.
  const activeMainCategories = new Set(
    effectiveRuleHits.map(h => h.mainCategory)
  );
  const appliedExceptionsHit = exceptionsHit.filter(
    e => activeMainCategories.has(e.mainCategory)
  );
  const exemptedMainCategories = new Set(
    appliedExceptionsHit.map(e => e.mainCategory)
  );

  // 등록 건기식에 따른 1.4 해제와 문맥 예외 해제를 분리해, 출력 카운터가 실제 예외 제거 건수만 나타내게 한다.
  const hitsBeforeExceptionFilter = effectiveRuleHits.length;

  // 예외 매칭된 main_category 룰 해제
  effectiveRuleHits = effectiveRuleHits.filter(
    h => !exemptedMainCategories.has(h.mainCategory)
  );

  const removedByException =
    hitsBeforeExceptionFilter - effectiveRuleHits.length;

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
        `해당 제품('${detectedProductName}')은 건강기능식품으로 등재되어 있으나, ` +
        `위법 가능성이 있는 표현이 감지되었습니다. ` +
        `허가받은 기능성을 직접 확인해보세요.`;
      verificationUrl = HEALTH_FOOD_VERIFY_URL;
    }

    return finalizeAnalysis({
      sentence,
      productName: detectedProductName,
      isHealthFood,
      finalStatus: 'Rule-Positive',
      warningMessage,
      verificationUrl,
      ruleAnalysis: {
        weightSum: ruleWeightSum,
        hits: effectiveRuleHits,
        exceptionsHit: appliedExceptionsHit,
        removedByException,
      },
      triggerAnalysis: null,
      modelResult: null,
    });
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
        matchedText: match[0] || sentence,
        rationale: trigger.rationale,
        weight: trigger.weight,
        severityCoefficient: trigger.severityCoefficient,
        // 모델 검증으로 넘긴 이유를 설명할 때만 쓰는 후보 근거. 위반 확정 근거로 쓰지 않는다.
        candidateLawKeys: trigger.candidateLawKeys,
        candidateLegalReferences: trigger.candidateLegalReferences,
        safeHarborLawKeys: trigger.safeHarborLawKeys,
        safeHarborLegalReferences: trigger.safeHarborLegalReferences,
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
      `해당 제품('${detectedProductName}')은 건강기능식품으로 등재되어 있습니다. ` +
      `허가받은 기능성을 직접 확인해보세요.`;
    verificationUrl = HEALTH_FOOD_VERIFY_URL;
  }

  return finalizeAnalysis({
    sentence,
    productName: detectedProductName,
    isHealthFood,
    finalStatus,
    warningMessage,
    verificationUrl,
    ruleAnalysis: {
      weightSum: ruleWeightSum,
      hits: effectiveRuleHits,
      exceptionsHit: appliedExceptionsHit,
      removedByException,
    },
    triggerAnalysis: {
      weightSum: triggerWeightSum,
      categoriesHit: Array.from(seenTriggerCategories),
      hits: triggerHits,
    },
    modelResult: null,
  });
}

// 외부 소비자: adScan(analyzeSentence) + 보고서 빌더(reportBuilder)가 hit 단위 필드를 읽으므로,
//   RuleHit/TriggerHit/RuleAnalysis/TriggerAnalysis 타입까지 공개한다 (isRegisteredHealthFood·ExceptionHit 는 내부 전용).
export {
  analyzeSentence,
  attachModelResult,
  normalizeModelResult,
  findRegisteredHealthFoodInSentence,
};
export type {
  AnalysisResult,
  FinalStatus,
  HfModelOutput,
  ModelResult,
  RawModelResult,
  RuleAnalysis,
  RuleHit,
  SentenceRisk,
  TriggerAnalysis,
  TriggerHit,
  UserFacingDecision,
};
