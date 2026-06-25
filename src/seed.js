// Carga las tenencias desde data/holdings.json a la base.
//   npm run seed            -> agrega las filas del JSON
//   npm run seed -- --reset -> borra las tenencias actuales y luego carga
//
// Alternativa sin terminal: usá el boton "Importar lista" en la web.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, addHoldingsBulk, deleteAllHoldings, pool } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(__dirname, '..', 'data', 'holdings.json');

(async () => {
  if (!fs.existsSync(file)) {
    console.error('No existe data/holdings.json');
    process.exit(1);
  }
  const items = JSON.parse(fs.readFileSync(file, 'utf8'));
  await migrate();
  if (process.argv.includes('--reset')) {
    await deleteAllHoldings();
    console.log('Tenencias previas borradas.');
  }
  const n = await addHoldingsBulk(items);
  console.log(`Cargadas ${n} tenencias desde data/holdings.json`);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
