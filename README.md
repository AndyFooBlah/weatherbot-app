# weatherbot-app

Mobile-first chat + voice frontend for the weatherbot project. React + Vite + TypeScript + Tailwind, built on Firebase (Auth, Hosting, Firestore, Functions) and Google's Gemini Live API. Companion to the existing [`weatherbot`](https://github.com/AndyFooBlah/weatherbot) repo, which holds the data pipeline + MCP Toolbox.

> Status: **live** — voice + text sessions against the full toolbox (Phases 1–5 of the plan below are done; Phase 6 mobile polish is ongoing). See the issue tracker for current work.

## Architecture

```
Browser (mobile-first SPA)
  ├── Firebase Auth (Google + email/password, verified-email allow-list)
  └── Gemini Live via single-use ephemeral tokens
       └── Calls Cloud Functions broker for MCP tool execution
                    │
                    ▼
       Cloud Run: weatherbot-toolbox  (private, IAM-gated, in the
                    │                  weatherbot backend project)
                    ▼
       Cloud SQL + Conversational Analytics QueryData
```

## Phase plan

See the chat history in the [`weatherbot`](https://github.com/AndyFooBlah/weatherbot) repo for full context. Roughly:

- **Phase 1** ([weatherbot#3](https://github.com/AndyFooBlah/weatherbot/issues/3)) — Containerize MCP Toolbox, deploy as private Cloud Run service.
- **Phase 2** (this repo) — Create Firebase project, scaffold SPA, deploy with auth.
- **Phase 3** — Cloud Functions: `liveToken` (ephemeral Gemini Live tokens) and `callTool` (proxy to MCP Toolbox).
- **Phase 4** — Wire VoiceCommon + 7 weatherbot tools + system instruction. Voice and text both working.
- **Phase 5** — Firestore-backed allow-list, enforced via Firestore Rules.
- **Phase 6** — Mobile polish + PWA.

## First-time setup

```bash
# 1. Install deps (@andyfooblah/voice-common resolves from npmjs.org)
npm install

# 2. Pull Firebase web config (or copy .env.example → .env.local with values
#    from `firebase apps:sdkconfig WEB --project=<your-project>`)
cp .env.example .env.local

# 3. Point the functions at your deployed toolbox
cp functions/.env.example functions/.env   # set TOOLBOX_URL

# 4. Dev server
npm run dev      # http://localhost:3005

# 5. Build + deploy
npm run deploy   # build (with bundle secret scan), then firebase deploy --only hosting
```

### Manual one-time steps

**1. Enable Google sign-in (Firebase Console)**
[Authentication → Sign-in method → Google → Enable](https://console.firebase.google.com/project/weatherbot-app/authentication/providers). Email/password is already enabled programmatically.

**2. Store the Gemini API key in Secret Manager**
Get a key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey), then:
```bash
bash scripts/setup-gemini-secret.sh
```
The script prompts for the key with hidden input and adds a new version to the `GEMINI_API_KEY` secret. Until a real value is stored, `mintGeminiLiveToken` will succeed in deploy but fail at runtime.

**3. Initialize Firebase Storage**
VoiceCommon archives each voice session's mixed audio. Storage rules can't deploy until the bucket is registered with Firebase:
[Firebase Console → Storage → Get started](https://console.firebase.google.com/project/weatherbot-app/storage). After clicking through the one-time prompt, run `firebase deploy --only storage` to publish the rules.

**4. Add allowed users**
Both `mintGeminiLiveToken` and `callTool` enforce a Firestore allow-list. Anyone signed in whose email isn't in the list gets `permission-denied`. To add a user:
```bash
bash scripts/add-allowed-email.sh someone@example.com
```
Idempotent. Removes are easiest via [Firestore Console → Data → allowed_emails](https://console.firebase.google.com/project/weatherbot-app/firestore/data) → click the doc → delete.

## Cloud Functions

Three callable functions live in `functions/src/`:

- **`mintGeminiLiveToken`** — signed-in, allow-listed users call this to get a single-use, 30-minute ephemeral token for opening a Gemini Live WebSocket. The real `GEMINI_API_KEY` never leaves the server.
- **`callTool`** — proxies one MCP `tools/call` to the [`weatherbot-toolbox`](https://github.com/AndyFooBlah/weatherbot/issues/3) Cloud Run service. Validates auth + allow-list, mints a Cloud Run OIDC token, returns the MCP `result`. (Tool names are not separately allow-listed here — the toolbox's own tool registry is the authoritative boundary; see the note in `callTool.ts`.)
- **`listTools`** — proxies MCP `tools/list` so the SPA sources the canonical tool registry live from the toolbox instead of hardcoding declarations.

All three enforce the Firestore allow-list via `functions/src/auth.ts` → `requireAllowed(request)`, which also requires a **verified** email (anyone can register an email/password account claiming an arbitrary address). This is defense in depth on top of the Firebase Auth Console settings: even if Console gating drifts open, an attacker still needs a verified email in the `allowed_emails` collection (which is only writable by the admin SDK).

Deployed to `us-central1`. The function runtime SA (`<project-number>-compute@developer.gserviceaccount.com`) has:
- `roles/secretmanager.secretAccessor` on `GEMINI_API_KEY` (auto-granted by Firebase deploy)
- `roles/run.invoker` on `weatherbot-toolbox` in the weatherbot backend project (cross-project, granted by hand)
- The toolbox URL itself is configuration: `TOOLBOX_URL` in `functions/.env` (see `functions/.env.example`)
