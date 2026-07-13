"""
Frontrun — Track B · RocketRide runner (the "one RocketRide tool" prize surface).

Runs the outreach-DRAFT step of Track B as a native RocketRide cloud pipeline
(`frontrun.pipe`): webhook -> agent_rocketride (+ llm + memory) -> response_answers.
The enrich/verify steps stay in the TypeScript pipeline (they're HTTP/API calls);
RocketRide orchestrates the intelligent drafting.

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

DEFAULT_PIPELINE = Path(__file__).resolve().parent / "frontrun.pipe"

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

        # 2) Deploy + feed the lead through the drafting agent.
        used = await client.use(filepath=str(args.pipeline), ttl=180)
        token = used["token"]

        chunks: list[Any] = []
        response = await client.send(token, lead, on_sse=lambda e: chunks.append(e))

        # 3) Give the agent a moment, then read the run status.
        answer = ""
        status: dict[str, Any] = {}
        for _ in range(12):
            await asyncio.sleep(2)
            status = await client.get_task_status(token)
            if isinstance(status, dict) and (status.get("completed") or status.get("errors")):
                break
        for ev in chunks:
            text = ev.get("text") or ev.get("data") if isinstance(ev, dict) else None
            if text:
                answer += str(text)

        await client.terminate(token)

    return {
        "connected": True,
        "validated": bool(validation),
        "token": token,
        "llm_key_present": have_llm_key,
        "draft": answer or None,
        "response_handle": response,
        "status_errors": (status or {}).get("errors", []),
    }


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
            "  so the drafting agent produced no text. Add ONE of "
            + ", ".join(LLM_KEY_VARS)
            + " (an sk-... key)\n  to .env.local for a live draft. The rr_ key authenticates orchestration only (BYOK inference).",
            file=sys.stderr,
        )


if __name__ == "__main__":
    asyncio.run(main())
