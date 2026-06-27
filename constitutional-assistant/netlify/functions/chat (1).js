// netlify/functions/chat.js
// Proxies chat turns to the Gemini API and keeps the API key server-side.

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

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
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
