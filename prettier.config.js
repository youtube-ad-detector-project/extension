// Prettier 설정 객체를 CommonJS 방식으로 내보냅니다.
module.exports = {
  // === Base (모든 프로젝트 공통) ===

  // 한 줄의 최대 길이를 설정 (기본값: 80)
  // 이 길이를 초과하면 자동으로 줄바꿈이 발생
  printWidth: 80,

  // 들여쓰기 시 사용할 공백 문자 수 (기본값: 2)
  // useTabs가 false일 때만 적용됨
  tabWidth: 2,

  // 들여쓰기에 탭 문자 사용 여부 (기본값: false)
  // true: 탭 문자 사용, false: 공백 문자 사용
  useTabs: false,

  // 문장 끝 세미콜론 사용 여부 (기본값: true)
  // true: 모든 문장 끝에 세미콜론 추가
  // false: 필요한 경우에만 세미콜론 추가
  semi: true,

  // 문자열에 작은따옴표 사용 여부 (기본값: false)
  // true: 'string', false: "string"
  singleQuote: true,

  // 객체 속성에 따옴표 추가 방식 (기본값: "as-needed")
  quoteProps: 'as-needed',
  // - "as-needed": 필요한 경우에만 따옴표 추가
  // - "consistent": 하나라도 따옴표가 필요하면 모든 속성에 따옴표 추가
  // - "preserve": 입력된 따옴표 스타일 유지

  // 객체, 배열 등의 후행 쉼표 설정 (기본값: "es5")
  trailingComma: 'es5',
  // - "all": 모든 구문에서 후행 쉼표 사용 (함수 인자 포함)
  // - "es5": ES5에서 유효한 위치에만 후행 쉼표 추가
  // - "none": 후행 쉼표 사용 안 함

  // 객체 리터럴의 중괄호 주위 공백 추가 (기본값: true)
  // true: { foo: bar }, false: {foo: bar}
  bracketSpacing: true,

  // 화살표 함수 매개변수 괄호 사용 방식 (기본값: "always")
  arrowParens: 'always',
  // - "always": (x) => x
  // - "avoid": x => x (매개변수가 하나일 때)

  // 줄 끝 문자 설정 (기본값: "lf")
  endOfLine: 'lf',
  // - "lf": \n (Unix)
  // - "crlf": \r\n (Windows)
  // - "cr": \r (Mac OS)
  // - "auto": 첫 줄 끝 문자 유지

  // 마크다운 텍스트의 줄바꿈 방식 (기본값: "preserve")
  proseWrap: 'never',
  // - "always": 항상 printWidth에 따라 줄바꿈
  // - "never": 줄바꿈 하지 않음
  // - "preserve": 원본 텍스트 줄바꿈 유지

  // HTML 공백 처리 방식 (기본값: "css")
  htmlWhitespaceSensitivity: 'strict',
  // - "css": CSS display 속성 기준으로 처리
  // - "strict": 모든 공백을 유지
  // - "ignore": 모든 공백을 무시

  // === React 전용 추가 규칙 (JSX/TSX 파일에만 적용) ===
  jsxSingleQuote: true, // JSX에서 '단일따옴표'
  singleAttributePerLine: true, // JSX 속성 1줄 1개
  bracketSameLine: true, // JSX의 마지막 `>`를 다음 줄로 내릴지 여부
};
