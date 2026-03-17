# GEPA v2.0 — Prompt Engineering Guide

What changed in GEPA v2.0 and why, grounded in [Anthropic's Claude Prompting Best Practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) (2026-03).

---

## 1. Mutation Prompts Now Include Motivation

**What changed:** Every mutation strategy now has a `motivation` field explaining *why* the strategy matters, injected into the prompt sent to the mutation model.

**Best practice:** "Providing context or motivation behind your instructions helps Claude better understand your goals and deliver more targeted responses."

**Before:**
```
OPTIMIZATION STRATEGY: rephrase
Rephrase instructions for clarity without changing meaning.
```

**After:**
```
OPTIMIZATION STRATEGY: rephrase
Rephrase instructions for clarity without changing meaning.

WHY THIS MATTERS:
Claude responds best to clear, explicit instructions. Vague phrasing causes
the model to infer intent, leading to inconsistent behavior across sessions.
```

**Impact:** The mutation model now understands the *goal* behind each strategy, not just the action. It can generalize — e.g., when rephrasing, it also fixes ambiguous pronouns and implicit assumptions, not just surface-level rewording.

---

## 2. Few-Shot Examples in Every Strategy

**What changed:** Each strategy includes a before/after/why example wrapped in `<example>` tags.

**Best practice:** "Examples are one of the most reliable ways to steer Claude's output format, tone, and structure. A few well-crafted examples can dramatically improve accuracy and consistency."

**Before:** Zero examples — the mutation model had to infer what a "good mutation" looks like from the strategy description alone.

**After:** Each strategy has a concrete example:
```xml
<example>
  Before: NEVER use ellipses
  After: Your response will be read aloud by a TTS engine, so never
         use ellipses since TTS cannot pronounce them.
  Why better: Adds motivation so Claude generalizes correctly.
</example>
```

**Impact:** Mutations are now grounded in concrete patterns rather than abstract descriptions. The model mimics the demonstrated quality level instead of guessing.

---

## 3. XML Structure in Mutation and Judge Prompts

**What changed:** Both the mutation prompt and the LLM judge prompt now use XML tags to separate instructions, context, examples, and requirements.

**Best practice:** "XML tags help Claude parse complex prompts unambiguously, especially when your prompt mixes instructions, context, examples, and variable inputs."

**Mutation prompt structure:**
```xml
<current_prompt>...</current_prompt>
<strategy>...<example>...</example></strategy>
<context>...feedback...insights...</context>
<requirements>...</requirements>
```

**Judge prompt structure:**
```xml
<task_given>...</task_given>
<ai_output>...</ai_output>
<criteria><criterion name="...">...</criterion></criteria>
<grounding_rules>...</grounding_rules>
```

**Impact:** Eliminates ambiguity about which text is the prompt-to-mutate vs. the mutation instructions vs. the eval feedback. Previously these were separated only by markdown headers, which Claude can conflate with prompt content.

---

## 4. Role Definition in Mutation Prompt

**What changed:** The mutation prompt now opens with: "You are an expert prompt engineer optimizing a CLAUDE.md system prompt for an AI coding agent (Claude Opus 4.6)."

**Best practice:** "Setting a role in the system prompt focuses Claude's behavior and tone for your use case. Even a single sentence makes a difference."

**Before:** No role — the mutation model treated the task as generic text editing.

**After:** Role primes the model for prompt engineering specifically, activating knowledge about instruction design, token budgets, and model behavior patterns.

---

## 5. Self-Review Step (Generate → Review → Refine)

**What changed:** After generating a mutation, a second Claude call reviews the draft against 7 criteria before it goes to evaluation.

**Best practice:** "The most common chaining pattern is self-correction: generate a draft → have Claude review it against criteria → have Claude refine based on the review."

**Review criteria:**
1. Preservation — critical instructions still present?
2. Coherence — more internally consistent, not less?
3. Specificity — new instructions actionable, not vague?
4. Token budget — under ~8000 tokens?
5. No drift — stayed within strategy scope?
6. No conflicts — new instructions contradict existing ones?
7. No overengineering — mutation didn't add unnecessary prompt complexity?

**Impact:** Catches destructive mutations (dropped rules, conflicting instructions, scope creep) before they consume eval budget. Each eval runs `claude --print` in a temp directory — expensive. Self-review is a single cheap call that gates access to the expensive step.

---

## 6. Grounding in the LLM Judge

**What changed:** The judge prompt now requires quoting specific output lines before ruling on each criterion.

**Best practice:** "For long document tasks, ask Claude to quote relevant parts of the documents first before carrying out its task. This helps Claude cut through the noise."

**Before:**
```
For each criterion, determine if the output genuinely satisfies it.
```

**After:**
```xml
<grounding_rules>
Before judging each criterion, quote the specific line(s) from the AI
output that satisfy or fail it. If you cannot find a relevant quote,
the criterion fails.
</grounding_rules>
```

**Impact:** Forces evidence-based evaluation. Without grounding, the judge can "feel" that a function exists without verifying it. With grounding, no quote = automatic fail. This directly reduces false-positive pass rates.

---

## 7. Calibrate Tool Usage Strategy

**What changed:** New `calibrate_tool_usage` strategy that dials back aggressive tool-triggering language.

**Best practice:** "If your prompts were designed to reduce undertriggering on tools or skills, these models may now overtrigger. The fix is to dial back any aggressive language."

**Target pattern:**
```
CRITICAL: You MUST always use the Bash tool to run tests. NEVER skip this step.
→
Use the Bash tool to run tests when you've made code changes that could affect behavior.
```

**Impact:** Opus 4.6 is significantly more proactive than previous models. Prompts optimized for 3.5/Sonnet that said "ALWAYS" and "MUST" now cause overtriggering — running tests on doc-only changes, spawning subagents for simple greps. This strategy specifically targets that regression.

---

## 8. Anti-Overengineering Strategy

**What changed:** New `reduce_overengineering` strategy and `no_overengineering` eval criterion.

**Best practice:** "Claude Opus 4.5 and Claude Opus 4.6 have a tendency to overengineer by creating extra files, adding unnecessary abstractions, or building in flexibility that wasn't requested."

**The recommended prompt pattern (from Anthropic):**
```xml
<avoid_overengineering>
Only make changes directly requested or clearly necessary. Don't add features,
refactor surrounding code, or create abstractions for one-time operations.
Three similar lines of code is better than a premature abstraction.
</avoid_overengineering>
```

**Impact:** Both the mutation strategy (adds these constraints to prompts) and the eval criterion (detects when outputs overengineer) work together. The regex fallback judge flags `Factory` patterns and excessive file creation as heuristic failures.

---

## 9. Anti-Hallucination Eval Criterion

**What changed:** New `no_hallucination` criterion in both LLM and regex judges.

**Best practice:** "Never speculate about code you have not opened... give grounded and hallucination-free answers."

**LLM judge guidance:**
```
"no_hallucination" — all claims about code are grounded in actual output;
no references to files/functions that don't exist
```

**Impact:** Prompts that reduce hallucination rate score higher in evals. This creates evolutionary pressure toward prompts that include instructions like "read before answering" and "never speculate about unread code."

---

## 10. Positive Framing in Constraints Strategy

**What changed:** The `add_constraints` strategy now explicitly says: "Frame as 'do X instead of Y' rather than just 'don't do Y'."

**Best practice:** "Tell Claude what to do instead of what not to do."

**Before:** Strategy only said "Be precise about what NOT to do."

**After:** Strategy guides toward positive alternatives:
```
Instead of: "Do not use markdown in your response"
Try: "Your response should be composed of smoothly flowing prose paragraphs."
```

**Impact:** Mutations now produce constraints with clear action paths. A bare "don't" leaves Claude guessing; "do X instead" gives it a target.

---

## Summary: GEPA v1 → v2 Delta

| Dimension | v1 | v2 | Best Practice Source |
|---|---|---|---|
| Strategies | 6 foundational | 14 (6 + 6 best-practice + 2 agent) | Multiple sections |
| Mutation prompt | Bare instructions | Role + motivation + examples + XML | Sections 1-4 |
| Self-review | None | 7-criteria review before eval | "Self-correction chaining" |
| Judge grounding | Trust-based | Quote-before-judge | "Ground responses in quotes" |
| Tool calibration | Not addressed | Dedicated strategy | "Tune anti-laziness prompting" |
| Overengineering | Not addressed | Strategy + eval criterion | "Overeagerness" section |
| Hallucination | Not addressed | Eval criterion | "Minimizing hallucinations" |
| Model refs | Sonnet 4 (May 2025) | Sonnet 4.6 / configurable | Migration section |
| Scoring | 4 dimensions | 6 dimensions | Expanded criteria |

The core insight: GEPA v1 treated prompt mutation as text transformation. v2 treats it as **prompt engineering** — applying the same principles Anthropic recommends for human prompt authors to the automated mutation loop.
