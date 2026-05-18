# CPLA Trainer

CPLA 학습용 웹앱입니다.  
서술형 답안 AI 채점, 플래시카드 보조 질문, 힌트/두문자 생성 등 학습 보조 기능을 제공합니다.

---

## Deploy

Production: `https://cpla-trainer.vercel.app`

GitHub 저장소와 Vercel이 연동되어 있으며, `main` 브랜치에 push하면 자동으로 재배포됩니다.

### Vercel 환경 변수 (필수)

| 변수 | 설명 |
|------|------|
| `GEMINI_API_KEY` | Google Gemini API 키 (모든 `/api/*` AI 라우트) |
| `GEMINI_MODEL` | (선택) 기본 `gemini-2.5-flash` |

채점(`/api/grade-answer`)이 `502`이면 Vercel **Functions → Logs**에서 `[grade-answer] failed:` 로그를 확인하세요. 키 누락 시 `500`과 `GEMINI_API_KEY is missing` 메시지가 납니다.

---

## Main Features

- AI 서술형 답안 채점
- 플래시카드 하단 보조 질문
- 플래시카드 힌트 생성
- 플래시카드 두문자 생성
- 개념 비교
- 개요 생성
- 문단 생성
- 학습 기록 분석
- AI 변환 처리
- 법령 검색

---

## Project Structure

```bash
CPLA-trainer/
├─ api/
│  ├─ grade-answer.js
│  ├─ ai-tutor.js
│  ├─ fc-hint.js
│  ├─ fc-mnemonic.js
│  ├─ compare-concepts.js
│  ├─ generate-outline.js
│  ├─ generate-paragraph.js
│  ├─ analyze-study-history.js
│  ├─ process-ai-convert.js
│  └─ search-law.js
├─ index.html
├─ README.md
└─ ...
