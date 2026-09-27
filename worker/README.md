# Сервер Nova Market (Cloudflare Worker)

Хранит список подарков и балансы, пускает в админку только Telegram ID из `ADMIN_IDS`.
Каждый запрос из мини-приложения подписан Telegram, подпись проверяется токеном бота.

## Развернуть через сайт Cloudflare

1. Зарегистрируйтесь на dash.cloudflare.com (бесплатно).
2. **Storage & Databases → KV → Create** — namespace `nova-market`.
3. **Workers & Pages → Create → Create Worker**, имя `nova-market-api`, **Deploy**.
4. **Edit code** — вставьте содержимое `worker.js` целиком, **Deploy**.
5. **Settings → Bindings → Add → KV namespace**: имя переменной `DB`, namespace `nova-market`.
6. **Settings → Variables and Secrets → Add**:
   - `BOT_TOKEN`, тип **Secret** — токен бота от @BotFather;
   - `ADMIN_IDS`, тип **Text** — ваш Telegram ID (узнать у @userinfobot), несколько через запятую.
7. Скопируйте адрес воркера (`https://nova-market-api.<ваш-поддомен>.workers.dev`) и впишите его в `index.html` в `var API=""`.

## API

| Метод | Путь | Доступ |
|---|---|---|
| GET | `/gifts` | все |
| GET | `/me` | с подписью Telegram |
| POST | `/admin/gifts` `{link, price_ton, name?, rare?, new?}` | админ |
| DELETE | `/admin/gifts/<slug>-<номер>` | админ |
