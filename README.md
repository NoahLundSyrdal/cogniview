This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Environment Configuration

Copy `.env.example` to `.env` and fill in keys for the provider(s) you want to use.

### Core LLM settings

- `ANTHROPIC_API_KEY` - Anthropic API key for chat/vision/summarize when Anthropic is selected.
- `OPENAI_API_KEY` - OpenAI API key for chat/vision/summarize and required for fact-checking.
- `LLM_PROVIDER` - optional override: `anthropic` or `openai`.
- `ANTHROPIC_MODEL` - optional text/vision model override for Anthropic (default in code: `claude-sonnet-4-6`).
- `OPENAI_MODEL` - optional text/vision model override for OpenAI (default in code: `gpt-4o`).
- `RAILTRACKS_AGENT_URL` - optional URL for the Python Railtracks agent service. When unset, chat stays on the built-in TypeScript path.
- `RAILTRACKS_LLM_PROVIDER` - optional override for the Railtracks service: `anthropic` or `openai`.
- `RAILTRACKS_ANTHROPIC_MODEL` - optional Anthropic model override for the Railtracks service.
- `RAILTRACKS_OPENAI_MODEL` - optional OpenAI model override for the Railtracks service.

### Fact-checking settings

- `OPENAI_FACTCHECK_IMAGE_MODEL` - model used for image-to-claim extraction (default: `gpt-5.4`).
- `OPENAI_FACTCHECK_REASONING_MODEL` - model used for web-grounded claim verification (default: `gpt-5.4`).
- `FACTCHECK_MAX_CLAIMS` - max claims extracted per run (default: `5`).

## Railtracks Agent Service

Chat can now run through a small Python Railtracks service in [`services/meeting-agent/app.py`](services/meeting-agent/app.py) while the existing Next.js chat route remains as a fallback.

### Run the service

```bash
python3 -m venv services/meeting-agent/.venv
source services/meeting-agent/.venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --app-dir services/meeting-agent --reload --port 8000
```

The service loads the repo's `.env.local` first and then `.env`, so it can reuse the same `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` values as the Next app. The root [`requirements.txt`](requirements.txt) is also where Railtracks is declared for submission eligibility, while [`services/meeting-agent/requirements.txt`](services/meeting-agent/requirements.txt) delegates to it for local installs.

### Connect Next.js to Railtracks

Add this to `.env.local`:

```bash
RAILTRACKS_AGENT_URL=http://127.0.0.1:8000
```

Then start the Next app as usual with `npm run dev`. When `RAILTRACKS_AGENT_URL` is set, [`src/app/api/chat/route.ts`](src/app/api/chat/route.ts) forwards the existing chat payload to `POST /chat` on the Python service. When it is unset, the app keeps using `completeText(...)` in TypeScript.

### Railtracks observability

[`requirements.txt`](requirements.txt) installs `railtracks[cli]`, so once the Python service is running you can also use the Railtracks CLI tools locally, including `railtracks viz`, against the flows executed by the service.
