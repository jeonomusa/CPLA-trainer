/**
 * POST /api/grade-answer
 *
 * Minimal server-side grading proxy for the mock-exam flow.
 * - Input: { subject, question, rubric, fullAnswer }
 * - Output: { score, details:{issue,law,logic,conclusion,format}, feedback, good, missing, advice, next3 }
 *
 * Environment:
 * - GEMINI_API_KEY (required)
 * - GEMINI_MODEL (optional, default: "gemini-2.5-flash")
 */
 
const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
 
function setCors(res) {
  // Keep permissive for local dev; tighten in production as needed.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}
 
function sendJson(res, statusCode, obj) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}
 
function safeInt(n, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.trunc(x) : fallback;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
 
function normalizeResult(result) {
  const details = result && typeof result === "object" ? (result.details || {}) : {};
  const next3 = result && typeof result === "object" ? result.next3 : [];
 
  return {
    score: clamp(safeInt(result?.score, 0), 0, 100),
    details: {
      issue: clamp(safeInt(details.issue, 0), 0, 25),
      law: clamp(safeInt(details.law, 0), 0, 30),
      logic: clamp(safeInt(details.logic, 0), 0, 25),
      conclusion: clamp(safeInt(details.conclusion, 0), 0, 10),
      format: clamp(safeInt(details.format, 0), 0, 10),
    },
    feedback: typeof result?.feedback === "string" ? result.feedback : "",
    good: typeof result?.good === "string" ? result.good : "",
    missing: typeof result?.missing === "string" ? result.missing : "",
    advice: typeof result?.advice === "string" ? result.advice : "",
    next3: Array.isArray(next3)
      ? next3.filter((x) => typeof x === "string").slice(0, 3)
      : [],
  };
}
 
async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body; // Express / some runtimes
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
 
  // Tiny retry to match the client behavior a bit
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
      const rawText =
        data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
 
      // Parse "JSON-ish" model output (matches the client's parseJSON behavior)
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
      if (String(e?.statusCode || "").includes("429")) break;
      await new Promise((r) => setTimeout(r, 500 * Math.pow(2, i)));
    }
  }
  throw lastErr || new Error("Gemini call failed");
}
 
function buildSchema() {
  return {
    type: "OBJECT",
    properties: {
      score: { type: "INTEGER" },
      details: {
        type: "OBJECT",
        properties: {
          issue: { type: "INTEGER" },
          law: { type: "INTEGER" },
          logic: { type: "INTEGER" },
          conclusion: { type: "INTEGER" },
          format: { type: "INTEGER" },
        },
        required: ["issue", "law", "logic", "conclusion", "format"],
      },
      feedback: { type: "STRING" },
      good: { type: "STRING" },
      missing: { type: "STRING" },
      advice: { type: "STRING" },
      next3: { type: "ARRAY", items: { type: "STRING" } },
    },
    required: ["score", "details", "feedback", "good", "missing", "advice", "next3"],
  };
}
 
function buildPrompt({ subject, question, rubric, fullAnswer }) {
  return `
과목: ${subject}
문제: ${question}

${rubric || "[자료 없음]"}

[학생 답안]
${fullAnswer || "미작성"}

당신은 아주 깐깐한 노무사 2차 시험 채점위원입니다.
학생 답안을 [기본 모범답안]과 한 줄 한 줄 치밀하게 대조하여 100점 만점 기준으로 채점하세요.
특히 [강사 채점평 및 주의사항]이 있다면, 수험생들이 자주 범하는 오류나 누락 포인트에 이 학생도 빠지지 않았는지 최우선으로 검토하고 가차없이 감점하세요.
쟁점 25, 법적근거 30, 논리 25, 결론 10, 형식 10 기준으로 세부 점수를 매기고, 구체적인 피드백을 제공하세요.

반드시 JSON 객체만 반환하세요.
설명, 마크다운, 코드블록, 인사말, 추가 문장은 절대 포함하지 마세요.
`.trim();
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
    const question = String(body?.question || "").trim();
    const rubric = typeof body?.rubric === "string" ? body.rubric : "";
    const fullAnswer = typeof body?.fullAnswer === "string" ? body.fullAnswer : "";
 
    if (!subject || !question) {
      return sendJson(res, 400, { message: "Missing required fields: subject, question" });
    }
 
    // fullAnswer can be empty ("미작성") — that’s a valid grading request.
    const schema = buildSchema();
    const prompt = buildPrompt({ subject, question, rubric, fullAnswer });
 
    const raw = await callGeminiServer({ prompt, schema });
    const normalized = normalizeResult(raw);
 
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
        : e?.message || "Server error";
    return sendJson(res, status, { message });
  }
}

