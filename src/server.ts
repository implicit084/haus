import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import path from 'path';
import fs from 'fs';
import ical from 'ical';

const PORT = Number(process.env.PORT) || 3000;

type WastePickup = {
  date: string; // ISO-Datum (YYYY-MM-DD)
  summary: string;
};

const wastePickups: WastePickup[] = [];

const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

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

    return { ok: true, count: wastePickups.length };
  });

  return app;
}

async function start() {
  const app = await buildServer();

  try {
    await app.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`Server läuft auf Port ${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();

