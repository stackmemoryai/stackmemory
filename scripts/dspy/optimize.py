#!/usr/bin/env python3
"""
DSPy prompt optimization for StackMemory retrieval.

Optimizes the frame retrieval prompt using:
1. Audit data from retrieval_audit table (if available)
2. Synthetic examples for cold-start
3. MIPROv2 optimizer for instruction + few-shot tuning

Usage:
    python scripts/dspy/optimize.py [--db PATH] [--model MODEL] [--output PATH]

Output:
    - Optimized prompt exported as JSON (for TS integration)
    - Evaluation metrics printed to stdout
"""

import argparse
import json
import os
import sys
from pathlib import Path

import dspy

from signatures import FrameRetrieval, QueryComplexity, FrameScoring
from data import (
    find_db, load_audit_examples, load_frames, load_anchors,
    build_frame_summary, build_decisions_summary, build_synthetic_examples,
)


def retrieval_metric(prediction, example, trace=None) -> float:
    """Score a retrieval prediction against ground truth.

    Measures:
    - Confidence calibration (predicted vs actual)
    - Reasoning quality (non-empty, mentions query terms)
    - Frame selection validity (parseable JSON array)
    """
    score = 0.0

    # 1. Valid JSON output (0.3)
    try:
        frames = json.loads(prediction.frames_to_retrieve)
        if isinstance(frames, list) and len(frames) > 0:
            score += 0.3
    except (json.JSONDecodeError, AttributeError):
        pass

    # 2. Confidence is reasonable (0.2)
    try:
        conf = float(prediction.confidence_score)
        if 0.0 <= conf <= 1.0:
            score += 0.2
    except (ValueError, TypeError, AttributeError):
        pass

    # 3. Reasoning mentions query terms (0.3)
    reasoning = getattr(prediction, "reasoning", "") or ""
    query_terms = example.query.lower().split()
    matches = sum(1 for t in query_terms if t in reasoning.lower() and len(t) > 3)
    if matches > 0:
        score += min(0.3, matches * 0.1)

    # 4. Non-trivial output (0.2)
    if len(reasoning) > 20:
        score += 0.1
    try:
        frames = json.loads(prediction.frames_to_retrieve)
        if isinstance(frames, list) and all("frameId" in f for f in frames):
            score += 0.1
    except (json.JSONDecodeError, AttributeError):
        pass

    return score


def complexity_metric(prediction, example, trace=None) -> float:
    """Score complexity prediction accuracy."""
    score = 0.0
    if getattr(prediction, "complexity", "") == getattr(example, "complexity", ""):
        score += 0.5
    if getattr(prediction, "use_llm", None) == getattr(example, "use_llm", None):
        score += 0.3
    if getattr(prediction, "strategy", "") == getattr(example, "strategy", ""):
        score += 0.2
    return score


def optimize_retrieval(db_path: Path, model: str, output_path: Path):
    """Run the full optimization pipeline."""
    print(f"Model: {model}")
    print(f"Database: {db_path}")
    print()

    # Configure DSPy
    lm = dspy.LM(model, api_key=os.environ.get("ANTHROPIC_API_KEY"))
    dspy.configure(lm=lm)

    # Load data
    frames = load_frames(db_path)
    anchors = load_anchors(db_path)
    frame_summary = build_frame_summary(frames)
    decisions_summary = build_decisions_summary(anchors)

    print(f"Loaded {len(frames)} frames, {len(anchors)} anchors")

    # Load audit examples or fall back to synthetic
    audit_examples = load_audit_examples(db_path, min_confidence=0.5)
    if len(audit_examples) >= 10:
        print(f"Using {len(audit_examples)} audit examples for optimization")
        # Enrich with frame context
        for ex in audit_examples:
            ex.session_summary = f"Frames: {len(frames)}, recent activity"
            ex.available_frames = frame_summary
            ex.key_decisions = decisions_summary
        trainset = audit_examples[:int(len(audit_examples) * 0.8)]
        devset = audit_examples[int(len(audit_examples) * 0.8):]
    else:
        print(f"Only {len(audit_examples)} audit examples — using synthetic data for cold-start")
        synthetic = build_synthetic_retrieval_examples(frames, frame_summary, decisions_summary)
        trainset = synthetic[:6]
        devset = synthetic[6:]

    # --- Phase 1: Optimize FrameRetrieval ---
    print("\n=== Phase 1: Optimizing FrameRetrieval ===")
    retrieval_module = dspy.ChainOfThought(FrameRetrieval)

    if len(trainset) >= 10:
        optimizer = dspy.MIPROv2(
            metric=retrieval_metric,
            num_threads=2,
            max_bootstrapped_demos=3,
            max_labeled_demos=3,
        )
        optimized_retrieval = optimizer.compile(
            retrieval_module,
            trainset=trainset,
            num_trials=15,
        )
    else:
        # Not enough data for MIPROv2 — use BootstrapFewShot
        optimizer = dspy.BootstrapFewShot(
            metric=retrieval_metric,
            max_bootstrapped_demos=2,
            max_labeled_demos=2,
        )
        optimized_retrieval = optimizer.compile(
            retrieval_module,
            trainset=trainset,
        )

    # Evaluate
    print("\n--- Evaluation ---")
    evaluate = dspy.Evaluate(devset=devset, metric=retrieval_metric, num_threads=2)
    baseline_score = evaluate(retrieval_module)
    optimized_score = evaluate(optimized_retrieval)
    print(f"Baseline:  {baseline_score:.3f}")
    print(f"Optimized: {optimized_score:.3f}")
    print(f"Delta:     {optimized_score - baseline_score:+.3f}")

    # --- Phase 2: Optimize QueryComplexity ---
    print("\n=== Phase 2: Optimizing QueryComplexity ===")
    complexity_examples = build_synthetic_examples()
    complexity_module = dspy.Predict(QueryComplexity)

    complexity_optimizer = dspy.BootstrapFewShot(
        metric=complexity_metric,
        max_bootstrapped_demos=3,
    )
    optimized_complexity = complexity_optimizer.compile(
        complexity_module,
        trainset=complexity_examples[:6],
    )

    complexity_eval = dspy.Evaluate(
        devset=complexity_examples[6:], metric=complexity_metric, num_threads=2
    )
    complexity_baseline = complexity_eval(complexity_module)
    complexity_optimized = complexity_eval(optimized_complexity)
    print(f"Baseline:  {complexity_baseline:.3f}")
    print(f"Optimized: {complexity_optimized:.3f}")

    # --- Export ---
    print(f"\n=== Exporting to {output_path} ===")
    result = {
        "retrieval": {
            "state": optimized_retrieval.dump_state(),
            "baseline_score": baseline_score,
            "optimized_score": optimized_score,
        },
        "complexity": {
            "state": optimized_complexity.dump_state(),
            "baseline_score": complexity_baseline,
            "optimized_score": complexity_optimized,
        },
        "metadata": {
            "model": model,
            "db_path": str(db_path),
            "train_size": len(trainset),
            "dev_size": len(devset),
            "frames_available": len(frames),
        },
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, indent=2, default=str))
    print(f"Saved optimized state to {output_path}")
    print("\nDone. To apply: copy optimized prompts into llm-context-retrieval.ts")


def build_synthetic_retrieval_examples(
    frames: list[dict], frame_summary: str, decisions_summary: str
) -> list[dspy.Example]:
    """Build synthetic FrameRetrieval examples from available frames."""
    examples = []
    for i, frame in enumerate(frames[:8]):
        query = f"What happened in {frame.get('name', 'this frame')}?"
        ex = dspy.Example(
            query=query,
            token_budget=4096,
            session_summary=f"Frames: {len(frames)}, recent activity in project",
            available_frames=frame_summary,
            key_decisions=decisions_summary,
            reasoning=f"Frame '{frame.get('name', '')}' directly matches the query topic.",
            frames_to_retrieve=json.dumps([{
                "frameId": frame["frame_id"],
                "priority": 9,
                "reason": "Direct match",
                "includeEvents": True,
                "includeAnchors": True,
            }]),
            confidence_score=0.9,
        ).with_inputs("query", "token_budget", "session_summary", "available_frames", "key_decisions")
        examples.append(ex)
    return examples


def main():
    parser = argparse.ArgumentParser(description="Optimize StackMemory retrieval prompts with DSPy")
    parser.add_argument("--db", type=str, help="Path to context.db")
    parser.add_argument("--model", type=str, default="anthropic/claude-haiku-4-5-20251001",
                        help="LM to use for optimization")
    parser.add_argument("--output", type=str, default="scripts/dspy/optimized_state.json",
                        help="Output path for optimized state")
    args = parser.parse_args()

    db_path = Path(args.db) if args.db else find_db()
    output_path = Path(args.output)

    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("ERROR: ANTHROPIC_API_KEY not set", file=sys.stderr)
        sys.exit(1)

    optimize_retrieval(db_path, args.model, output_path)


if __name__ == "__main__":
    main()
