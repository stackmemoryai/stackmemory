#!/usr/bin/env python3
"""
Evaluate StackMemory retrieval quality against baseline.

Runs the current (or optimized) retrieval prompt against test queries
and reports metrics. Use in CI to detect prompt regression.

Usage:
    python scripts/dspy/eval.py [--optimized PATH] [--db PATH]
"""

import argparse
import json
import os
import sys
from pathlib import Path

import dspy

from signatures import FrameRetrieval, QueryComplexity
from data import find_db, load_frames, load_anchors, build_frame_summary, build_decisions_summary
from optimize import retrieval_metric, complexity_metric


# Fixed eval queries — stable across runs
EVAL_QUERIES = [
    "What errors happened in the last hour?",
    "How does the authentication flow work?",
    "What did I work on yesterday?",
    "Why is the API returning 500?",
    "Show me recent database schema changes",
    "What's the current state of the billing integration?",
    "What architectural decisions were made about caching?",
    "List all unfinished tasks",
    "What files were changed in the last commit?",
    "How is the deployment pipeline configured?",
]


def run_eval(db_path: Path, model: str, optimized_path: Path | None):
    """Run evaluation against fixed queries."""
    lm = dspy.LM(model, api_key=os.environ.get("ANTHROPIC_API_KEY"))
    dspy.configure(lm=lm)

    frames = load_frames(db_path)
    anchors = load_anchors(db_path)
    frame_summary = build_frame_summary(frames)
    decisions_summary = build_decisions_summary(anchors)

    # Build eval examples
    eval_set = []
    for q in EVAL_QUERIES:
        eval_set.append(
            dspy.Example(
                query=q,
                token_budget=4096,
                session_summary=f"Frames: {len(frames)}, recent activity",
                available_frames=frame_summary,
                key_decisions=decisions_summary,
            ).with_inputs("query", "token_budget", "session_summary", "available_frames", "key_decisions")
        )

    # Baseline
    baseline = dspy.ChainOfThought(FrameRetrieval)
    evaluate = dspy.Evaluate(devset=eval_set, metric=retrieval_metric, num_threads=2)
    baseline_score = evaluate(baseline)
    print(f"Baseline score: {baseline_score:.3f}")

    # Optimized (if available)
    if optimized_path and optimized_path.exists():
        state = json.loads(optimized_path.read_text())
        optimized = dspy.ChainOfThought(FrameRetrieval)
        optimized.load_state(state["retrieval"]["state"])
        optimized_score = evaluate(optimized)
        print(f"Optimized score: {optimized_score:.3f}")
        delta = optimized_score - baseline_score
        print(f"Delta: {delta:+.3f}")

        if delta < -0.05:
            print("REGRESSION DETECTED — optimized prompt is worse than baseline")
            sys.exit(1)
        elif delta > 0.02:
            print("IMPROVEMENT — consider updating the production prompt")
        else:
            print("NO SIGNIFICANT CHANGE")
    else:
        print("No optimized state found — baseline only")

    return baseline_score


def main():
    parser = argparse.ArgumentParser(description="Evaluate StackMemory retrieval")
    parser.add_argument("--db", type=str, help="Path to context.db")
    parser.add_argument("--model", type=str, default="anthropic/claude-haiku-4-5-20251001")
    parser.add_argument("--optimized", type=str, default="scripts/dspy/optimized_state.json")
    args = parser.parse_args()

    db_path = Path(args.db) if args.db else find_db()
    optimized_path = Path(args.optimized) if args.optimized else None

    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("ERROR: ANTHROPIC_API_KEY not set", file=sys.stderr)
        sys.exit(1)

    run_eval(db_path, args.model, optimized_path)


if __name__ == "__main__":
    main()
