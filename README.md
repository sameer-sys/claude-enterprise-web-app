# Claude Enterprise App

A Next.js and TypeScript AI workspace, deployable on Vercel, with an Electron desktop wrapper.

## Workspace cloud sync

Chat sessions and project metadata can sync between trusted devices using Supabase.

- The server-side API reads `SUPABASE_URL` and `SUPABASE_ANON_KEY` from Vercel environment variables.
- `POST /api/sync` supports `action: "load"` and `action: "save"`.
- Database RPC functions `get_claude_workspace` and `save_claude_workspace` validate the private workspace code.
- The `public.claude_workspaces` table has Row Level Security enabled and direct table access is revoked; access goes through the validated RPC functions.
- The app creates a random 64-character workspace sync key when one is not already saved. Enter the same key only on devices that should share a workspace. Anyone holding that key can access that workspace, so treat it like a password.
- The client never sends Supabase keys in URLs or stores them in browser storage.
- Connector credentials and attachment data URLs are excluded from the sync payload. Large binary files should be stored separately.
- The API only reports cloud sync success after Supabase confirms the operation.

## Environment

Configure these variables in Vercel for Production, Preview and Development:

- `SUPABASE_URL` — the Supabase project URL
- `SUPABASE_ANON_KEY` — the project's anon API key, kept server-side by this implementation

Never put a Supabase service-role key in frontend code or browser storage.

## Browser agent (web deployment)

The web deployment runs browser automation in a remote Chromium session. It cannot attach to Chrome on your laptop from a Vercel serverless function.

Configure these server-side Vercel environment variables for Production (and Preview if you test there):

- `BROWSER_WS_ENDPOINT` — a private CDP WebSocket endpoint from a managed browser provider, for example a provider-issued `wss://...` endpoint. Keep its token inside the environment variable; never commit it to Git.
- `GEMINI_API_KEY` or `GROQ_API_KEY` — the model key used to plan and execute browser actions. The app uses Gemini when both are configured, otherwise Groq.

After setting the variables, redeploy the web app. The Browser Agent route now attempts real browser execution and returns an explicit setup/runtime error instead of reporting fake success when a browser is unavailable. Browser screenshots are streamed into the Browser Panel after each action. The ordinary iframe preview remains only a fallback; websites that block framing must be viewed through the remote-browser screenshots.
