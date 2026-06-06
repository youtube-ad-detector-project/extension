// 임시 헬퍼(이번 전용) — out/<videoId>.json(scanned)과 _index.json(링크 매핑)을 읽어
//   노션 update_content 에 그대로 넣을 content_updates payload(이스케이프 완료)를 토글별 1파일로 떨군다.
//   왜 스크립트로: 큰 한글 JSON을 손으로 \n/\" 이스케이프하면 숫자/텍스트가 틀어질 위험 → JSON.stringify 로 정확히 처리.
//   흐름: _index 순회 → 각 videoId 의 scanned 를 ```json 코드블록으로 감싸 토글 안에 넣는 old_str/new_str 생성 → out/upd/<videoId>.json 저장.

import { readFile, writeFile, mkdir } from "node:fs/promises"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(HERE, "out")
const UPD_DIR = resolve(OUT_DIR, "upd")

// 빈 토글(교체 대상)과 채운 토글(교체 결과)을 만든다 — 노션 페이지의 실제 표기와 1:1로 맞춰야 old_str 가 매칭됨
//   page 표기: <details>\n<summary>[url](url)</summary>\n</details>
function buildOps(url, scannedText) {
  const summary = `<summary>[${url}](${url})</summary>`
  const oldStr = `<details>\n${summary}\n</details>`
  // 코드블록은 ```json 펜스로 감싼다. scannedText 는 파일 원문 그대로(가공 X)
  const newStr = `<details>\n${summary}\n\n\`\`\`json\n${scannedText}\n\`\`\`\n\n</details>`
  return [{ old_str: oldStr, new_str: newStr }]
}

async function main() {
  await mkdir(UPD_DIR, { recursive: true })
  const index = JSON.parse(await readFile(resolve(OUT_DIR, "_index.json"), "utf8"))

  // 에러 없이 videoId 가 있는 항목만 — scanned 파일을 읽어 payload 생성
  for (const it of index) {
    if (it.error || !it.videoId) {
      console.log(`skip ${it.url} (error=${it.error})`)
      continue
    }
    const scannedText = await readFile(resolve(OUT_DIR, `${it.videoId}.json`), "utf8")
    const ops = buildOps(it.url, scannedText.trimEnd())
    // 한 줄(compact)로 — 내가 그대로 복사해 content_updates 파라미터에 넣기 위함
    await writeFile(resolve(UPD_DIR, `${it.videoId}.json`), JSON.stringify(ops))
    console.log(`built ${it.videoId} (${it.lines} lines)`)
  }
  console.log(`\nDONE → ${UPD_DIR}`)
}

main()
