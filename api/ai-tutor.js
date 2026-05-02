/**
 * POST /api/ai-tutor
 *
 * Input:
 * - { subject, front, back, question }
 *
 * Output:
 * - { answer }
 *
 * Env:
 * - GEMINI_API_KEY (required)
 * - GEMINI_MODEL (optional, default: "gemini-2.5-flash")
 */

const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const MAX_ANSWER = 3000;

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

function normalizeAnswer(raw) {
  const answer = typeof raw?.answer === "string" ? raw.answer.trim() : "";
  const fallback =
    "카드의 앞·뒤 내용을 다시 확인한 뒤, 모르는 용어만 골라 핵심 정의와 시험에서 자주 묻는 쟁점을 2~3문장으로 정리해 보세요.";
  return {
    answer: (answer || fallback).slice(0, MAX_ANSWER),
  };
}

function buildSchema() {
  return {
    type: "OBJECT",
    properties: { answer: { type: "STRING" } },
    required: ["answer"],
  };
}

function buildPrompt({ subject, front, back, question }) {
  return `
과목: ${subject}
주제/질문: ${front}
핵심내용: ${back}

사용자의 질문: "${question}"

위 플래시카드 내용을 공부하는 수험생의 질문입니다.
노무사 시험 관점에서 정확하고 이해하기 쉽게 2~3문장으로 답변하세요.

불필요한 인사말, 장황한 서론 없이 답변 본문만 작성하세요.

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
    const front = String(body?.front || "").trim();
    const back = String(body?.back || "").trim();
    const question = String(body?.question || "").trim();

    if (!subject || !front || !back || !question) {
      return sendJson(res, 400, {
        message:
          "Missing required fields: subject, front, back, question",
      });
    }

    if (
      subject.length > 100 ||
      front.length > 500 ||
      back.length > 1000 ||
      question.length > 600
    ) {
      return sendJson(res, 400, { message: "Input too long" });
    }

    const schema = buildSchema();
    const prompt = buildPrompt({ subject, front, back, question });
    const raw = await callGeminiServer({ prompt, schema });
    const normalized = normalizeAnswer(raw);

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
