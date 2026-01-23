## Repo-specific Copilot instructions

This repository is a combined Node + React app (backend and frontend bundled under `NodeBackend/`) designed for DigitalOcean/App Platform deployments with persistent WhatsApp sessions.

Keep guidance short and focused — the goal is to make an AI coding assistant immediately productive in this codebase.

### Big picture (what touches what)
- NodeBackend/
  - `server/` — Express server entry (`server/index.ts`) and route registration (`server/routes.ts`). The server conditionally loads Vite in development via `vite-dev` and is bundled with `esbuild` for production (`build:server`).
  - `client/` — Vite + React app (source under `client/src`), built with the `build:client` script.
  - `uploads/` and `sessions/` — persistent runtime directories for file uploads and WhatsApp session data. Don't move these or change persistence semantics without considering deployment storage.
- `shared/schema.ts` & `migrations/` — Drizzle ORM schema and migrations; DB is managed with `drizzle-kit`.

### Cross-Project Integration: HR Chatbot Flow
This backend integrates with two external systems for HR/Task Management via DigitalOcean AI Agent:
```
WhatsApp User → HRChatbotService → DO AI Agent (GPT-4o) → DO Serverless Functions → Supabase Edge Functions
```
- **HRChatbotService** (`server/services/HRChatbotService.ts`): Routes messages from registered HR admins to DO AI Agent
- **HR Admin routing**: `routes.ts` checks `hr_admins` table to determine if incoming WhatsApp message should be routed to HR chatbot vs LIMS chatbot
- **Config table**: `hr_chatbot_configs` stores DO AI Agent URL, Supabase credentials for function execution
- **API endpoints**: `/api/hr-admins/*` for HR admin management, `/api/hr-chatbot/*` for config
- See [HR_CHATBOT_INTEGRATION.md](NodeBackend/HR_CHATBOT_INTEGRATION.md) for full architecture diagram

### Quick developer workflows (commands)
- Dev (single command from repo root):
  - `npm run dev` — runs `cd NodeBackend && npm run dev` (this launches the server via `tsx server/index.ts` and uses Vite for the client in dev mode).
- Build for production (from repo root):
  - `npm run build` — runs `cd NodeBackend && npm run build` (builds client with Vite, bundles server with `esbuild`).
  - `npm run start` — runs `cd NodeBackend && npm start` (starts `node dist/index.js`).
- DB migration / schema
  - Inside `NodeBackend/`: `npm run db:push` runs `drizzle-kit push` to apply the schema.
- Static port / deploy notes
  - Server uses `PORT` env var (default behavior falls back to 3001). `.replit` sets `PORT=5000` for dev. For DigitalOcean/App Platform, ensure persistent volumes for `uploads/` and `sessions/`.

### Project-specific conventions and gotchas
- ESM + TypeScript: `NodeBackend/package.json` sets `type: "module"`. Use ESM imports and be mindful when adding Node-only modules.
- Dev vs Prod server behavior: `server/index.ts` only imports `vite-dev` in development. The production server serves pre-built static assets via `serveStatic`. When testing routes locally in dev, Vite is a middleware — changing route ordering can break dev middleware behavior.
- Server bundling: `build:server` uses `esbuild` and explicitly excludes `./vite-dev` and `./vite` from the bundle. If you add dev-only modules, ensure they are excluded the same way to avoid bundle errors.
- Logging: `server/index.ts` captures API JSON responses and truncates logs to ~80 chars. Keep large payloads out of the default logs.
- WhatsApp integration: see `server/services/WhatsAppService.ts` (and `WhatsAppService.old.ts`) for how sessions are created and persisted. The codebase uses `@whiskeysockets/baileys` (and may also reference other libs) — preserve session handling conventions when modifying connection logic.
- File handling: `server/services/PersistentFileService.ts` / `FileService.ts` and `multer` are used for uploads. Uploaded files land under `uploads/`.

### Important files to inspect before making changes
- `NodeBackend/server/index.ts` — server startup, dev vs prod wiring.
- `NodeBackend/server/routes.ts` — where routes are registered; add new API routes here using the existing `registerRoutes` pattern.
- `NodeBackend/server/services/*` — WhatsApp, Message, File services. Follow existing async patterns and error handling (Boom-style HTTP errors are used).
- `NodeBackend/server/storage/DatabaseStorage.ts` — DB-backed storage implementation.
- `shared/schema.ts` and `migrations/` — DB layout and migration history.
- `NodeBackend/package.json` — scripts and build tool details (vite/esbuild/tsx).

### Examples (how to implement common changes)
- Add an API route: add a route handler file under `server/` and register it in `server/routes.ts`. The `registerRoutes(app)` pattern returns the server instance used by `vite-dev` in development.
- Add a background task or service: create a new file under `server/services/`, keep exports async, and import from `registerRoutes` or a specific route. Avoid forcing process.exit on unhandled errors — the server installs global handlers and prefers logging.

### What the AI should NOT change automatically
- Do NOT change persistence semantics (paths `uploads/`, `sessions/`) or rename them without coordinating deployment and Docker/DO App Platform settings.
- Do NOT commit secrets; DB credentials live in environment variables (check `.replit` / `.env.production` usage). Ensure any change supports reading config from env.

If anything above is unclear or you'd like more detail (CI steps, Dockerfile specifics, or common PR patterns), tell me which area to expand and I will iterate.
