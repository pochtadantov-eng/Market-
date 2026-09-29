# Nova Market

Telegram Mini App магазина: NFT-подарки, Telegram Stars, TON и Premium (скоро).

Один файл `index.html`, без сборки. Картинки и анимации подарков загружаются с `nft.fragment.com`.
Каталог и цены пока примерные, реальная оплата не подключена.

## Где живёт

- Мини-приложение: https://novamarketsbot.inarmine2009.workers.dev/ — воркер `novamarketsbot` в Cloudflare
  раздаёт `index.html` и `gifts.json` из этого репозитория (настройки в `wrangler.jsonc`, лишние файлы исключены в `.assetsignore`).
  Подключение один раз: Cloudflare → Workers & Pages → novamarketsbot → Settings → Build → Connect → репозиторий `Market-`, ветка `main`.
  После этого каждое изменение в `main` выкладывается само.
- Сервер (подарки, балансы, заказы, админка): `worker/worker.js`, см. `worker/README.md`.
- Старая ссылка https://pochtadantov-eng.github.io/Market-/ перекидывает на новую.
