import { InfluxDB, Point } from '@influxdata/influxdb-client';
import { readFileSync } from 'fs';

// Konfiguration
const INFLUX_URL = 'http://192.168.178.32:8086';
const INFLUX_TOKEN = 'Rag7bdMB8WNO2s4R8xrAUHA13JnJbVBD0zq0V25ANfPyHj-ltVlwPYz3UQap54P-fT6LCLjFe0XTTIKKQ1FzQA==';
const INFLUX_ORG = 'home';
const INFLUX_BUCKET = 'influx_home';
const CSV_PATH = '/Users/christianmester/Downloads/Utilities Übersicht DBX - RAW.csv';

const influx = new InfluxDB({ url: INFLUX_URL, token: INFLUX_TOKEN });
const writeApi = influx.getWriteApi(INFLUX_ORG, INFLUX_BUCKET, 'ms');

const csv = readFileSync(CSV_PATH, 'utf-8');
const lines = csv.trim().split('\n').slice(1); // Header überspringen

let count = 0;

for (const line of lines) {
  const [dateStr, gas, water, power1, power2] = line.split(',').map(s => s.trim());
  if (!dateStr) continue;

  // DD.MM.YYYY → ISO Date
  const [day, month, year] = dateStr.split('.');
  const ts = new Date(`${year}-${month}-${day}T12:00:00Z`);
  if (isNaN(ts.getTime())) {
    console.warn(`Ungültiges Datum: ${dateStr}`);
    continue;
  }

  const meters = [
    { tag: 'gas',    value: gas },
    { tag: 'water',  value: water },
    { tag: 'power1', value: power1 },
    { tag: 'power2', value: power2 },
  ];

  for (const { tag, value } of meters) {
    const num = parseFloat(value);
    if (isNaN(num)) continue;

    writeApi.writePoint(
      new Point('energy_meter')
        .tag('meter', tag)
        .floatField('reading', num)
        .timestamp(ts)
    );
  }

  count++;
  console.log(`${dateStr}: Gas=${gas}, Wasser=${water}, Strom88=${power1}, Strom89=${power2}`);
}

await writeApi.close();
console.log(`\nFertig! ${count} Zeilen nach InfluxDB geschrieben.`);
