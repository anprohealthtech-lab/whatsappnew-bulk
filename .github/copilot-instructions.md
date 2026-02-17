
# Copilot Instructions: Multi-Project WhatsApp/Task/Function Platform

>This workspace contains three tightly integrated projects for WhatsApp automation, HR/task management, and DigitalOcean serverless functions. These instructions are for AI coding agents to be productive across all codebases.

---

## 1. Big Picture Architecture

- **WHATSAPP-PERSISTENT/**: Node.js + React (bundled in `NodeBackend/`). Persistent WhatsApp sessions, Express API, Vite client, Drizzle ORM, DigitalOcean/App Platform ready. Integrates with HR/Task via serverless/AI agent flows.
- **project/**: Hybrid React + Capacitor + Supabase app for pathology lab ops (tasks, HR, payroll, WhatsApp outreach, AI insights). Uses Supabase Edge Functions for privileged ops, heavy Tailwind, and mobile build via Capacitor.
- **Digital ocean function JS/**: DigitalOcean Serverless Functions (Node.js) that bridge WhatsApp backend and Supabase Edge Functions. Each function proxies to a corresponding Supabase Edge function, using service role keys.

**Cross-system flow:**
```
WhatsApp User → NodeBackend HRChatbotService → DO AI Agent (GPT-4o) → DO Serverless Functions → Supabase Edge Functions
```

---

## 2. Critical Developer Workflows

- **WHATSAPP-PERSISTENT/NodeBackend**
  - Dev: `npm run dev` (from repo root, launches server and Vite client)
  - Build: `npm run build` (builds client/server), `npm run start` (prod server)
  - DB: `cd NodeBackend && npm run db:push` (Drizzle migrations)
  - Persistent dirs: `uploads/`, `sessions/` (do not rename/move)
- **project/**
  - Dev: `npm run dev` (Vite), `npx cap run android` (mobile)
  - Build: `npm run build`, `npm run preview`
  - Edge: Deploy functions with `deploy-functions.ps1/.sh`
- **Digital ocean function JS/**
  - Deploy: `doctl serverless deploy .`
  - Test: `node -e "require('./create-task/index.js').main({...})"`

---

## 3. Project-Specific Conventions & Patterns

- **NodeBackend**: ESM + TypeScript, Vite dev middleware, esbuild prod bundle, Boom-style HTTP errors, async/await, logging truncates large payloads, route registration via `registerRoutes`, session/file persistence conventions.
- **project/**: DTOs in `src/models/`, Supabase client in `src/utils/supabaseClient.ts`, Edge calls via `src/lib/edgeClient.ts`, state via `OrganizationProvider`, RLS enforced, Tailwind for styling, mobile via Capacitor.
- **Digital ocean function JS/**: All functions export `main(args)`, validate params, proxy to Supabase Edge, return `{ body: result }`, config in `project.yml`.

---

## 4. Integration Points & External Dependencies

- WhatsApp: `@whiskeysockets/baileys` (session handling in `NodeBackend/server/services/WhatsAppService.ts`)
- HR/Task: DigitalOcean AI Agent (GPT-4o), DO Serverless Functions, Supabase Edge Functions
- File uploads: `multer`, persistent under `uploads/`
- DB: Drizzle ORM, schema in `shared/schema.ts`, migrations in `migrations/`
- Mobile: Capacitor, Android native project under `project/android/`

---

## 5. Key Files & Where to Look First

- `NodeBackend/server/index.ts`, `routes.ts`, `services/`, `storage/DatabaseStorage.ts`
- `shared/schema.ts`, `migrations/`
- `project/src/App.tsx`, `src/models/`, `src/services/`, `src/lib/edgeClient.ts`
- `Digital ocean function JS/project.yml`, `*/index.js`

---

## 6. Do NOT...

- Change persistence semantics for `uploads/`, `sessions/` without deployment review
- Commit secrets; always use env vars for credentials
- Break route registration or dev/prod server wiring

---

For unclear or missing areas (CI, Docker, PR flow), ask for clarification to expand this doc.
