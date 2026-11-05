# Life — архитектура (документ для разработчиков)

PWA «Life» — личный менеджер: расписание/пары/встречи, задачи, питание, вода, вес,
полезные и вредные привычки, уведомления и сверка с внешними сайтами (ICS/JSON/HTML).
Живёт в `/life/` репозитория `sempik.github.io` (GitHub Pages, без сборки).
Работает на телефоне и ПК (устанавливается как приложение из браузера), офлайн.

Язык интерфейса — **русский**. Без фреймворков и сборщиков: нативные ES-модули,
все пути относительные (`./js/app.js`), чтобы приложение работало и на
`https://sempik.github.io/life/`, и на `http://localhost:8000/life/`.

---

## 1. Файлы

```
life/
  index.html               оболочка, <script type="module" src="./js/app.js">
  manifest.webmanifest
  sw.js                    классический Service Worker (НЕ module)
  icons/                   icon.svg, icon-192.png, icon-512.png, maskable-512.png, badge-72.png
  css/app.css              вся вёрстка и дизайн-токены
  js/
    app.js                 загрузка: store → router → nav → notify → sync → SW
    core/                  БРАУЗЕРНЫЕ модули (DOM, IndexedDB, SW)
      db.js                обёртка IndexedDB
      store.js             состояние + сохранение + события
      ui.js                html-шаблоны, шторки/формы, тосты, кольца прогресса
      icons.js             набор inline-SVG иконок
      router.js            hash-роутер + навигация (нижняя панель / сайдбар)
      notify.js            локальные уведомления, очередь для SW, Web Push подписка
      sync.js              синхронизация через GitHub Gist
    lib/                   ЧИСТЫЕ модули (без DOM/window/localStorage/IDB) — общие с Node-ботом
      util.js  dates.js    (готовы, см. исходники)
      recur.js             развёртка повторяющихся событий
      reminders.js         расчёт напоминаний + тексты + дайджесты
      habits.js            прогресс, серии, «чистые дни», экономия
      nutrition.js         КБЖУ, нормы (Миффлин—Сан Жеор), суммы
      foods-db.js          встроенная база продуктов (на 100 г)
      ics.js               парсер/генератор iCalendar, RRULE, импорт в события
      sources.js           загрузка источников (ics/json/page), снимки, diff → изменения
      merge.js             слияние наборов данных (LWW по записи)
      crypto.js            шифрование файлов gist паролем (AES-GCM/PBKDF2), VAPID-ключи
      gist.js              клиент GitHub Gist API (браузер + Node)
      demo.js              демо-данные
    pages/                 страницы (по одному модулю на маршрут)
      today.js schedule.js tasks.js food.js habits.js stats.js sources.js settings.js
  tests/                   node --test life/tests/*.test.mjs  (+ e2e.mjs на Playwright)
  README.md                инструкция для пользователя
.github/
  workflows/life-bot.yml   бот по расписанию (cron) — напоминания, Telegram, сверка сайтов
  workflows/life-tests.yml юнит-тесты на push/PR
  scripts/life-bot.mjs     сам бот (Node 22, импортирует life/js/lib/*)
```

**Чистые модули `lib/*` обязаны работать в Node 22** (`import` напрямую из бота):
только `fetch`, `globalThis.crypto`, `Intl`, `btoa/atob`, `TextEncoder`. Никаких
`window`, `document`, `localStorage`, `navigator`.

---

## 2. Время и даты

Всё хранится в **локальном «настенном» времени** пользователя строками:
`date: 'YYYY-MM-DD'`, `time: 'HH:MM'`. Метки создания/изменения — `ms` (epoch).
Часовой пояс пользователя — `settings.timezone` (IANA). В браузере это зона устройства;
бот в Node делает `process.env.TZ = settings.timezone` до любых вычислений, поэтому
обычные локальные методы `Date` и `lib/dates.js` везде дают время пользователя.

Дни недели — **ISO: 1 = пн … 7 = вс**. Неделя начинается с понедельника.
Учебная неделя: неделя, содержащая `settings.semesterStart`, — №1 = нечётная
(«числитель»), см. `weekIndex`/`weekParity` в `dates.js`.

---

## 3. Модель данных

Каждая запись коллекции: `{ id, createdAt, updatedAt, deleted?, ...поля }`.
`id` — `uid()`; `updatedAt` обновляется при каждом `store.put`. Удаление —
«надгробие» `deleted: true` (нужно для синхронизации; чистится через 90 дней).

### Синхронизируемый набор данных (`Data`)

```js
{
  v: 1,
  settings: { ...Settings, updatedAt },
  snapshots: { [sourceId]: Snapshot },      // последние снимки внешних источников
  collections: {
    events: [], tasks: [], meals: [], products: [], water: [], weight: [],
    habits: [], habitLogs: [], sources: [], changes: []
  }
}
```

### Коллекции

**events** — события расписания
```js
{ title, type: 'class'|'meeting'|'workout'|'other',
  date: 'YYYY-MM-DD',             // дата (для повторяющихся — первое вхождение)
  start: 'HH:MM'|null, end: 'HH:MM'|null, allDay: false,
  location: '', link: '', who: '', notes: '',   // who — преподаватель/участники
  color: null,                    // null → цвет типа
  reminders: null | number[],     // минуты ДО начала; null → settings.defaultReminders[type]; [] → без напоминаний
  recur: null | {
    freq: 'daily'|'weekly'|'monthly',
    interval: 1,                  // каждые N дней/недель/месяцев
    days: [1,3],                  // weekly: ISO-дни недели (пусто → день недели date)
    parity: null|'odd'|'even',    // weekly: только нечётные/чётные учебные недели
    until: null|'YYYY-MM-DD',     // включительно
    exdates: ['YYYY-MM-DD']       // пропущенные вхождения
  },
  sourceId: null, extUid: null    // связь с внешним источником (если импортировано/привязано)
}
```
Если `end < start` — событие заканчивается на следующий день.

**tasks** — задачи
```js
{ title, notes: '', due: null|'YYYY-MM-DD', dueTime: null|'HH:MM',
  priority: 0|1|2,               // 0 обычная, 1 важная, 2 срочная
  done: false, doneAt: null|ms,
  remind: null|number,           // минут до срока; если dueTime нет — в settings.taskRemindTime в день срока
  repeat: null|'daily'|'weekly'|'monthly',  // при выполнении создаётся следующая
  tags: [], eventId: null }      // eventId — привязка к паре/событию («ДЗ к паре»)
```

**meals** — дневник питания
```js
{ date, time, meal: 'breakfast'|'lunch'|'dinner'|'snack',
  name, grams: null|number, kcal, p, f, c,    // итог за порцию
  productId: null|string }
```

**products** — свои продукты и избранное (значения на 100 г)
```js
{ name, brand: '', kcal, p, f, c, portion: 100, barcode: '',
  source: 'user'|'off'|'builtin', favorite: false, uses: 0 }
```

**water** `{ date, time, ml }` · **weight** `{ date, kg }`

**habits**
```js
{ name, emoji: '✅', kind: 'good'|'bad', color: null, archived: false, order: 0,
  // good:
  target: 1, unit: 'раз', days: [1,2,3,4,5,6,7],
  // bad:
  mode: 'quit'|'limit',          // quit — бросаю (считаем чистые дни); limit — не больше limit в день
  limit: 0, costPerUnit: 0,      // ₽ за единицу (сигарета/банка)
  baseline: 0,                   // сколько единиц в день было «до» (для расчёта экономии)
  since: 'YYYY-MM-DD',           // начало отслеживания / дата отказа
  reminder: null|'HH:MM' }
```

**habitLogs**
```js
{ habitId, date, time, type: 'done'|'slip'|'craving', count: 1, note: '' }
```
good: прогресс дня = сумма `count` у `type:'done'`. bad: срывы/единицы = сумма `count`
у `type:'slip'`; `craving` — «хотелось, но удержался» (засчитывается как победа).

**sources** — внешние сайты
```js
{ name, kind: 'ics'|'json'|'page', url, enabled: true,
  eventType: 'class',            // тип для событий из источника
  color: null, notify: true,     // уведомлять об изменениях
  remind: false,                 // напоминать о событиях источника как о своих
  // json:
  path: '',                      // путь до массива: 'data.lessons' ('' — корень)
  fields: { title: 'title', start: 'start', end: 'end', location: 'location', uid: 'id', who: '' },
  // page:
  match: '',                     // regex (без флагов, ищется без учёта регистра) — оставлять только такие строки
  between: ['', ''] }            // [начальный маркер, конечный маркер] — вырезать кусок текста
```

**changes** — обнаруженные изменения/расхождения (лента «Изменения»)
```js
{ id /* детерминированный, см. sources.js */, sourceId, at: ms,
  kind: 'added'|'removed'|'changed'|'page'|'conflict',
  title, details, key: '', when: null|ms, seen: false }
```

### Snapshot (снимок источника)
```js
{ fetchedAt: ms, ok: true, error: '', hash: '',
  items: [ ExtOcc ],              // для ics/json
  lines: [ '...' ] }              // для page
ExtOcc = { key, uid, title, start: ms, end: ms|null, allDay: false,
           location: '', who: '', status: '' }   // key = uid + '|' + исходное начало вхождения
```
Снимок хранит развёрнутые вхождения в окне [-7 дней; +90 дней] (не более 3000).
Слияние снимков — побеждает больший `fetchedAt`.

### Settings (с умолчаниями в `store.js` → `DEFAULT_SETTINGS`)
```js
{ name: '', timezone: deviceTimezone(), theme: 'dark'|'light'|'auto',
  onboarded: false,
  modules: { schedule: true, tasks: true, food: true, habits: true },
  semesterStart: null,
  pairTimes: [['09:00','10:30'],['10:40','12:10'],['12:40','14:10'],['14:20','15:50'],
              ['16:00','17:30'],['17:40','19:10'],['19:20','20:50']],
  defaultReminders: { class: [10], meeting: [30, 5], workout: [60], other: [15] },
  taskRemindTime: '09:00',
  digest: { morning: '08:00', evening: '21:30' },       // null — выкл
  quiet: { from: '23:00', to: '07:30' },                 // тихие часы (кроме событий и задач)
  nutrition: { kcal: 2200, p: 110, f: 70, c: 270, water: 2000,
               mealTimes: { breakfast: '08:30', lunch: '13:30', dinner: '19:30' },
               remindMeals: false, waterEvery: 0, waterFrom: '09:00', waterTo: '21:00' },
  profile: { sex: 'm', age: 25, height: 175, weight: 70, activity: 1.375, goal: 'keep' },
  channels: { local: true, push: true, telegram: true },
  corsProxy: '',                 // шаблон: 'https://corsproxy.io/?url={url}' ('' — не использовать)
  sourcesEvery: 60,              // минут между проверками источников ботом
  publishIcs: false,             // публиковать life-calendar.ics в gist (для подписки календаря телефона)
  botRepo: '',                   // 'owner/repo' для ссылок на настройки Actions ('' — из location)
  updatedAt: 0 }
```

### Локальное (НЕ синхронизируется), IndexedDB `kv['local']`
```js
{ deviceId, gist: { token: '', id: '' }, passphrase: '', lastSync: 0,
  lastSyncError: '', pushEndpoint: '' , installHintShown: false }
```

---

## 4. IndexedDB (общая для страницы и SW)

База `life`, версия 1, одно хранилище `kv` (ключи вне записей):
- `'data'` — Data (весь синхронизируемый набор)
- `'local'` — локальные настройки устройства
- `'notifQueue'` — `[{key, at, title, body, tag, url}]` ближайшие уведомления (пишет страница)
- `'fired'` — `{ [key]: ms }` уже показанные (пишут страница и SW; чистить старше 3 дней)
- `'ext'` — служебное для sync: `{ botStatus, pushSubs }`

`core/db.js`: `get(key)`, `set(key, value)`, `del(key)`, `keys()`.
SW открывает ту же базу напрямую (свой мини-код, без импортов).

---

## 5. Ядро: API

### `core/store.js`
```js
export const COLLECTIONS = ['events','tasks','meals','products','water','weight','habits','habitLogs','sources','changes'];
export const DEFAULT_SETTINGS = {...};
export const store = {
  ready,                       // Promise — загрузка из IDB завершена
  all(coll),                   // массив НЕудалённых записей (не мутировать!)
  get(coll, id),               // запись или undefined (удалённые → undefined)
  put(coll, rec),              // создать/обновить (слияние с существующей по id), возвращает запись
  bulkPut(coll, recs),
  remove(coll, id),            // надгробие
  get settings(),              // deepMerge(DEFAULT_SETTINGS, saved)
  setSettings(patch),          // глубокое слияние, updatedAt = now
  get local(), setLocal(patch),
  snapshot(sourceId), setSnapshot(sourceId, snap), get snapshots(),
  on(fn) → off,                // fn({ colls: Set<string>, origin: 'local'|'sync'|'load' })
  exportData(),                // Data со всеми надгробиями (для sync/бэкапа)
  importData(data, {replace}), // replace=false → merge (lib/merge.js)
  reminderState(),             // { events, tasks, habits, habitLogs, meals, water, sources, snapshots, settings } без удалённых
};
```
Сохранение в IDB — с задержкой 300 мс после изменения. События `on` — батчем (microtask).

### `core/ui.js`
```js
html`...${x}...`        // тегированный шаблон: значения экранируются; массивы склеиваются; raw(s) — без экранирования
raw(str)
$(sel, root=document), $$(sel, root)
openSheet({ title, body, onMount(el, close), wide? }) → { el, close }   // нижняя шторка на мобиле, диалог на ПК
formSheet({ title, fields, values, submitLabel='Сохранить', onSubmit(values) → false|Promise, extra?: [{label, danger, onClick(values, close)}] })
   field: { name, label, type: 'text'|'number'|'date'|'time'|'select'|'textarea'|'checkbox'|'days'|'chips'|'color'|'emoji'|'datetime'|'hidden',
            options: [{value,label}], placeholder, required, min, max, step, hint, show: values => bool, full: true }
   'days' — выбор ISO-дней недели (массив чисел); 'chips' — мультивыбор из options (массив)
confirmDialog(text, { ok='Да', danger=false }) → Promise<boolean>
promptDialog(text, { value, placeholder, type }) → Promise<string|null>
toast(text, { action, onAction, ms=2600 })
ring({ value, max, size=72, stroke=7, label, sub, color })  → html-строка (SVG кольцо прогресса)
bar({ value, max, color })                                   → html-строка (полоска)
empty({ icon, title, text, action })                         → html-строка
icon(name, size=20)                                           → html-строка SVG (из icons.js)
downloadFile(name, text, mime), pickFile(accept) → Promise<File|null>
```

### `core/router.js`
Маршруты `#/today`, `#/schedule`, `#/tasks`, `#/food`, `#/habits`, `#/stats`,
`#/sources`, `#/settings`; параметры — query: `#/schedule?date=2026-11-05&view=week`.
```js
export function navigate(path, params?)     // меняет hash
export function currentRoute() → { id, params }
export function setParams(patch, {replace=true})  // обновить query без перезагрузки истории
```
Страница — модуль `pages/<id>.js`:
```js
export default {
  id: 'food', title: 'Питание', icon: 'utensils', nav: true,
  render(root, params) { root.innerHTML = html`...`; /* навесить обработчики на root */ },
  destroy?() {},             // при уходе со страницы
};
```
Роутер перерисовывает текущую страницу при `store.on` (debounce 80 мс), если страница
не экспортирует `shouldRerender(colls) → false`. Состояние вида (выбранная дата/вкладка)
хранить в params URL или в переменных модуля. Обработчики — делегирование
(`root.onclick = e => e.target.closest('[data-act]')...`), т. к. innerHTML перезаписывается.

### `core/notify.js`
```js
init()                       // регистрирует таймеры, слушает store, пересчитывает очередь
permission() → 'granted'|'denied'|'default'|'unsupported'
requestPermission() → Promise<string>
reschedule()                 // пересчитать очередь (computeReminders на [now-2мин; now+48ч]) → IDB notifQueue
test()                       // показать тестовое уведомление
pushSupported(), subscribePush() → Promise<sub>, unsubscribePush()
upcoming(limit) → ближайшие напоминания (для UI)
```
Показ — только через `registration.showNotification(title, {body, tag:key, icon, badge, data:{url}})`.
Каждую минуту: показать «созревшие» (at ≤ now, at > now-15мин, не в fired), отметить в fired.
Periodic Background Sync (`life-reminders`, если поддерживается) — SW сам читает очередь.

### `core/sync.js`
```js
status() → { state: 'off'|'idle'|'syncing'|'error', lastSync, error, gistId, botLastRun }
on(fn) → off
connect(token, { gistId? }) → найти gist с life-data.json или создать (secret)
disconnect()
syncNow(reason) → Promise
start()                      // при старте, при возврате на вкладку, каждые 2 мин, через 4 с после изменений
savePushSub(sub), removePushSub(endpoint)
ensureVapid() → publicKey    // создаёт пару VAPID (crypto.js) и кладёт в life-config.json
setTelegram({ token, chatId })
refreshSources({ only? })    // загрузка источников прямо из браузера (sources.js), с corsProxy при необходимости
```

---

## 6. Gist — «облако» и мост к боту

Один **секретный** gist пользователя, файлы:
| файл | пишет | содержимое |
|---|---|---|
| `life-data.json` | приложение | Data (все коллекции + настройки + снимки) |
| `life-config.json` | приложение (бот чистит subs) | `{ vapid:{publicKey,privateKey}, telegram:{token,chatId}, subs:[PushSubscriptionJSON+{deviceId,ua,createdAt}] }` |
| `life-bot.json` | бот | `{ lastRun, runs:[...последние 30], sent:{key:ms}, tgOffset, snapshots:{...}, changes:[...], inbox:[{coll, rec}] }` |
| `life-calendar.ics` | приложение (если publishIcs) | открытый ICS для подписки календаря телефона |

Если задан пароль шифрования, JSON-файлы хранятся как
`{ app:'life', enc:'v1', salt, iv, ct }` (см. `lib/crypto.js`); ICS — всегда открыт (опция).

Приложение при синхронизации: читает все файлы → `mergeData(local, remote)` →
вливает из `life-bot.json` снимки (по fetchedAt), изменения (`changes` по id) и
`inbox` (записи из Telegram-команд, по id — идемпотентно) → если итог отличается
от remote, пишет `life-data.json`.

## 7. Бот (`.github/scripts/life-bot.mjs`, cron каждые 10 мин)

1. Токен из `LIFE_GIST_TOKEN`; gist — `LIFE_GIST_ID` или поиск gist с `life-data.json`.
2. Читает файлы, расшифровывает (`LIFE_PASSPHRASE`), `process.env.TZ = settings.timezone`.
3. Telegram (`getUpdates` от `tgOffset`, только из `chatId`): /today /tomorrow /water /eat /done /slip /task /weight /help.
4. Источники: если прошло ≥ `sourcesEvery` мин — `fetchSource` → `diffSnapshots` → changes + уведомления.
5. Напоминания: `computeReminders(state, from, now+11мин)` минус `sent` → Web Push (`web-push`) всем subs + Telegram.
6. Записывает `life-bot.json` (и чистит протухшие subs в `life-config.json`).
Без настроенных секретов — тихо завершается (exit 0). Включение — переменная репозитория `LIFE_BOT=on`.

---

## 8. Дизайн

Тёмная тема по умолчанию (как у sempik.github.io: чёрный фон, белый текст, шрифт Rubik),
есть светлая и «как в системе». Акцентный цвет — один, сдержанный. Цвета типов событий:
пара `--c-class`, встреча `--c-meeting`, тренировка `--c-workout`, другое `--c-other`;
статусы `--ok`, `--warn`, `--bad`.

Мобила (< 900px): верхняя шапка (заголовок страницы + кнопки), контент, нижняя
панель вкладок: Сегодня · Расписание · Задачи · Питание · Привычки; «Ещё» (статистика,
источники, настройки) — через иконку в шапке. ПК (≥ 900px): левый сайдбар со всеми
разделами, контент до ~1100px, на «Сегодня» — сетка карточек в 2–3 колонки.

Классы (реализует `css/app.css`):
`.page`, `.page-head` (`h1` + `.actions`), `.card`, `.card-head` (`.card-title` + действия),
`.grid` (адаптивная сетка карточек), `.stack` (вертикальный отступ), `.row` (флекс в строку),
`.spacer`, `.list`, `.item` (`.item-main` > `.item-title` + `.item-sub`, `.item-side`),
`.btn` (+ `.primary` `.ghost` `.danger` `.sm` `.block`), `.icon-btn`, `.chip` (+ `.on`),
`.chips`, `.badge` (+ `.ok` `.warn` `.bad` `.info`), `.seg` (сегментный переключатель,
кнопки внутри, активная `.on`), `.tabs`, `.kpi` (`.kpi-value` + `.kpi-label`),
`.muted`, `.small`, `.empty`, `.fab`, `.dot`, `.check` (круглый чекбокс-кнопка, `.on`),
`.progress` (полоска), `.field` / `.input` / `.switch`, `.timeline` (`.tl-item`, `.tl-time`, `.tl-now`),
`.week-grid` (сетка недели на ПК), `.heatmap` (`.hm-cell`), `.alert` (+ `.warn` `.bad` `.info`).
Поля ввода ≥ 16px (iOS не зумит), учёт `env(safe-area-inset-*)`.

Безопасность: **любой пользовательский/внешний текст выводится только через `html```
(экранирование)**. `raw()` — только для своей разметки. Ссылки из данных — только
`http(s):`, с `rel="noopener"`.

---

## 9. Тесты

- Юнит: `TZ=Europe/Moscow node --test life/tests/*.test.mjs` (и в других зонах — тесты от зоны не зависят).
- Дымовой e2e: `node life/tests/e2e.mjs [--shots DIR] [--only mobile|desktop] [--tz IANA]` —
  статический сервер + Chromium (Playwright), телефон и ПК: все маршруты на пустых и демо-данных,
  «Добавить», «Ещё», SW и офлайн, уведомления, источник ICS с локального «сайта», светлая тема.
  Ошибка — любое сообщение `console.error/warn`, исключение, 404, запрос к чужому сайту
  (кроме шрифтов), горизонтальная прокрутка на телефоне, раздел без `.page-head h1`,
  файл `js/**`/`css/**`, которого нет в `SHELL` в `sw.js`.
  Новые проверки — в `ROUTES[i].check(h)` или `CHECKS` (см. начало файла).
- Требования к страницам, которые проверяет e2e: у каждой страницы есть `<h1>` внутри
  `.page-head`; страница не пишет в консоль `error`/`warn` в штатной работе; не ходит в чужую
  сеть при открытии раздела (только по действию пользователя: поиск в OpenFoodFacts,
  «Проверить источник» и т. п.); новые модули
  добавлены в `SHELL` в `sw.js`. Раздел, модуль которого не загрузился, `app.js` заменяет
  заглушкой с ошибкой — остальное приложение продолжает работать.
