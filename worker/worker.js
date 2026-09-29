// Nova Market API: Cloudflare Worker.
// Хранит список подарков и балансы в KV, пускает в админку только ADMIN_IDS.
// Каждый запрос от мини-приложения подписан Telegram (initData), подпись проверяется токеном бота.
//
// Настройки воркера (Settings → Variables and Secrets / Bindings):
//   BOT_TOKEN   секрет, токен бота от @BotFather
//   ADMIN_IDS   Telegram ID админов через запятую, например 123456789
//   DB          привязка KV namespace
//   ALLOWED_ORIGIN  (необязательно) адреса мини-приложения через запятую,
//                   по умолчанию https://novamarketsbot.inarmine2009.workers.dev и https://pochtadantov-eng.github.io

const MAX_AUTH_AGE = 24 * 60 * 60; // initData действительна сутки
const FLOOR_DISCOUNT = 0.2; // цена подарка = флор минус 20%
// Те же правила цен, что в мини-приложении (index.html). Сервер считает цену сам и клиенту не верит.
const TON_DISCOUNT = 0.15; // TON продаём на 15% дешевле биржи
const TON_MIN = 1, TON_MAX = 5000;
const RATE_TTL = 5 * 60 * 1000; // курс обновляем раз в 5 минут
const STAR_MIN = 100, STAR_MAX = 100000;
const STAR_TIERS = [ { from: 100, rub: 1.3 }, { from: 500, rub: 1.1 }, { from: 2000, rub: 1.0 }, { from: 10000, rub: 0.9 } ];
const PRICE_SLACK = 0.03; // если цена выросла больше чем на 3% с того, что видел покупатель, просим подтвердить заново
const FRAG = "https://nft.fragment.com/gift/";
const PAGES = "https://pochtadantov-eng.github.io"; // отсюда берётся запасной gifts.json
const APP_ORIGINS = ["https://novamarketsbot.inarmine2009.workers.dev", PAGES];
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36";

export default {
  async fetch(request, env, ctx) {
    const allowed = env.ALLOWED_ORIGIN ? env.ALLOWED_ORIGIN.split(",").map((s) => s.trim().replace(/\/+$/, "")) : APP_ORIGINS;
    const reqOrigin = request.headers.get("Origin");
    const origin = allowed.includes(reqOrigin) ? reqOrigin : allowed[0];
    const cors = {
      "Access-Control-Allow-Origin": origin,
      "Vary": "Origin",
      "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,X-Init-Data",
      "Access-Control-Max-Age": "86400",
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });

    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";

      // Публично: список подарков
      if (request.method === "GET" && path === "/gifts") {
        return json({ gifts: await loadGifts(env, origin) });
      }

      // Публично: курс TON/RUB, по которому сервер считает цены (мини-приложение показывает его же)
      if (request.method === "GET" && path === "/rate") {
        const r = await tonRub(env);
        return r.v ? json({ market: r.v, source: r.src, at: r.t }) : json({ error: "Курс недоступен" }, 503);
      }

      const token = String(env.BOT_TOKEN || "").trim().replace(/^["']|["']$/g, "");
      if (!token) return json({ error: "На сервере не задан BOT_TOKEN" }, 500);

      // Кнопки «Подтвердить / Отклонить» в боте: Telegram присылает нажатия сюда (webhook)
      if (request.method === "POST" && path === "/tg") {
        const secret = await hookSecret(token);
        if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== secret) return new Response("forbidden", { status: 403 });
        const update = await request.json().catch(() => ({}));
        await onUpdate(env, token, update).catch(() => {});
        return new Response("ok");
      }

      // Дальше только с подписью Telegram
      const auth = await checkInitData(request.headers.get("X-Init-Data") || "", token);
      if (auth.error) return json({ error: auth.error }, 401);
      const user = auth.user;
      const isAdmin = adminIds(env).includes(String(user.id));
      const me = await touchUser(env, user);
      if (me.banned && !isAdmin) return json({ error: "Доступ к магазину закрыт", banned: true }, 403);

      if (request.method === "GET" && path === "/me") {
        // Когда админ открывает магазин, подключаем webhook бота (один раз), чтобы работали кнопки заказов
        if (isAdmin) {
          const job = ensureWebhook(env, token, url.origin).catch(() => {});
          if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
        }
        return json({ id: user.id, username: user.username || null, isAdmin, balance: me.balance || 0 });
      }

      // История заказов покупателя
      if (request.method === "GET" && path === "/orders") {
        const orders = ((await env.DB.get("orders", "json")) || []).filter((o) => o.user === user.id).slice(0, 50);
        return json({ orders: orders.map(({ gift, ...o }) => o) });
      }

      // Покупка за баланс: {type:"gift", id} | {type:"stars", amount, to?} | {type:"ton", amount, wallet}; expect = цена, которую видел покупатель
      if (request.method === "POST" && path === "/buy") {
        const body = await request.json().catch(() => ({}));
        return buy(env, origin, token, user, body, json);
      }

      if (!isAdmin) return json({ error: "Нет доступа" }, 403);

      // Пользователи: список и поиск по ID, @username или имени
      if (request.method === "GET" && path === "/admin/users") {
        const q = String(url.searchParams.get("q") || "").trim().replace(/^@/, "").toLowerCase();
        if (/^\d+$/.test(q)) {
          const u = await getUser(env, q);
          return json({ users: u ? [u] : [{ id: Number(q), username: null, name: "", balance: 0, banned: false, unknown: true }] });
        }
        const ids = ((await env.DB.get("users", "json")) || []).slice(0, q ? 500 : 100);
        let users = (await Promise.all(ids.map((id) => getUser(env, id)))).filter(Boolean);
        if (q) users = users.filter((u) => (u.username || "").toLowerCase().includes(q) || (u.name || "").toLowerCase().includes(q));
        return json({ users: users.slice(0, 100) });
      }

      const um = path.match(/^\/admin\/users\/(\d+)\/(balance|ban)$/);
      if (request.method === "POST" && um) {
        const body = await request.json().catch(() => ({}));
        const u = (await getUser(env, um[1])) || newUser({ id: Number(um[1]) });
        if (um[2] === "balance") {
          const amount = Math.round(Number(body.amount) * 100) / 100;
          if (!isFinite(amount) || Math.abs(amount) > 1e9) return json({ error: "Неверная сумма" }, 400);
          const next = body.mode === "add" ? (u.balance || 0) + amount : amount;
          if (next < 0) return json({ error: "Баланс не может быть меньше нуля" }, 400);
          u.balance = Math.round(next * 100) / 100;
        } else {
          if (adminIds(env).includes(String(u.id))) return json({ error: "Админа забанить нельзя" }, 400);
          u.banned = !!body.banned;
        }
        await saveUser(env, u, true);
        return json({ ok: true, user: u });
      }

      // Флор коллекции с маркета Fragment, цена = флор минус 20%
      if (request.method === "GET" && path === "/admin/floor") {
        const m = String(url.searchParams.get("link") || "").match(/nft\/([A-Za-z0-9]+)-\d+/);
        if (!m) return json({ error: "Нужна ссылка вида t.me/nft/PlushPepe-1843" }, 400);
        const floor = await fragmentFloor(m[1].toLowerCase());
        if (!floor) return json({ error: "Не удалось узнать флор, введите цену вручную" }, 502);
        return json({ floor, price_ton: Math.round(floor * (1 - FLOOR_DISCOUNT) * 100) / 100 });
      }

      if (request.method === "POST" && path === "/admin/gifts") {
        const body = await request.json().catch(() => ({}));
        const gift = parseGift(body);
        if (!gift) return json({ error: "Нужна ссылка вида t.me/nft/PlushPepe-1843 и цена в TON больше нуля" }, 400);
        const gifts = await loadGifts(env, origin);
        const i = gifts.findIndex((g) => g.id === gift.id);
        if (i >= 0) gifts[i] = gift; else gifts.unshift(gift);
        await env.DB.put("gifts", JSON.stringify(gifts));
        return json({ ok: true, gift, gifts });
      }

      // Вернуть витрину из gifts.json на сайте (заменяет текущий список)
      if (request.method === "POST" && path === "/admin/gifts/restore") {
        const gifts = await loadGifts(env, origin, true);
        return json({ ok: true, gifts });
      }

      const del = path.match(/^\/admin\/gifts\/([a-z0-9]+-\d+)$/);
      if (request.method === "DELETE" && del) {
        const gifts = (await loadGifts(env, origin)).filter((g) => g.id !== del[1]);
        await env.DB.put("gifts", JSON.stringify(gifts));
        return json({ ok: true, gifts });
      }

      return json({ error: "Не найдено" }, 404);
    } catch (e) {
      return json({ error: "Ошибка сервера" }, 500);
    }
  },
};

async function buy(env, origin, token, tgUser, body, json) {
  const type = String(body.type || "");
  let rub, item, gift = null, gifts = null;
  if (type === "gift") {
    gifts = await loadGifts(env, origin);
    gift = gifts.find((g) => g.id === String(body.id || ""));
    if (!gift) return json({ error: "Этот подарок уже купили или сняли с продажи", sold: true }, 410);
    const market = (await tonRub(env)).v;
    if (!market) return json({ error: "Не удалось узнать курс TON, попробуйте через минуту" }, 503);
    rub = Math.round(gift.price_ton * market);
    item = gift.name + " #" + gift.link.split("-").pop();
  } else if (type === "stars") {
    const n = Math.floor(Number(body.amount));
    if (!(n >= STAR_MIN && n <= STAR_MAX)) return json({ error: "Можно купить от " + STAR_MIN + " до " + STAR_MAX + " звёзд" }, 400);
    const tier = STAR_TIERS.filter((t) => n >= t.from).pop();
    rub = Math.round(n * tier.rub * 100) / 100;
    const to = String(body.to || "").trim().replace(/^@/, "");
    if (to && !/^[A-Za-z0-9_]{4,32}$/.test(to)) return json({ error: "Неверный username получателя" }, 400);
    item = n + " Telegram Stars" + (to ? " для @" + to : "");
  } else if (type === "ton") {
    const v = Math.round(Number(body.amount) * 100) / 100;
    if (!(v >= TON_MIN && v <= TON_MAX)) return json({ error: "Можно купить от " + TON_MIN + " до " + TON_MAX + " TON" }, 400);
    const wallet = String(body.wallet || "").trim();
    if (!/^[A-Za-z0-9_:\-]{20,80}$/.test(wallet)) return json({ error: "Неверный адрес кошелька TON" }, 400);
    const market = (await tonRub(env)).v;
    if (!market) return json({ error: "Не удалось узнать курс TON, попробуйте через минуту" }, 503);
    rub = Math.round(v * Math.floor(market * (1 - TON_DISCOUNT)));
    item = v + " TON на кошелёк " + wallet;
  } else {
    return json({ error: "Неизвестный товар" }, 400);
  }

  const expect = Number(body.expect);
  if (expect > 0 && rub > expect * (1 + PRICE_SLACK)) return json({ error: "Цена обновилась, теперь " + fmtRub(rub), price: rub }, 409);

  // Баланс перечитываем прямо перед списанием. Главная проверка здесь: денег меньше цены — ничего не списываем.
  const u = (await getUser(env, tgUser.id)) || newUser(tgUser);
  const balance = u.balance || 0;
  if (balance < rub) return json({ error: "Недостаточно средств: нужно " + fmtRub(rub) + ", на балансе " + fmtRub(balance), need: rub, balance }, 402);
  u.balance = Math.round((balance - rub) * 100) / 100;
  await saveUser(env, u, false);

  // Уникальный подарок продаётся один раз: убираем его с витрины
  if (gift) await env.DB.put("gifts", JSON.stringify(gifts.filter((g) => g.id !== gift.id)));

  const orders = (await env.DB.get("orders", "json")) || [];
  let id;
  do id = orderId(); while (orders.some((o) => o.id === id));
  const order = { id, type, item, rub, user: u.id, username: u.username || null, at: Date.now(), status: "pending" };
  if (gift) { order.link = gift.link; order.gift = gift; }
  orders.unshift(order);
  await env.DB.put("orders", JSON.stringify(orders.slice(0, 500)));

  // Сообщения в бота. Ошибка отправки не отменяет покупку.
  const notified = await notifyBuyer(token, u, order, gift).catch(() => false);
  await notifyAdmins(env, token, u, order).catch(() => {});

  const { gift: _g, ...pub } = order;
  return json({ ok: true, balance: u.balance, order: pub, notified, gifts: gift ? gifts.filter((g) => g.id !== gift.id) : undefined });
}

// Курс TON/RUB. Биржи иногда не отвечают серверам Cloudflare, поэтому источников несколько:
// CoinGecko и CryptoCompare сразу в рублях, иначе TON/USDT с OKX, Bybit, KuCoin или Binance × курс доллара.
// Держим в памяти 5 минут, последний удачный курс храним в KV (не старше суток) на случай, если все молчат.
let rateCache = { v: 0, t: 0, src: "" };
const getJ = (u) => fetch(u, { headers: { "User-Agent": UA, Accept: "application/json" } }).then((r) => (r.ok ? r.json() : Promise.reject(r.status)));
const RUB_SOURCES = [
  ["coingecko", async () => (await getJ("https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=rub"))["the-open-network"].rub],
  ["cryptocompare", async () => (await getJ("https://min-api.cryptocompare.com/data/price?fsym=TON&tsyms=RUB")).RUB],
];
const USD_SOURCES = [
  ["okx", async () => (await getJ("https://www.okx.com/api/v5/market/ticker?instId=TON-USDT")).data[0].last],
  ["bybit", async () => (await getJ("https://api.bybit.com/v5/market/tickers?category=spot&symbol=TONUSDT")).result.list[0].lastPrice],
  ["kucoin", async () => (await getJ("https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=TON-USDT")).data.price],
  ["binance", async () => (await getJ("https://api.binance.com/api/v3/ticker/price?symbol=TONUSDT")).price],
];
const USDRUB_SOURCES = [
  async () => (await getJ("https://www.cbr-xml-daily.ru/daily_json.js")).Valute.USD.Value,
  async () => (await getJ("https://open.er-api.com/v6/latest/USD")).rates.RUB,
];
async function firstOk(list) {
  for (const f of list) {
    try { const v = Number(await f()); if (v > 0) return v; } catch {}
  }
  return 0;
}
async function tonRub(env) {
  if (rateCache.v && Date.now() - rateCache.t < RATE_TTL) return rateCache;
  let v = 0, src = "";
  for (const [name, f] of RUB_SOURCES) {
    try { v = Number(await f()) || 0; } catch {}
    if (v > 0) { src = name; break; }
  }
  if (!v) {
    const [usd, usdrub] = await Promise.all([firstOk(USD_SOURCES.map(([, f]) => f)), firstOk(USDRUB_SOURCES)]);
    if (usd && usdrub) { v = usd * usdrub; src = "usdt×usd"; }
  }
  if (v > 0) {
    rateCache = { v, t: Date.now(), src };
    const saved = await env.DB.get("rate", "json").catch(() => null);
    if (!saved || Date.now() - saved.t > 60 * 60 * 1000) await env.DB.put("rate", JSON.stringify(rateCache)).catch(() => {});
    return rateCache;
  }
  const saved = await env.DB.get("rate", "json").catch(() => null);
  if (saved && saved.v > 0 && Date.now() - saved.t < 24 * 3600 * 1000) return { ...saved, src: "saved" };
  return rateCache.v ? rateCache : { v: 0, t: 0, src: "" };
}

function orderId() {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const b = crypto.getRandomValues(new Uint8Array(6));
  return [...b].map((x) => abc[x % abc.length]).join("");
}

function fmtRub(n) {
  return n.toLocaleString("ru-RU", { maximumFractionDigits: 2 }) + " ₽";
}

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}

async function tgApi(token, method, payload) {
  const isForm = payload instanceof FormData;
  const res = await fetch("https://api.telegram.org/bot" + token + "/" + method, {
    method: "POST",
    headers: isForm ? undefined : { "Content-Type": "application/json" },
    body: isForm ? payload : JSON.stringify(payload),
  });
  const d = await res.json().catch(() => ({}));
  return !!d.ok;
}

// Покупателю в чат с ботом: анимация подарка (стикер из его Lottie с Fragment), затем описание.
async function notifyBuyer(token, u, order, gift) {
  const chat_id = u.id;
  const wait = "⏳ Подарок будет выведен на ваш аккаунт в течение нескольких часов. Возможна задержка, это нормально: всё придёт.\nСтатус заказа видно в магазине во вкладке «История».";
  let text, sticker = false, extra = {};
  if (gift) {
    const key = gift.id; // slug-номер, как на nft.fragment.com
    sticker = await sendGiftSticker(token, chat_id, key).catch(() => false);
    const attrs = await fetch(FRAG + key + ".json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const at = (attrs && attrs.attributes) || [];
    const pick = (names) => at.find((a) => names.includes(String(a.trait_type || a.type || "").toLowerCase()));
    const rows = [["Модель", pick(["model"])], ["Фон", pick(["backdrop", "background"])], ["Узор", pick(["symbol", "pattern"])]]
      .filter(([, a]) => a && a.value)
      .map(([k, a]) => k + ": <b>" + esc(a.value) + "</b>");
    text = ["🎁 <b>Покупка оформлена!</b>" + "\nЗаказ <b>#" + order.id + "</b>", "", "<b>" + esc(order.item) + "</b>", "Коллекция Telegram", ...rows, "",
      "Списано: <b>" + fmtRub(order.rub) + "</b>", "Остаток на балансе: " + fmtRub(u.balance), "", wait].join("\n");
    extra.reply_markup = { inline_keyboard: [[{ text: "Посмотреть подарок", url: gift.link }]] };
    // Не получилось со стикером: пусть Telegram покажет анимированное превью подарка по ссылке над текстом
    extra.link_preview_options = sticker ? { is_disabled: true } : { url: gift.link, prefer_large_media: true, show_above_text: true };
  } else {
    const emoji = order.type === "stars" ? "⭐️" : "💎";
    text = [emoji + " <b>Покупка оформлена!</b>" + "\nЗаказ <b>#" + order.id + "</b>", "", "<b>" + esc(order.item) + "</b>", "",
      "Списано: <b>" + fmtRub(order.rub) + "</b>", "Остаток на балансе: " + fmtRub(u.balance), "",
      wait.replace("Подарок будет выведен на ваш аккаунт", order.type === "stars" ? "Звёзды будут зачислены" : "TON будут отправлены на кошелёк")].join("\n");
    extra.link_preview_options = { is_disabled: true };
  }
  return tgApi(token, "sendMessage", { chat_id, text, parse_mode: "HTML", ...extra });
}

// Telegram принимает анимированные стикеры .tgs: это Lottie JSON, сжатый gzip.
async function sendGiftSticker(token, chat_id, key) {
  const res = await fetch(FRAG + key + ".lottie.json");
  if (!res.ok) return false;
  const tgs = await new Response(res.body.pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
  const form = new FormData();
  form.append("chat_id", String(chat_id));
  form.append("sticker", new Blob([tgs], { type: "application/x-tgsticker" }), key + ".tgs");
  return tgApi(token, "sendSticker", form);
}

// Админам: кто и что купил, с кнопками. Каждое действие спрашивается второй раз.
function adminText(order, extra) {
  const who = order.username ? "@" + order.username : "без username";
  return "🛒 <b>Заказ #" + order.id + "</b>\n" + esc(order.item) + "\nСумма: " + fmtRub(order.rub) +
    "\nПокупатель: " + who + " (ID <code>" + order.user + "</code>)" + (order.link ? "\n" + order.link : "") + (extra ? "\n\n" + extra : "");
}
const kbMain = (id) => ({ inline_keyboard: [[{ text: "✅ Подтвердить", callback_data: "c:" + id }, { text: "❌ Отклонить", callback_data: "r:" + id }]] });

async function notifyAdmins(env, token, u, order) {
  await Promise.all(adminIds(env).map((id) => tgApi(token, "sendMessage", {
    chat_id: id, text: adminText(order), parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: kbMain(order.id),
  })));
}

async function hookSecret(token) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("nova-hook:" + token));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
}

async function ensureWebhook(env, token, origin) {
  const url = origin + "/tg";
  if ((await env.DB.get("webhook")) === url) return;
  const ok = await tgApi(token, "setWebhook", { url, secret_token: await hookSecret(token), allowed_updates: ["callback_query"] });
  if (ok) await env.DB.put("webhook", url);
}

async function onUpdate(env, token, update) {
  const q = update.callback_query;
  if (!q) return;
  const answer = (text) => tgApi(token, "answerCallbackQuery", { callback_query_id: q.id, text: text || "" });
  const chat_id = q.message && q.message.chat.id, message_id = q.message && q.message.message_id;
  if (!adminIds(env).includes(String(q.from.id))) return answer("Нет доступа");
  const m = String(q.data || "").match(/^(c|r|cc|rr|b):([A-Za-z0-9]+)$/);
  if (!m) return answer();
  const [, act, id] = m;
  const orders = (await env.DB.get("orders", "json")) || [];
  const order = orders.find((o) => o.id === id);
  if (!order) return answer("Заказ не найден");
  const done = order.status && order.status !== "pending";
  if (done) {
    await tgApi(token, "editMessageText", { chat_id, message_id, text: adminText(order, statusLine(order)), parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    return answer("Заказ уже обработан");
  }
  if (act === "c" || act === "r") {
    // Второй шаг: спрашиваем ещё раз
    const yes = act === "c" ? { text: "✅ Да, подтвердить #" + id, callback_data: "cc:" + id } : { text: "❌ Да, отклонить #" + id, callback_data: "rr:" + id };
    await tgApi(token, "editMessageReplyMarkup", { chat_id, message_id, reply_markup: { inline_keyboard: [[yes], [{ text: "↩️ Назад", callback_data: "b:" + id }]] } });
    return answer(act === "c" ? "Точно подтвердить? Нажмите ещё раз" : "Точно отклонить? Деньги вернутся покупателю");
  }
  if (act === "b") {
    await tgApi(token, "editMessageReplyMarkup", { chat_id, message_id, reply_markup: kbMain(id) });
    return answer();
  }
  // Окончательное решение
  order.status = act === "cc" ? "done" : "rejected";
  order.closed = Date.now();
  order.by = q.from.username ? "@" + q.from.username : String(q.from.id);
  let u = null;
  if (order.status === "rejected") {
    u = (await getUser(env, order.user)) || newUser({ id: order.user });
    u.balance = Math.round(((u.balance || 0) + order.rub) * 100) / 100;
    await saveUser(env, u, false);
    if (order.gift) {
      const gifts = await env.DB.get("gifts", "json") || [];
      if (!gifts.some((g) => g.id === order.gift.id)) { gifts.unshift(order.gift); await env.DB.put("gifts", JSON.stringify(gifts)); }
    }
  }
  await env.DB.put("orders", JSON.stringify(orders));
  await tgApi(token, "editMessageText", { chat_id, message_id, text: adminText(order, statusLine(order)), parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  const buyerText = order.status === "done"
    ? "✅ <b>Заказ #" + order.id + " выполнен</b>\n" + esc(order.item) + "\n\nСпасибо за покупку!"
    : "❌ <b>Заказ #" + order.id + " отклонён</b>\n" + esc(order.item) + "\n\n" + fmtRub(order.rub) + " вернули на баланс. Сейчас на балансе " + fmtRub(u.balance) + ".";
  await tgApi(token, "sendMessage", { chat_id: order.user, text: buyerText, parse_mode: "HTML" }).catch(() => {});
  return answer(order.status === "done" ? "Заказ подтверждён" : "Заказ отклонён, деньги возвращены");
}

function statusLine(o) {
  return o.status === "done" ? "✅ Подтверждён" + (o.by ? " (" + esc(o.by) + ")" : "") : "❌ Отклонён, деньги возвращены" + (o.by ? " (" + esc(o.by) + ")" : "");
}

function newUser(tgUser) {
  return { id: tgUser.id, username: tgUser.username || null, name: [tgUser.first_name, tgUser.last_name].filter(Boolean).join(" "), balance: 0, banned: false, first_seen: Date.now(), last_seen: Date.now() };
}

async function getUser(env, id) {
  return env.DB.get("u:" + id, "json");
}

async function saveUser(env, u, addToIndex) {
  await env.DB.put("u:" + u.id, JSON.stringify(u));
  if (addToIndex) {
    const ids = (await env.DB.get("users", "json")) || [];
    if (!ids.includes(u.id)) {
      ids.unshift(u.id);
      await env.DB.put("users", JSON.stringify(ids.slice(0, 5000)));
    }
  }
}

// Запоминаем пользователя. Пишем в KV редко: бесплатный тариф даёт 1000 записей в день.
async function touchUser(env, tgUser) {
  let u = await getUser(env, tgUser.id);
  if (!u) {
    u = newUser(tgUser);
    const oldBal = Number(await env.DB.get("bal:" + tgUser.id)) || 0;
    if (oldBal) u.balance = oldBal;
    await saveUser(env, u, true);
    return u;
  }
  const name = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(" ");
  if (u.username !== (tgUser.username || null) || u.name !== name || Date.now() - (u.last_seen || 0) > 6 * 3600 * 1000) {
    u.username = tgUser.username || null;
    u.name = name;
    u.last_seen = Date.now();
    await saveUser(env, u, false);
  }
  return u;
}

// Самая низкая цена среди выставленных на продажу подарков коллекции на fragment.com
async function fragmentFloor(slug) {
  const res = await fetch("https://fragment.com/gifts/" + slug + "?sort=price_asc&filter=sale", {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36", "Accept-Language": "en" },
  });
  if (!res.ok) return null;
  const html = await res.text();
  // Берём цену только из карточек подарков в выдаче (отсортирована по цене),
  // остальные числа на странице (статистика, прошлые продажи) не трогаем.
  const prices = html.split(/class="[^"]*tm-grid-item[\s"]/).slice(1).map((card) => {
    const m = card.match(/icon-ton[^"]*"[^>]*>\s*([\d,]+(?:\.\d+)?)\s*</);
    return m ? Number(m[1].replace(/,/g, "")) : 0;
  }).filter((n) => n > 0);
  return prices.length ? Math.min(...prices) : null;
}

// Список подарков магазина. Пока в базе пусто (null), берём витрину из gifts.json на сайте
// и сохраняем её, чтобы удаление и добавление работали с тем, что видят покупатели.
async function loadGifts(env, origin, force) {
  if (!force) {
    const saved = await env.DB.get("gifts", "json");
    if (saved) return saved;
  }
  let list = [];
  try {
    const res = await fetch(env.GIFTS_URL || PAGES + "/Market-/gifts.json", { cf: { cacheTtl: 0 } });
    if (res.ok) list = (await res.json()).map(parseGift).filter(Boolean);
  } catch {}
  if (list.length) await env.DB.put("gifts", JSON.stringify(list));
  return list;
}

function adminIds(env) {
  return String(env.ADMIN_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
}

export function parseGift(body) {
  const m = String(body.link || "").match(/nft\/([A-Za-z0-9]+)-(\d+)/);
  const price = Number(body.price_ton);
  if (!m || !(price > 0) || price > 1e7) return null;
  const slug = m[1].toLowerCase();
  const no = Number(m[2]);
  const name = String(body.name || "").trim().slice(0, 60) || m[1].replace(/([a-z])([A-Z])/g, "$1 $2");
  return {
    id: slug + "-" + no,
    link: "https://t.me/nft/" + m[1] + "-" + no,
    name,
    price_ton: Math.round(price * 100) / 100,
    rare: !!body.rare,
    new: !!body.new,
    added: Date.now(),
  };
}

// Проверка подписи по документации Telegram:
// secret = HMAC_SHA256(key="WebAppData", data=bot_token); hash = hex(HMAC_SHA256(key=secret, data=data_check_string))
export async function verifyInitData(initData, botToken) {
  const r = await checkInitData(initData, botToken);
  return r.user || null;
}

export async function checkInitData(initData, botToken) {
  if (!initData) return { error: "Откройте магазин через бота в Telegram" };
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { error: "Нет подписи Telegram, откройте магазин через бота" };
  params.delete("hash");
  const enc = new TextEncoder();
  const secret = await hmac(enc.encode("WebAppData"), enc.encode(botToken));
  const check = async (entries) => {
    const str = entries.map(([k, v]) => k + "=" + v).sort().join("\n");
    const sig = await hmac(secret, enc.encode(str));
    return timingSafeEqual([...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join(""), hash);
  };
  // Хэш считается по всем полям, кроме hash (поле signature входит в строку).
  // На всякий случай пробуем и без signature: так делали старые клиенты.
  const all = [...params.entries()];
  const ok = (await check(all)) || (await check(all.filter(([k]) => k !== "signature")));
  if (!ok) return { error: "Подпись не совпала: BOT_TOKEN не от того бота, через которого открыт магазин, или скопирован с ошибкой" };
  const authDate = Number(params.get("auth_date"));
  if (!authDate || Date.now() / 1000 - authDate > MAX_AUTH_AGE) return { error: "Сессия устарела, закройте и откройте магазин заново" };
  try {
    const user = JSON.parse(params.get("user") || "null");
    return user ? { user } : { error: "Telegram не передал пользователя" };
  } catch {
    return { error: "Telegram не передал пользователя" };
  }
}

async function hmac(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, dataBytes);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
