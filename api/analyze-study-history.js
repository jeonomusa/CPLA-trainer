/**
 * POST /api/analyze-study-history
 *
 * Input:
 * - { historyText }
 *
 * Output:
 * - { analysis }
 *
 * Env:
 * - GEMINI_API_KEY (required)
 * - GEMINI_MODEL (optional, default: "gemini-2.5-flash")
 */

const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const MAX_HISTORY_TEXT = 5000;
const MAX_ANALYSIS = 6000;

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

function normalizeAnalysis(raw) {
  const analysis =
    typeof raw?.analysis === "string" ? raw.analysis.trim() : "";
  const fallback =
    "분석 결과를 만들지 못했습니다. 기록을 조금 더 쌓은 뒤 다시 시도하거나, 과목별로 채점 피드백이 채워졌는지 확인해 주세요.";
  return {
    analysis: (analysis || fallback).slice(0, MAX_ANALYSIS),
  };
}

function buildSchema() {
  return {
    type: "OBJECT",
    properties: { analysis: { type: "STRING" } },
    required: ["analysis"],
  };
}

function buildPrompt({ historyText }) {
  return `
학생의 최근 모의고사 기록과 채점에서 드러난 부족한 점(텍스트)입니다.

---
${historyText}
---

위를 바탕으로 다음을 간결히 정리하세요.
- 최근 경향 및 취약한 부분
- 우선 보완 순서(무엇부터 할지)
- 실행 가능한 개선 방법 2~4가지

인사말·마크다운·코드블록 없이 평문으로만 작성하세요.
총 3~7문장 정도면 충분합니다.

반드시 JSON 객체 하나만 반환하고, 문자열 필드 analysis에 본문만 넣으세요.
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
    const historyTextRaw = String(body?.historyText || "").trim();

    if (!historyTextRaw) {
      return sendJson(res, 400, { message: "Missing required field: historyText" });
    }

    if (historyTextRaw.length > MAX_HISTORY_TEXT) {
      return sendJson(res, 400, { message: "Input too long" });
    }

    const historyText = historyTextRaw;

    const schema = buildSchema();
    const prompt = buildPrompt({ historyText });
    const raw = await callGeminiServer({ prompt, schema });
    const normalized = normalizeAnalysis(raw);

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
