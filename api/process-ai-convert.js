/**
 * POST /api/process-ai-convert
 *
 * Input:
 * - { subject, mode, sourceText, images?: string[] }
 *   mode: "exam" | "flashcard"
 *   sourceText ≤ 3000 (trim 적용 후)
 *   images: optional JPEG base64 (no data: prefix), 최대 3장, 장당 문자열 길이 ≤ 2,000,000
 *
 * Output:
 * - { results: Array }
 *
 * Env:
 * - GEMINI_API_KEY (required)
 * - GEMINI_MODEL (optional, default: "gemini-2.5-flash")
 */

const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const MAX_SOURCE_TEXT = 3000;
const MAX_ITEMS = 20;
const MAX_IMAGE_PARTS = 3;
const MAX_BASE64_CHARS = 2_000_000;

const EXAM_QUESTION_MAX = 8000;
const EXAM_RUBRIC_MAX = 15000;
const FC_FRONT_MAX = 600;
const FC_BACK_MAX = 3500;

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, statusCode, obj) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error("Invalid JSON body");
    err.statusCode = 400;
    throw err;
  }
}

function normalizeImages(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x) => typeof x === "string" && x.length > 0)
    .slice(0, MAX_IMAGE_PARTS)
    .filter((s) => s.length <= MAX_BASE64_CHARS);
}

function buildExamSchema() {
  return {
    type: "OBJECT",
    properties: {
      results: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            subject: { type: "STRING" },
            question: { type: "STRING" },
            rubric: { type: "STRING" },
          },
          required: ["question", "rubric"],
        },
      },
    },
    required: ["results"],
  };
}

function buildFlashcardSchema() {
  return {
    type: "OBJECT",
    properties: {
      results: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            front: { type: "STRING" },
            back: { type: "STRING" },
          },
          required: ["front", "back"],
        },
      },
    },
    required: ["results"],
  };
}

function buildPromptExam({ subject, sourceText, hasImages }) {
  const imgHint = hasImages
    ? "\n참고: 첨부 이미지(최대 3장)는 텍스트가 부족한 PDF 페이지에서 추출한 페이지입니다. 텍스트와 함께 참고하세요."
    : "";

  return `
과목: ${subject}

[학습 자료]
${sourceText}
${imgHint}

위 자료를 바탕으로 노무사 2차 시험 '문제'와 '모범답안' 1세트를 추출하세요.
특히 각 항목의 rubric 필드에는 단순 요약이 아닌, 목차와 배점, 핵심 키워드가 포함된 상세한 모범답안을 최대한 원문에 가깝게 작성하세요.

결과 배열 각 객체에는 최소한 question, rubric을 반드시 채워야 합니다.

반드시 JSON 객체만 반환하세요. 키 이름은 "results" 하나이고 값은 배열이어야 합니다.
설명, 마크다운, 코드블록, 추가 문장은 절대 포함하지 마세요.
`.trim();
}

function buildPromptFlashcard({ subject, sourceText, hasImages }) {
  const imgHint = hasImages
    ? "\n참고: 첨부 이미지는 텍스트가 부족한 PDF 페이지입니다. 참고하여 핵심을 추출하세요."
    : "";

  return `
과목: ${subject}

[학습 자료]
${sourceText}
${imgHint}

위 자료에서 암기해야 할 핵심 쟁점이나 판례를 안키형 플래시카드(앞면/뒷면) 5~10개로 만드세요.
중요: 뒷면 내용 중 반드시 암기해야 할 핵심 키워드나 문구는 양쪽에 [대괄호]로 묶으세요. (예: 근로기준법상 [근로자]란…)

결과 배열 각 객체에는 front, back을 반드시 채워야 합니다.

반드시 JSON 객체만 반환하세요. 키 이름은 "results" 하나이고 값은 배열이어야 합니다.
설명, 마크다운, 코드블록, 추가 문장은 절대 포함하지 마세요.
`.trim();
}

function normalizeExamResults(raw, subject) {
  const arr = Array.isArray(raw?.results) ? raw.results : [];
  return arr
    .map((item) => ({
      subject: String(subject || "").trim(),
      question: typeof item?.question === "string" ? item.question.trim() : "",
      rubric:
        typeof item?.rubric === "string"
          ? item.rubric.trim()
          : "",
    }))
    .map((item) => ({
      ...item,
      question: item.question.slice(0, EXAM_QUESTION_MAX),
      rubric: item.rubric.slice(0, EXAM_RUBRIC_MAX),
    }))
    .filter((item) => item.question.length > 0)
    .slice(0, MAX_ITEMS);
}

function normalizeFlashcardResults(raw) {
  const arr = Array.isArray(raw?.results) ? raw.results : [];
  return arr
    .map((item) => ({
      front: typeof item?.front === "string" ? item.front.trim() : "",
      back: typeof item?.back === "string" ? item.back.trim() : "",
    }))
    .map((item) => ({
      ...item,
      front: item.front.slice(0, FC_FRONT_MAX),
      back: item.back.slice(0, FC_BACK_MAX),
    }))
    .filter((item) => item.front.length > 0 && item.back.length > 0)
    .slice(0, MAX_ITEMS);
}

async function callGeminiServer({ prompt, schema, images }) {
  if (!GEMINI_API_KEY) {
    const err = new Error("Server misconfigured: GEMINI_API_KEY is missing.");
    err.statusCode = 500;
    throw err;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    DEFAULT_MODEL
  )}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const parts = [{ text: prompt }];
  const imgList = normalizeImages(images);
  for (const b64 of imgList) {
    parts.push({
      inlineData: { mimeType: "image/jpeg", data: b64 },
    });
  }

  const payload = {
    contents: [{ parts }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: schema,
    },
  };

  let lastErr;
  for (let i = 0; i <= 2; i++) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!r.ok) {
        const text = await r.text().catch(() => "");
        const err = new Error(text || `Gemini HTTP ${r.status}`);
        err.statusCode = r.status === 429 ? 429 : 502;
        throw err;
      }

      const data = await r.json();
      const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

      const clean = String(rawText)
        .replace(/```json/g, "")
        .replace(/```/g, "")
        .trim();

      const match = clean.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
      if (!match) {
        const err = new Error("AI 응답 해석 실패 (JSON not found)");
        err.statusCode = 502;
        throw err;
      }
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed)) {
        return { results: parsed };
      }
      return parsed;
    } catch (e) {
      lastErr = e;
      if (i === 2) break;
      if (Number(e?.statusCode) === 429) break;
      await new Promise((r) => setTimeout(r, 500 * Math.pow(2, i)));
    }
  }
  throw lastErr || new Error("Gemini call failed");
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== "POST") {
    return sendJson(res, 405, { message: "Method Not Allowed" });
  }

  try {
    const body = await readJsonBody(req);
    const subject = String(body?.subject || "").trim();
    const mode = String(body?.mode || "").trim();
    const sourceText = String(body?.sourceText || "").trim();
    const images = body?.images;

    if (!subject) {
      return sendJson(res, 400, { message: "Missing required field: subject" });
    }
    if (mode !== "exam" && mode !== "flashcard") {
      return sendJson(res, 400, { message: "Invalid mode (use exam or flashcard)" });
    }

    if (subject.length > 100) {
      return sendJson(res, 400, { message: "Input too long" });
    }

    const textSlice = sourceText.slice(0, MAX_SOURCE_TEXT);
    const imgList = normalizeImages(images);

    if (!textSlice && imgList.length === 0) {
      return sendJson(res, 400, {
        message: "Missing content: sourceText or images required",
      });
    }

    const hasImages = imgList.length > 0;
    const schema =
      mode === "exam" ? buildExamSchema() : buildFlashcardSchema();
    const prompt =
      mode === "exam"
        ? buildPromptExam({ subject, sourceText: textSlice, hasImages })
        : buildPromptFlashcard({ subject, sourceText: textSlice, hasImages });

    const raw = await callGeminiServer({
      prompt,
      schema,
      images: imgList.length ? imgList : undefined,
    });

    const results =
      mode === "exam"
        ? normalizeExamResults(raw, subject)
        : normalizeFlashcardResults(raw);

    return sendJson(res, 200, { results });
  } catch (e) {
    const status =
      typeof e?.statusCode === "number"
        ? e.statusCode
        : String(e?.message || "").includes("429")
          ? 429
          : 500;

    const message =
      status === 429
        ? "무료 API 호출 한도를 초과했습니다. 잠시 후 시도해주세요."
        : status >= 500
          ? "서버 처리 중 오류가 발생했습니다."
          : e?.message || "요청 처리 실패";

    return sendJson(res, status, { message });
  }
}
