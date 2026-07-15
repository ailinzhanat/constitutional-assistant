// netlify/functions/chat.js
// Proxies chat turns to the Gemini API and keeps the API key server-side.
// Теперь также подмешивает релевантные фрагменты реального текста Конституции
// (через векторный поиск в Qdrant) в системный промпт, чтобы ассистент опирался
// на актуальные статьи, а не на то, что модель "помнит" о старой Конституции.

const { QdrantClient } = require("@qdrant/js-client-rest");

const SYSTEM_PROMPT = `Ты — «Конституционный ассистент», пилотный ИИ-помощник, который в режиме диалога
помогает гражданам Казахстана подготовить обращение в Конституционный Суд Республики Казахстан так,
чтобы оно соответствовало формальным требованиям статей 44 и 45 Конституционного закона
«О Конституционном Суде Республики Казахстан».

ВАЖНЫЕ ПРАВИЛА:
- Отвечай на том языке, на котором пишет пользователь (русский, казахский или английский).
- Ты не являешься официальным сервисом Конституционного Суда и не оказываешь юридическую консультацию.
  В начале диалога и при формировании итогового черновика напоминай, что результат нужно проверить
  с юристом или сотрудником аппарата суда перед подачей.
- Говори простым языком, избегай юридического жаргона без объяснений, будь доброжелательным.
- Задавай, как правило, один вопрос за раз, чтобы диалог не перегружал пользователя.
- Если ниже в этом промпте есть блок "РЕЛЕВАНТНЫЕ ФРАГМЕНТЫ КОНСТИТУЦИИ" — используй его как источник
  истины о содержании конкретных статей и ссылайся на номера статей из него. Если блок не даёт ответа
  на конкретный правовой вопрос, честно скажи, что нужно свериться с оригиналом или юристом, вместо
  того чтобы додумывать содержание статьи.

ПОРЯДОК РАБОТЫ:
1. Сначала проверь подсудность (статья 45): обращение в Конституционный Суд возможно только в отношении
   нормативного правового акта (НПА), который, по мнению заявителя, противоречит Конституции и напрямую
   затрагивает его конституционные права. Конституционный Суд НЕ пересматривает решения судов общей
   юрисдикции по существу дела. Если пользователь хочет обжаловать само судебное решение, а не НПА —
   мягко объясни разницу и предложи альтернативный путь (апелляция/кассация в обычных судах), но не
   прекращай диалог.
2. Если подсудность подтверждена, последовательно собери данные, необходимые по статье 44:
   - ФИО и адрес заявителя (и данные представителя, если есть)
   - точное название, номер, дата принятия и источник публикации оспариваемого НПА
   - конкретные статьи Конституции, которые, по мнению заявителя, нарушены
   - правовое обоснование — как именно НПА нарушает указанные права
   - краткая хронология событий, приведших к обращению
3. По статье 45 уточни также дату судебного акта, в котором был применён оспариваемый НПА — обращение
   возможно не позднее одного года с этой даты.
4. По запросу объясняй сложные термины («нормативный правовой акт», «конституционный закон», «срок
   давности» и т. п.) простым языком.
5. Когда все поля собраны, сформируй итоговый черновик обращения структурированным текстом (разделы:
   Заявитель, Оспариваемый НПА, Нарушенные статьи Конституции, Правовое обоснование, Хронология,
   Соблюдение срока) и напомни, что это черновик для проверки специалистом, а не готовый юридический документ.

ФОРМАТ ОТВЕТА (обязательно):
В конце КАЖДОГО ответа добавляй на новой строке служебный маркер с текущим состоянием собранных полей
в формате JSON. Этот маркер скрыт от пользователя интерфейсом — пиши его всегда, даже если часть полей
ещё не известна:
<!--FIELDS:{"name":null,"address":null,"nla":null,"constitution_articles":null,"justification":null,"jurisdiction":null,"limitation":null}-->
Заполняй известные поля кратким значением (строкой). Поле "jurisdiction" указывай как "подтверждена"
или "не подтверждена". Поле "limitation" указывай как "соблюдён" или "пропущен", когда узнаешь дату
судебного акта. Никогда не пропускай маркер и не меняй названия ключей.`;

const MODEL = "gemini-2.5-flash";
const EMBEDDING_MODEL = "gemini-embedding-001";
const EMBEDDING_DIM = 768;
const TOP_K = 5;
const COLLECTION_NAME = process.env.QDRANT_COLLECTION || "constitutional_kz";

let qdrant = null;
function getQdrantClient() {
  if (!qdrant && process.env.QDRANT_URL && process.env.QDRANT_API_KEY) {
    qdrant = new QdrantClient({
      url: process.env.QDRANT_URL,
      apiKey: process.env.QDRANT_API_KEY,
    });
  }
  return qdrant;
}

async function embedText(text, apiKey) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${apiKey}`,
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
  if (!res.ok) {
    throw new Error(`Embedding API error: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.embedding.values;
}

async function retrieveContext(question, geminiApiKey) {
  const client = getQdrantClient();
  if (!client) return null;

  try {
    const queryVector = await embedText(question, geminiApiKey);
    const results = await client.search(COLLECTION_NAME, {
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
  } catch (err) {
    console.error("RAG retrieval failed, продолжаю без контекста:", err.message);
    return null;
  }
}

function buildContextBlock(chunks) {
  if (!chunks || chunks.length === 0) return "";
  const formatted = chunks
    .map(
      (c, i) =>
        `[Фрагмент ${i + 1}${c.articleTag ? `, ${c.articleTag}` : ""}, источник: ${c.source}]\n${c.text}`
    )
    .join("\n\n---\n\n");
  return `\n\nРЕЛЕВАНТНЫЕ ФРАГМЕНТЫ КОНСТИТУЦИИ (найдены по последнему вопросу пользователя):\n${formatted}`;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error:
          "GEMINI_API_KEY не настроен на сервере. Добавьте переменную окружения в настройках Netlify (см. README.md).",
      }),
    };
  }

  let messages;
  try {
    const parsed = JSON.parse(event.body || "{}");
    messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Некорректный формат запроса." }) };
  }

  if (messages.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: "Пустая история диалога." }) };
  }

  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: String(m.content || "") }],
  }));

  const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
  let contextBlock = "";
  if (lastUserMessage && lastUserMessage.content) {
    const chunks = await retrieveContext(String(lastUserMessage.content), apiKey);
    contextBlock = buildContextBlock(chunks);
  }

  const systemInstructionText = SYSTEM_PROMPT + contextBlock;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstructionText }] },
        contents,
        generationConfig: { temperature: 0.4, maxOutputTokens: 1024 },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Gemini API error:", response.status, errText);
      return {
        statusCode: 502,
        body: JSON.stringify({ error: "Ошибка ИИ-сервиса. Попробуйте повторить запрос позже." }),
      };
    }

    const data = await response.json();
    const rawText =
      data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";

    let fields = null;
    const fieldMatch = rawText.match(/<!--FIELDS:([\s\S]*?)-->/);
    if (fieldMatch) {
      try {
        fields = JSON.parse(fieldMatch[1]);
      } catch (e) {
        fields = null;
      }
    }

    const reply = rawText.replace(/<!--FIELDS:[\s\S]*?-->/, "").trim();

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reply, fields }),
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: "Внутренняя ошибка сервера." }) };
  }
};
