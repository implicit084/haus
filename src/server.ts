import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import path from 'path';
import fs from 'fs';
import ical from 'ical';
import { InfluxDB, Point, WriteApi, QueryApi } from '@influxdata/influxdb-client';

const PORT = Number(process.env.PORT) || 3000;

type WastePickup = {
  date: string; // ISO-Datum (YYYY-MM-DD)
  summary: string;
};

type EnergyMeterType = 'gas' | 'water' | 'power1' | 'power2';

type EnergyConfigEntry = {
  basePrice: number; // Grundpreis (z.B. €/Monat)
  unitPrice: number; // Arbeitspreis (z.B. €/kWh oder €/m³)
};

type EnergyConfig = Record<EnergyMeterType, EnergyConfigEntry>;

const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const wastePickupsPath = path.join(dataDir, 'waste-pickups.json');

function loadWastePickups(): WastePickup[] {
  try {
    const raw = fs.readFileSync(wastePickupsPath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function saveWastePickups(pickups: WastePickup[]) {
  fs.writeFileSync(wastePickupsPath, JSON.stringify(pickups, null, 2), 'utf-8');
}

const wastePickups: WastePickup[] = loadWastePickups();

const energyConfigPath = path.join(dataDir, 'energy-config.json');

function loadEnergyConfig(): EnergyConfig {
  try {
    const raw = fs.readFileSync(energyConfigPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      gas: parsed.gas ?? { basePrice: 0, unitPrice: 0 },
      water: parsed.water ?? { basePrice: 0, unitPrice: 0 },
      power1: parsed.power1 ?? { basePrice: 0, unitPrice: 0 },
      power2: parsed.power2 ?? { basePrice: 0, unitPrice: 0 },
    };
  } catch {
    return {
      gas: { basePrice: 0, unitPrice: 0 },
      water: { basePrice: 0, unitPrice: 0 },
      power1: { basePrice: 0, unitPrice: 0 },
      power2: { basePrice: 0, unitPrice: 0 },
    };
  }
}

function saveEnergyConfig(config: EnergyConfig) {
  fs.writeFileSync(energyConfigPath, JSON.stringify(config, null, 2), 'utf-8');
}

// Telegram-Konfiguration (optional)
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
const telegramChatId = process.env.TELEGRAM_CHAT_ID;

async function sendTelegramMessageToChat(chatId: string | number, text: string): Promise<void> {
  if (!telegramBotToken) return;
  const url = `https://api.telegram.org/bot${telegramBotToken}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
  if (!res.ok) {
    throw new Error(`Telegram API Fehler: ${res.status}`);
  }
}

async function sendTelegramMessage(text: string): Promise<void> {
  if (!telegramChatId) return;
  return sendTelegramMessageToChat(telegramChatId, text);
}

// Wetter-Konfiguration (Open-Meteo, kein API-Key nötig)
const weatherLat = process.env.WEATHER_LAT ?? '52.4344';
const weatherLon = process.env.WEATHER_LON ?? '13.2486';

const WMO_CODES: Record<number, string> = {
  0:  'Klarer Himmel ☀️',
  1:  'Überwiegend klar 🌤',
  2:  'Teilweise bewölkt ⛅',
  3:  'Bedeckt ☁️',
  45: 'Nebel 🌫',
  48: 'Reifnebel 🌫',
  51: 'Leichter Nieselregen 🌦',
  53: 'Mäßiger Nieselregen 🌦',
  55: 'Starker Nieselregen 🌧',
  61: 'Leichter Regen 🌧',
  63: 'Mäßiger Regen 🌧',
  65: 'Starker Regen 🌧',
  71: 'Leichter Schneefall ❄️',
  73: 'Mäßiger Schneefall ❄️',
  75: 'Starker Schneefall ❄️',
  77: 'Schneekörner 🌨',
  80: 'Leichte Regenschauer 🌦',
  81: 'Mäßige Regenschauer 🌦',
  82: 'Starke Regenschauer 🌧',
  85: 'Leichte Schneeschauer 🌨',
  86: 'Starke Schneeschauer 🌨',
  95: 'Gewitter ⛈',
  96: 'Gewitter mit leichtem Hagel ⛈',
  99: 'Schweres Gewitter mit Hagel ⛈',
};

function wmoDescription(code: number): string {
  return WMO_CODES[code] ?? `Unbekannt (Code ${code})`;
}

async function fetchWeatherText(): Promise<string> {
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${weatherLat}&longitude=${weatherLon}` +
    `&current=temperature_2m,apparent_temperature,weathercode,windspeed_10m,precipitation` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode` +
    `&timezone=Europe%2FBerlin&forecast_days=1`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo Fehler: ${res.status}`);
  const data: any = await res.json();

  const cur = data.current;
  const day = data.daily;

  const condition  = wmoDescription(Number(cur.weathercode));
  const tempNow    = Number(cur.temperature_2m).toFixed(1);
  const feelsLike  = Number(cur.apparent_temperature).toFixed(1);
  const wind       = Number(cur.windspeed_10m).toFixed(0);
  const tMax       = Number(day.temperature_2m_max[0]).toFixed(1);
  const tMin       = Number(day.temperature_2m_min[0]).toFixed(1);
  const precipSum  = Number(day.precipitation_sum[0]).toFixed(1);

  return (
    `🌤 <b>Wetter Berlin-Zehlendorf</b>\n` +
    `${condition}\n\n` +
    `🌡 Aktuell: <b>${tempNow} °C</b> (gefühlt ${feelsLike} °C)\n` +
    `📈 Tageshoch: ${tMax} °C  •  📉 Tief: ${tMin} °C\n` +
    `💨 Wind: ${wind} km/h\n` +
    `🌧 Niederschlag heute: ${precipSum} mm`
  );
}

type AppLogger = { info: (msg: string) => void; error: (obj: object, msg: string) => void };

async function startTelegramPolling(logger: AppLogger): Promise<void> {
  if (!telegramBotToken) return;

  let offset = 0;

  async function poll(): Promise<void> {
    try {
      const url = `https://api.telegram.org/bot${telegramBotToken}/getUpdates?offset=${offset}&timeout=10`;
      const res = await fetch(url);
      if (!res.ok) {
        logger.error({}, `Telegram getUpdates Fehler: ${res.status}`);
        return;
      }
      const data: any = await res.json();
      if (!data.ok || !Array.isArray(data.result)) return;

      for (const update of data.result) {
        offset = update.update_id + 1;
        const message = update.message;
        if (!message?.text) continue;

        const text   = (message.text as string).toLowerCase().trim();
        const chatId = message.chat.id as number;

        if (text.includes('wetter') || text === '/wetter') {
          try {
            const weatherText = await fetchWeatherText();
            await sendTelegramMessageToChat(chatId, weatherText);
          } catch (err) {
            logger.error({ err }, 'Fehler beim Abrufen der Wetterdaten');
            await sendTelegramMessageToChat(
              chatId,
              '❌ Wetterdaten konnten gerade nicht abgerufen werden.',
            ).catch(() => {});
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Fehler beim Telegram-Polling');
    } finally {
      setTimeout(poll, 2000);
    }
  }

  poll();
  logger.info('Telegram-Polling gestartet (antwortet auf "Wetter" / /wetter)');
}

async function checkAndNotifyMeterReading(logger: AppLogger): Promise<void> {
  if (!telegramBotToken || !telegramChatId) return;

  const today = new Date();
  if (today.getDate() !== 1) return;

  const monthName = today.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
  const text = `🔢 <b>Zählerstände erfassen</b>\nHeute ist der 1. des Monats – bitte die Zählerstände für <b>${monthName}</b> eintragen.`;

  try {
    await sendTelegramMessage(text);
    logger.info(`Telegram-Zählerstand-Erinnerung gesendet für ${today.toISOString().slice(0, 10)}`);
  } catch (err) {
    logger.error({ err }, 'Fehler beim Senden der Zählerstand-Erinnerung');
  }
}

async function checkAndNotifyTomorrowPickups(logger: AppLogger): Promise<void> {
  if (!telegramBotToken || !telegramChatId) return;

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);

  const pickups = wastePickups.filter(p => p.date === tomorrowStr);
  if (pickups.length === 0) return;

  const items = pickups.map(p => `• ${p.summary}`).join('\n');
  const text = `🗑️ <b>Morgen wird abgeholt:</b>\n${items}`;

  try {
    await sendTelegramMessage(text);
    logger.info(`Telegram-Benachrichtigung gesendet für ${tomorrowStr}`);
  } catch (err) {
    logger.error({ err }, 'Fehler beim Senden der Telegram-Nachricht');
  }
}

function scheduleDailyAt(hour: number, minute: number, task: () => void): void {
  function msUntilNext(): number {
    const now = new Date();
    const next = new Date();
    next.setHours(hour, minute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.getTime() - now.getTime();
  }
  function run() {
    task();
    setTimeout(run, msUntilNext());
  }
  setTimeout(run, msUntilNext());
}

// InfluxDB-Konfiguration (optional)
const influxUrl = process.env.INFLUX_URL;
const influxToken = process.env.INFLUX_TOKEN;
const influxOrg = process.env.INFLUX_ORG;
const influxBucket = process.env.INFLUX_BUCKET;

let influxWriteApi: WriteApi | null = null;
let influxQueryApi: QueryApi | null = null;

if (influxUrl && influxToken && influxOrg && influxBucket) {
  const influx = new InfluxDB({ url: influxUrl, token: influxToken });
  influxWriteApi = influx.getWriteApi(influxOrg, influxBucket, 'ms');
  influxQueryApi = influx.getQueryApi(influxOrg);
}

async function writeEnergyReadings(
  readings: { meter: EnergyMeterType; date: string; value: number; basePrice: number; unitPrice: number }[],
) {
  if (!influxWriteApi) {
    // Influx ist nicht konfiguriert – still akzeptieren, aber nichts schreiben
    return;
  }

  for (const r of readings) {
    const ts = new Date(r.date);
    const point = new Point('energy_meter')
      .tag('meter', r.meter)
      .floatField('reading', r.value)
      .floatField('base_price', r.basePrice)
      .floatField('unit_price', r.unitPrice)
      .timestamp(ts);
    influxWriteApi.writePoint(point);
  }

  await influxWriteApi.flush();
}

async function buildServer() {
  const app = Fastify({
    logger: true,
  });

  // Statische Dateien (Web-UI)
  const publicDir = path.join(__dirname, '..', 'public');
  app.register(fastifyStatic, {
    root: publicDir,
    index: ['index.html'],
  });

  // Multipart für Datei-Uploads
  app.register(multipart);

  // Healthcheck
  app.get('/health', async () => {
    return { status: 'ok' };
  });

  // Telegram-Test
  app.get('/telegram/test', async (_, reply) => {
    if (!telegramBotToken || !telegramChatId) {
      reply.code(503);
      return { ok: false, message: 'TELEGRAM_BOT_TOKEN oder TELEGRAM_CHAT_ID nicht konfiguriert' };
    }
    try {
      await sendTelegramMessage('✅ <b>Haus-App Test</b>\nTelegram-Benachrichtigungen funktionieren!');
      return { ok: true, message: 'Testnachricht gesendet' };
    } catch (err: any) {
      reply.code(500);
      return { ok: false, message: err.message };
    }
  });

  // Liste aller importierten Müll-Abholtermine
  app.get('/waste-pickups', async () => {
    return wastePickups;
  });

  // Upload einer ICS-Datei und Import der Termine
  app.post('/waste-pickups/import', async (request, reply) => {
    const file = await (request as any).file();
    if (!file) {
      reply.code(400);
      return { ok: false, message: 'Keine Datei hochgeladen' };
    }

    const chunks: Buffer[] = [];
    for await (const chunk of file.file) {
      chunks.push(chunk as Buffer);
    }
    const buffer = Buffer.concat(chunks);
    const icsText = buffer.toString('utf-8');

    const parsed = ical.parseICS(icsText);

    // Bestehende Einträge verwerfen und neu aufbauen
    wastePickups.length = 0;

    for (const ev of Object.values(parsed)) {
      const event: any = ev;
      if (event.type === 'VEVENT' && event.start) {
        const date = new Date(event.start);
        if (Number.isNaN(date.getTime())) continue;

        wastePickups.push({
          date: date.toISOString().slice(0, 10),
          summary: event.summary || 'Abholung',
        });
      }
    }

    saveWastePickups(wastePickups);
    return { ok: true, count: wastePickups.length };
  });

  // Energiekonfiguration lesen
  app.get('/energy/config', async () => {
    return loadEnergyConfig();
  });

  // Letzten Zählerstand pro Meter aus InfluxDB abfragen
  app.get('/energy/readings/latest', async (_, reply) => {
    if (!influxQueryApi || !influxBucket) {
      return {};
    }

    const fluxQuery = `
      from(bucket: "${influxBucket}")
        |> range(start: -10y)
        |> filter(fn: (r) => r._measurement == "energy_meter" and r._field == "reading")
        |> group(columns: ["meter"])
        |> last()
    `;

    const result: Record<string, { reading: number; date: string }> = {};

    try {
      await new Promise<void>((resolve, reject) => {
        influxQueryApi!.queryRows(fluxQuery, {
          next(row, tableMeta) {
            const o = tableMeta.toObject(row);
            const meter = o['meter'] as string;
            if (meter && o['_value'] != null && o['_time']) {
              result[meter] = {
                reading: Number(o['_value']),
                date: new Date(String(o['_time'])).toISOString().slice(0, 10),
              };
            }
          },
          error: reject,
          complete: resolve,
        });
      });
    } catch (err) {
      app.log.error({ err }, 'Fehler beim Abfragen der InfluxDB (latest readings)');
      reply.code(500);
      return { error: 'InfluxDB-Abfrage fehlgeschlagen' };
    }

    return result;
  });

  // Alle Zählerstände aus InfluxDB für Verlaufsdiagramm
  app.get('/energy/readings/history', async (_, reply) => {
    if (!influxQueryApi || !influxBucket) {
      return {};
    }

    const fluxQuery = `
      from(bucket: "${influxBucket}")
        |> range(start: -10y)
        |> filter(fn: (r) => r._measurement == "energy_meter" and r._field == "reading")
        |> group(columns: ["meter"])
        |> sort(columns: ["_time"])
    `;

    const result: Record<string, { date: string; reading: number }[]> = {};

    try {
      await new Promise<void>((resolve, reject) => {
        influxQueryApi!.queryRows(fluxQuery, {
          next(row, tableMeta) {
            const o = tableMeta.toObject(row);
            const meter = o['meter'] as string;
            if (meter && o['_value'] != null && o['_time']) {
              if (!result[meter]) result[meter] = [];
              result[meter].push({
                date: new Date(String(o['_time'])).toISOString().slice(0, 10),
                reading: Number(o['_value']),
              });
            }
          },
          error: reject,
          complete: resolve,
        });
      });
    } catch (err) {
      app.log.error({ err }, 'Fehler beim Abfragen der InfluxDB (history)');
      reply.code(500);
      return { error: 'InfluxDB-Abfrage fehlgeschlagen' };
    }

    return result;
  });

  // Energie-Werte schreiben (Gas/Wasser/Strom-Zählerstände + Preise)
  app.post(
    '/energy/readings',
    async (
      request,
      reply,
    ): Promise<{ ok: boolean; message?: string }> => {
      const body = request.body as any;
      if (!body || typeof body !== 'object') {
        reply.code(400);
        return { ok: false, message: 'Ungültiger Request-Body' };
      }

      const dateStr = typeof body.date === 'string' ? body.date : null;
      if (!dateStr) {
        reply.code(400);
        return { ok: false, message: 'Datum fehlt' };
      }

      const readings = Array.isArray(body.readings) ? body.readings : [];
      const validMeters: EnergyMeterType[] = ['gas', 'water', 'power1', 'power2'];

      const parsedReadings: {
        meter: EnergyMeterType;
        date: string;
        value: number;
        basePrice: number;
        unitPrice: number;
      }[] = [];

      let config = loadEnergyConfig();

      for (const r of readings) {
        if (!r || typeof r !== 'object') continue;
        const meter = r.meter as EnergyMeterType;
        if (!validMeters.includes(meter)) continue;

        const value = Number(r.value);
        const basePrice = Number(r.basePrice);
        const unitPrice = Number(r.unitPrice);
        if (!Number.isFinite(value)) continue;

        if (!config[meter]) {
          config[meter] = { basePrice: 0, unitPrice: 0 };
        }
        // Neue Preise werden als Standard gespeichert
        if (Number.isFinite(basePrice)) {
          config[meter].basePrice = basePrice;
        }
        if (Number.isFinite(unitPrice)) {
          config[meter].unitPrice = unitPrice;
        }

        parsedReadings.push({
          meter,
          date: dateStr,
          value,
          basePrice: Number.isFinite(basePrice) ? basePrice : config[meter].basePrice,
          unitPrice: Number.isFinite(unitPrice) ? unitPrice : config[meter].unitPrice,
        });
      }

      saveEnergyConfig(config);

      if (parsedReadings.length === 0) {
        return { ok: false, message: 'Keine gültigen Messwerte übergeben' };
      }

      try {
        await writeEnergyReadings(parsedReadings);
      } catch (err) {
        app.log.error({ err }, 'Fehler beim Schreiben nach InfluxDB');
        // Wir melden trotzdem ok=true, damit du die Werte nicht verlierst
      }

      return { ok: true };
    },
  );

  return app;
}

async function start() {
  const app = await buildServer();

  try {
    await app.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`Server läuft auf Port ${PORT}`);

    // Täglich um 07:00 Uhr: Wetterbericht senden
    scheduleDailyAt(7, 0, () => {
      fetchWeatherText()
        .then(text => sendTelegramMessage(text))
        .catch(err => app.log.error({ err }, 'Fehler beim täglichen Wetterbericht'));
    });

    // Täglich um 18:00 Uhr prüfen ob morgen ein Müllabholtermin ansteht
    scheduleDailyAt(18, 0, () => {
      checkAndNotifyTomorrowPickups(app.log).catch(err =>
        app.log.error({ err }, 'Fehler im Telegram-Benachrichtigungscheck'),
      );
    });

    // Täglich um 08:00 Uhr: am 1. des Monats Zählerstand-Erinnerung senden
    scheduleDailyAt(8, 0, () => {
      checkAndNotifyMeterReading(app.log).catch(err =>
        app.log.error({ err }, 'Fehler im Zählerstand-Erinnerungscheck'),
      );
    });

    if (telegramBotToken && telegramChatId) {
      app.log.info('Telegram-Benachrichtigungen aktiviert (Wetter 07:00, Müll 18:00, Zähler 08:00 am 1. des Monats)');
    }

    // Telegram-Polling starten (antwortet auf Wetter-Anfragen)
    startTelegramPolling(app.log);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();

