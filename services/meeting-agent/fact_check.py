from __future__ import annotations

import json
import os
from typing import Any, Literal

import railtracks as rt
from openai import AsyncOpenAI
from pydantic import BaseModel, Field
from runtime_memory import load_lessons, remember_lessons

FactCheckVerdict = Literal[
    "supported",
    "contradicted",
    "mixed",
    "insufficient_evidence",
]
FactCheckMode = Literal["interactive", "background"]
FactCheckStatementSource = Literal["voice", "visual"]


class FactCheckSource(BaseModel):
    title: str
    url: str
    snippet: str = ""


class FactCheckResult(BaseModel):
    claim: str
    source: FactCheckStatementSource = "visual"
    verdict: FactCheckVerdict
    confidence: float
    summary: str
    sources: list[FactCheckSource] = Field(default_factory=list)


class FactCheckStatement(BaseModel):
    claim: str
    source: FactCheckStatementSource
    priority: int | None = None


class FactCheckResponse(BaseModel):
    claims: list[str] = Field(default_factory=list)
    statements: list[FactCheckStatement] = Field(default_factory=list)
    results: list[FactCheckResult] = Field(default_factory=list)


class FactCheckRequest(BaseModel):
    frame: str = Field(min_length=1)
    meetingContext: str | None = None
    screenContext: str | None = None
    transcriptContext: str | None = None
    maxClaims: int | None = Field(default=None, ge=1, le=10)
    mode: FactCheckMode = "interactive"


class ClaimEvidence(BaseModel):
    claim: str
    summary: str = ""
    evidence_for: list[str] = Field(default_factory=list)
    evidence_against: list[str] = Field(default_factory=list)
    open_questions: list[str] = Field(default_factory=list)
    sources: list[FactCheckSource] = Field(default_factory=list)


class ValidationOutcome(BaseModel):
    passes: bool
    feedback: str = ""


class MemoryLessonsResponse(BaseModel):
    lessons: list[str] = Field(default_factory=list)


def _clean_text(value: Any, fallback: str = "") -> str:
    if isinstance(value, str):
        text = value.strip()
        if text:
            return text
    return fallback


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


def _parse_env_int(name: str, fallback: int) -> int:
    raw = os.getenv(name)
    if not raw:
        return fallback

    try:
        parsed = int(raw)
    except ValueError:
        return fallback

    return parsed if parsed > 0 else fallback


def _parse_env_bool(name: str, fallback: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return fallback
    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return fallback


def _claims_to_statements(
    claims: list[str],
    source: FactCheckStatementSource,
    *,
    limit: int,
) -> list[FactCheckStatement]:
    normalized = _clean_items(claims, limit=limit)
    return [
        FactCheckStatement(claim=claim, source=source, priority=index + 1)
        for index, claim in enumerate(normalized)
    ]


def _merge_statements(
    visual_statements: list[FactCheckStatement],
    voice_statements: list[FactCheckStatement],
    *,
    total_max_items: int,
    prefer_voice_first: bool = False,
) -> list[FactCheckStatement]:
    merged: list[FactCheckStatement] = []
    seen: set[str] = set()
    visual_index = 0
    voice_index = 0

    while len(merged) < total_max_items and (
        visual_index < len(visual_statements) or voice_index < len(voice_statements)
    ):
        batch: list[FactCheckStatement] = []
        if prefer_voice_first:
            if voice_index < len(voice_statements):
                batch.append(voice_statements[voice_index])
                voice_index += 1
            if visual_index < len(visual_statements):
                batch.append(visual_statements[visual_index])
                visual_index += 1
        else:
            if visual_index < len(visual_statements):
                batch.append(visual_statements[visual_index])
                visual_index += 1
            if voice_index < len(voice_statements):
                batch.append(voice_statements[voice_index])
                voice_index += 1

        for statement in batch:
            key = f"{statement.source}:{statement.claim.lower()}"
            if key in seen:
                continue
            seen.add(key)
            statement.priority = len(merged) + 1
            merged.append(statement)
            if len(merged) >= total_max_items:
                break

    return merged


def _parse_data_url_frame(frame: str) -> tuple[str, str]:
    prefix, separator, payload = frame.partition(",")
    if separator and prefix.startswith("data:") and ";base64" in prefix:
        mime_type = prefix[5:].split(";", 1)[0] or "image/jpeg"
        return payload, mime_type

    stripped = frame.replace("data:image/jpeg;base64,", "", 1)
    return stripped, "image/jpeg"


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


def _parse_lessons_response(text: str) -> list[str]:
    json_blob = _parse_first_json_object(text)
    if not json_blob:
        return []

    try:
        payload = json.loads(json_blob)
    except json.JSONDecodeError:
        return []

    if not isinstance(payload, dict):
        return []

    return _clean_items(payload.get("lessons"), limit=3)


def _read_response_output_text(response: Any) -> str:
    output_text = getattr(response, "output_text", None)
    if isinstance(output_text, str):
        return output_text.strip()

    parts: list[str] = []
    for item in getattr(response, "output", []) or []:
        for content in getattr(item, "content", []) or []:
            content_type = getattr(content, "type", "")
            if content_type == "output_text":
                text = getattr(content, "text", None)
                if isinstance(text, str) and text.strip():
                    parts.append(text.strip())
    return "\n".join(parts).strip()


def _normalize_sources(value: Any, *, limit: int = 6) -> list[FactCheckSource]:
    if not isinstance(value, list):
        return []

    results: list[FactCheckSource] = []
    seen_urls: set[str] = set()
    for item in value:
        if not isinstance(item, dict):
            continue

        url = _clean_text(item.get("url"))
        if not url or url in seen_urls:
            continue

        seen_urls.add(url)
        results.append(
            FactCheckSource(
                title=_clean_text(item.get("title"), "Source"),
                url=url,
                snippet=_clean_text(item.get("snippet")),
            )
        )
        if len(results) >= limit:
            break

    return results


def _normalize_verdict(value: Any) -> FactCheckVerdict:
    clean = _clean_text(value).lower()
    if clean in {
        "supported",
        "contradicted",
        "mixed",
        "insufficient_evidence",
    }:
        return clean
    return "insufficient_evidence"


def _clamp_confidence(value: Any, fallback: float = 0.5) -> float:
    if isinstance(value, (int, float)):
        return max(0.0, min(1.0, float(value)))
    return fallback


def _fallback_result(
    claim: str,
    *,
    source: FactCheckStatementSource = "visual",
    summary: str,
    confidence: float = 0.2,
    sources: list[FactCheckSource] | None = None,
) -> FactCheckResult:
    return FactCheckResult(
        claim=claim,
        source=source,
        verdict="insufficient_evidence",
        confidence=max(0.0, min(1.0, confidence)),
        summary=summary,
        sources=sources or [],
    )


def _format_evidence_for_prompt(evidence: ClaimEvidence) -> str:
    source_lines = [
        f"- {source.title} | {source.url} | {source.snippet}"
        for source in evidence.sources
    ]
    return (
        f"Evidence summary:\n{evidence.summary or 'None'}\n\n"
        f"Evidence supporting the claim:\n"
        f"{chr(10).join(f'- {item}' for item in evidence.evidence_for) or '- None'}\n\n"
        f"Evidence contradicting the claim:\n"
        f"{chr(10).join(f'- {item}' for item in evidence.evidence_against) or '- None'}\n\n"
        f"Open questions:\n"
        f"{chr(10).join(f'- {item}' for item in evidence.open_questions) or '- None'}\n\n"
        f"Sources:\n{chr(10).join(source_lines) or '- None'}"
    )


def _normalize_candidate_result(
    claim: str,
    source: FactCheckStatementSource,
    payload: dict[str, Any],
    *,
    evidence: ClaimEvidence,
) -> FactCheckResult:
    known_sources_by_url = {source.url: source for source in evidence.sources}
    candidate_sources = _normalize_sources(payload.get("sources"), limit=3)
    filtered_sources = [
        known_sources_by_url[source.url]
        for source in candidate_sources
        if source.url in known_sources_by_url
    ]

    verdict = _normalize_verdict(payload.get("verdict"))
    confidence = _clamp_confidence(
        payload.get("confidence"),
        fallback=0.35 if verdict == "insufficient_evidence" else 0.6,
    )
    summary = _clean_text(
        payload.get("summary"),
        evidence.summary or "The available evidence was inconclusive.",
    )

    if verdict != "insufficient_evidence" and not filtered_sources:
        filtered_sources = evidence.sources[: min(3, len(evidence.sources))]

    return FactCheckResult(
        claim=claim,
        source=source,
        verdict=verdict,
        confidence=confidence,
        summary=summary[:320],
        sources=filtered_sources,
    )


def _build_programmatic_feedback(
    candidate: FactCheckResult,
    evidence: ClaimEvidence,
) -> str | None:
    issues: list[str] = []

    if not candidate.summary.strip():
        issues.append("Add a concise summary grounded in the evidence.")
    if len(candidate.summary) > 320:
        issues.append("Keep the summary under 320 characters.")
    if candidate.verdict != "insufficient_evidence" and not candidate.sources:
        issues.append("Include at least one cited source for non-empty verdicts.")
    if candidate.verdict == "supported" and not evidence.evidence_for:
        issues.append("The evidence bundle does not contain clear support for a supported verdict.")
    if candidate.verdict == "contradicted" and not evidence.evidence_against:
        issues.append(
            "The evidence bundle does not contain clear contradictory evidence for a contradicted verdict."
        )
    if (
        candidate.verdict == "mixed"
        and not evidence.evidence_for
        and not evidence.evidence_against
    ):
        issues.append("A mixed verdict needs both tension and nuance in the evidence bundle.")

    return " ".join(issues) if issues else None


def _create_openai_client() -> AsyncOpenAI:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is required for Railtracks fact-checking.")
    return AsyncOpenAI(api_key=api_key)


def _create_factcheck_llm():
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is required for Railtracks fact-checking.")

    model_name = (
        os.getenv("RAILTRACKS_FACTCHECK_JUDGE_MODEL")
        or os.getenv("OPENAI_FACTCHECK_REASONING_MODEL")
        or os.getenv("RAILTRACKS_OPENAI_MODEL")
        or "gpt-5.4"
    )
    return rt.llm.OpenAILLM(model_name=model_name, api_key=api_key, temperature=0)


@rt.function_node
async def load_fact_check_improvement_lessons(limit: int = 6) -> list[str]:
    return load_lessons("fact_check", limit=limit)


@rt.function_node
async def remember_fact_check_improvement_lessons(lessons: list[str]) -> list[str]:
    return remember_lessons("fact_check", _clean_items(lessons, limit=6))


async def _create_openai_response_with_web_search(
    client: AsyncOpenAI,
    request: dict[str, Any],
) -> Any:
    last_error: Exception | None = None
    for tool_type in ("web_search_preview", "web_search"):
        try:
            return await client.responses.create(
                **request,
                tools=[{"type": tool_type}],
            )
        except Exception as error:  # pragma: no cover - depends on provider support
            last_error = error

    if last_error is not None:
        raise last_error
    raise RuntimeError("OpenAI web search call failed.")


@rt.function_node
async def extract_claims_from_frame(
    frame: str,
    screen_context: str | None = None,
    max_claims: int = 5,
) -> list[str]:
    client = _create_openai_client()
    base64, mime_type = _parse_data_url_frame(frame)
    data_url = f"data:{mime_type};base64,{base64}"
    model = os.getenv("OPENAI_FACTCHECK_IMAGE_MODEL") or "gpt-5.4"
    context_line = (
        f"Screen context:\n{screen_context.strip()}\n"
        if isinstance(screen_context, str) and screen_context.strip()
        else "Screen context is unavailable.\n"
    )

    response = await client.responses.create(
        model=model,
        input=[
            {
                "role": "system",
                "content": [
                    {
                        "type": "input_text",
                        "text": (
                            "You extract factual claims from meeting screenshots.\n"
                            "- Keep only checkable, high-value claims.\n"
                            "- Prioritize numbers, percentages, dates, rankings, causal claims, and strong superlatives.\n"
                            "- Be conservative: include a claim only if being wrong would materially change understanding, decisions, or credibility.\n"
                            "- Ignore opinions, slogans, coding suggestions, speculative questions, and obvious common knowledge.\n"
                            "- Ignore low-stakes approximations, minor imprecision, and claims where small inaccuracies are not important.\n"
                            "- Deduplicate semantically similar claims.\n"
                            "- Return JSON only in this shape: {\"claims\":[\"...\"]}.\n"
                            f"- Return at most {max_claims} claims.\n"
                            "- Keep each claim under 180 characters."
                        ),
                    }
                ],
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": (
                            f"{context_line}\n"
                            "Analyze the screenshot and extract only the claims that are worth fact-checking."
                        ),
                    },
                    {"type": "input_image", "image_url": data_url},
                ],
            },
        ],
        max_output_tokens=700,
    )

    raw = _read_response_output_text(response)
    json_blob = _parse_first_json_object(raw)
    if not json_blob:
        return []

    try:
        payload = json.loads(json_blob)
    except json.JSONDecodeError:
        return []

    return _clean_items(payload.get("claims"), limit=max_claims)


@rt.function_node
async def extract_claims_from_transcript(
    transcript_context: str | None = None,
    meeting_context: str | None = None,
    max_claims: int = 5,
) -> list[str]:
    transcript = _clean_text(transcript_context)
    if not transcript:
        return []

    client = _create_openai_client()
    model = os.getenv("OPENAI_FACTCHECK_REASONING_MODEL") or "gpt-5.4"
    context_line = (
        f"Meeting context:\n{meeting_context.strip()}\n"
        if isinstance(meeting_context, str) and meeting_context.strip()
        else "No additional meeting context provided.\n"
    )

    response = await client.responses.create(
        model=model,
        input=[
            {
                "role": "system",
                "content": [
                    {
                        "type": "input_text",
                        "text": (
                            "You extract fact-check-worthy factual statements from spoken meeting transcript text.\n"
                            "- Keep only checkable, high-value claims.\n"
                            "- Prioritize specific numbers, percentages, dates, rankings, causal assertions, and strong superlatives.\n"
                            "- Be conservative: include a claim only if being wrong would materially affect decisions, interpretation, or trust.\n"
                            "- Ignore opinions, brainstorming, vague commitments, and generic process talk.\n"
                            "- Ignore low-impact claims, harmless approximations, and statements that are likely true enough for meeting context.\n"
                            "- Deduplicate semantically similar claims.\n"
                            "- Return JSON only in this shape: {\"claims\":[\"...\"]}.\n"
                            f"- Return at most {max_claims} claims.\n"
                            "- Keep each claim under 180 characters."
                        ),
                    }
                ],
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": (
                            f"{context_line}\n"
                            f"Transcript excerpt:\n{transcript}\n\n"
                            "Extract only the statements that should be fact-checked."
                        ),
                    }
                ],
            },
        ],
        max_output_tokens=700,
    )

    raw = _read_response_output_text(response)
    json_blob = _parse_first_json_object(raw)
    if not json_blob:
        return []

    try:
        payload = json.loads(json_blob)
    except json.JSONDecodeError:
        return []

    return _clean_items(payload.get("claims"), limit=max_claims)


@rt.function_node
async def gather_claim_evidence(
    claim: str,
    meeting_context: str | None = None,
) -> ClaimEvidence:
    client = _create_openai_client()
    model = os.getenv("OPENAI_FACTCHECK_REASONING_MODEL") or "gpt-5.4"
    context_line = (
        f"Meeting context:\n{meeting_context.strip()}\n"
        if isinstance(meeting_context, str) and meeting_context.strip()
        else "No additional meeting context provided.\n"
    )

    response = await _create_openai_response_with_web_search(
        client,
        {
            "model": model,
            "input": [
                {
                    "role": "system",
                    "content": [
                        {
                            "type": "input_text",
                            "text": (
                                "You gather evidence for fact-checking a claim.\n"
                                "- Search the web and prefer primary or highly reputable sources.\n"
                                "- Collect both evidence supporting and evidence contradicting the claim.\n"
                                "- Stay neutral; do not decide the final verdict.\n"
                                "- Return JSON only in this exact shape:\n"
                                "{\n"
                                '  "summary":"1-2 neutral sentences",\n'
                                '  "evidence_for":["..."],\n'
                                '  "evidence_against":["..."],\n'
                                '  "open_questions":["..."],\n'
                                '  "sources":[{"title":"...","url":"https://...","snippet":"..."}]\n'
                                "}\n"
                                "- Include 2-6 sources when possible."
                            ),
                        }
                    ],
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "input_text",
                            "text": (
                                f"{context_line}\n"
                                f'Gather evidence for this claim:\n"{claim}"'
                            ),
                        }
                    ],
                },
            ],
            "max_output_tokens": 1200,
        },
    )

    raw = _read_response_output_text(response)
    json_blob = _parse_first_json_object(raw)
    if not json_blob:
        return ClaimEvidence(
            claim=claim,
            summary=raw or "No structured evidence was returned.",
        )

    try:
        payload = json.loads(json_blob)
    except json.JSONDecodeError:
        return ClaimEvidence(
            claim=claim,
            summary=raw or "Could not parse the evidence gathering output.",
        )

    return ClaimEvidence(
        claim=claim,
        summary=_clean_text(payload.get("summary")),
        evidence_for=_clean_items(payload.get("evidence_for"), limit=6),
        evidence_against=_clean_items(payload.get("evidence_against"), limit=6),
        open_questions=_clean_items(payload.get("open_questions"), limit=4),
        sources=_normalize_sources(payload.get("sources"), limit=6),
    )


@rt.function_node
async def synthesize_fact_check_result(
    claim: str,
    source: FactCheckStatementSource,
    evidence: ClaimEvidence,
    meeting_context: str | None = None,
    review_feedback: str | None = None,
    prior_lessons: list[str] | None = None,
) -> FactCheckResult:
    agent = rt.agent_node(
        "Fact-check Judge",
        llm=_create_factcheck_llm(),
        system_message=(
            "You are a meticulous fact-check judge.\n"
            "- Use only the provided evidence bundle.\n"
            "- Do not invent sources or new facts.\n"
            "- Choose supported only when reliable evidence clearly backs the claim.\n"
            "- Choose contradicted only when reliable evidence clearly refutes the claim.\n"
            "- Choose mixed when the claim is partially true, nuanced, or sources materially disagree.\n"
            "- Choose insufficient_evidence when the evidence is weak, outdated, indirect, or sparse.\n"
            "- Confidence must be conservative.\n"
            "- Return JSON only in this shape:\n"
            "{\n"
            '  "verdict":"supported|contradicted|mixed|insufficient_evidence",\n'
            '  "confidence":0.0,\n'
            '  "summary":"1-2 sentences",\n'
            '  "sources":[{"title":"...","url":"https://...","snippet":"..."}]\n'
            "}\n"
            "- Reuse only sources from the evidence bundle and include at most 3."
        ),
    )

    context_line = (
        f"Meeting context:\n{meeting_context.strip()}\n\n"
        if isinstance(meeting_context, str) and meeting_context.strip()
        else ""
    )
    feedback_line = (
        f"Previous review feedback:\n{review_feedback.strip()}\n\n"
        if isinstance(review_feedback, str) and review_feedback.strip()
        else ""
    )
    lessons_line = (
        "Improvement lessons from earlier fact-check runs:\n"
        + "\n".join(f"- {lesson}" for lesson in _clean_items(prior_lessons or [], limit=6))
        + "\n\n"
        if prior_lessons
        else ""
    )
    prompt = (
        f"{context_line}"
        f"{lessons_line}"
        f"Claim:\n{claim}\n\n"
        f"{feedback_line}"
        f"{_format_evidence_for_prompt(evidence)}"
    )

    result = await rt.call(agent, prompt)
    text = _clean_text(result.text)
    json_blob = _parse_first_json_object(text)
    if not json_blob:
        return _fallback_result(
            claim,
            source=source,
            summary=evidence.summary or "The available evidence was inconclusive.",
            sources=evidence.sources[:3],
        )

    try:
        payload = json.loads(json_blob)
    except json.JSONDecodeError:
        return _fallback_result(
            claim,
            source=source,
            summary=evidence.summary or "Could not parse the fact-check verdict.",
            sources=evidence.sources[:3],
        )

    return _normalize_candidate_result(claim, source, payload, evidence=evidence)


@rt.function_node
async def review_fact_check_result(
    claim: str,
    evidence: ClaimEvidence,
    candidate: FactCheckResult,
    meeting_context: str | None = None,
) -> ValidationOutcome:
    programmatic_feedback = _build_programmatic_feedback(candidate, evidence)
    if programmatic_feedback:
        return ValidationOutcome(passes=False, feedback=programmatic_feedback)

    agent = rt.agent_node(
        "Fact-check Reviewer",
        llm=_create_factcheck_llm(),
        system_message=(
            "You review a fact-check result against the evidence bundle.\n"
            "- Fail if the verdict overstates certainty.\n"
            "- Fail if the candidate ignores major contradictory evidence.\n"
            "- Fail if the candidate cites sources that are not in the evidence bundle.\n"
            "- Fail if the summary is not faithful to the evidence.\n"
            '- Return JSON only in this shape: {"passes":true,"feedback":"..."}.\n'
            "- When the result passes, feedback can be an empty string."
        ),
    )

    context_line = (
        f"Meeting context:\n{meeting_context.strip()}\n\n"
        if isinstance(meeting_context, str) and meeting_context.strip()
        else ""
    )
    prompt = (
        f"{context_line}"
        f"Claim:\n{claim}\n\n"
        f"Candidate result:\n{candidate.model_dump_json(indent=2)}\n\n"
        f"Evidence bundle:\n{evidence.model_dump_json(indent=2)}"
    )
    result = await rt.call(agent, prompt)
    text = _clean_text(result.text)
    json_blob = _parse_first_json_object(text)
    if not json_blob:
        return ValidationOutcome(
            passes=False,
            feedback="Reviewer did not return structured validation feedback.",
        )

    try:
        payload = json.loads(json_blob)
    except json.JSONDecodeError:
        return ValidationOutcome(
            passes=False,
            feedback="Reviewer returned malformed validation feedback.",
        )

    return ValidationOutcome(
        passes=bool(payload.get("passes")),
        feedback=_clean_text(payload.get("feedback")),
    )


@rt.function_node
async def distill_fact_check_improvement_lessons(
    claim: str,
    source: FactCheckStatementSource,
    evidence: ClaimEvidence,
    candidate: FactCheckResult,
    review_feedback: str,
    prior_lessons: list[str],
) -> list[str]:
    feedback = _clean_text(review_feedback)
    if not feedback:
        return []

    distiller = rt.agent_node(
        "Fact-check Improvement Distiller",
        llm=_create_factcheck_llm(),
        system_message=(
            "You convert fact-check review feedback into compact reusable lessons for future fact-check runs. "
            "Return valid JSON only in the shape {\"lessons\":[\"...\"]}. "
            "Lessons must be general rules, not claim-specific facts or URLs. "
            "Good lesson: 'Use insufficient_evidence when the source bundle is indirect or sparse.' "
            "Bad lesson: 'Volcanoes do not cause most climate change.' "
            "Return 0-3 lessons and avoid repeating prior lessons."
        ),
    )
    lessons_text = (
        "\n".join(f"- {lesson}" for lesson in _clean_items(prior_lessons, limit=6))
        if prior_lessons
        else "- No prior lessons stored yet."
    )
    prompt = f"""Distill reusable lessons from this fact-check review.

Prior stored lessons:
{lessons_text}

Claim:
{claim}

Claim source:
{source}

Candidate result:
{candidate.model_dump_json(indent=2)}

Evidence bundle:
{evidence.model_dump_json(indent=2)}

Review feedback:
{feedback}

Return only general lessons that would improve future fact-checks."""

    result = await rt.call(distiller, prompt)
    return _parse_lessons_response(result.text.strip())


@rt.function_node
async def fact_check_single_claim(
    claim: str,
    source: FactCheckStatementSource = "visual",
    meeting_context: str | None = None,
    max_attempts: int = 2,
    enable_review: bool = True,
) -> FactCheckResult:
    prior_lessons = await rt.call(load_fact_check_improvement_lessons, 6)
    evidence = await rt.call(gather_claim_evidence, claim, meeting_context)
    if (
        not evidence.sources
        and not evidence.evidence_for
        and not evidence.evidence_against
        and not evidence.summary
    ):
        return _fallback_result(
            claim,
            source=source,
            summary="No meaningful evidence was gathered for this claim.",
        )

    if not enable_review:
        candidate = await rt.call(
            synthesize_fact_check_result,
            claim,
            source,
            evidence,
            meeting_context,
            None,
            prior_lessons,
        )
        programmatic_feedback = _build_programmatic_feedback(candidate, evidence)
        if programmatic_feedback:
            fallback_summary = candidate.summary or evidence.summary or programmatic_feedback
            return _fallback_result(
                claim,
                source=source,
                summary=fallback_summary,
                confidence=min(candidate.confidence, 0.35),
                sources=candidate.sources[:3] or evidence.sources[:3],
            )
        return candidate

    attempts = max(1, max_attempts)
    review_feedback: str | None = None
    last_validation_feedback: str = ""
    last_candidate: FactCheckResult | None = None

    for _ in range(attempts):
        candidate = await rt.call(
            synthesize_fact_check_result,
            claim,
            source,
            evidence,
            meeting_context,
            review_feedback,
            prior_lessons,
        )
        last_candidate = candidate
        validation = await rt.call(
            review_fact_check_result,
            claim,
            evidence,
            candidate,
            meeting_context,
        )
        if validation.passes:
            feedback_to_store = _clean_text(last_validation_feedback or review_feedback or "")
            if feedback_to_store:
                distilled_lessons = await rt.call(
                    distill_fact_check_improvement_lessons,
                    claim,
                    source,
                    evidence,
                    candidate,
                    feedback_to_store,
                    prior_lessons,
                )
                if distilled_lessons:
                    await rt.call(remember_fact_check_improvement_lessons, distilled_lessons)
            return candidate

        review_feedback = validation.feedback or (
            "Be more conservative and ground the verdict more tightly in the evidence bundle."
        )
        last_validation_feedback = review_feedback

    if last_candidate and last_candidate.verdict == "insufficient_evidence":
        if last_validation_feedback:
            distilled_lessons = await rt.call(
                distill_fact_check_improvement_lessons,
                claim,
                source,
                evidence,
                last_candidate,
                last_validation_feedback,
                prior_lessons,
            )
            if distilled_lessons:
                await rt.call(remember_fact_check_improvement_lessons, distilled_lessons)
        return last_candidate

    fallback_sources = (
        last_candidate.sources[:3]
        if last_candidate is not None and last_candidate.sources
        else evidence.sources[:3]
    )
    fallback_summary = (
        "The evidence was not strong enough to support a higher-confidence verdict after review."
    )
    if last_candidate is not None and last_candidate.summary:
        fallback_summary = f"{last_candidate.summary} Validation remained inconclusive."

    if last_candidate is not None and last_validation_feedback:
        distilled_lessons = await rt.call(
            distill_fact_check_improvement_lessons,
            claim,
            source,
            evidence,
            last_candidate,
            last_validation_feedback,
            prior_lessons,
        )
        if distilled_lessons:
            await rt.call(remember_fact_check_improvement_lessons, distilled_lessons)

    return _fallback_result(
        claim,
        source=source,
        summary=fallback_summary,
        confidence=0.3,
        sources=fallback_sources,
    )


@rt.function_node
async def quick_fact_check_single_claim(
    claim: str,
    source: FactCheckStatementSource = "visual",
    meeting_context: str | None = None,
) -> FactCheckResult:
    client = _create_openai_client()
    model = (
        os.getenv("OPENAI_FACTCHECK_BACKGROUND_REASONING_MODEL")
        or os.getenv("OPENAI_FACTCHECK_REASONING_MODEL")
        or "gpt-5.4"
    )
    context_line = (
        f"Meeting context:\n{meeting_context.strip()}\n\n"
        if isinstance(meeting_context, str) and meeting_context.strip()
        else ""
    )

    response = await _create_openai_response_with_web_search(
        client,
        {
            "model": model,
            "input": [
                {
                    "role": "system",
                    "content": [
                        {
                            "type": "input_text",
                            "text": (
                                "You are a fast fact-checker for a live presentation copilot.\n"
                                "- Search the web quickly and prefer primary or highly reputable sources.\n"
                                "- Return JSON only in this exact shape:\n"
                                "{\n"
                                '  "verdict":"supported|contradicted|mixed|insufficient_evidence",\n'
                                '  "confidence":0.0,\n'
                                '  "summary":"1-2 sentences",\n'
                                '  "sources":[{"title":"...","url":"https://...","snippet":"..."}]\n'
                                "}\n"
                                "- Be conservative when evidence is incomplete.\n"
                                "- Include at most 3 sources."
                            ),
                        }
                    ],
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "input_text",
                            "text": f'{context_line}Fact-check this claim:\n"{claim}"',
                        }
                    ],
                },
            ],
            "max_output_tokens": 900,
        },
    )

    raw = _read_response_output_text(response)
    json_blob = _parse_first_json_object(raw)
    if not json_blob:
        return _fallback_result(
            claim,
            source=source,
            summary=raw or "The quick fact-check did not return a structured verdict.",
        )

    try:
        payload = json.loads(json_blob)
    except json.JSONDecodeError:
        return _fallback_result(
            claim,
            source=source,
            summary=raw or "The quick fact-check returned malformed output.",
        )

    verdict = _normalize_verdict(payload.get("verdict"))
    confidence = _clamp_confidence(
        payload.get("confidence"),
        fallback=0.35 if verdict == "insufficient_evidence" else 0.55,
    )
    summary = _clean_text(
        payload.get("summary"),
        "The quick fact-check could not produce a confident verdict.",
    )
    sources = _normalize_sources(payload.get("sources"), limit=3)

    if verdict != "insufficient_evidence" and not sources:
        return _fallback_result(
            claim,
            source=source,
            summary=summary,
            confidence=min(confidence, 0.35),
        )

    return FactCheckResult(
        claim=claim,
        source=source,
        verdict=verdict,
        confidence=confidence,
        summary=summary[:320],
        sources=sources,
    )


@rt.function_node
async def fact_check_latest_frame(
    frame: str,
    meeting_context: str | None = None,
    screen_context: str | None = None,
    transcript_context: str | None = None,
    max_claims: int | None = None,
    mode: FactCheckMode = "interactive",
) -> FactCheckResponse:
    is_background = mode == "background"
    resolved_max_claims = max_claims or _parse_env_int(
        "FACTCHECK_BACKGROUND_MAX_CLAIMS" if is_background else "FACTCHECK_MAX_CLAIMS",
        1 if is_background else 5,
    )
    max_visual_statements = _parse_env_int(
        "FACTCHECK_BACKGROUND_MAX_VISUAL_STATEMENTS"
        if is_background
        else "FACTCHECK_MAX_VISUAL_STATEMENTS",
        resolved_max_claims,
    )
    max_voice_statements = _parse_env_int(
        "FACTCHECK_BACKGROUND_MAX_VOICE_STATEMENTS"
        if is_background
        else "FACTCHECK_MAX_VOICE_STATEMENTS",
        resolved_max_claims,
    )
    enable_transcript_extraction = _parse_env_bool(
        "ENABLE_TRANSCRIPT_FACTCHECK_EXTRACTION",
        True,
    )
    max_attempts = (
        1
        if is_background
        else _parse_env_int("FACTCHECK_VALIDATION_ATTEMPTS", 2)
    )
    enable_review = False if is_background else _parse_env_bool("FACTCHECK_ENABLE_REVIEW", True)

    visual_claims = (
        []
        if is_background and bool(_clean_text(transcript_context))
        else await rt.call(
            extract_claims_from_frame,
            frame,
            screen_context,
            min(resolved_max_claims, max_visual_statements),
        )
    )
    voice_claims = (
        await rt.call(
            extract_claims_from_transcript,
            transcript_context,
            meeting_context,
            min(resolved_max_claims, max_voice_statements),
        )
        if enable_transcript_extraction
        else []
    )

    visual_statements = _claims_to_statements(
        visual_claims,
        "visual",
        limit=max_visual_statements,
    )
    voice_statements = _claims_to_statements(
        voice_claims,
        "voice",
        limit=max_voice_statements,
    )
    statements = _merge_statements(
        visual_statements,
        voice_statements,
        total_max_items=resolved_max_claims,
        prefer_voice_first=is_background and bool(_clean_text(transcript_context)),
    )
    if not statements:
        return FactCheckResponse()

    claims = [statement.claim for statement in statements]
    sources = [statement.source for statement in statements]
    if is_background:
        results = await rt.call_batch(
            quick_fact_check_single_claim,
            claims,
            sources,
            [meeting_context] * len(claims),
            return_exceptions=True,
        )
    else:
        results = await rt.call_batch(
            fact_check_single_claim,
            claims,
            sources,
            [meeting_context] * len(claims),
            [max_attempts] * len(claims),
            [enable_review] * len(claims),
            return_exceptions=True,
        )

    normalized_results: list[FactCheckResult] = []
    for statement, result in zip(statements, results):
        if isinstance(result, Exception):
            normalized_results.append(
                _fallback_result(
                    statement.claim,
                    source=statement.source,
                    summary=f"Fact-checking failed for this claim: {result}",
                )
            )
            continue
        normalized_results.append(result)

    return FactCheckResponse(
        claims=claims,
        statements=statements,
        results=normalized_results,
    )


FACT_CHECK_FLOW = rt.Flow(
    name="Fact Check Flow",
    entry_point=fact_check_latest_frame,
)
