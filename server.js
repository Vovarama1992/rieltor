import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const dataDir = join(__dirname, "data");
const dbPath = join(dataDir, "db.json");
const port = Number(process.env.PORT || 3000);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

let dbCache = null;

await loadEnvFile();

async function loadEnvFile() {
  try {
    const content = await readFile(join(__dirname, ".env"), "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
        continue;
      }

      const index = trimmed.indexOf("=");
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
      process.env[key] ||= value;
    }
  } catch {
    // .env is optional; real deployment can provide environment variables directly.
  }
}

function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || "")
      .split(";")
      .map((cookie) => cookie.trim())
      .filter(Boolean)
      .map((cookie) => {
        const index = cookie.indexOf("=");
        return [cookie.slice(0, index), decodeURIComponent(cookie.slice(index + 1))];
      })
  );
}

function setSessionCookie(res, token) {
  res.setHeader(
    "Set-Cookie",
    `session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`
  );
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) {
      throw new Error("Request body is too large");
    }
  }
  return body ? JSON.parse(body) : {};
}

async function loadDb() {
  if (dbCache) {
    return dbCache;
  }

  try {
    dbCache = JSON.parse(await readFile(dbPath, "utf8"));
  } catch {
    dbCache = { users: [], sessions: {}, leads: {} };
    await saveDb();
  }

  dbCache.users ||= [];
  dbCache.sessions ||= {};
  dbCache.leads ||= {};
  return dbCache;
}

async function saveDb() {
  await mkdir(dirname(dbPath), { recursive: true });
  await writeFile(dbPath, JSON.stringify(dbCache, null, 2));
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function validateAuth(email, password) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return "Введите корректный e-mail.";
  }

  if (String(password || "").length < 4) {
    return "Пароль должен быть хотя бы 4 символа.";
  }

  return null;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 100_000, 32, "sha256").toString("hex");
  return { salt, hash };
}

function verifyPassword(password, user) {
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(user.passwordHash, "hex"));
}

async function getCurrentUser(req) {
  const db = await loadDb();
  const token = parseCookies(req).session;
  const userId = token ? db.sessions[token] : null;
  return db.users.find((user) => user.id === userId) || null;
}

function publicUser(user) {
  return { id: user.id, email: user.email };
}

async function requireUser(req, res) {
  const user = await getCurrentUser(req);
  if (!user) {
    json(res, 401, { error: "Нужно войти в аккаунт." });
    return null;
  }
  return user;
}

function buildInstructions(clientName) {
  return `
Ты голосовой AI-риелтор. Ты звонишь человеку из холодной базы агентства недвижимости.

Клиента зовут: ${clientName}.

Цель звонка: естественно и коротко понять, есть ли у клиента интерес к недвижимости. Интересом считается покупка, аренда или продажа объекта.

Главное правило демо:
- Как только клиент сказал, что хочет купить, арендовать или продать недвижимость, он уже не холодный.
- После первого явного интереса можно задать максимум один короткий уточняющий вопрос для вида.
- Если клиент ответил на этот вопрос, отказался уточнять или начал раздражаться, сразу завершай звонок и сохраняй подходящий статус по шкале.
- Не пытайся обязательно собрать бюджет, район и срок. Это необязательные поля; если их нет, ставь "неизвестно".

Шкала статуса:
- "hot" / горячий: клиент прямо просит подобрать объект, перезвонить, встретиться, оставить заявку, продать объект или явно готов к следующему шагу.
- "warm" / тёплый: клиент сказал, что хочет купить, арендовать или продать недвижимость, но без явного следующего шага.
- "lukewarm" / тёпленький: клиент говорит "расскажите", "в целом интересно", "может быть", задает общий вопрос.
- "cool" / полухолодный: клиент скорее не хочет, говорит "да вроде нет", "не сейчас", "может потом", но без жесткого отказа.
- "cold" / холодный: клиент прямо отказался, просит не звонить, грубит или интереса нет.

Правила поведения:
- Говори только по-русски.
- Начни первым строго одной короткой фразой: "${clientName}, здравствуйте. Удобно сейчас говорить?"
- Веди себя как живой сотрудник агентства, не как чат-бот.
- Не продавай квартиры, не подбирай объекты, не консультируй, не спорь и не уходи в длинные объяснения.
- Говори коротко: максимум 1-2 коротких предложения за ход.
- Задавай только один вопрос за раз.
- Не произноси длинные вступления и не объясняй, как работает звонок.
- Не затягивай разговор. Твоя задача не удерживать клиента, а быстро квалифицировать.
- Как только понял статус клиента и собрал минимально доступную информацию, сразу мягко завершай звонок.
- Если клиент уже явно не холодный, не продолжай расспрашивать: один короткий вопрос максимум, затем финальная фраза.
- Если клиент холодный, грубит, уходит от темы или явно не хочет говорить, завершай после одной спокойной реплики.
- Если клиент грубит, не заинтересован или занят, спокойно заверши разговор.
- Если клиент просит перезвонить позже, отметь это в сроке или резюме и заверши.
- Если клиент заинтересован, задай 0-1 короткий уточняющий вопрос и заверши.
- Если клиент сначала проявил интерес, а потом раздражается из-за вопросов, не ставь cold. Причина: интерес был, детализацию не захотел.
- Если клиент хочет продать квартиру или дом, это warm или hot. Не спорь с ценой, даже если она выглядит странно. Скажи коротко: "Понял вас. Передам специалисту, с вами свяжутся."
- Перед вызовом инструмента обязательно произнеси финальную фразу голосом. Не вызывай инструмент молча.
- Когда информации достаточно, скажи примерно: "Понял вас, ${clientName}. Передам специалисту, с вами свяжутся. Хорошего дня."
- После финальной фразы обязательно вызови инструмент finish_call с итоговой квалификацией.
`.trim();
}

function buildTool() {
  return {
    type: "function",
    name: "finish_call",
    description: "Завершить звонок и сохранить карточку квалификации клиента.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: {
          type: "string",
          enum: ["hot", "warm", "lukewarm", "cool", "cold"],
          description: "Итог по шкале: горячий, тёплый, тёпленький, полухолодный или холодный клиент."
        },
        interest_score: { type: "integer", minimum: 0, maximum: 100 },
        deal_type: { type: "string", description: "Покупка, аренда, продажа, неизвестно или неактуально." },
        budget: { type: "string", description: "Примерный бюджет, желаемая цена или 'неизвестно'." },
        district: { type: "string", description: "Район или 'неизвестно'." },
        timeline: { type: "string", description: "Срок или договоренность о перезвоне." },
        summary: { type: "string", description: "Краткое резюме разговора в 1-2 предложениях." },
        reason: { type: "string", description: "Почему присвоен такой статус." }
      },
      required: [
        "status",
        "interest_score",
        "deal_type",
        "budget",
        "district",
        "timeline",
        "summary",
        "reason"
      ]
    }
  };
}

async function handleRegister(req, res) {
  const db = await loadDb();
  const input = await readBody(req);
  const email = normalizeEmail(input.email);
  const password = String(input.password || "");
  const validationError = validateAuth(email, password);

  if (validationError) {
    json(res, 400, { error: validationError });
    return;
  }

  if (db.users.some((user) => user.email === email)) {
    json(res, 409, { error: "Такой e-mail уже зарегистрирован." });
    return;
  }

  const { salt, hash } = hashPassword(password);
  const user = {
    id: crypto.randomUUID(),
    email,
    salt,
    passwordHash: hash,
    createdAt: new Date().toISOString()
  };
  const token = crypto.randomBytes(32).toString("hex");

  db.users.push(user);
  db.sessions[token] = user.id;
  db.leads[user.id] = [];
  await saveDb();

  setSessionCookie(res, token);
  json(res, 201, { user: publicUser(user) });
}

async function handleLogin(req, res) {
  const db = await loadDb();
  const input = await readBody(req);
  const email = normalizeEmail(input.email);
  const password = String(input.password || "");
  const validationError = validateAuth(email, password);

  if (validationError) {
    json(res, 400, { error: validationError });
    return;
  }

  const user = db.users.find((candidate) => candidate.email === email);
  if (!user || !verifyPassword(password, user)) {
    json(res, 401, { error: "Неверный e-mail или пароль." });
    return;
  }

  const token = crypto.randomBytes(32).toString("hex");
  db.sessions[token] = user.id;
  db.leads[user.id] ||= [];
  await saveDb();

  setSessionCookie(res, token);
  json(res, 200, { user: publicUser(user) });
}

async function handleLogout(req, res) {
  const db = await loadDb();
  const token = parseCookies(req).session;
  if (token) {
    delete db.sessions[token];
    await saveDb();
  }
  clearSessionCookie(res);
  json(res, 200, { ok: true });
}

async function handleMe(req, res) {
  const user = await getCurrentUser(req);
  json(res, 200, { user: user ? publicUser(user) : null });
}

function cleanLead(input, userId) {
  const statuses = new Set(["hot", "warm", "lukewarm", "cool", "cold", "unclear"]);
  const score = Number(input.interest_score);
  const rawDealType = String(input.deal_type || "неизвестно").trim().slice(0, 160);
  const hasRealEstateIntent = /покуп|куп|аренд|сним|снять|продаж|продать|прода/.test(
    rawDealType.toLowerCase()
  );
  const rawStatus = statuses.has(input.status) ? input.status : "lukewarm";
  const status = rawStatus === "unclear" ? "lukewarm" : rawStatus;
  const normalizedStatus =
    hasRealEstateIntent && (status === "cold" || status === "cool") ? "warm" : status;
  const normalizedScore =
    (normalizedStatus === "hot" || normalizedStatus === "warm") &&
    Number.isFinite(score) &&
    score < 60
      ? 60
      : score;

  return {
    id: crypto.randomUUID(),
    userId,
    name: String(input.name || "Неизвестный клиент").trim().slice(0, 80),
    status: normalizedStatus,
    interest_score: Number.isFinite(normalizedScore)
      ? Math.max(0, Math.min(100, Math.round(normalizedScore)))
      : 0,
    deal_type: rawDealType,
    budget: String(input.budget || "неизвестно").trim().slice(0, 160),
    district: String(input.district || "неизвестно").trim().slice(0, 160),
    timeline: String(input.timeline || "неизвестно").trim().slice(0, 160),
    summary: String(input.summary || "неизвестно").trim().slice(0, 500),
    reason: String(input.reason || "неизвестно").trim().slice(0, 500),
    created_at: new Date().toISOString()
  };
}

function isDuplicateLead(previous, next) {
  if (!previous) {
    return false;
  }

  const previousTime = new Date(previous.created_at).getTime();
  const isRecent = Number.isFinite(previousTime) && Date.now() - previousTime < 10_000;

  return (
    isRecent &&
    previous.name === next.name &&
    previous.status === next.status &&
    previous.deal_type === next.deal_type &&
    previous.budget === next.budget &&
    previous.district === next.district &&
    previous.timeline === next.timeline &&
    previous.summary === next.summary &&
    previous.reason === next.reason
  );
}

async function handleLeads(req, res) {
  const user = await requireUser(req, res);
  if (!user) {
    return;
  }

  const db = await loadDb();
  db.leads[user.id] ||= [];

  if (req.method === "GET") {
    json(res, 200, { leads: db.leads[user.id] });
    return;
  }

  if (req.method === "POST") {
    const input = await readBody(req);
    const lead = cleanLead(input, user.id);
    const existing = db.leads[user.id][0];
    if (isDuplicateLead(existing, lead)) {
      json(res, 200, { lead: existing, duplicate: true });
      return;
    }

    db.leads[user.id].unshift(lead);
    await saveDb();
    json(res, 201, { lead });
    return;
  }

  if (req.method === "DELETE") {
    db.leads[user.id] = [];
    await saveDb();
    json(res, 200, { ok: true });
    return;
  }

  json(res, 405, { error: "Method not allowed" });
}

async function handleToken(req, res) {
  if (req.method !== "POST") {
    json(res, 405, { error: "Method not allowed" });
    return;
  }

  const user = await requireUser(req, res);
  if (!user) {
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    json(res, 500, { error: "OPENAI_API_KEY is not set on the server" });
    return;
  }

  try {
    const input = await readBody(req);
    const clientName = String(input.clientName || "Виктор Викторович").slice(0, 80);
    const safetyId = crypto
      .createHash("sha256")
      .update(`ai-realtor-demo:${user.id}`)
      .digest("hex");

    const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "OpenAI-Safety-Identifier": safetyId
      },
      body: JSON.stringify({
        session: {
          type: "realtime",
          model: "gpt-realtime-2",
          instructions: buildInstructions(clientName),
          audio: {
            input: {
              turn_detection: {
                type: "server_vad",
                silence_duration_ms: 650
              }
            },
            output: {
              voice: "marin"
            }
          },
          tools: [buildTool()],
          tool_choice: "auto"
        }
      })
    });

    const data = await response.json();
    if (!response.ok) {
      json(res, response.status, {
        error: data.error?.message || "OpenAI token request failed",
        details: data
      });
      return;
    }

    json(res, 200, data);
  } catch (error) {
    json(res, 500, { error: error.message || "Failed to create realtime token" });
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = normalize(decodeURIComponent(requestedPath)).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath);

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream"
    });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const routes = {
  "/api/register": handleRegister,
  "/api/login": handleLogin,
  "/api/logout": handleLogout,
  "/api/me": handleMe,
  "/api/leads": handleLeads,
  "/token": handleToken
};

const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
    const route = routes[pathname];

    if (route) {
      await route(req, res);
      return;
    }

    await serveStatic(req, res);
  } catch (error) {
    json(res, 500, { error: error.message || "Server error" });
  }
});

server.listen(port, () => {
  console.log(`AI realtor demo: http://localhost:${port}`);
});
