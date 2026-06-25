# 📈 Car te re ar — dashboard + reporte diario por mail

App en la nube para seguir tu cartera de inversiones. Tiene:

- **ABM de tickers** (alta/baja/modificación de tus tenencias y de tickers de interés) desde una interfaz web.
- **Análisis diario automático**: cada mañana lee tu cartera, trae precios y noticias del mercado, calcula tu rendimiento vs. tu precio de compra y arma observaciones objetivas.
- **Mail diario** con el reporte, enviado a tu casilla.

> ⚠️ **Aviso**: la app da *información para tu decisión*, no asesoramiento financiero. Las observaciones son objetivas (variaciones, rendimiento vs. precio de compra) y no son órdenes de compra/venta.

---

## CEDEARs y ratios

La app está pensada para **CEDEARs**. Cada CEDEAR representa una fracción de la acción que cotiza en EEUU según un **ratio** (ej. AVGO = 39: 39 CEDEARs equivalen a 1 acción).

Convención de carga (igual que una planilla de compras):

- **Precio de compra** = precio de la **acción en EEUU** al momento de comprar (USD/CCL), tal como figura en tu planilla.
- **Nominales** = cantidad de **CEDEARs** que compraste.
- **Ratio** = CEDEARs por acción (se **autocompleta** con `src/ratios.js`, editable).
- **Rendimiento %** = (precio actual de la acción − tu precio de compra) / compra.
- **Valor de la posición** = (nominales ÷ ratio) × precio actual de la acción.
- También cargás la **fecha de compra**.
- Tickers cuyo símbolo difiere del de EEUU se mapean solos (ej. `BRKB` → `BRK.B`).

### Cargar datos (botones de 1 clic — recomendado)

En la web, arriba de todo:

1. **Empezar de 0** (en el panel de Tickers): borra tenencias, tickers y reportes.
2. **Cargar sugeridos** (panel Tickers): carga los 18 tickers con sus ratios.
3. **Cargar mis compras** (panel Cartera): carga las 142 compras desde `data/holdings.json` (y registra sus tickers).

Otras formas: botón **Importar lista** (pegar `fecha · ticker · precio acción · nominales`) o, por terminal, `npm run seed` (lee `data/holdings.json`).

> Ratios precargados: AVGO 39, BRKB 22, EEM 5, EWZ 2, FXI 5, GOOGL 58, JPM 15, MELI 120, META 25, MSFT 30, NU 2, PFE 4, QQQ 20, SPY 20, SPXL 25, TQQQ 25, VEA 10, XLV 29.

## Cómo funciona (arquitectura)

Un solo servicio Node (Express) que:

- sirve la interfaz web (carpeta `public/`),
- expone una API REST (`src/server.js`),
- guarda todo en **Postgres** (`src/db.js`),
- corre un **cron interno** que cada día genera y envía el reporte (`node-cron`).

Por eso alcanza con **una sola plataforma** (Railway): ahí viven la app, la base de datos y el job diario.

---

## Stack y costos

| Pieza | Servicio | Plan |
|---|---|---|
| App + cron | Railway | crédito de prueba, luego ~centavos–pocos USD/mes |
| Base de datos | Railway Postgres | incluida en el proyecto |
| Datos de mercado | Finnhub (gratis) | 60 llamadas/min |
| Envío de mail | Resend (gratis, sin teléfono) | 100 mails/día |

---

## 🚀 Deploy paso a paso (guiado)

### 1. Crear cuenta de GitHub y subir el código
1. Entrá a **github.com** → *Sign up* (si no tenés cuenta).
2. Creá un repositorio nuevo (botón **New**), nombre p. ej. `cartera-app`, **Private**.
3. Subí los archivos de esta carpeta:
   - **Opción fácil (sin instalar nada)**: en el repo vacío, clic en *uploading an existing file* y arrastrá **todo el contenido** de la carpeta `cartera-app` (no subas `node_modules`).
   - **Opción con git** (si lo tenés): dentro de la carpeta, ejecutá:
     ```bash
     git init && git add . && git commit -m "primera version"
     git branch -M main
     git remote add origin https://github.com/TU_USUARIO/cartera-app.git
     git push -u origin main
     ```

### 2. Crear cuenta de Railway y desplegar
1. Entrá a **railway.app** → *Login* con tu cuenta de GitHub.
2. **New Project** → **Deploy from GitHub repo** → elegí `cartera-app`.
3. Railway detecta Node y hace el build solo (`npm install` + `npm start`).

### 3. Agregar la base de datos Postgres
1. Dentro del proyecto en Railway: **+ New** → **Database** → **Add PostgreSQL**.
2. Eso crea la base. Ahora hay que decirle a la app cómo conectarse:
   - Andá al servicio de tu **app** → pestaña **Variables** → **New Variable**.
   - Nombre: `DATABASE_URL` — Valor: clic en *Add Reference* y elegí `Postgres → DATABASE_URL` (queda como `${{Postgres.DATABASE_URL}}`).
3. Las tablas se crean solas la primera vez que arranca la app.

### 4. Crear la API de datos de mercado (Finnhub)
1. Entrá a **finnhub.io** → *Get free API key* → registrate.
2. Copiá tu **API key** del dashboard.
3. En Railway → app → **Variables**, agregá:
   - `MARKET_PROVIDER` = `finnhub`
   - `MARKET_API_KEY` = *(tu key de Finnhub)*

### 5. Configurar el envío de mail (Resend — sin teléfono)
1. Entrá a **resend.com** → *Sign up* con tu mail (`gascazur@gmail.com`). **No pide SMS.**
2. En el panel → **API Keys** → *Create API Key* → copiala.
3. En Railway → app → **Variables**, agregá:
   - `MAIL_PROVIDER` = `resend`
   - `RESEND_API_KEY` = *(tu API key)*
   - `MAIL_FROM_EMAIL` = `onboarding@resend.dev`  *(remitente de prueba, no requiere dominio)*
   - `MAIL_FROM_NAME` = `Cartera Bot`
   - `MAIL_TO_EMAIL` = `gascazur@gmail.com`  *(debe ser el MISMO mail con el que te registraste en Resend)*

> Con el remitente de prueba `onboarding@resend.dev` solo podés enviarte mails **a vos mismo** (el mail de tu cuenta Resend) — que es justo lo que necesitás. Para mandar a otras casillas o personalizar el remitente, más adelante verificás un dominio propio en Resend.
>
> **Alternativa Brevo** (si preferís): poné `MAIL_PROVIDER=brevo`, `BREVO_API_KEY`, y un `MAIL_FROM_EMAIL` verificado en Brevo.

### 6. Ajustar horario del reporte
En Railway → app → **Variables**:
- `REPORT_HOUR` = `8`  (hora local, 0–23)
- `REPORT_MINUTE` = `0`
- `TZ` = `America/Argentina/Buenos_Aires`
- `CURRENCY` = `USD`  (solo etiqueta de visualización)
- `APP_TOKEN` = *(opcional)* una clave secreta; si la ponés, la web pedirá ese token para entrar.

> Después de agregar variables, Railway redeploya solo.

### 7. Abrir la app y fijar el dominio
1. En Railway → app → **Settings** → **Networking** → **Generate Domain**.
2. Copiá esa URL (ej. `https://cartera-app.up.railway.app`). La vas a necesitar abajo.
3. En **Variables** agregá `BASE_URL` = esa URL (sin barra final).

### 8. Login con Google (SSO)
1. Entrá a **console.cloud.google.com** → creá un proyecto (o usá uno).
2. **APIs y servicios → Pantalla de consentimiento OAuth**: tipo *Externo*, completá nombre y tu mail, y en *Usuarios de prueba* agregá `gascazur@gmail.com`.
3. **APIs y servicios → Credenciales → Crear credenciales → ID de cliente de OAuth** → tipo *Aplicación web*.
   - **Orígenes autorizados de JavaScript:** tu `BASE_URL`.
   - **URIs de redirección autorizados:** `BASE_URL` + `/auth/callback` (ej. `https://cartera-app.up.railway.app/auth/callback`).
4. Copiá el **Client ID** y el **Client secret**.
5. En Railway → **Variables**, agregá:
   - `GOOGLE_CLIENT_ID` = *(tu client id)*
   - `GOOGLE_CLIENT_SECRET` = *(tu client secret)*
   - `SESSION_SECRET` = *(una cadena larga al azar)*
   - `ALLOWED_EMAILS` = `gascazur@gmail.com`  *(solo vos podés entrar)*
6. Listo: al abrir la app te va a pedir **Ingresar con Google**. Solo tu cuenta tiene acceso.

> Sin `GOOGLE_CLIENT_ID` el SSO queda desactivado (útil para probar en local).

### 9. Cargar datos y probar
1. **Empezar de 0** → **Cargar sugeridos** (tickers) → **Cargar mis compras** (142 desde el archivo).
2. Usá los **filtros** (tipo, ticker, año, fechas, ganadoras/perdedoras) y el **toggle** lotes/consolidado; los totales se ajustan al filtro.
3. Clic en **Generar reporte ahora** para probar el mail al instante.
4. A partir de ahí, el reporte sale solo todos los días a la hora configurada.

---

## Variables de entorno (resumen)

Ver `.env.example`. Las obligatorias para producción:

- `DATABASE_URL` (la inyecta Railway por referencia)
- `MARKET_API_KEY` (+ `MARKET_PROVIDER`)
- `MAIL_PROVIDER`, `RESEND_API_KEY` (o `BREVO_API_KEY`), `MAIL_FROM_EMAIL`, `MAIL_TO_EMAIL`

Sin `MARKET_API_KEY` la app corre en **modo demo** (precios simulados) para que puedas ver la interfaz funcionando.

---

## Correr en local (opcional, para desarrollo)

Necesitás Node 18+ y un Postgres.

```bash
npm install
cp .env.example .env     # completá los valores
npm start                # http://localhost:3000
npm run report:now -- --send   # genera y envía un reporte de prueba
```

---

## Notas técnicas

- Proveedor de datos cambiable: `MARKET_PROVIDER=finnhub` o `fmp` (Financial Modeling Prep). Cada uno usa su propia `MARKET_API_KEY`.
- El cron corre **dentro** del servicio web (que en Railway está siempre encendido), así que no hace falta un servicio de cron aparte.
- Endpoints útiles: `GET /api/dashboard` (datos en vivo), `POST /api/report/run` (genera/envía), `GET /api/reports/latest` (último reporte en HTML).

## Próximos pasos / evolución

Ideas para sumar más adelante: alertas por umbral (avisar si algo cae/sube X%), medias móviles y tendencia, soporte multi-moneda real con conversión, login de usuario, e histórico de precios para gráficos.
