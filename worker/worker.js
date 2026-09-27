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
      const user = await verifyInitData(request.headers.get("X-Init-Data") || "", env.BOT_TOKEN);
      if (!user) return json({ error: "Откройте магазин через бота в Telegram" }, 401);
      const isAdmin = adminIds(env).includes(String(user.id));

      if (request.method === "GET" && path === "/me") {
        const balance = Number(await env.DB.get("bal:" + user.id)) || 0;
        return json({ id: user.id, username: user.username || null, isAdmin, balance });
      }

      if (!isAdmin) return json({ error: "Нет доступа" }, 403);

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
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  params.delete("signature");
  const checkString = [...params.entries()]
    .map(([k, v]) => k + "=" + v)
    .sort()
    .join("\n");
  const enc = new TextEncoder();
  const secret = await hmac(enc.encode("WebAppData"), enc.encode(botToken));
  const sig = await hmac(secret, enc.encode(checkString));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (!timingSafeEqual(hex, hash)) return null;
  const authDate = Number(params.get("auth_date"));
  if (!authDate || Date.now() / 1000 - authDate > MAX_AUTH_AGE) return null;
  try {
    return JSON.parse(params.get("user") || "null");
  } catch {
    return null;
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
