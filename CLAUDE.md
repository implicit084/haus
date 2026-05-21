## Haus – Lokale Hausverwaltung (Raspberry Pi)

Dieses Projekt ist eine kleine Web-App, die auf einem Raspberry Pi in Docker läuft und drei Hauptfunktionen bietet:

- **Müllkalender**
  - Import von Abfuhrterminen über ICS-Dateien (z.B. BSR-Abfuhrkalender oder Google-Kalender).
  - Parsing der ICS-Datei im Backend und Ablage der Termine im Speicher.
  - Monatskalender-UI mit Tageskacheln; Tage mit Abholterminen werden farbig markiert (Restmüll, Bio, Wertstoffe).
  - Der ICS-Import ist über einen separaten Tab „Import" erreichbar, inklusive Anzeige des letzten Importzeitpunkts (clientseitig via `localStorage`).

- **Energie-Tracker**
  - Tab „Energie" mit Formular für vier Zähler:
    - Gas (m³, Grundpreis €/Monat, Arbeitspreis €/kWh)
    - Wasser (m³, Grundpreis €/Monat, Arbeitspreis €/m³)
    - Stromzähler 1 (kWh, Grundpreis €/Monat, Arbeitspreis €/kWh)
    - Stromzähler 2 (kWh, Grundpreis €/Monat, Arbeitspreis €/kWh)
  - Pro Eintrag wird ein Datum gewählt (Standard: aktuelles Datum) und pro aktiv ausgefülltem Zähler ein Messwert gespeichert.
  - **Grundpreis und Arbeitspreis** werden als Default-Konfiguration persistiert:
    - Backend speichert sie in `data/energy-config.json` (nicht von Git getrackt).
    - Beim Speichern neuer Messwerte können Preise mitgeschickt werden; sie überschreiben dann die Defaults für zukünftige Einträge.
    - Beim Laden des Energie-Tabs werden die aktuell bekannten Preise aus `/energy/config` vorbefüllt.
  - Optionales Schreiben der Messwerte nach **InfluxDB**:
    - Über ENV-Variablen konfigurierbar (`INFLUX_URL`, `INFLUX_TOKEN`, `INFLUX_ORG`, `INFLUX_BUCKET`).
    - Pro Messwert wird ein `energy_meter`-Point mit Tag `meter` (`gas`, `water`, `power1`, `power2`) und Feldern `reading`, `base_price`, `unit_price` geschrieben.

- **Wetter-Integration (Telegram)**
  - Täglicher Wetterbericht um **07:00 Uhr** per Telegram-Nachricht.
  - Bot antwortet auf eingehende Nachrichten, die „Wetter" enthalten oder `/wetter` lauten.
  - Wetterdaten kommen von **Open-Meteo** (kostenlos, kein API-Key nötig).
  - Standort konfigurierbar via `WEATHER_LAT` / `WEATHER_LON` (Standard: Berlin-Zehlendorf, 52.4344 / 13.2486).
  - Die Nachricht enthält: Wetterzustand, aktuelle Temperatur, Gefühlte Temperatur, Tageshoch/-tief, Wind, Niederschlagssumme.
  - Telegram-Empfang läuft per **Long Polling** (`getUpdates`) – kein öffentlicher Server oder HTTPS nötig.

## Technischer Überblick

- **Backend**
  - Node.js + TypeScript + Fastify.
  - Statische Auslieferung der Web-UI aus `public/`.
  - Routen:
    - `GET /health` – einfacher Healthcheck.
    - `GET /waste-pickups` – gibt die aktuell importierten Müll-Termine zurück.
    - `POST /waste-pickups/import` – Multipart-Upload einer ICS-Datei, Parsing mit `ical`.
    - `GET /energy/config` – liest Energie-Konfiguration aus `data/energy-config.json` oder liefert Default-Werte.
    - `POST /energy/readings` – nimmt Messwerte + (optionale) Preisangaben entgegen, aktualisiert `energy-config.json` und schreibt optional nach InfluxDB.
    - `GET /energy/readings/latest` – letzter Zählerstand pro Meter aus InfluxDB.
    - `GET /energy/readings/history` – Verlauf aller Messwerte aus InfluxDB.
    - `GET /telegram/test` – sendet eine Test-Nachricht über Telegram.
  - Datenverzeichnis `data/` wird beim Start angelegt, ist als Volume in Docker gemountet und in `.gitignore` ausgeschlossen (keine Secrets/Benutzerdaten in Git).
  - **Tägliche Scheduler** (via `scheduleDailyAt`):
    - 07:00 Uhr – Wetterbericht per Telegram senden.
    - 08:00 Uhr – Am 1. des Monats: Zählerstand-Erinnerung per Telegram.
    - 18:00 Uhr – Prüfen ob morgen Müllabholung; wenn ja, Telegram-Benachrichtigung.
  - **Telegram Long Polling** – `startTelegramPolling()` läuft als dauerhafter Loop im Hintergrund und beantwortet Wetter-Anfragen.

- **Frontend**
  - Reines HTML/CSS/Vanilla-JS in `public/index.html`.
  - Tabs (Kalender / Import / Energie) werden clientseitig per DOM-Manipulation umgeschaltet.
  - Müllkalender:
    - Holt Termine über `/waste-pickups`, baut ein Monatsgrid mit festen Kachelgrößen und Markierung des aktuellen Tages.
  - Import:
    - Dateiupload per `FormData` an `/waste-pickups/import`, Anzeige von Statusmeldungen, Speicherung des letzten Imports in `localStorage`.
  - Energie:
    - Lädt Preis-Defaults über `/energy/config`, vorbefüllt die Felder.
    - Speichert Messwerte und neue Defaults via `POST /energy/readings`.
    - Zeigt Verlaufsdiagramm (Chart.js) mit Umschalter Zählerstand/Verbrauch.
    - Zeigt Statusmeldungen zu Validierung und Speichervorgang.

- **Deployment**
  - Dockerfile baut ein TypeScript-Build und erstellt ein schlankes Runtime-Image (Node 20, `npm ci`).
  - `docker-compose.yml`:
    - Service `haus-muell-app`, Port-Mapping `3000:3000`.
    - Mount von `./data` nach `/app/data` im Container (persistente Konfiguration/Messdaten).
    - `restart: unless-stopped` für automatischen Neustart auf dem Raspberry Pi.

- **ENV-Variablen** (vollständige Liste, siehe `.env.example`):

  | Variable | Pflicht | Beschreibung |
  |---|---|---|
  | `PORT` | nein | Server-Port (Standard: 3000) |
  | `TELEGRAM_BOT_TOKEN` | für Telegram | Bot-Token vom @BotFather |
  | `TELEGRAM_CHAT_ID` | für Telegram | Chat-ID des Empfängers |
  | `WEATHER_LAT` | nein | Breitengrad (Standard: 52.4344) |
  | `WEATHER_LON` | nein | Längengrad (Standard: 13.2486) |
  | `INFLUX_URL` | für InfluxDB | URL der InfluxDB-Instanz |
  | `INFLUX_TOKEN` | für InfluxDB | API-Token |
  | `INFLUX_ORG` | für InfluxDB | Organisation |
  | `INFLUX_BUCKET` | für InfluxDB | Bucket-Name |
