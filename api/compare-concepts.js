/**
 * POST /api/compare-concepts
 *
 * Input:
 * - { conceptA, conceptB }
 *
 * Output:
 * - { comparison }
 *
 * Env:
 * - GEMINI_API_KEY (required)
 * - GEMINI_MODEL (optional, default: "gemini-2.5-flash")
 */

const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const MAX_CONCEPT_LEN = 200;
const MAX_COMPARISON = 6000;

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

function normalizeComparison(raw) {
  const comparison =
    typeof raw?.comparison === "string" ? raw.comparison.trim() : "";
  const fallback =
    "두 개념을 각각 ① 의의 ② 성립 요건 또는 주요 논점 ③ 법적 효과(또는 판례·실무 관점) 순으로 간단히 적은 뒤, 마무리 한 줄에서 핵심 차이만 대비해서 정리하면 답안 구조가 잡히기 쉽습니다.";
  return {
    comparison: (comparison || fallback).slice(0, MAX_COMPARISON),
  };
}

function buildSchema() {
  return {
    type: "OBJECT",
    properties: { comparison: { type: "STRING" } },
    required: ["comparison"],
  };
}

function buildPrompt({ conceptA, conceptB }) {
  return `
노무사 2차 시험 수험생입니다.
'${conceptA}'와 '${conceptB}'라는 두 쟁점(또는 개념)에 대해
1. 의의, 2. 주요 요건, 3. 법적 효과(또는 학설/판례의 태도)를 비교하는 내용을 작성하세요.
답안지에 바로 옮길 수 있도록 핵심 키워드 위주로 간결하게 비교하세요.

마크다운 코드블록, 굵게 표시용 특수문자, 인삿말은 쓰지 마세요.
일반 텍스트 줄글로만 작성하세요.

반드시 JSON 객체만 반환하고, 단일 문자열 필드 comparison에 본문을 넣으세요.
설명이나 다른 키는 포함하지 마세요.
`.trim();
}

async function callGeminiServer({ prompt, schema }) {
  if (!GEMINI_API_KEY) {
    const err = new Error("Server misconfigured: GEMINI_API_KEY is missing.");
    err.statusCode = 500;
    throw err;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    DEFAULT_MODEL
  )}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
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
      return JSON.parse(match[0]);
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
    const conceptA = String(body?.conceptA || "").trim();
    const conceptB = String(body?.conceptB || "").trim();

    if (!conceptA || !conceptB) {
      return sendJson(res, 400, {
        message: "Missing required fields: conceptA, conceptB",
      });
    }

    if (
      conceptA.length > MAX_CONCEPT_LEN ||
      conceptB.length > MAX_CONCEPT_LEN
    ) {
      return sendJson(res, 400, { message: "Input too long" });
    }

    const schema = buildSchema();
    const prompt = buildPrompt({ conceptA, conceptB });
    const raw = await callGeminiServer({ prompt, schema });
    const normalized = normalizeComparison(raw);

    return sendJson(res, 200, normalized);
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
