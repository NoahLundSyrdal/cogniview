from __future__ import annotations

import os
from pathlib import Path
from typing import Literal

import railtracks as rt
from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from fact_check import FACT_CHECK_FLOW, FactCheckRequest, FactCheckResponse
from meeting_summary import (
    MEETING_SUMMARY_FLOW,
    MeetingSummaryRequest,
    MeetingSummaryResponse,
)

ROOT_DIR = Path(__file__).resolve().parents[2]
load_dotenv(ROOT_DIR / ".env.local", override=False)
load_dotenv(ROOT_DIR / ".env", override=False)


class ScreenAnalysis(BaseModel):
    screenType: str | None = None
    summary: str | None = None
    keyPoints: list[str] = Field(default_factory=list)
    actionItems: list[str] = Field(default_factory=list)


class ChatHistoryMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1)


class ChatRequest(BaseModel):
    message: str = Field(min_length=1)
    meetingContext: str | None = None
    screenAnalysis: ScreenAnalysis | None = None
    transcriptContext: str | None = None
    chatHistory: list[ChatHistoryMessage] = Field(default_factory=list)


class ChatResponse(BaseModel):
    response: str


def _clean_text(value: str | None, fallback: str) -> str:
    text = value.strip() if isinstance(value, str) else ""
    return text or fallback


def _clean_items(values: list[str] | None) -> list[str]:
    if not values:
        return []
    return [item.strip() for item in values if isinstance(item, str) and item.strip()]


def resolve_provider() -> Literal["anthropic", "openai"]:
    explicit = (
        os.getenv("RAILTRACKS_LLM_PROVIDER")
        or os.getenv("LLM_PROVIDER")
        or ""
    ).strip().lower()
    if explicit in {"anthropic", "openai"}:
        return explicit  # type: ignore[return-value]

    has_anthropic = bool(os.getenv("ANTHROPIC_API_KEY"))
    has_openai = bool(os.getenv("OPENAI_API_KEY"))
    if has_anthropic and not has_openai:
        return "anthropic"
    if has_openai and not has_anthropic:
        return "openai"
    if has_anthropic and has_openai:
        return "anthropic"

    raise RuntimeError(
        "No Railtracks LLM configured: set ANTHROPIC_API_KEY and/or OPENAI_API_KEY "
        "(optionally RAILTRACKS_LLM_PROVIDER=anthropic|openai when both are set)."
    )


def create_llm():
    provider = resolve_provider()

    if provider == "anthropic":
        api_key = os.getenv("ANTHROPIC_API_KEY")
        if not api_key:
            raise RuntimeError("ANTHROPIC_API_KEY is required for Anthropic")

        model_name = (
            os.getenv("RAILTRACKS_ANTHROPIC_MODEL")
            or os.getenv("ANTHROPIC_MODEL")
            or "claude-sonnet-4-6"
        )
        return rt.llm.AnthropicLLM(model_name=model_name, api_key=api_key)

    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is required for OpenAI")

    model_name = (
        os.getenv("RAILTRACKS_OPENAI_MODEL")
        or os.getenv("OPENAI_MODEL")
        or "gpt-4o"
    )
    return rt.llm.OpenAILLM(model_name=model_name, api_key=api_key)


def build_screen_context(screen_analysis: ScreenAnalysis | None) -> str:
    if screen_analysis is None:
        return "No screen capture active yet."

    screen_type = _clean_text(screen_analysis.screenType, "Unknown screen")
    summary = _clean_text(screen_analysis.summary, "No screen summary available.")
    key_points = ", ".join(_clean_items(screen_analysis.keyPoints)) or "None"
    action_items = ", ".join(_clean_items(screen_analysis.actionItems)) or "None"

    return (
        f"Current screen: {screen_type} - {summary}\n"
        f"Key points: {key_points}\n"
        f"Action items identified: {action_items}"
    )


def build_system_message(
    *,
    meeting_context: str | None,
    screen_analysis: ScreenAnalysis | None,
    transcript_context: str | None,
    chat_history_text: str | None = None,
) -> str:
    screen_context = build_screen_context(screen_analysis)
    prior_chat = (
        f"Recent copilot chat:\n{chat_history_text}\n\n"
        if isinstance(chat_history_text, str) and chat_history_text.strip()
        else ""
    )

    return f"""You are an intelligent meeting copilot. You are watching the user's screen in real-time during their meeting.

{screen_context}

Meeting history so far:
{meeting_context or 'Meeting just started.'}

Recent spoken transcript:
{transcript_context or 'No transcript available yet.'}

{prior_chat}Your role:
- Answer questions about what's being presented on screen
- Suggest questions the user could ask the presenter
- Highlight important points or action items
- Provide relevant context, facts, or definitions
- Be concise and actionable - this is a live meeting, brevity matters
- If asked about something not visible, say so honestly

Respond in 1-3 sentences unless a detailed explanation is genuinely needed."""


def build_chat_history_text(chat_history: list[ChatHistoryMessage]) -> str | None:
    lines = [
        f"{'User' if message.role == 'user' else 'Assistant'}: {message.content.strip()}"
        for message in chat_history[-10:]
        if message.content.strip()
    ]
    return "\n".join(lines) if lines else None


@rt.function_node
async def meeting_copilot_reply(
    message: str,
    meeting_context: str | None = None,
    transcript_context: str | None = None,
    chat_history_text: str | None = None,
    screen_type: str | None = None,
    screen_summary: str | None = None,
    screen_key_points: list[str] | None = None,
    screen_action_items: list[str] | None = None,
) -> str:
    system_message = build_system_message(
        meeting_context=meeting_context,
        transcript_context=transcript_context,
        chat_history_text=chat_history_text,
        screen_analysis=ScreenAnalysis(
            screenType=screen_type,
            summary=screen_summary,
            keyPoints=screen_key_points or [],
            actionItems=screen_action_items or [],
        )
        if any(
            value
            for value in (
                screen_type,
                screen_summary,
                screen_key_points,
                screen_action_items,
            )
        )
        else None,
    )

    agent = rt.agent_node(
        "Meeting Copilot",
        llm=create_llm(),
        system_message=system_message,
    )
    result = await rt.call(agent, message)
    return result.text.strip()


MEETING_COPILOT_FLOW = rt.Flow(
    name="Meeting Copilot Flow",
    entry_point=meeting_copilot_reply,
)

app = FastAPI(title="CogniView Railtracks Meeting Agent")


@app.get("/health")
async def health() -> dict[str, str]:
    return {
        "status": "ok",
        "flow": MEETING_COPILOT_FLOW.name,
        "fact_check_flow": FACT_CHECK_FLOW.name,
        "meeting_summary_flow": MEETING_SUMMARY_FLOW.name,
    }


@app.post("/chat", response_model=ChatResponse)
async def chat(payload: ChatRequest):
    try:
        response = await MEETING_COPILOT_FLOW.ainvoke(
            message=payload.message.strip(),
            meeting_context=payload.meetingContext,
            transcript_context=payload.transcriptContext,
            chat_history_text=build_chat_history_text(payload.chatHistory),
            screen_type=payload.screenAnalysis.screenType if payload.screenAnalysis else None,
            screen_summary=payload.screenAnalysis.summary if payload.screenAnalysis else None,
            screen_key_points=payload.screenAnalysis.keyPoints if payload.screenAnalysis else None,
            screen_action_items=payload.screenAnalysis.actionItems if payload.screenAnalysis else None,
        )
        return ChatResponse(response=response)
    except Exception as error:
        return JSONResponse(status_code=500, content={"error": str(error)})


@app.post("/fact-check", response_model=FactCheckResponse)
async def fact_check(payload: FactCheckRequest):
    try:
        response = await FACT_CHECK_FLOW.ainvoke(
            frame=payload.frame.strip(),
            meeting_context=payload.meetingContext,
            screen_context=payload.screenContext,
            transcript_context=payload.transcriptContext,
            max_claims=payload.maxClaims,
            mode=payload.mode,
        )
        return response
    except Exception as error:
        return JSONResponse(status_code=500, content={"error": str(error)})


@app.post("/summarize", response_model=MeetingSummaryResponse)
async def summarize(payload: MeetingSummaryRequest):
    try:
        summary = await MEETING_SUMMARY_FLOW.ainvoke(
            insights=payload.insights,
            action_items=payload.actionItems,
            transcript_segments=payload.transcriptSegments,
            fact_check_runs=payload.factCheckRuns,
            duration=payload.duration,
        )
        return MeetingSummaryResponse(summary=summary)
    except Exception as error:
        return JSONResponse(status_code=500, content={"error": str(error)})


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="127.0.0.1", port=8000, reload=False)
