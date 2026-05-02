/**
 * POST /api/fc-hint
 *
 * Input:
 * - { subject, front, back }
 *
 * Output:
 * - { hint }
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

function normalizeHint(raw) {
  const hint = typeof raw?.hint === "string" ? raw.hint.trim() : "";
  return {
    hint: (hint || "정답의 의미, 쓰임, 반대 개념을 떠올려 보세요.").slice(0, 500),
  };
}

function buildSchema() {
  return {
    type: "OBJECT",
    properties: { hint: { type: "STRING" } },
    required: ["hint"],
  };
}

function buildPrompt({ subject, front, back }) {
  return `
과목: ${subject}
질문: ${front}
정답: ${back}

사용자가 정답을 떠올리지 못하고 있습니다.
정답에 포함된 직접적인 핵심 단어는 절대 노출하지 말고, 정답을 유추할 수 있도록 돕는 아주 결정적인 힌트나 초성을 1~2문장으로 제공해주세요.

반드시 JSON 객체만 반환하세요.
설명, 마크다운, 코드블록, 인사말, 추가 문장은 절대 포함하지 마세요.
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

    if (!subject || !front || !back) {
      return sendJson(res, 400, { message: "Missing required fields: subject, front, back" });
    }

    if (subject.length > 100 || front.length > 500 || back.length > 1000) {
      return sendJson(res, 400, { message: "Input too long" });
    }

    const schema = buildSchema();
    const prompt = buildPrompt({ subject, front, back });
    const raw = await callGeminiServer({ prompt, schema });
    const normalized = normalizeHint(raw);

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

