from __future__ import annotations

import json
import os
import re
from datetime import datetime
from typing import Any

import railtracks as rt
from pydantic import BaseModel, Field

MAX_INSIGHTS = 12
MAX_TRANSCRIPT_SEGMENTS = 24
MAX_ACTION_ITEMS = 18
REQUIRED_SECTION_HEADINGS = [
    "## Final Overview",
    "## What Was Shown",
    "## What Was Said",
    "## Decisions And Commitments",
    "## Action Items",
    "## Open Questions",
]


class MeetingInsight(BaseModel):
    timestamp: int | None = None
    screenType: str | None = None
    summary: str | None = None
    keyPoints: list[str] = Field(default_factory=list)
    actionItems: list[str] = Field(default_factory=list)
    factCheckFlags: list[str] = Field(default_factory=list)
    suggestedQuestions: list[str] = Field(default_factory=list)
    sceneSignature: str | None = None


class MeetingTranscriptSegment(BaseModel):
    timestamp: int | None = None
    text: str | None = None


class MeetingSummaryRequest(BaseModel):
    insights: list[MeetingInsight] = Field(default_factory=list)
    actionItems: list[str] = Field(default_factory=list)
    transcriptSegments: list[MeetingTranscriptSegment] = Field(default_factory=list)
    duration: int | None = Field(default=None, ge=1)


class MeetingSummaryResponse(BaseModel):
    summary: str


class SummaryContext(BaseModel):
    duration_label: str
    shown_timeline: str
    transcript_timeline: str
    commitments_text: str
    visible_actions_text: str
    notable_questions_text: str


class SummaryReview(BaseModel):
    passes: bool
    feedback: str = ""
    revised_summary: str = ""


def _clean_text(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    return ""


def _clean_items(values: Any, *, limit: int | None = None) -> list[str]:
    if not isinstance(values, list):
        return []

    results: list[str] = []
    seen: set[str] = set()
    for value in values:
        if not isinstance(value, str):
            continue
        clean = value.strip()
        if not clean:
            continue
        key = clean.lower()
        if key in seen:
            continue
        seen.add(key)
        results.append(clean)
        if limit is not None and len(results) >= limit:
            break
    return results


def _normalize_summary_key(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9\s]", " ", text.lower())).strip()


def _format_timestamp(timestamp_ms: int | None) -> str:
    if not isinstance(timestamp_ms, int) or timestamp_ms <= 0:
        return "Unknown time"
    return datetime.fromtimestamp(timestamp_ms / 1000).strftime("%H:%M:%S")


def _create_summary_llm():
    provider = (
        os.getenv("RAILTRACKS_LLM_PROVIDER")
        or os.getenv("LLM_PROVIDER")
        or ""
    ).strip().lower()

    if provider == "anthropic" or (
        not provider and os.getenv("ANTHROPIC_API_KEY") and not os.getenv("OPENAI_API_KEY")
    ):
        api_key = os.getenv("ANTHROPIC_API_KEY")
        if not api_key:
            raise RuntimeError("ANTHROPIC_API_KEY is required for Railtracks summaries.")
        model_name = (
            os.getenv("RAILTRACKS_ANTHROPIC_MODEL")
            or os.getenv("ANTHROPIC_MODEL")
            or "claude-sonnet-4-6"
        )
        return rt.llm.AnthropicLLM(model_name=model_name, api_key=api_key)

    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is required for Railtracks summaries.")

    model_name = (
        os.getenv("RAILTRACKS_OPENAI_MODEL")
        or os.getenv("OPENAI_MODEL")
        or "gpt-4o"
    )
    return rt.llm.OpenAILLM(model_name=model_name, api_key=api_key, temperature=0)


def _parse_first_json_object(text: str) -> str | None:
    trimmed = text.strip()
    if not trimmed:
        return None
    if (trimmed.startswith("{") and trimmed.endswith("}")) or (
        trimmed.startswith("[") and trimmed.endswith("]")
    ):
        return trimmed

    start = min(
        [index for index in (trimmed.find("{"), trimmed.find("[")) if index >= 0],
        default=-1,
    )
    if start < 0:
        return None

    opens = {"{": "}", "[": "]"}
    stack: list[str] = []
    for index in range(start, len(trimmed)):
        char = trimmed[index]
        if char in opens:
            stack.append(opens[char])
        elif stack and char == stack[-1]:
            stack.pop()
            if not stack:
                return trimmed[start : index + 1]

    return None


def _parse_review(raw_text: str, fallback_summary: str) -> SummaryReview:
    parsed = _parse_first_json_object(raw_text)
    if not parsed:
        return SummaryReview(passes=True, revised_summary=fallback_summary)

    try:
        payload = json.loads(parsed)
    except json.JSONDecodeError:
        return SummaryReview(passes=True, revised_summary=fallback_summary)

    if not isinstance(payload, dict):
        return SummaryReview(passes=True, revised_summary=fallback_summary)

    revised_summary = _clean_text(payload.get("revised_summary")) or fallback_summary
    return SummaryReview(
        passes=bool(payload.get("passes")),
        feedback=_clean_text(payload.get("feedback")),
        revised_summary=revised_summary,
    )


def _missing_required_sections(summary: str) -> list[str]:
    return [heading for heading in REQUIRED_SECTION_HEADINGS if heading not in summary]


@rt.function_node
async def build_summary_context(
    insights: list[MeetingInsight],
    transcript_segments: list[MeetingTranscriptSegment],
    action_items: list[str],
    duration: int | None = None,
) -> SummaryContext:
    unique_insights: list[MeetingInsight] = []
    seen_keys: set[str] = set()

    for insight in insights:
        key = _normalize_summary_key(_clean_text(insight.summary))
        if key and key in seen_keys:
            continue
        if key:
            seen_keys.add(key)
        unique_insights.append(insight)

    selected_insights = unique_insights[-MAX_INSIGHTS:]
    selected_transcript_segments = [
        segment
        for segment in transcript_segments[-MAX_TRANSCRIPT_SEGMENTS:]
        if _clean_text(segment.text)
    ]

    shown_lines: list[str] = []
    visible_actions: list[str] = []
    notable_questions: list[str] = []

    for insight in selected_insights:
        summary = _clean_text(insight.summary) or "No visual summary captured."
        key_points = _clean_items(insight.keyPoints, limit=4)
        shown_lines.append(
            f"[{_format_timestamp(insight.timestamp)}] ({_clean_text(insight.screenType) or 'other'}) "
            f"{summary}\n"
            f"Key points: {', '.join(key_points) or 'None'}"
        )
        visible_actions.extend(_clean_items(insight.actionItems, limit=4))
        notable_questions.extend(_clean_items(insight.suggestedQuestions, limit=3))

    transcript_lines = [
        f"[{_format_timestamp(segment.timestamp)}] {_clean_text(segment.text)}"
        for segment in selected_transcript_segments
    ]

    commitments = _clean_items(action_items, limit=MAX_ACTION_ITEMS)

    return SummaryContext(
        duration_label=f"{duration} minutes" if duration else "unknown duration",
        shown_timeline="\n\n".join(shown_lines) or "No screen activity captured.",
        transcript_timeline="\n".join(transcript_lines) or "No transcript captured.",
        commitments_text="\n".join(f"- {item}" for item in commitments)
        or "- No explicit commitments captured.",
        visible_actions_text="\n".join(f"- {item}" for item in _clean_items(visible_actions, limit=12))
        or "- No visible action items captured on screen.",
        notable_questions_text="\n".join(
            f"- {item}" for item in _clean_items(notable_questions, limit=10)
        )
        or "- No unresolved questions were surfaced in the on-screen analysis.",
    )


@rt.function_node
async def draft_final_summary(context: SummaryContext) -> str:
    writer = rt.agent_node(
        "Meeting Summary Writer",
        llm=_create_summary_llm(),
        system_message=(
            "You write concise but high-signal final meeting summaries. "
            "Always combine what was shown on screen, what was said, and what was decided or done. "
            "Return markdown only. Use exactly these section headings:\n"
            "## Final Overview\n"
            "## What Was Shown\n"
            "## What Was Said\n"
            "## Decisions And Commitments\n"
            "## Action Items\n"
            "## Open Questions\n"
            "Do not invent owners, deadlines, or facts. If something is implied, use cautious wording."
        ),
    )
    prompt = f"""Write the final summary for a completed meeting lasting {context.duration_label}.

Visible timeline:
{context.shown_timeline}

Transcript timeline:
{context.transcript_timeline}

Commitments and extracted action items:
{context.commitments_text}

Visible action items from on-screen analysis:
{context.visible_actions_text}

Outstanding or suggested questions:
{context.notable_questions_text}

Make the result feel like one coherent closing recap, not disconnected notes."""

    result = await rt.call(writer, prompt)
    return result.text.strip()


@rt.function_node
async def review_final_summary(
    context: SummaryContext,
    draft_summary: str,
) -> SummaryReview:
    reviewer = rt.agent_node(
        "Meeting Summary Reviewer",
        llm=_create_summary_llm(),
        system_message=(
            "You review final meeting summaries for completeness and accuracy. "
            "Check whether the summary clearly covers what was shown, what was said, "
            "and what was decided or done. "
            "Return valid JSON only with keys passes, feedback, revised_summary. "
            "revised_summary must always contain the full final markdown summary."
        ),
    )
    missing_sections = _missing_required_sections(draft_summary)
    prompt = f"""Review this meeting summary draft.

Context to cover:
Visible timeline:
{context.shown_timeline}

Transcript timeline:
{context.transcript_timeline}

Commitments:
{context.commitments_text}

Visible action items:
{context.visible_actions_text}

Outstanding or suggested questions:
{context.notable_questions_text}

Draft summary:
{draft_summary}

Missing required headings detected programmatically:
{', '.join(missing_sections) if missing_sections else 'None'}

Return JSON:
{{
  "passes": true or false,
  "feedback": "short explanation",
  "revised_summary": "full markdown summary using the exact required section headings"
}}

Set passes to false if the draft misses important spoken content, visible work, decisions, or required sections."""

    result = await rt.call(reviewer, prompt)
    return _parse_review(result.text.strip(), draft_summary)


@rt.function_node
async def create_final_meeting_summary(
    insights: list[MeetingInsight],
    action_items: list[str],
    transcript_segments: list[MeetingTranscriptSegment],
    duration: int | None = None,
) -> str:
    context = await rt.call(
        build_summary_context,
        insights=insights,
        transcript_segments=transcript_segments,
        action_items=action_items,
        duration=duration,
    )
    draft_summary = await rt.call(draft_final_summary, context=context)
    review = await rt.call(
        review_final_summary,
        context=context,
        draft_summary=draft_summary,
    )

    candidate = (review.revised_summary or draft_summary).strip()
    if _missing_required_sections(candidate):
        return draft_summary.strip()
    return candidate


MEETING_SUMMARY_FLOW = rt.Flow(
    name="Meeting Summary Flow",
    entry_point=create_final_meeting_summary,
)
