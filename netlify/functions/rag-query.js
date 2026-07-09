/**
 * netlify/functions/rag-query.js
 * Принимает вопрос пользователя, находит релевантные фрагменты
 * законодательства в Qdrant, формирует контекст и отправляет в Gemini.
 */

import { QdrantClient } from "@qdrant/js-client-rest";

const COLLECTION_NAME = process.env.QDRANT_COLLECTION || "constitutional_kz";
const EMBEDDING_MODEL = "gemini-embedding-001";
const EMBEDDING_DIM = 768;
const GENERATION_MODEL = "gemini-2.5-flash";
const TOP_K = 5;

const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
});

async function embedText(text) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `models/${EMBEDDING_MODEL}`,
        content: { parts: [{ text }] },
        outputDimensionality: EMBEDDING_DIM,
      }),
    }
  );
  if (!res.ok) throw new Error(`Embedding error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.embedding.values;
}

async function retrieveContext(question) {
  const queryVector = await embedText(question);
  const results = await qdrant.search(COLLECTION_NAME, {
    vector: queryVector,
    limit: TOP_K,
    with_payload: true,
  });

  return results.map((r) => ({
    text: r.payload.text,
    source: r.payload.source,
    articleTag: r.payload.articleTag,
    score: r.score,
  }));
}

function buildPrompt(question, contextChunks) {
  const contextBlock = contextChunks
    .map(
      (c, i) =>
        `[Фрагмент ${i + 1}${c.articleTag ? `, ${c.articleTag}` : ""}, источник: ${c.source}]\n${c.text}`
    )
    .join("\n\n---\n\n");

  return `Ты — юридический ассистент по Конституции и законодательству Республики Казахстан.
Отвечай СТРОГО на основе приведённых ниже фрагментов законодательства. Если ответа в них нет — прямо скажи об этом, не выдумывай.
Всегда указывай, на какую статью/фрагмент ты опираешься.

КОНТЕКСТ:
${contextBlock}

ВОПРОС ПОЛЬЗОВАТЕЛЯ:
${question}

Дай точный, структурированный ответ со ссылками на конкретные статьи/источники из контекста.`;
}

export default async (req, context) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  try {
    const { question } = await req.json();
    if (!question || typeof question !== "string") {
      return new Response(JSON.stringify({ error: "Поле 'question' обязательно" }), { status: 400 });
    }

    const contextChunks = await retrieveContext(question);
    const prompt = buildPrompt(question, contextChunks);

    const genRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GENERATION_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
        }),
      }
    );

    if (!genRes.ok) {
      const errText = await genRes.text();
      return new Response(JSON.stringify({ error: `Gemini API error: ${errText}` }), { status: 502 });
    }

    const genData = await genRes.json();
    const answer = genData.candidates?.[0]?.content?.parts?.[0]?.text ?? "Не удалось сгенерировать ответ.";

    return new Response(
      JSON.stringify({
        answer,
        sources: contextChunks.map((c) => ({
          source: c.source,
          articleTag: c.articleTag,
          score: c.score,
        })),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};

export const config = {
  path: "/api/rag-query",
};
