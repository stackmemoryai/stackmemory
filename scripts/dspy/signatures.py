"""
DSPy Signatures for StackMemory optimization.

These define the input/output contracts for each LLM call.
DSPy will optimize the prompts that implement these signatures.
"""

import dspy


class FrameRetrieval(dspy.Signature):
    """Select the most relevant context frames for a developer's query.

    Given a query about code, debugging, or project status, analyze the
    available frames and select those most likely to contain useful context.
    Prioritize recency, relevance to the query topic, and frame quality score.
    """

    query: str = dspy.InputField(desc="Developer's natural language query")
    token_budget: int = dspy.InputField(desc="Maximum tokens available for context")
    session_summary: str = dspy.InputField(
        desc="Compressed summary: frame list, operations, errors, files touched"
    )
    available_frames: str = dspy.InputField(
        desc="Frame IDs with name, type, score, event count"
    )
    key_decisions: str = dspy.InputField(
        desc="Recent key decisions from project history"
    )

    reasoning: str = dspy.OutputField(desc="Why these frames are relevant to the query")
    frames_to_retrieve: str = dspy.OutputField(
        desc='JSON array: [{"frameId": "...", "priority": 1-10, "reason": "...", "includeEvents": bool, "includeAnchors": bool}]'
    )
    confidence_score: float = dspy.OutputField(desc="0.0-1.0 confidence in selection")


class QueryComplexity(dspy.Signature):
    """Assess query complexity to decide retrieval strategy.

    Simple queries (single file lookup, recent status) use heuristic retrieval.
    Complex queries (cross-cutting concerns, debugging, architecture) use LLM analysis.
    This saves tokens by skipping LLM when heuristics suffice.
    """

    query: str = dspy.InputField(desc="Developer's query")
    frame_count: int = dspy.InputField(desc="Number of available frames")
    has_time_constraint: bool = dspy.InputField(desc="Whether query has time filters")
    has_file_constraint: bool = dspy.InputField(desc="Whether query mentions specific files")

    complexity: str = dspy.OutputField(desc="simple, moderate, or complex")
    use_llm: bool = dspy.OutputField(desc="Whether LLM analysis would improve results")
    strategy: str = dspy.OutputField(desc="keyword, recent, semantic, or hybrid")


class FrameScoring(dspy.Signature):
    """Score a frame's relevance to a query on a 1-10 scale.

    Consider: topic match, recency, frame type alignment with query intent,
    event density, and whether the frame contains decisions or errors
    relevant to the query.
    """

    query: str = dspy.InputField(desc="Developer's query")
    frame_name: str = dspy.InputField(desc="Frame name/title")
    frame_type: str = dspy.InputField(desc="Frame type (e.g., feature, bugfix, refactor)")
    frame_age_hours: float = dspy.InputField(desc="Hours since frame was last updated")
    event_count: int = dspy.InputField(desc="Number of events in the frame")
    has_errors: bool = dspy.InputField(desc="Whether frame contains error events")
    has_decisions: bool = dspy.InputField(desc="Whether frame contains decision anchors")

    score: int = dspy.OutputField(desc="1-10 relevance score")
    reason: str = dspy.OutputField(desc="Brief explanation for the score")


class ContextCompression(dspy.Signature):
    """Compress a context frame while preserving key information for retrieval.

    The compressed output should retain: key decisions, error patterns,
    file paths, and actionable insights. Drop: verbose logs, redundant
    timestamps, and boilerplate.
    """

    frame_content: str = dspy.InputField(desc="Raw frame content with events and anchors")
    query_context: str = dspy.InputField(desc="What the developer is looking for")
    max_tokens: int = dspy.InputField(desc="Target compressed size in tokens")

    compressed: str = dspy.OutputField(desc="Compressed frame preserving key information")
    tokens_saved: int = dspy.OutputField(desc="Estimated tokens saved by compression")
