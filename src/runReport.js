// Genera un reporte una vez desde la linea de comandos (para pruebas).
//   npm run report:now
import { migrate, pool } from './db.js';
import { generateReport } from './report.js';

const send = process.argv.includes('--send');

(async () => {
  await migrate();
  const r = await generateReport({ send });
  console.log('Reporte #' + r.reportId, '| mail:', r.emailResult.sent ? 'enviado' : r.emailResult.reason);
  console.log(JSON.stringify(r.summary, null, 2));
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
