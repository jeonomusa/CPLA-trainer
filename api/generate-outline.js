/**
 * POST /api/generate-outline
 *
 * Input:
 * - { subject, title }
 *
 * Output:
 * - { outline }
 *
 * Env:
 * - GEMINI_API_KEY (required)
 * - GEMINI_MODEL (optional, default: "gemini-2.5-flash")
 */

const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

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

function normalizeOutline(raw) {
  const outline = typeof raw?.outline === "string" ? raw.outline.trim() : "";
  const fallback = `I. 개념 및 의의\n1. 논의 배경\n2. 핵심 정의\n\nII. 구성요건(또는 성립요건)\n1. 객관적 요건\n2. 주관적 요건\n\nIII. 효과 및 법적 지위\n\nIV. 관련 쟁점\n(1) 대표적 쟁점 1\n(2) 대표적 쟁점 2\n\nV. 사례 적용(판례 중심 정리)\n\nVI. 결론`;
  return { outline: (outline || fallback).slice(0, 3000) };
}

function buildSchema() {
  return {
    type: "OBJECT",
    properties: { outline: { type: "STRING" } },
    required: ["outline"],
  };
}

function buildPrompt({ subject, title }) {
  return `
과목: ${subject}
주제: ${title}

당신은 노무사 2차 시험 수험생입니다.
위 주제에 대해 시험 답안지에 바로 쓸 수 있는 핵심 표준 목차를 작성하세요.

반드시 'I. → 1. → (1)' 번호 체계를 엄격히 사용하세요.
불필요한 부가 설명, 인사말, 서론 없이 목차 텍스트만 출력하세요.

반드시 JSON 객체만 반환하세요.
설명, 마크다운, 코드블록, 추가 문장은 절대 포함하지 마세요.
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
    const subject = String(body?.subject || "").trim();
    const title = String(body?.title || "").trim();

    if (!subject || !title) {
      return sendJson(res, 400, { message: "Missing required fields: subject, title" });
    }

    if (subject.length > 100 || title.length > 200) {
      return sendJson(res, 400, { message: "Input too long" });
    }

    const schema = buildSchema();
    const prompt = buildPrompt({ subject, title });
    const raw = await callGeminiServer({ prompt, schema });
    const normalized = normalizeOutline(raw);

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
