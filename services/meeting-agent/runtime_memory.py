from __future__ import annotations

import json
import re
import threading
import time
from pathlib import Path
from typing import Any, Literal

LessonDomain = Literal["summary", "fact_check"]

ROOT_DIR = Path(__file__).resolve().parents[2]
MEMORY_DIR = ROOT_DIR / ".railtracks" / "memory"
MEMORY_FILE = MEMORY_DIR / "agent_lessons.json"
MAX_LESSONS_PER_DOMAIN = 40
_MEMORY_LOCK = threading.Lock()


def _normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9\s]", " ", value.lower())).strip()


def _tokenize_text(value: str) -> list[str]:
    return [token for token in _normalize_text(value).split(" ") if len(token) >= 2]


def _text_similarity(left: str, right: str) -> float:
    left_tokens = _tokenize_text(left)
    right_tokens = _tokenize_text(right)
    if not left_tokens or not right_tokens:
        return 0.0

    left_set = set(left_tokens)
    right_set = set(right_tokens)
    intersection = len(left_set & right_set)
    union = len(left_set | right_set)
    return intersection / union if union else 0.0


def _is_near_duplicate(left: str, right: str) -> bool:
    normalized_left = _normalize_text(left)
    normalized_right = _normalize_text(right)

    if not normalized_left or not normalized_right:
        return False
    if normalized_left == normalized_right:
        return True
    if (
        (normalized_left in normalized_right or normalized_right in normalized_left)
        and min(len(normalized_left), len(normalized_right))
        / max(len(normalized_left), len(normalized_right))
        >= 0.72
    ):
        return True

    return _text_similarity(left, right) >= 0.76


def _default_store() -> dict[str, list[dict[str, Any]]]:
    return {"summary": [], "fact_check": []}


def _ensure_store_shape(data: Any) -> dict[str, list[dict[str, Any]]]:
    if not isinstance(data, dict):
        return _default_store()

    normalized = _default_store()
    for domain in ("summary", "fact_check"):
        raw_items = data.get(domain)
        if not isinstance(raw_items, list):
            continue

        entries: list[dict[str, Any]] = []
        for raw_item in raw_items:
            if not isinstance(raw_item, dict):
                continue

            lesson = raw_item.get("lesson")
            if not isinstance(lesson, str) or not lesson.strip():
                continue

            entries.append(
                {
                    "lesson": lesson.strip(),
                    "times_seen": int(raw_item.get("times_seen") or 1),
                    "first_seen": float(raw_item.get("first_seen") or time.time()),
                    "last_seen": float(raw_item.get("last_seen") or time.time()),
                }
            )

        normalized[domain] = entries

    return normalized


def _load_store() -> dict[str, list[dict[str, Any]]]:
    if not MEMORY_FILE.exists():
        return _default_store()

    try:
        data = json.loads(MEMORY_FILE.read_text())
    except (OSError, json.JSONDecodeError):
        return _default_store()

    return _ensure_store_shape(data)


def _write_store(store: dict[str, list[dict[str, Any]]]) -> None:
    MEMORY_DIR.mkdir(parents=True, exist_ok=True)
    temp_path = MEMORY_FILE.with_suffix(".tmp")
    temp_path.write_text(json.dumps(store, indent=2, sort_keys=True))
    temp_path.replace(MEMORY_FILE)


def _sorted_entries(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(
        entries,
        key=lambda item: (
            int(item.get("times_seen") or 1),
            float(item.get("last_seen") or 0),
        ),
        reverse=True,
    )


def load_lessons(domain: LessonDomain, limit: int = 6) -> list[str]:
    safe_limit = max(1, limit)
    with _MEMORY_LOCK:
        store = _load_store()
        entries = _sorted_entries(store.get(domain, []))
        return [
            str(entry["lesson"]).strip()
            for entry in entries[:safe_limit]
            if isinstance(entry.get("lesson"), str) and entry["lesson"].strip()
        ]


def remember_lessons(
    domain: LessonDomain,
    lessons: list[str],
    *,
    max_entries: int = MAX_LESSONS_PER_DOMAIN,
) -> list[str]:
    cleaned_lessons = [lesson.strip() for lesson in lessons if isinstance(lesson, str) and lesson.strip()]
    if not cleaned_lessons:
        return load_lessons(domain)

    now = time.time()
    with _MEMORY_LOCK:
        store = _load_store()
        entries = list(store.get(domain, []))

        for lesson in cleaned_lessons:
            matching_entry = next(
                (
                    entry
                    for entry in entries
                    if isinstance(entry.get("lesson"), str)
                    and _is_near_duplicate(str(entry["lesson"]), lesson)
                ),
                None,
            )

            if matching_entry is not None:
                matching_entry["times_seen"] = int(matching_entry.get("times_seen") or 1) + 1
                matching_entry["last_seen"] = now
                existing_lesson = str(matching_entry.get("lesson") or "").strip()
                if len(lesson) < len(existing_lesson) or not existing_lesson:
                    matching_entry["lesson"] = lesson
                continue

            entries.append(
                {
                    "lesson": lesson,
                    "times_seen": 1,
                    "first_seen": now,
                    "last_seen": now,
                }
            )

        store[domain] = _sorted_entries(entries)[: max(1, max_entries)]
        _write_store(store)

    return load_lessons(domain)


def get_memory_stats() -> dict[str, int]:
    with _MEMORY_LOCK:
        store = _load_store()
        return {
            "summary": len(store.get("summary", [])),
            "fact_check": len(store.get("fact_check", [])),
        }
