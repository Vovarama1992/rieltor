const authPanel = document.querySelector("#authPanel");
const authForm = document.querySelector("#authForm");
const authStatus = document.querySelector("#authStatus");
const emailInput = document.querySelector("#email");
const passwordInput = document.querySelector("#password");
const registerButton = document.querySelector("#registerButton");
const logoutButton = document.querySelector("#logoutButton");
const accountBox = document.querySelector("#accountBox");
const accountEmail = document.querySelector("#accountEmail");
const appSections = document.querySelectorAll(".app-only");

const startButton = document.querySelector("#startButton");
const endButton = document.querySelector("#endButton");
const clearButton = document.querySelector("#clearButton");
const randomNameButton = document.querySelector("#randomNameButton");
const clientNameInput = document.querySelector("#clientName");
const statusLine = document.querySelector("#statusLine");
const cards = document.querySelector("#cards");
const remoteAudio = document.querySelector("#remoteAudio");

const firstNames = [
  "Мария",
  "Петр",
  "Анна",
  "Сергей",
  "Елена",
  "Дмитрий",
  "Ольга",
  "Алексей",
  "Наталья",
  "Игорь"
];

const patronymics = [
  "Ивановна",
  "Петрович",
  "Викторовна",
  "Сергеевич",
  "Андреевна",
  "Михайлович",
  "Александровна",
  "Николаевич"
];

const statusLabels = {
  warm: "тёплый",
  cold: "холодный",
  unclear: "неоднозначно"
};

let peerConnection = null;
let dataChannel = null;
let microphoneStream = null;
let activeClientName = "";
let currentUser = null;
let leads = [];
let finishInProgress = false;
let processedFunctionCalls = new Set();

authForm.addEventListener("submit", (event) => {
  event.preventDefault();
  authenticate("login");
});

registerButton.addEventListener("click", () => authenticate("register"));
logoutButton.addEventListener("click", logout);

randomNameButton.addEventListener("click", () => {
  clientNameInput.value = randomName();
});

startButton.addEventListener("click", startCall);
endButton.addEventListener("click", () => stopCall("Звонок завершён вручную."));
clearButton.addEventListener("click", clearLeads);

bootstrap();

async function bootstrap() {
  try {
    const data = await api("/api/me");
    if (data.user) {
      await enterApp(data.user);
      return;
    }
  } catch {
    // The login form is the fallback state.
  }

  renderAuth();
}

async function authenticate(mode) {
  try {
    setAuthStatus(mode === "login" ? "Входим..." : "Создаём аккаунт...");
    const data = await api(mode === "login" ? "/api/login" : "/api/register", {
      method: "POST",
      body: {
        email: emailInput.value,
        password: passwordInput.value
      }
    });
    await enterApp(data.user);
  } catch (error) {
    setAuthStatus(error.message);
  }
}

async function logout() {
  stopCall();
  await api("/api/logout", { method: "POST" }).catch(() => null);
  currentUser = null;
  leads = [];
  passwordInput.value = "";
  renderAuth();
}

async function enterApp(user) {
  currentUser = user;
  accountEmail.textContent = user.email;
  authPanel.hidden = true;
  accountBox.hidden = false;
  appSections.forEach((section) => {
    section.hidden = false;
  });
  setStatus("Готов к прозвону. Нажмите кнопку, AI начнёт разговор первым.");
  await loadLeads();
}

function renderAuth() {
  authPanel.hidden = false;
  accountBox.hidden = true;
  appSections.forEach((section) => {
    section.hidden = true;
  });
  setAuthStatus("Войдите или создайте аккаунт.");
  renderCards();
}

async function loadLeads() {
  const data = await api("/api/leads");
  leads = data.leads || [];
  renderCards();
}

async function clearLeads() {
  await api("/api/leads", { method: "DELETE" });
  leads = [];
  renderCards();
}

async function startCall() {
  if (!currentUser) {
    setAuthStatus("Сначала войдите в аккаунт.");
    return;
  }

  try {
    activeClientName = normalizeName(clientNameInput.value) || randomName();
    clientNameInput.value = activeClientName;
    finishInProgress = false;
    processedFunctionCalls = new Set();
    setBusy(true);
    setStatus("Запрашиваю доступ к микрофону...");

    microphoneStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    setStatus("Создаю голосовую Realtime-сессию...");
    const tokenData = await api("/token", {
      method: "POST",
      body: { clientName: activeClientName }
    });

    const ephemeralKey = tokenData.value || tokenData.client_secret?.value;
    if (!ephemeralKey) {
      throw new Error("Сервер не вернул временный ключ Realtime API.");
    }

    peerConnection = new RTCPeerConnection();
    peerConnection.ontrack = (event) => {
      remoteAudio.srcObject = event.streams[0];
    };

    for (const track of microphoneStream.getAudioTracks()) {
      peerConnection.addTrack(track, microphoneStream);
    }

    dataChannel = peerConnection.createDataChannel("oai-events");
    dataChannel.addEventListener("open", () => {
      setStatus(`Идёт звонок: ${activeClientName}. AI начнёт разговор первым.`);
      createAssistantResponse();
    });
    dataChannel.addEventListener("message", handleRealtimeEvent);
    dataChannel.addEventListener("close", () => setStatus("Соединение закрыто."));

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    const sdpResponse = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      body: offer.sdp,
      headers: {
        Authorization: `Bearer ${ephemeralKey}`,
        "Content-Type": "application/sdp"
      }
    });

    if (!sdpResponse.ok) {
      throw new Error(await sdpResponse.text());
    }

    await peerConnection.setRemoteDescription({
      type: "answer",
      sdp: await sdpResponse.text()
    });
  } catch (error) {
    stopCall();
    setStatus(`Ошибка: ${error.message}`);
  }
}

function createAssistantResponse() {
  sendEvent({
    type: "response.create",
    response: {
      instructions: `Скажи только: "${activeClientName}, здравствуйте. Удобно сейчас говорить?"`
    }
  });
}

function handleRealtimeEvent(message) {
  const event = JSON.parse(message.data);

  if (event.type === "response.function_call_arguments.done") {
    finishFromArguments(event.arguments, event.call_id || event.item_id || event.response_id);
    return;
  }

  if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
    finishFromArguments(event.item.arguments, event.item.call_id || event.item.id || event.response_id);
    return;
  }

  if (event.type === "error") {
    console.warn("Realtime API event error", event.error || event);
  }
}

async function finishFromArguments(rawArguments, callId) {
  const dedupeKey = callId || `${activeClientName}:${rawArguments}`;
  if (finishInProgress || processedFunctionCalls.has(dedupeKey)) {
    return;
  }

  finishInProgress = true;
  processedFunctionCalls.add(dedupeKey);

  let result;
  try {
    result = typeof rawArguments === "string" ? JSON.parse(rawArguments) : rawArguments;
  } catch {
    result = {};
  }

  const payload = {
    name: activeClientName,
    status: result.status || "unclear",
    interest_score: clampScore(result.interest_score),
    deal_type: clean(result.deal_type),
    budget: clean(result.budget),
    district: clean(result.district),
    timeline: clean(result.timeline),
    summary: clean(result.summary),
    reason: clean(result.reason)
  };

  try {
    const data = await api("/api/leads", {
      method: "POST",
      body: payload
    });
    if (!data.duplicate && !leads.some((lead) => lead.id === data.lead.id)) {
      leads.unshift(data.lead);
    }
    renderCards();
    setStatus(`База обновлена: ${data.lead.name} — ${statusLabels[data.lead.status]}.`);
    clientNameInput.value = randomName();
  } catch (error) {
    setStatus(`Карточка получена, но не сохранена: ${error.message}`);
  }

  window.setTimeout(() => stopCall("Звонок завершён. Можно запускать следующий."), 900);
}

function sendEvent(event) {
  if (dataChannel?.readyState === "open") {
    dataChannel.send(JSON.stringify(event));
  }
}

function stopCall(message) {
  dataChannel?.close();
  peerConnection?.close();
  microphoneStream?.getTracks().forEach((track) => track.stop());

  dataChannel = null;
  peerConnection = null;
  microphoneStream = null;
  remoteAudio.srcObject = null;
  setBusy(false);

  if (message) {
    setStatus(message);
  }
}

function renderCards() {
  if (!currentUser) {
    cards.innerHTML = "";
    return;
  }

  if (!leads.length) {
    cards.innerHTML = '<div class="empty-state">После звонка здесь появится первая запись.</div>';
    return;
  }

  cards.innerHTML = leads.map(renderCard).join("");
}

function renderCard(lead) {
  const status = ["warm", "cold", "unclear"].includes(lead.status) ? lead.status : "unclear";
  return `
    <article class="lead-card ${status}">
      <div class="card-top">
        <div>
          <div class="client-name">${escapeHtml(lead.name)}</div>
          <div class="created-at">${formatDate(lead.created_at)}</div>
        </div>
        <div class="status-pill ${status}">${statusLabels[status]}</div>
      </div>
      <div class="meta-grid">
        ${meta("Оценка интереса", `${lead.interest_score}%`)}
        ${meta("Тип сделки", lead.deal_type)}
        ${meta("Бюджет", lead.budget)}
        ${meta("Район", lead.district)}
        ${meta("Срок", lead.timeline)}
      </div>
      <p class="card-text"><strong>Резюме:</strong> ${escapeHtml(lead.summary)}</p>
      <p class="card-text"><strong>Причина:</strong> ${escapeHtml(lead.reason)}</p>
    </article>
  `;
}

function meta(label, value) {
  return `
    <div class="meta">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value || "неизвестно")}</strong>
    </div>
  `;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Ошибка запроса.");
  }
  return data;
}

function setBusy(isBusy) {
  startButton.disabled = isBusy;
  endButton.disabled = !isBusy;
  randomNameButton.disabled = isBusy;
  clientNameInput.disabled = isBusy;
}

function setStatus(text) {
  statusLine.textContent = text;
}

function setAuthStatus(text) {
  authStatus.textContent = text;
}

function randomName() {
  const firstName = firstNames[Math.floor(Math.random() * firstNames.length)];
  const patronymic = patronymics[Math.floor(Math.random() * patronymics.length)];
  return `${firstName} ${patronymic}`;
}

function normalizeName(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function clean(value) {
  return String(value || "неизвестно").trim().slice(0, 360);
}

function clampScore(value) {
  const score = Number(value);
  if (!Number.isFinite(score)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

function formatDate(value) {
  if (!value) {
    return "";
  }

  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
