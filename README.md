# Brand Placement Analysis (POC)

Upload a short video (10–20s), detect brands with **Gemini Flash Lite**, optionally rate **placement sentiment**, and view **brand summaries** in the browser. A **bounded agentic loop** runs per brand (decide → search → self-verdict → retry).

## Quick start (recommended — web UI)

```bash
git clone <your-repo-url> brand-placement-analysis
cd brand-placement-analysis
npm install
cp .env.example .env
# Set GEMINI_API_KEY in .env
brew install ffmpeg   # macOS; install ffmpeg on your OS if needed
npm run dev
```

Open **http://localhost:3456**, upload a clip, and watch progress + results on the page.

**Test obscure brands (search vs skip):** `npm run samples:build` then upload `samples/clips/obscure-brands-test.mp4` — see [samples/README.md](samples/README.md).

## CLI (optional)

```bash
npm run analyze -- /path/to/clip.mp4
```

Writes `output.json` and prints markdown to the terminal.

## Project layout

| Path | Purpose |
|------|---------|
| [`pipeline.ts`](pipeline.ts) | Core agent + vision pipeline (shared by UI and CLI) |
| [`server.ts`](server.ts) | Local web server + upload API (SSE progress) |
| [`public/`](public/) | Upload UI and results display |
| [`analyze.ts`](analyze.ts) | CLI wrapper |

## Agent behavior

1. Tool-use decision — skip or use Google Search per brand  
2. Grounding — live web results when search runs  
3. Self-verdict — model rates its brand summary  
4. Bounded retry — up to 2 attempts if confidence is low  

## Placement sentiment

After detection, one optional vision call rates **placement** per brand (`positive` / `neutral` / `negative`) from on-screen context. Each result card can show a placement badge and short rationale.

## Rate limits

Free-tier Flash Lite allows about **15 requests per rolling minute**. The client enforces a **sliding 60s window** (`GEMINI_MAX_REQUESTS_PER_MINUTE`, default **12**) plus minimum spacing (`GEMINI_MIN_INTERVAL_MS`, default **5000** ms). After a quota error it **cool downs for at least ~55s** (or the API’s “retry in Ns”, whichever is longer). A 13-brand mashup can take **10–20+ minutes** on the free tier — that is expected.

## Requirements

- Node.js 20+
- ffmpeg on PATH
- `GEMINI_API_KEY` in `.env`

Optional: `PORT=3456`, `GEMINI_MODEL=gemini-3.1-flash-lite`, `GEMINI_MIN_INTERVAL_MS=4500`

## Security

Do not commit `.env`. Videos are processed locally; uploads use a temp folder and are deleted after each run.
