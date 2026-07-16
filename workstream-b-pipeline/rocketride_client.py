"""
Frontrun — Track B · RocketRide runner (the "one RocketRide tool" prize surface).

Runs the enrich->draft step of Track B as a native RocketRide cloud pipeline
(`enrich.pipe`): webhook -> agent_rocketride (+ llm + memory + http_request)
-> response_answers. The agent resolves the company's real domain + exec email,
researches the raise, and drafts the outreach in one deployed pipe.

Auth (verified working):
  ROCKETRIDE_URI   = https://api.rocketride.ai        (Cloud; wss upgrade)
  ROCKETRIDE_AUTH  = rr_...   (or ROCKETRIDE_API_KEY / ROCKETRIDE_APIKEY)

BYOK for inference: the LLM node reads ${ROCKETRIDE_OPENAI_KEY} (an OpenAI
`sk-...` key). The rr_ key authenticates the ORCHESTRATION; the LLM call is your
key. Without it the pipeline still connects/validates/deploys but the agent
produces no draft — this script says so explicitly instead of failing silently.

Usage:
  python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
  ROCKETRIDE_OPENAI_KEY=sk-... npm run track-b:rocketride            # live draft
  echo '{"lead":"Company: Acme ... raised $5M"}' | npm run track-b:rocketride -- --json-stdin
"""

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

from rocketride import RocketRideClient
from rocketride.schema import Question

DEFAULT_PIPELINE = Path(__file__).resolve().parent / "enrich.pipe"

# LLM node env vars RocketRide substitutes into the pipe (any one enables output).
LLM_KEY_VARS = ("ROCKETRIDE_OPENAI_KEY", "ROCKETRIDE_ANTHROPIC_KEY", "ROCKETRIDE_GEMINI_KEY")

SAMPLE_LEAD = (
    "Company: Synthreo, Inc. | Founder: Callen Sapien (Executive Officer, Director) "
    "| Raised: $999,999 (SEC Form D, filed today) | Location: Phoenix, AZ."
)


def resolve_auth() -> str:
    for var in ("ROCKETRIDE_AUTH", "ROCKETRIDE_API_KEY", "ROCKETRIDE_APIKEY"):
        val = os.getenv(var)
        if val:
            return val
    return ""


def read_lead(args: argparse.Namespace) -> str:
    if args.json_stdin:
        raw = sys.stdin.read().strip()
        if raw:
            try:
                obj = json.loads(raw)
                return obj.get("lead") or obj.get("prompt") or raw
            except json.JSONDecodeError:
                return raw
    return args.lead or SAMPLE_LEAD


async def run_rocketride(args: argparse.Namespace) -> dict[str, Any]:
    auth = resolve_auth()
    lead = read_lead(args)
    have_llm_key = any(os.getenv(v) for v in LLM_KEY_VARS)

    async with RocketRideClient(uri=args.uri, auth=auth) as client:
        if not client.is_connected():
            raise RuntimeError(f"Could not connect to RocketRide at {args.uri}")

        # 1) Validate the pipeline graph against the cloud engine.
        pipe = json.loads(Path(args.pipeline).read_text())
        validation = await client.validate(pipe)

        # 2) Deploy. Pass the LLM key(s) as pipeline env so ${ROCKETRIDE_OPENAI_KEY}
        #    substitutes into the agent's llm node.
        llm_env = {v: os.environ[v] for v in LLM_KEY_VARS if os.getenv(v)}
        used = await client.use(filepath=str(args.pipeline), ttl=180, env=llm_env or None)
        token = used["token"]

        # 3) Run the enrichment agent via chat() — routes the lead into the
        #    'questions' lane; the agent (with http_request + LLM) resolves the
        #    real domain/email, researches funding, and drafts outreach.
        question = Question(expectJson=True)
        question.addContext(f"Company that filed an SEC Form D (raised private capital): {lead}")
        question.addQuestion(
            "Enrich this lead end to end. Resolve the company's REAL website domain and the "
            "exec's professional email at it, write a short funding/company research summary, "
            'and draft ONE warm first-touch recruiting outreach email. Return STRICT JSON: '
            '{"domain":"...","email":"...","emailConfidence":"high|medium|low","research":"...",'
            '"draft":{"subject":"...","body":"..."}}.'
        )
        response = await client.chat(token=token, question=question)
        answers = response.get("answers") if isinstance(response, dict) else None

        await client.terminate(token)

    raw = answers[0] if answers else None
    enrichment = raw if isinstance(raw, dict) else _try_json(raw)
    return {
        "connected": True,
        "validated": bool(validation),
        "token": token,
        "llm_key_present": have_llm_key,
        "enrichment": enrichment,
        "raw": None if enrichment else raw,
        "objectId": response.get("objectId") if isinstance(response, dict) else None,
    }


def _try_json(s: Any) -> Any:
    if not isinstance(s, str):
        return None
    try:
        import ast
        t = s.strip()
        if t.startswith("```"):
            t = t.strip("`").split("\n", 1)[-1]
        return json.loads(t)
    except Exception:
        try:
            return ast.literal_eval(s)
        except Exception:
            return None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the Frontrun Track B drafting step through RocketRide Cloud.")
    parser.add_argument("--uri", default=os.getenv("ROCKETRIDE_URI", "https://api.rocketride.ai"))
    parser.add_argument("--pipeline", type=Path, default=DEFAULT_PIPELINE)
    parser.add_argument("--lead", help="Lead summary to draft outreach for (defaults to a sample).")
    parser.add_argument("--json-stdin", action="store_true", help="Read {\"lead\": \"...\"} from stdin.")
    return parser.parse_args()


async def main() -> None:
    args = parse_args()
    if not resolve_auth():
        print("✗ No RocketRide key. Set ROCKETRIDE_AUTH (or ROCKETRIDE_API_KEY) to your rr_... key.", file=sys.stderr)
        sys.exit(1)

    result = await run_rocketride(args)
    print(json.dumps(result, indent=2, default=str))

    if not result["llm_key_present"]:
        print(
            "\nℹ RocketRide connected, validated, and deployed the pipeline, but no LLM key is set,\n"
            "  so the enrichment agent produced no output. Add ONE of "
            + ", ".join(LLM_KEY_VARS)
            + " (an sk-... key)\n  to .env.local. The rr_ key authenticates orchestration only (BYOK inference).",
            file=sys.stderr,
        )
    elif result.get("enrichment"):
        e = result["enrichment"]
        print(
            f"\n✓ RocketRide Cloud enriched the lead live (agent_rocketride + http_request + OpenAI): "
            f"domain={e.get('domain')} email={e.get('email')} ({e.get('emailConfidence')}).",
            file=sys.stderr,
        )


if __name__ == "__main__":
    asyncio.run(main())
