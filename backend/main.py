"""FastAPI routes for catalogue search, reader accounts, and collections."""

from __future__ import annotations

import logging
import mimetypes
import os
import ipaddress
import random
import subprocess
import sys
import time
from collections import Counter, deque
from threading import Lock
from urllib.parse import urlparse
from contextlib import asynccontextmanager
from pathlib import Path
from typing import List, Literal, Optional

import uvicorn
from fastapi import (
    BackgroundTasks,
    Depends,
    FastAPI,
    HTTPException,
    Query,
    Request,
    Response,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from covers import (
    fetch_and_cache,
    get_cached_path,
    delete_cached,
    cache_stats,
    is_cached,
)
from catalogue_admin import create_record, update_record
from accounts import (
    change_password,
    initialise_accounts,
    login,
    logout,
    register,
    require_admin,
    reset_password,
    rotate_recovery_code,
    user_from_request,
)
from collection import (
    initialise as initialise_collection,
    list_items,
    move_item,
    now,
    profile,
    save_item,
    set_tier,
    sync_catalogue_metadata,
)
from community import (
    add_collection_comment,
    add_review,
    add_to_collection,
    collection_comments,
    create_collection,
    featured_favorites,
    follow_collection,
    get_collection as get_shared_collection,
    initialise_community,
    list_collections,
    list_novel_requests,
    move_collection_item as move_shared_collection_item,
    public_reader_profile,
    reader_analytics,
    request_novel,
    reviews,
    set_novel_request_status,
    storage_usage,
)
from search import SearchEngine

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(name)s — %(message)s",
)
logger = logging.getLogger(__name__)

_engine: Optional[SearchEngine] = None
_frontend_dir = Path(__file__).parent.parent / "frontend"
_catalogue_job_lock = Lock()


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _engine
    initialise_accounts()
    initialise_collection()
    initialise_community()
    logger.info("Loading search engine…")
    _engine = SearchEngine()
    synced = sync_catalogue_metadata(_engine.metadata)
    if synced:
        logger.info("Refreshed catalogue metadata for %d saved library records", synced)
    logger.info("Ready — %d novels indexed", _engine.num_indexed)
    yield
    logger.info("Shutdown.")


app = FastAPI(
    title="NoveList",
    version="3.0.0",
    lifespan=lifespan,
)

cors_origins = [
    origin.strip()
    for origin in os.getenv(
        "CORS_ORIGINS",
        "http://localhost:3000,http://localhost:8080,http://127.0.0.1:3000,http://127.0.0.1:8080",
    ).split(",")
    if origin.strip()
]
cors_origin_regex = os.getenv(
    "CORS_ORIGIN_REGEX", r"^https?://(localhost|127\.0\.0\.1)(?::\d+)?$"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_origin_regex=cors_origin_regex or None,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Helpers ────────────────────────────────────────────────────────────────


def _get_engine() -> SearchEngine:
    if _engine is None:
        raise HTTPException(503, "Search engine not ready")
    return _engine


def _get_novel_by_id(novel_id: int) -> dict:
    """Look up a novel by its id field from the metadata list."""
    eng = _get_engine()
    novel = eng.metadata_by_id.get(novel_id)
    if novel:
        return novel
    raise HTTPException(404, f"Novel #{novel_id} not found")


def _catalogue_url(url: str | None) -> str | None:
    """Return a safe remote URL already stored in catalogue metadata."""
    if not url:
        return None
    parsed = urlparse(url)
    return url if parsed.scheme in {"http", "https"} and parsed.netloc else None


def _catalogue_links(links: list[dict]) -> list[dict]:
    return [link for link in links if _catalogue_url(str(link.get("url", "")))]


def _custom_source_url(value: str | None) -> str:
    parsed = urlparse((value or "").strip())
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise HTTPException(422, "Enter a complete HTTP or HTTPS metadata URL")
    if parsed.hostname.casefold() in {"localhost", "localhost.localdomain"}:
        raise HTTPException(422, "Local addresses cannot be collected")
    try:
        address = ipaddress.ip_address(parsed.hostname)
    except ValueError:
        address = None
    if address and (
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_reserved
    ):
        raise HTTPException(422, "Private network addresses cannot be collected")
    return parsed.geturl()


def _cover_media_type(path: Path) -> str:
    return {
        ".webp": "image/webp",
        ".png": "image/png",
        ".avif": "image/avif",
        ".gif": "image/gif",
    }.get(path.suffix.casefold(), "image/jpeg")


def _public_novel(novel: dict) -> dict:
    """Shape catalogue metadata consistently for browse and search views."""
    novel_id = novel.get("id")
    return {
        "id": novel_id,
        "novel_id": novel_id,
        "title": novel.get("title", "Untitled"),
        "title_aliases": novel.get("title_aliases") or [],
        "author": novel.get("author") or "",
        "synopsis": "" if novel.get("hand_authored") else novel.get("synopsis") or "",
        "tags": novel.get("tags") or [],
        "urls": _catalogue_links(novel.get("urls") or []),
        "cover_url": _catalogue_url(novel.get("cover_url")),
        "cover_cached": bool(novel_id is not None and is_cached(novel_id)),
        "source": novel.get("source") or "",
        "status": novel.get("status") or "",
    }


# ── Schemas ────────────────────────────────────────────────────────────────


class SearchRequest(BaseModel):
    query: str = Field(
        ...,
        min_length=2,
        max_length=500,
        json_schema_extra={"example": "beast tamer MC, green worm evolves into dragon"},
    )
    top_k: int = Field(default=120, ge=1, le=5000)
    page: int = Field(default=1, ge=1)
    page_size: int = Field(default=24, ge=1, le=60)
    tags: List[str] = Field(default_factory=list, max_length=20)


class NovelResult(BaseModel):
    title: str
    score: float
    reason: str
    synopsis: str
    tags: List[str]
    urls: List[dict] = Field(default_factory=list)
    cover_url: Optional[str] = None
    cover_cached: bool = False
    novel_id: Optional[int] = None
    author: str = ""
    title_aliases: List[str] = Field(default_factory=list)
    source: str = ""
    status: str = ""


class SearchResponse(BaseModel):
    results: List[NovelResult]
    rewritten_query: Optional[str] = None
    total_indexed: int
    page: int = 1
    page_size: int = 24
    has_more: bool = False


class HealthResponse(BaseModel):
    status: str
    total_indexed: int
    cover_cache: dict


class CollectionSaveRequest(BaseModel):
    status: Optional[
        Literal["reading", "completed", "dropped", "plan_to_read", "continue", "paused"]
    ] = None
    rating: Optional[int] = Field(default=None, ge=1, le=5)


class LibraryImportRow(BaseModel):
    title: str = Field(..., min_length=1, max_length=300)
    status: Literal[
        "reading", "completed", "dropped", "plan_to_read", "continue", "paused"
    ] = "plan_to_read"


class LibraryImportRequest(BaseModel):
    items: List[LibraryImportRow] = Field(..., min_length=1, max_length=500)


class TierUpdateRequest(BaseModel):
    tier: Optional[str] = None
    confirm_prediction: bool = False


class TierMoveRequest(BaseModel):
    tier: Literal["S", "A", "B", "C", "D"]
    ordered_novel_ids: List[int]


class Credentials(BaseModel):
    username: str = Field(..., min_length=3, max_length=32)
    password: str = Field(..., min_length=1, max_length=256)


class PasswordChangeRequest(BaseModel):
    current_password: str = Field(..., min_length=1, max_length=256)
    new_password: str = Field(..., min_length=10, max_length=256)


class PasswordResetRequest(BaseModel):
    username: str = Field(..., min_length=3, max_length=32)
    recovery_code: str = Field(..., min_length=16, max_length=128)
    new_password: str = Field(..., min_length=10, max_length=256)


class ReviewRequest(BaseModel):
    rating: Optional[int] = Field(default=None, ge=1, le=5)
    body: str = Field(..., min_length=1, max_length=2000)


class NovelRequestBody(BaseModel):
    query: str = Field(..., min_length=1, max_length=300)
    note: str = Field(default="", max_length=1000)


class SharedCollectionRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    description: str = Field(default="", max_length=500)
    visibility: Literal["public", "private"] = "public"


class AddSharedItemRequest(BaseModel):
    novel_id: int


class SharedTierMoveRequest(BaseModel):
    tier: Literal["S", "A", "B", "C", "D"]
    ordered_novel_ids: List[int]


class FollowRequest(BaseModel):
    following: bool = True


class ScrapeRequest(BaseModel):
    source: Literal[
        "custom",
        "repair",
        "royalroad",
        "novelfull",
        "novelfire",
        "novelupdates",
    ]
    limit: int = Field(default=100, ge=1, le=200)
    source_url: Optional[str] = Field(default=None, max_length=2000)


class DirectTitleRequest(BaseModel):
    title: str = Field(..., min_length=2, max_length=300)


class RequestStatusRequest(BaseModel):
    status: Literal["open", "collecting", "resolved", "declined"]


class SourceLink(BaseModel):
    site: str = Field(default="", max_length=80)
    url: str = Field(..., min_length=8, max_length=2000)


class CatalogueRecordRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=300)
    title_aliases: List[str] = Field(default_factory=list, max_length=30)
    author: str = Field(default="", max_length=300)
    synopsis: str = Field(default="", max_length=20_000)
    tags: List[str] = Field(default_factory=list, max_length=100)
    source: str = Field(default="", max_length=120)
    status: str = Field(default="", max_length=80)
    cover_url: str = Field(default="", max_length=2000)
    urls: List[SourceLink] = Field(default_factory=list, max_length=30)


# ── Search ─────────────────────────────────────────────────────────────────


@app.post("/search", response_model=SearchResponse, tags=["search"])
async def search(req: SearchRequest):
    eng = _get_engine()
    query = req.query.strip()
    if not query:
        raise HTTPException(400, "Query must not be empty")

    retrieve = min(eng.num_indexed, max(req.top_k, req.page * req.page_size + 1))
    results, rewritten = await eng.search(
        query=query,
        top_k=retrieve,
        filter_tags=req.tags,
    )

    start = (req.page - 1) * req.page_size
    page_results = results[start : start + req.page_size]

    novel_results = []
    for r in page_results:
        novel_id = r.get("novel_id")
        matched_novel = eng.metadata_by_id.get(novel_id) or eng.metadata_by_title.get(
            r["title"].casefold()
        )
        if novel_id is None and matched_novel:
            novel_id = matched_novel.get("id")

        novel_results.append(
            NovelResult(
                title=r["title"],
                score=r["score"],
                reason=r["reason"],
                synopsis=""
                if (matched_novel or {}).get("hand_authored")
                else r["synopsis"],
                tags=r["tags"],
                urls=_catalogue_links(r.get("urls", [])),
                cover_url=_catalogue_url(
                    r.get("cover_url") or (matched_novel or {}).get("cover_url")
                ),
                cover_cached=bool(
                    _catalogue_url((matched_novel or {}).get("cover_url"))
                )
                and is_cached(novel_id)
                if novel_id
                else False,
                novel_id=novel_id,
                author=r.get("author") or (matched_novel or {}).get("author", ""),
                title_aliases=(matched_novel or {}).get("title_aliases", []),
                source=(matched_novel or {}).get("source", ""),
                status=(matched_novel or {}).get("status", ""),
            )
        )

    return SearchResponse(
        results=novel_results,
        rewritten_query=rewritten,
        total_indexed=eng.num_indexed,
        page=req.page,
        page_size=req.page_size,
        has_more=len(results) > start + req.page_size,
    )


# ── Novels list ────────────────────────────────────────────────────────────


@app.get("/novels", tags=["data"])
def list_novels(
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
):
    eng = _get_engine()
    novels = [_public_novel(novel) for novel in eng.metadata[offset : offset + limit]]
    return {
        "novels": novels,
        "total": len(eng.metadata),
        "offset": offset,
        "limit": limit,
    }


@app.get("/catalogue", tags=["data"])
def browse_catalogue(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=36, ge=1, le=60),
    tags: List[str] = Query(default=[]),
    sort: Literal["recent", "title", "random"] = Query(default="recent"),
):
    eng = _get_engine()
    wanted = {tag.casefold().strip() for tag in tags if tag.strip()}
    novels = [
        novel
        for novel in eng.metadata
        if not wanted
        or wanted.issubset({str(tag).casefold() for tag in novel.get("tags", [])})
    ]
    if sort == "title":
        novels.sort(key=lambda novel: str(novel.get("title", "")).casefold())
    elif sort == "random":
        # A stable seed keeps page boundaries intact for the current day.
        random.Random(now()[:10]).shuffle(novels)
    else:
        novels.sort(key=lambda novel: int(novel.get("id") or 0), reverse=True)
    total = len(novels)
    start = (page - 1) * page_size
    return {
        "items": [_public_novel(novel) for novel in novels[start : start + page_size]],
        "total": total,
        "page": page,
        "page_size": page_size,
        "pages": max(1, (total + page_size - 1) // page_size),
        "has_more": start + page_size < total,
    }


@app.get("/catalogue/tags", tags=["data"])
def catalogue_tags():
    variants: dict[str, Counter] = {}
    for novel in _get_engine().metadata:
        seen: set[str] = set()
        for raw_tag in novel.get("tags", []):
            tag = str(raw_tag).strip()
            key = tag.casefold()
            if key and key not in seen:
                variants.setdefault(key, Counter())[tag] += 1
                seen.add(key)
    counts = [
        (forms.most_common(1)[0][0], sum(forms.values())) for forms in variants.values()
    ]
    highest = max((count for _, count in counts), default=1)
    return {
        "tags": [
            {
                "name": name,
                "count": count,
                "weight": round(0.75 + 1.25 * (count / highest) ** 0.45, 2),
            }
            for name, count in sorted(
                counts, key=lambda item: (-item[1], item[0].casefold())
            )
        ]
    }


@app.get("/catalogue/stats", tags=["data"])
def catalogue_stats():
    eng = _get_engine()
    storage = storage_usage()
    covers = cache_stats()
    return {
        "novels": eng.num_indexed,
        "storage_mb": storage["total"],
        "catalogue_mb": storage["catalogue"],
        "covers_mb": storage["covers"],
        "cached_covers": covers["cached_count"],
        "with_covers": sum(bool(novel.get("cover_url")) for novel in eng.metadata),
        "with_authors": sum(bool(novel.get("author")) for novel in eng.metadata),
    }


@app.get("/catalogue/featured", tags=["community"])
def catalogue_featured(limit: int = Query(default=12, ge=1, le=24)):
    return {"items": featured_favorites(limit)}


@app.get("/profiles/{username}", tags=["community"])
def public_profile(username: str):
    try:
        return public_reader_profile(username)
    except KeyError as exc:
        raise HTTPException(404, "Reader profile not found") from exc


# ── Personal library ───────────────────────────────────────────────────────


@app.get("/auth/me", tags=["auth"])
def auth_me(user: dict = Depends(user_from_request)):
    return user


@app.post("/auth/register", tags=["auth"])
def auth_register(req: Credentials):
    try:
        created = register(req.username, req.password)
        session = login(req.username, req.password)
        session["recovery_code"] = created["recovery_code"]
        return session
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.post("/auth/login", tags=["auth"])
def auth_login(req: Credentials):
    try:
        return login(req.username, req.password)
    except ValueError as exc:
        raise HTTPException(401, str(exc)) from exc


@app.post("/auth/logout", tags=["auth"])
def auth_logout(request: Request, user: dict = Depends(user_from_request)):
    logout(request.headers.get("Authorization", "")[7:])
    return {"status": "ok"}


@app.post("/auth/password", tags=["auth"])
def auth_change_password(
    req: PasswordChangeRequest, user: dict = Depends(user_from_request)
):
    try:
        change_password(user["id"], req.current_password, req.new_password)
        return {"status": "ok"}
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.post("/auth/reset", tags=["auth"])
def auth_reset_password(req: PasswordResetRequest):
    try:
        return {
            "status": "ok",
            "recovery_code": reset_password(
                req.username, req.recovery_code, req.new_password
            ),
        }
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.post("/auth/recovery-code", tags=["auth"])
def auth_rotate_recovery_code(user: dict = Depends(user_from_request)):
    return {"recovery_code": rotate_recovery_code(user["id"])}


@app.get("/collection", tags=["library"])
def get_collection(
    status: Optional[str] = Query(default=None), user: dict = Depends(user_from_request)
):
    return {"items": list_items(user["id"], status), "profile": profile(user["id"])}


@app.get("/profile", tags=["library"])
def get_profile(user: dict = Depends(user_from_request)):
    return profile(user["id"])


@app.put("/collection/{novel_id}", tags=["library"])
def save_to_collection(
    novel_id: int, req: CollectionSaveRequest, user: dict = Depends(user_from_request)
):
    novel = dict(_get_novel_by_id(novel_id))
    if novel.get("hand_authored"):
        novel["synopsis"] = ""
    try:
        return save_item(user["id"], novel, req.status, req.rating)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.post("/collection/import", tags=["library"])
def import_collection(
    req: LibraryImportRequest, user: dict = Depends(user_from_request)
):
    engine = _get_engine()
    saved = 0
    missing: list[str] = []
    for row in req.items:
        novel = engine.metadata_by_title.get(row.title.strip().casefold())
        if not novel:
            missing.append(row.title)
            continue
        safe_novel = dict(novel)
        if safe_novel.get("hand_authored"):
            safe_novel["synopsis"] = ""
        save_item(user["id"], safe_novel, row.status)
        saved += 1
    return {"saved": saved, "missing": missing[:50], "missing_count": len(missing)}


@app.put("/collection/{novel_id}/tier", tags=["library"])
def update_tier(
    novel_id: int, req: TierUpdateRequest, user: dict = Depends(user_from_request)
):
    try:
        return set_tier(user["id"], novel_id, req.tier or None, req.confirm_prediction)
    except KeyError as exc:
        raise HTTPException(404, "Save this novel before placing it in a tier") from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.put("/collection/{novel_id}/move", tags=["library"])
def move_collection_item(
    novel_id: int, req: TierMoveRequest, user: dict = Depends(user_from_request)
):
    try:
        return move_item(user["id"], novel_id, req.tier, req.ordered_novel_ids)
    except KeyError as exc:
        raise HTTPException(404, "Save this novel before moving it") from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.post("/collection/{novel_id}/cover/cache", tags=["library"])
async def cache_collection_cover(
    novel_id: int, user: dict = Depends(user_from_request)
):
    item = next(
        (item for item in list_items(user["id"]) if item["novel_id"] == novel_id), None
    )
    if not item:
        raise HTTPException(404, "Save this novel before caching its cover")
    if not item.get("cover_url"):
        raise HTTPException(422, "No cover URL is available for this novel")
    if is_cached(novel_id):
        return {"status": "already_cached", "novel_id": novel_id}
    import asyncio

    cached = await asyncio.get_running_loop().run_in_executor(
        None, fetch_and_cache, novel_id, item["cover_url"]
    )
    if not cached:
        raise HTTPException(502, "Could not download this cover")
    return {
        "status": "cached",
        "novel_id": novel_id,
        "size_kb": round(cached.stat().st_size / 1024, 1),
    }


@app.get("/analytics", tags=["library"])
def get_analytics(user: dict = Depends(user_from_request)):
    return reader_analytics(user["id"])


@app.get("/storage", tags=["system"])
def get_storage(user: dict = Depends(user_from_request)):
    return storage_usage()


@app.post("/requests", tags=["community"])
def create_novel_request(
    req: NovelRequestBody, user: dict = Depends(user_from_request)
):
    try:
        request_novel(user["id"], req.query, req.note)
        return {"status": "received"}
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.get("/novels/{novel_id}/reviews", tags=["community"])
def get_reviews(novel_id: int):
    return {"reviews": reviews(novel_id)}


@app.post("/novels/{novel_id}/reviews", tags=["community"])
def create_review(
    novel_id: int, req: ReviewRequest, user: dict = Depends(user_from_request)
):
    try:
        _get_novel_by_id(novel_id)
        return add_review(user["id"], novel_id, req.rating, req.body)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.get("/shared-collections", tags=["community"])
def get_shared_collections(request: Request):
    try:
        user = user_from_request(request)
        viewer_id = user["id"]
    except HTTPException:
        viewer_id = None
    return {"collections": list_collections(viewer_id)}


@app.post("/shared-collections", tags=["community"])
def post_shared_collection(
    req: SharedCollectionRequest, user: dict = Depends(user_from_request)
):
    try:
        return create_collection(user["id"], req.name, req.description, req.visibility)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.get("/shared-collections/{collection_id}", tags=["community"])
def get_one_shared_collection(collection_id: int, request: Request):
    try:
        user = user_from_request(request)
    except HTTPException:
        user = None
    try:
        return get_shared_collection(collection_id, user["id"] if user else None)
    except KeyError as exc:
        raise HTTPException(404, "Collection not found") from exc
    except PermissionError as exc:
        raise HTTPException(403, "This collection is private") from exc


@app.post("/shared-collections/{collection_id}/items", tags=["community"])
def post_shared_item(
    collection_id: int,
    req: AddSharedItemRequest,
    user: dict = Depends(user_from_request),
):
    try:
        add_to_collection(user["id"], collection_id, req.novel_id)
        return {"status": "added"}
    except KeyError as exc:
        raise HTTPException(404, "Collection or saved title not found") from exc
    except PermissionError as exc:
        raise HTTPException(403, "Only the owner can edit this collection") from exc


@app.put(
    "/shared-collections/{collection_id}/items/{novel_id}/move", tags=["community"]
)
def put_shared_item_move(
    collection_id: int,
    novel_id: int,
    req: SharedTierMoveRequest,
    user: dict = Depends(user_from_request),
):
    try:
        move_shared_collection_item(
            user["id"], collection_id, novel_id, req.tier, req.ordered_novel_ids
        )
        return {"status": "moved"}
    except KeyError as exc:
        raise HTTPException(404, "Collection item not found") from exc
    except PermissionError as exc:
        raise HTTPException(403, "Only the owner can edit this collection") from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.put("/shared-collections/{collection_id}/follow", tags=["community"])
def put_follow_collection(
    collection_id: int, req: FollowRequest, user: dict = Depends(user_from_request)
):
    try:
        follow_collection(user["id"], collection_id, req.following)
        return {"following": req.following}
    except KeyError as exc:
        raise HTTPException(404, "Collection not found") from exc
    except PermissionError as exc:
        raise HTTPException(403, "This collection is private") from exc


@app.get("/shared-collections/{collection_id}/comments", tags=["community"])
def get_collection_comments(collection_id: int):
    return {"comments": collection_comments(collection_id)}


@app.post("/shared-collections/{collection_id}/comments", tags=["community"])
def post_collection_comment(
    collection_id: int, req: ReviewRequest, user: dict = Depends(user_from_request)
):
    try:
        return add_collection_comment(user["id"], collection_id, req.body)
    except KeyError as exc:
        raise HTTPException(404, "Collection not found") from exc
    except PermissionError as exc:
        raise HTTPException(403, "This collection is private") from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


def _run_scrape_job_unlocked(
    job_id: int, source: str, limit: int, query: str = "", source_url: str = ""
) -> None:
    from community import connection, now

    with connection() as conn:
        conn.execute(
            "UPDATE scrape_jobs SET status='running',detail=?,updated_at=? WHERE id=?",
            (
                f"Collecting up to {limit} metadata records from {source}…",
                now(),
                job_id,
            ),
        )
    scrape_source = "all" if query else source
    command = [
        sys.executable,
        str(Path(__file__).parent.parent / "scripts" / "scrape_novels.py"),
        "--site",
        scrape_source,
        "--limit",
        str(limit),
    ]
    if query:
        command.extend(["--query", query])
    elif source == "repair":
        command = [
            sys.executable,
            str(Path(__file__).parent.parent / "scripts" / "scrape_novels.py"),
            "--repair-incomplete",
            "--limit",
            str(limit),
        ]
    elif source == "custom":
        command = [
            sys.executable,
            str(Path(__file__).parent.parent / "scripts" / "scrape_novels.py"),
            "--url",
            source_url,
            "--limit",
            str(limit),
        ]
    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            cwd=Path(__file__).parent.parent,
        )
        recent: deque[str] = deque(maxlen=45)
        last_update = 0.0
        for line in process.stdout or []:
            if line.strip():
                recent.append(line.rstrip())
            if time.monotonic() - last_update >= 2:
                with connection() as conn:
                    conn.execute(
                        "UPDATE scrape_jobs SET detail=?,updated_at=? WHERE id=?",
                        (
                            "\n".join(recent)[-4000:]
                            or "Connecting to metadata source…",
                            now(),
                            job_id,
                        ),
                    )
                last_update = time.monotonic()
        return_code = process.wait()
        detail = (
            "\n".join(recent)[-4000:]
            or "Collection finished without additional output."
        )
        status = "completed" if return_code == 0 else "failed"
    except Exception as exc:
        detail = f"Collection could not start: {exc}"
        status = "failed"
    with connection() as conn:
        conn.execute(
            "UPDATE scrape_jobs SET status=?,detail=?,updated_at=? WHERE id=?",
            (status, detail, now(), job_id),
        )
    if status == "completed" and _engine:
        _engine.reload_index()
        sync_catalogue_metadata(_engine.metadata)


def _run_scrape_job(
    job_id: int, source: str, limit: int, query: str = "", source_url: str = ""
) -> None:
    with _catalogue_job_lock:
        _run_scrape_job_unlocked(job_id, source, limit, query, source_url)


def _run_index_job_unlocked(job_id: int) -> None:
    from community import connection, now

    with connection() as conn:
        conn.execute(
            "UPDATE scrape_jobs SET status='running',detail=?,updated_at=? WHERE id=?",
            ("Rebuilding the search index after catalogue edits…", now(), job_id),
        )
    command = [
        sys.executable,
        str(Path(__file__).parent.parent / "scripts" / "build_index.py"),
    ]
    try:
        result = subprocess.run(
            command, capture_output=True, text=True, cwd=Path(__file__).parent.parent
        )
        detail = (result.stdout + "\n" + result.stderr)[
            -4000:
        ] or "Index rebuild finished."
        status = "completed" if result.returncode == 0 else "failed"
    except Exception as exc:
        detail = f"Index rebuild could not start: {exc}"
        status = "failed"
    with connection() as conn:
        conn.execute(
            "UPDATE scrape_jobs SET status=?,detail=?,updated_at=? WHERE id=?",
            (status, detail, now(), job_id),
        )
    if status == "completed" and _engine:
        _engine.reload_index()
        sync_catalogue_metadata(_engine.metadata)


def _run_index_job(job_id: int) -> None:
    with _catalogue_job_lock:
        _run_index_job_unlocked(job_id)


def _queue_index_job(user_id: int, tasks: BackgroundTasks, detail: str) -> int:
    from community import connection

    with connection() as conn:
        cursor = conn.execute(
            "INSERT INTO scrape_jobs (user_id,source,limit_count,status,detail,created_at,updated_at) VALUES (?, 'catalogue_edit', 1, 'queued', ?, ?, ?)",
            (user_id, detail, now(), now()),
        )
    tasks.add_task(_run_index_job, cursor.lastrowid)
    return int(cursor.lastrowid)


@app.post("/admin/scrapes", tags=["admin"])
def start_scrape(
    req: ScrapeRequest, tasks: BackgroundTasks, user: dict = Depends(user_from_request)
):
    require_admin(user)
    source_url = _custom_source_url(req.source_url) if req.source == "custom" else ""
    from community import connection

    with connection() as conn:
        cursor = conn.execute(
            "INSERT INTO scrape_jobs (user_id,source,limit_count,status,created_at,updated_at) VALUES (?,?,?,'queued',?,?)",
            (user["id"], req.source, req.limit, now(), now()),
        )
    tasks.add_task(
        _run_scrape_job, cursor.lastrowid, req.source, req.limit, "", source_url
    )
    return {"job_id": cursor.lastrowid, "status": "queued"}


@app.post("/admin/novels", tags=["admin"])
def admin_create_novel(
    req: CatalogueRecordRequest,
    tasks: BackgroundTasks,
    user: dict = Depends(user_from_request),
):
    require_admin(user)
    try:
        record = create_record(req.model_dump())
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    job_id = _queue_index_job(
        user["id"], tasks, f"Indexing new catalogue record: {record['title']}"
    )
    return {"novel": _public_novel(record), "job_id": job_id, "status": "indexing"}


@app.put("/admin/novels/{novel_id}", tags=["admin"])
def admin_update_novel(
    novel_id: int,
    req: CatalogueRecordRequest,
    tasks: BackgroundTasks,
    user: dict = Depends(user_from_request),
):
    require_admin(user)
    try:
        record, old_cover = update_record(novel_id, req.model_dump())
    except KeyError as exc:
        raise HTTPException(404, "Catalogue record not found") from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    if old_cover != record.get("cover_url", ""):
        delete_cached(novel_id)
    job_id = _queue_index_job(
        user["id"], tasks, f"Indexing catalogue edits: {record['title']}"
    )
    return {"novel": _public_novel(record), "job_id": job_id, "status": "indexing"}


@app.post("/admin/discover-title", tags=["admin"])
def discover_title(
    req: DirectTitleRequest,
    tasks: BackgroundTasks,
    user: dict = Depends(user_from_request),
):
    """Search every configured metadata provider for one title and its series."""
    require_admin(user)
    title = req.title.strip()
    existing = _get_engine().metadata_by_title.get(title.casefold())
    if existing:
        return {"status": "already_indexed", "novel": _public_novel(existing)}
    from community import connection

    with connection() as conn:
        cursor = conn.execute(
            "INSERT INTO scrape_jobs (user_id,source,limit_count,status,detail,created_at,updated_at) VALUES (?,?,?,'queued',?,?,?)",
            (
                user["id"],
                "direct_search",
                30,
                f"Searching all metadata sources for {title} and related series titles.",
                now(),
                now(),
            ),
        )
    tasks.add_task(_run_scrape_job, cursor.lastrowid, "direct_search", 30, title)
    return {"job_id": cursor.lastrowid, "status": "queued"}


@app.get("/admin/scrapes", tags=["admin"])
def list_scrape_jobs(user: dict = Depends(user_from_request)):
    require_admin(user)
    from community import connection

    with connection() as conn:
        rows = conn.execute(
            "SELECT * FROM scrape_jobs ORDER BY id DESC LIMIT 20"
        ).fetchall()
    return {"jobs": [dict(row) for row in rows]}


@app.get("/admin/requests", tags=["admin"])
def list_requests_for_admin(user: dict = Depends(user_from_request)):
    require_admin(user)
    return {"requests": list_novel_requests()}


@app.put("/admin/requests/{request_id}", tags=["admin"])
def update_request_for_admin(
    request_id: int, req: RequestStatusRequest, user: dict = Depends(user_from_request)
):
    require_admin(user)
    try:
        return set_novel_request_status(request_id, req.status)
    except KeyError as exc:
        raise HTTPException(404, "Catalogue request not found") from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


# ── Health ─────────────────────────────────────────────────────────────────


@app.get("/health", response_model=HealthResponse, tags=["system"])
def health():
    eng = _get_engine()
    return HealthResponse(
        status="ok",
        total_indexed=eng.num_indexed,
        cover_cache=cache_stats(),
    )


@app.get("/robots.txt", include_in_schema=False)
def robots(request: Request):
    base = str(request.base_url).rstrip("/")
    body = f"User-agent: *\nAllow: /\nDisallow: /admin/\nDisallow: /auth/\nDisallow: /collection/\nSitemap: {base}/sitemap.xml\n"
    return Response(body, media_type="text/plain")


@app.get("/sitemap.xml", include_in_schema=False)
def sitemap(request: Request):
    base = str(request.base_url).rstrip("/")
    body = f'<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>{base}/</loc></url></urlset>'
    return Response(body, media_type="application/xml")


# ── Index reload ───────────────────────────────────────────────────────────


@app.post("/index/reload", tags=["system"])
def reload_index(user: dict = Depends(user_from_request)):
    require_admin(user)
    _get_engine().reload_index()
    return {"status": "ok", "total_indexed": _engine.num_indexed}


# ── Cover endpoints ────────────────────────────────────────────────────────


@app.get("/covers/stats", tags=["covers"])
def cover_stats(user: dict = Depends(user_from_request)):
    """Return statistics about the local cover image cache."""
    return cache_stats()


@app.get("/covers/{novel_id}", tags=["covers"])
def get_cover(novel_id: int):
    """
    Serve locally cached cover image for a novel.
    Returns 404 if not cached — use POST /covers/{id}/fetch to download it first.
    """
    cached = get_cached_path(novel_id)
    if not cached:
        raise HTTPException(
            404,
            f"Cover for novel #{novel_id} not cached. "
            "POST /covers/{novel_id}/fetch to download it.",
        )
    return FileResponse(
        str(cached),
        media_type=_cover_media_type(cached),
        headers={"Cache-Control": "public, max-age=86400"},
    )


@app.post("/covers/{novel_id}/fetch", tags=["covers"])
async def fetch_cover(novel_id: int, user: dict = Depends(user_from_request)):
    """
    Download and cache the cover image for a novel locally.
    The cover_url must already be in the novel's database entry.
    Returns the cached path info.
    """
    require_admin(user)
    novel = _get_novel_by_id(novel_id)
    cover_url = novel.get("cover_url", "")

    if not cover_url:
        raise HTTPException(
            422,
            f"Novel #{novel_id} has no cover_url — scrape it first or add one manually.",
        )

    # Already cached?
    if is_cached(novel_id):
        cached = get_cached_path(novel_id)
        size_kb = cached.stat().st_size / 1024
        return {
            "status": "already_cached",
            "novel_id": novel_id,
            "title": novel.get("title"),
            "path": str(cached),
            "size_kb": round(size_kb, 1),
            "serve_url": f"/covers/{novel_id}",
        }

    import asyncio

    loop = asyncio.get_event_loop()
    cached = await loop.run_in_executor(None, fetch_and_cache, novel_id, cover_url)

    if not cached:
        raise HTTPException(502, f"Failed to download cover from {cover_url}")

    size_kb = cached.stat().st_size / 1024
    return {
        "status": "cached",
        "novel_id": novel_id,
        "title": novel.get("title"),
        "path": str(cached),
        "size_kb": round(size_kb, 1),
        "serve_url": f"/covers/{novel_id}",
    }


@app.delete("/covers/{novel_id}", tags=["covers"])
def remove_cover(novel_id: int, user: dict = Depends(user_from_request)):
    """Delete a locally cached cover to free disk space."""
    require_admin(user)
    deleted = delete_cached(novel_id)
    if not deleted:
        raise HTTPException(404, f"No cached cover for novel #{novel_id}")
    return {"status": "deleted", "novel_id": novel_id}


@app.get("/covers/{novel_id}/proxy", tags=["covers"])
async def proxy_cover(novel_id: int):
    """
    Proxy the cover image directly from the source URL without caching.
    Use when you want to display a cover without storing it locally.
    Falls back to cached version if available.
    """
    # Prefer cached
    cached = get_cached_path(novel_id)
    if cached:
        return FileResponse(str(cached), media_type=_cover_media_type(cached))

    novel = _get_novel_by_id(novel_id)
    cover_url = novel.get("cover_url", "")
    if not cover_url:
        raise HTTPException(404, f"Novel #{novel_id} has no cover_url")

    import asyncio

    loop = asyncio.get_event_loop()
    cached = await loop.run_in_executor(None, fetch_and_cache, novel_id, cover_url)
    if not cached:
        raise HTTPException(502, f"Could not proxy cover from {cover_url}")
    return FileResponse(
        str(cached),
        media_type=_cover_media_type(cached),
        headers={"Cache-Control": "public, max-age=86400"},
    )


# ── Bulk cover operations ──────────────────────────────────────────────────


@app.post("/covers/bulk-fetch", tags=["covers"])
async def bulk_fetch_covers(
    novel_ids: List[int], user: dict = Depends(user_from_request)
):
    """
    Fetch and cache covers for a list of novel IDs.
    Returns per-novel results. Max 50 at a time to avoid hammering sources.
    """
    require_admin(user)
    if len(novel_ids) > 50:
        raise HTTPException(400, "Max 50 novel IDs per bulk request")

    eng = _get_engine()
    id_to_novel = {n.get("id"): n for n in eng.metadata if n.get("id") in novel_ids}

    import asyncio

    results = []
    for nid in novel_ids:
        novel = id_to_novel.get(nid)
        if not novel:
            results.append({"novel_id": nid, "status": "not_found"})
            continue

        cover_url = novel.get("cover_url", "")
        if not cover_url:
            results.append(
                {"novel_id": nid, "title": novel.get("title"), "status": "no_cover_url"}
            )
            continue

        if is_cached(nid):
            results.append(
                {
                    "novel_id": nid,
                    "title": novel.get("title"),
                    "status": "already_cached",
                }
            )
            continue

        loop = asyncio.get_event_loop()
        cached = await loop.run_in_executor(None, fetch_and_cache, nid, cover_url)
        results.append(
            {
                "novel_id": nid,
                "title": novel.get("title"),
                "status": "cached" if cached else "failed",
            }
        )
        await asyncio.sleep(0.3)  # small delay between downloads

    return {"results": results, "total": len(results)}


# Serving the client here keeps `make serve` same-origin. The frontend is a
# small fixed bundle, so direct reads avoid filesystem worker-thread overhead
# and make the custom 404 status unambiguous.
@app.get("/{asset_path:path}", include_in_schema=False)
def frontend_asset(asset_path: str):
    requested = asset_path or "index.html"
    candidate = (_frontend_dir / requested).resolve()
    if _frontend_dir.resolve() not in candidate.parents or not candidate.is_file():
        candidate = _frontend_dir / "404.html"
        status_code = 404
    else:
        status_code = 200
    media_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
    cache = (
        "public, max-age=86400"
        if candidate.suffix in {".css", ".js", ".svg"}
        else "no-cache"
    )
    return Response(
        candidate.read_bytes(),
        status_code=status_code,
        media_type=media_type,
        headers={"Cache-Control": cache, "X-Content-Type-Options": "nosniff"},
    )


# ── Entry point ────────────────────────────────────────────────────────────

if __name__ == "__main__":
    port = int(os.getenv("PORT", 8080))
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=port,
        reload=os.getenv("DEV_RELOAD") == "1",
        log_level="info",
    )
