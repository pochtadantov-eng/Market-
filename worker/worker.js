// Nova Market API: Cloudflare Worker.
// Хранит список подарков и балансы в KV, пускает в админку только ADMIN_IDS.
// Каждый запрос от мини-приложения подписан Telegram (initData), подпись проверяется токеном бота.
//
// Настройки воркера (Settings → Variables and Secrets / Bindings):
//   BOT_TOKEN   секрет, токен бота от @BotFather
//   ADMIN_IDS   Telegram ID админов через запятую, например 123456789
//   DB          привязка KV namespace
//   ALLOWED_ORIGIN  (необязательно) адрес мини-приложения, по умолчанию https://pochtadantov-eng.github.io

const MAX_AUTH_AGE = 24 * 60 * 60; // initData действительна сутки
const FLOOR_DISCOUNT = 0.2; // цена подарка = флор минус 20%

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || "https://pochtadantov-eng.github.io";
    const cors = {
      "Access-Control-Allow-Origin": origin,
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
        const gifts = await env.DB.get("gifts", "json");
        return json({ gifts: gifts ?? null });
      }

      // Дальше только с подписью Telegram
      const token = String(env.BOT_TOKEN || "").trim().replace(/^["']|["']$/g, "");
      if (!token) return json({ error: "На сервере не задан BOT_TOKEN" }, 500);
      const auth = await checkInitData(request.headers.get("X-Init-Data") || "", token);
      if (auth.error) return json({ error: auth.error }, 401);
      const user = auth.user;
      const isAdmin = adminIds(env).includes(String(user.id));
      const me = await touchUser(env, user);
      if (me.banned && !isAdmin) return json({ error: "Доступ к магазину закрыт", banned: true }, 403);

      if (request.method === "GET" && path === "/me") {
        return json({ id: user.id, username: user.username || null, isAdmin, balance: me.balance || 0 });
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
        const gifts = (await env.DB.get("gifts", "json")) || [];
        const i = gifts.findIndex((g) => g.id === gift.id);
        if (i >= 0) gifts[i] = gift; else gifts.unshift(gift);
        await env.DB.put("gifts", JSON.stringify(gifts));
        return json({ ok: true, gift, gifts });
      }

      const del = path.match(/^\/admin\/gifts\/([a-z0-9]+-\d+)$/);
      if (request.method === "DELETE" && del) {
        const gifts = ((await env.DB.get("gifts", "json")) || []).filter((g) => g.id !== del[1]);
        await env.DB.put("gifts", JSON.stringify(gifts));
        return json({ ok: true, gifts });
      }

      return json({ error: "Не найдено" }, 404);
    } catch (e) {
      return json({ error: "Ошибка сервера" }, 500);
    }
  },
};

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
