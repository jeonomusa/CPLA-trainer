/**
 * POST /api/generate-paragraph
 *
 * Input:
 * - { subject, title, outline }
 *
 * Output:
 * - { paragraph }
 *
 * Env:
 * - GEMINI_API_KEY (required)
 * - GEMINI_MODEL (optional, default: "gemini-2.5-flash")
 */

const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const MAX_PARAGRAPH = 10000;

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

function normalizeParagraph(raw) {
  const paragraph =
    typeof raw?.paragraph === "string" ? raw.paragraph.trim() : "";
  const fallback = `[개념] 본 문제는 규범 요건 및 효과를 순차 검토해야 하는 서술형 답안이다. 관련 규정의 문언·입법 취지를 밝히고, 요건 해당성부터 판단한다.\n\n[전개] 구성요건을 충족하면 해당 법적 효력이 발생하며, 쟁점이 있는 경우에는 대법원 판례의 기준 및 예외 논점을 간결히 연결하여 서술한다. 각 문단은 위 목차(뼈대)의 순서를 따르며, 과도한 장문 인용 없이 논증의 흐름을 유지한다.\n\n[결론] 사안 적용 결과는 위 검토에 따라 도출된다는 점을 한 문장으로 마무리한다.`;
  return {
    paragraph: (
      paragraph || fallback
    ).slice(0, MAX_PARAGRAPH),
  };
}

function buildSchema() {
  return {
    type: "OBJECT",
    properties: { paragraph: { type: "STRING" } },
    required: ["paragraph"],
  };
}

function buildPrompt({ subject, title, outline }) {
  return `
과목: ${subject}
주제: ${title}
목차 구조:
${outline}

당신은 노무사 2차 수석 합격생입니다.
위 뼈대(목차)만 보고, 실제 시험 답안지에 작성할 법한 매끄럽고 논리적인 모범 단락(줄글)을 1~2개로 전개하세요.
수험생이 이 목차에서 어떤 살을 붙여야 하는지 보여주는 용도입니다.
전문적인 법률·노무 용어를 사용하세요.

불필요한 부가 설명, 인사말, 목차 재출력 없이 본문(단락)만 작성하세요.

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
    const outline = String(body?.outline || "").trim();

    if (!subject || !title || !outline) {
      return sendJson(res, 400, {
        message: "Missing required fields: subject, title, outline",
      });
    }

    if (subject.length > 100 || title.length > 200 || outline.length > 8000) {
      return sendJson(res, 400, { message: "Input too long" });
    }

    const schema = buildSchema();
    const prompt = buildPrompt({ subject, title, outline });
    const raw = await callGeminiServer({ prompt, schema });
    const normalized = normalizeParagraph(raw);

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
