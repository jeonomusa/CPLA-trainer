/**
 * POST /api/fc-mnemonic
 *
 * Input:
 * - { subject, front, back }
 *
 * Output:
 * - { mnemonic }
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

function normalizeMnemonic(raw) {
  const mnemonic = typeof raw?.mnemonic === "string" ? raw.mnemonic.trim() : "";
  return {
    mnemonic: (mnemonic || "앞글자, 순서, 이미지 연상으로 핵심어를 연결해 보세요.").slice(
      0,
      500
    ),
  };
}

function buildSchema() {
  return {
    type: "OBJECT",
    properties: { mnemonic: { type: "STRING" } },
    required: ["mnemonic"],
  };
}

function buildPrompt({ subject, front, back }) {
  return `
과목: ${subject}
질문: ${front}
정답: ${back}

사용자가 이 내용을 오래 기억할 수 있도록, 짧고 강한 암기법을 만들어주세요.
가능하면 두문자, 연상 이미지, 이야기식 연결 중 가장 적합한 방식으로 1~2문장으로 작성해주세요.

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
    const normalized = normalizeMnemonic(raw);

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

