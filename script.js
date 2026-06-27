// ============================================================
// Constitutional Assistant — pilot frontend logic
// ============================================================

const FIELD_CONFIG = [
  { id: "name", article: "44", label: "ФИО / наименование заявителя" },
  { id: "address", article: "44", label: "Адрес заявителя" },
  { id: "nla", article: "44", label: "Оспариваемый НПА (название, дата, номер)" },
  { id: "constitution_articles", article: "44", label: "Нарушенные статьи Конституции" },
  { id: "justification", article: "44", label: "Правовое обоснование" },
  { id: "jurisdiction", article: "45", label: "Подсудность подтверждена" },
  { id: "limitation", article: "45", label: "Срок обращения (1 год) соблюдён" },
];

const INITIAL_ASSISTANT_MESSAGE =
  "Здравствуйте! Я — Конституционный ассистент, пилотный сервис, который помогает шаг за шагом " +
  "подготовить обращение в Конституционный Суд так, чтобы оно соответствовало статьям 44 и 45 " +
  "Конституционного закона.\n\n" +
  "Прежде чем мы начнём собирать данные — один важный вопрос: оспариваемый акт, о котором вы хотите " +
  "подать обращение, — это закон или иной нормативный правовой акт (НПА), который, как вы считаете, " +
  "противоречит Конституции? Или вы хотите обжаловать конкретное решение суда по вашему делу?";

const state = {
  // conversation sent to the model — excludes the hardcoded greeting on purpose,
  // it will be reconstructed server-side as the first turn of context implicitly.
  messages: [{ role: "assistant", content: INITIAL_ASSISTANT_MESSAGE }],
  fields: Object.fromEntries(FIELD_CONFIG.map((f) => [f.id, null])),
  busy: false,
};

const els = {
  thread: document.getElementById("chatThread"),
  form: document.getElementById("composerForm"),
  input: document.getElementById("composerInput"),
  sendBtn: document.getElementById("sendBtn"),
  fields44: document.getElementById("fields-44"),
  fields45: document.getElementById("fields-45"),
  dossier: document.getElementById("dossier"),
  dossierToggle: document.getElementById("dossierToggle"),
  dossierToggleCount: document.getElementById("dossierToggleCount"),
  template: document.getElementById("fieldItemTemplate"),
};

function renderFieldLists() {
  els.fields44.innerHTML = "";
  els.fields45.innerHTML = "";
  let doneCount = 0;

  FIELD_CONFIG.forEach((f) => {
    const value = state.fields[f.id];
    const isDone =
      value !== null &&
      value !== undefined &&
      String(value).trim() !== "" &&
      !/^(не указано|нет|null|pending|не подтверждена|пропущен)$/i.test(String(value).trim());

    if (isDone) doneCount += 1;

    const node = els.template.content.firstElementChild.cloneNode(true);
    node.dataset.field = f.id;
    node.classList.toggle("done", isDone);
    node.querySelector(".field-label").textContent = f.label;
    node.querySelector(".field-value").textContent = isDone ? String(value) : "Ожидает данных";

    (f.article === "44" ? els.fields44 : els.fields45).appendChild(node);
  });

  els.dossierToggleCount.textContent = `${doneCount} / ${FIELD_CONFIG.length}`;
}

function scrollToBottom() {
  els.thread.scrollTop = els.thread.scrollHeight;
}

function appendMessage(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  if (role === "assistant") {
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = "Ассистент";
    div.appendChild(label);
  }
  const body = document.createElement("span");
  body.textContent = text;
  div.appendChild(body);
  els.thread.appendChild(div);
  scrollToBottom();
  return div;
}

function appendSystemNote(text) {
  const div = document.createElement("div");
  div.className = "msg system-note";
  div.textContent = text;
  els.thread.appendChild(div);
  scrollToBottom();
}

function showTyping() {
  const div = document.createElement("div");
  div.className = "typing";
  div.id = "typingIndicator";
  div.innerHTML = "<span></span><span></span><span></span>";
  els.thread.appendChild(div);
  scrollToBottom();
}

function hideTyping() {
  const el = document.getElementById("typingIndicator");
  if (el) el.remove();
}

function setBusy(busy) {
  state.busy = busy;
  els.sendBtn.disabled = busy;
  els.input.disabled = busy;
}

async function sendToAssistant() {
  setBusy(true);
  showTyping();

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: state.messages, fields: state.fields }),
    });

    hideTyping();

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      appendSystemNote(
        errBody.error ||
          "Ассистент временно недоступен. Проверьте, что на сервере настроен GEMINI_API_KEY (см. README), и попробуйте снова."
      );
      setBusy(false);
      return;
    }

    const data = await res.json();
    const reply = data.reply || "Извините, не удалось сформировать ответ. Попробуйте переформулировать сообщение.";

    state.messages.push({ role: "assistant", content: reply });
    appendMessage("assistant", reply);

    if (data.fields && typeof data.fields === "object") {
      state.fields = { ...state.fields, ...data.fields };
      renderFieldLists();
    }
  } catch (err) {
    hideTyping();
    appendSystemNote(
      "Не удалось связаться с сервером ассистента. Это локальная сборка без подключённой функции — " +
        "после деплоя на Netlify с настроенным GEMINI_API_KEY чат заработает полностью (см. README.md)."
    );
  } finally {
    setBusy(false);
    els.input.focus();
  }
}

function autoresize() {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 130) + "px";
}

els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = els.input.value.trim();
  if (!text || state.busy) return;

  state.messages.push({ role: "user", content: text });
  appendMessage("user", text);
  els.input.value = "";
  autoresize();
  sendToAssistant();
});

els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    els.form.requestSubmit();
  }
});

els.input.addEventListener("input", autoresize);

els.dossierToggle.addEventListener("click", () => {
  const isOpen = els.dossier.classList.toggle("open");
  els.dossierToggle.setAttribute("aria-expanded", String(isOpen));
});

// ---- scroll-reveal for landing sections ----
function initReveal() {
  const targets = document.querySelectorAll(".reveal");
  if (!("IntersectionObserver" in window) || targets.length === 0) {
    targets.forEach((el) => el.classList.add("in-view"));
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("in-view");
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.15, rootMargin: "0px 0px -40px 0px" }
  );
  targets.forEach((el) => observer.observe(el));
}

// ---- init ----
appendMessage("assistant", INITIAL_ASSISTANT_MESSAGE);
renderFieldLists();
initReveal();
