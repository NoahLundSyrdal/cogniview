from __future__ import annotations

import json
import os
from typing import Any, Literal

import railtracks as rt
from openai import AsyncOpenAI
from pydantic import BaseModel, Field

FactCheckVerdict = Literal[
    "supported",
    "contradicted",
    "mixed",
    "insufficient_evidence",
]


class FactCheckSource(BaseModel):
    title: str
    url: str
    snippet: str = ""


class FactCheckResult(BaseModel):
    claim: str
    verdict: FactCheckVerdict
    confidence: float
    summary: str
    sources: list[FactCheckSource] = Field(default_factory=list)


class FactCheckResponse(BaseModel):
    claims: list[str] = Field(default_factory=list)
    results: list[FactCheckResult] = Field(default_factory=list)


class FactCheckRequest(BaseModel):
    frame: str = Field(min_length=1)
    meetingContext: str | None = None
    maxClaims: int | None = Field(default=None, ge=1, le=10)


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
    summary: str,
    confidence: float = 0.2,
    sources: list[FactCheckSource] | None = None,
) -> FactCheckResult:
    return FactCheckResult(
        claim=claim,
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
    meeting_context: str | None = None,
    max_claims: int = 5,
) -> list[str]:
    client = _create_openai_client()
    base64, mime_type = _parse_data_url_frame(frame)
    data_url = f"data:{mime_type};base64,{base64}"
    model = os.getenv("OPENAI_FACTCHECK_IMAGE_MODEL") or "gpt-5.4"
    context_line = (
        f"Meeting context:\n{meeting_context.strip()}\n"
        if isinstance(meeting_context, str) and meeting_context.strip()
        else "Meeting context is unavailable.\n"
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
                            "- Ignore opinions, slogans, coding suggestions, speculative questions, and obvious common knowledge.\n"
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
    evidence: ClaimEvidence,
    meeting_context: str | None = None,
    review_feedback: str | None = None,
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
    prompt = (
        f"{context_line}"
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
            summary=evidence.summary or "The available evidence was inconclusive.",
            sources=evidence.sources[:3],
        )

    try:
        payload = json.loads(json_blob)
    except json.JSONDecodeError:
        return _fallback_result(
            claim,
            summary=evidence.summary or "Could not parse the fact-check verdict.",
            sources=evidence.sources[:3],
        )

    return _normalize_candidate_result(claim, payload, evidence=evidence)


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
async def fact_check_single_claim(
    claim: str,
    meeting_context: str | None = None,
    max_attempts: int = 2,
) -> FactCheckResult:
    evidence = await rt.call(gather_claim_evidence, claim, meeting_context)
    if (
        not evidence.sources
        and not evidence.evidence_for
        and not evidence.evidence_against
        and not evidence.summary
    ):
        return _fallback_result(
            claim,
            summary="No meaningful evidence was gathered for this claim.",
        )

    attempts = max(1, max_attempts)
    review_feedback: str | None = None
    last_candidate: FactCheckResult | None = None

    for _ in range(attempts):
        candidate = await rt.call(
            synthesize_fact_check_result,
            claim,
            evidence,
            meeting_context,
            review_feedback,
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
            return candidate

        review_feedback = validation.feedback or (
            "Be more conservative and ground the verdict more tightly in the evidence bundle."
        )

    if last_candidate and last_candidate.verdict == "insufficient_evidence":
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

    return _fallback_result(
        claim,
        summary=fallback_summary,
        confidence=0.3,
        sources=fallback_sources,
    )


@rt.function_node
async def fact_check_latest_frame(
    frame: str,
    meeting_context: str | None = None,
    max_claims: int | None = None,
) -> FactCheckResponse:
    resolved_max_claims = max_claims or _parse_env_int("FACTCHECK_MAX_CLAIMS", 5)
    max_attempts = _parse_env_int("FACTCHECK_VALIDATION_ATTEMPTS", 2)

    claims = await rt.call(
        extract_claims_from_frame,
        frame,
        meeting_context,
        resolved_max_claims,
    )
    if not claims:
        return FactCheckResponse()

    results = await rt.call_batch(
        fact_check_single_claim,
        claims,
        [meeting_context] * len(claims),
        [max_attempts] * len(claims),
        return_exceptions=True,
    )

    normalized_results: list[FactCheckResult] = []
    for claim, result in zip(claims, results):
        if isinstance(result, Exception):
            normalized_results.append(
                _fallback_result(
                    claim,
                    summary=f"Fact-checking failed for this claim: {result}",
                )
            )
            continue
        normalized_results.append(result)

    return FactCheckResponse(claims=claims, results=normalized_results)


FACT_CHECK_FLOW = rt.Flow(
    name="Fact Check Flow",
    entry_point=fact_check_latest_frame,
)
