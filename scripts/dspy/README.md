# DSPy Prompt Optimization

Offline prompt optimization for any repo with LLM calls.

## How It Works

```
Your app runs → logs LLM calls (input, output, score) → DSPy optimizes → better prompts → repeat
```

DSPy does NOT run in your app's runtime. It runs offline, reads your logs, and exports optimized prompts that you paste back into your code.

## Adding to a New Repo

### Step 1: Instrument your LLM calls

Log every LLM call with:
```json
{
  "id": "uuid",
  "timestamp": "ISO",
  "prompt_name": "query_router",     // which prompt template
  "input": { ... },                   // what went in
  "output": { ... },                  // what came out
  "score": 0.85,                      // quality signal (0-1)
  "latency_ms": 340,
  "tokens_used": 1200
}
```

Store in any DB (SQLite, Postgres, JSON files).

### Step 2: Define DSPy Signatures

Map each LLM call to a signature:

```python
# signatures.py
import dspy

class YourPrompt(dspy.Signature):
    """One-line description of what this LLM call does."""
    user_input: str = dspy.InputField(desc="what the user asked")
    context: str = dspy.InputField(desc="retrieved context")
    response: str = dspy.OutputField(desc="the answer")
    confidence: float = dspy.OutputField(desc="0-1 confidence")
```

### Step 3: Write a data loader

```python
# data.py
def load_examples(db_path, min_score=0.7):
    """Load high-quality examples from your logs."""
    rows = db.query("SELECT * FROM llm_logs WHERE score >= ?", min_score)
    return [dspy.Example(**row).with_inputs("user_input", "context") for row in rows]
```

### Step 4: Define a metric

```python
# optimize.py
def my_metric(prediction, example, trace=None):
    """How good is this prediction? Return 0-1."""
    score = 0.0
    if prediction.response and len(prediction.response) > 10:
        score += 0.5  # non-empty response
    if some_quality_check(prediction.response, example):
        score += 0.5  # domain-specific quality
    return score
```

### Step 5: Run

```bash
./scripts/dspy/setup.sh
source scripts/dspy/.venv/bin/activate
python scripts/dspy/optimize.py
# → outputs optimized_state.json
# → paste improved prompt back into your code
```

## File Structure

```
scripts/dspy/
├── setup.sh              # Create venv, install deps
├── requirements.txt      # dspy + provider SDK
├── signatures.py         # DSPy I/O contracts (per-repo)
├── data.py               # Load training data from your DB (per-repo)
├── optimize.py           # Run optimization + export
├── eval.py               # CI regression detection
├── loop.sh               # Cron wrapper with threshold gating
├── optimized_state.json  # Output (gitignored)
└── .last_run             # Tracks audit row count (gitignored)
```

## Per-Repo Examples

### ProvenantAI (Node/Express/Postgres)

```python
# signatures.py
class QueryRoute(dspy.Signature):
    """Route a natural language query to data sources and generate a response."""
    prompt: str = dspy.InputField()
    org_context: str = dspy.InputField()
    response: str = dspy.OutputField()
    sources_used: str = dspy.OutputField()

class LeadScore(dspy.Signature):
    """Score a sales lead 0-100 based on signals."""
    name: str = dspy.InputField()
    title: str = dspy.InputField()
    company: str = dspy.InputField()
    signals: str = dspy.InputField(desc="visit count, page views, engagement")
    score: int = dspy.OutputField(desc="0-100 lead score")
    reasoning: str = dspy.OutputField()

class BriefingGeneration(dspy.Signature):
    """Generate a daily executive briefing from org data."""
    kpis: str = dspy.InputField()
    alerts: str = dspy.InputField()
    recent_activity: str = dspy.InputField()
    briefing: str = dspy.OutputField()

# data.py
def load_from_postgres():
    conn = psycopg2.connect(DATABASE_URL)
    rows = conn.execute("""
        SELECT prompt, response, feedback_score
        FROM query_logs
        WHERE feedback_score IS NOT NULL
        ORDER BY created_at DESC LIMIT 200
    """).fetchall()
    return [dspy.Example(...) for row in rows]
```

### Generic RAG App

```python
class RAGAnswer(dspy.Signature):
    """Answer a question using retrieved documents."""
    question: str = dspy.InputField()
    documents: str = dspy.InputField()
    answer: str = dspy.OutputField()
    citations: str = dspy.OutputField()

# Metric: answer contains info from documents + is factual
def rag_metric(pred, ex, trace=None):
    has_citation = any(doc_id in pred.citations for doc_id in ex.doc_ids)
    is_relevant = pred.answer and len(pred.answer) > 20
    return 0.5 * has_citation + 0.5 * is_relevant
```

## Cron Installation

```bash
# Add to crontab (every 4h, skips if not enough new data)
(crontab -l; echo "23 */4 * * * /path/to/repo/scripts/dspy/loop.sh") | crontab -
```

## Cost

| Model | Per Run | Daily (6x) | Monthly |
|-------|---------|------------|---------|
| Haiku | ~$0.05 | ~$0.30 | ~$9 |
| Sonnet | ~$0.50 | ~$3.00 | ~$90 |

Use Haiku for routine optimization, Sonnet for periodic deep optimization.
