#!/usr/bin/env python
"""Collect public catalogue metadata from supported catalogue sources.

Each entry records title, author, synopsis, tags, source URL, and a cover URL.
Only metadata is collected; no reading content is downloaded.
"""

from __future__ import annotations

import argparse
import difflib
import ipaddress
import json
import logging
import random
import re
import sys
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional
from urllib.parse import quote_plus, urljoin, urlparse

from bs4 import BeautifulSoup

ROOT_DIR = Path(__file__).parent.parent
BACKEND_DIR = ROOT_DIR / "backend"
SCRAPED_URLS_PATH = BACKEND_DIR / "data" / "scraped_urls.txt"
STATE_PATH = BACKEND_DIR / "data" / "scrape_state.json"
REPAIR_HISTORY_PATH = BACKEND_DIR / "data" / "repair_history.json"
sys.path.insert(0, str(Path(__file__).parent))
from title_normalizer import title_key  # noqa: E402
sys.path.insert(0, str(BACKEND_DIR))
from catalogue_store import load_records  # noqa: E402

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s"
)
logger = logging.getLogger("scraper")

NAVIGATION_LABELS = {"browse", "latest novels", "completed novels"}


def clean(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def first_text(soup: BeautifulSoup, *selectors: str) -> str:
    for selector in selectors:
        node = soup.select_one(selector)
        if node and (text := clean(node.get_text(" "))):
            return text
    return ""


def first_long_text(soup: BeautifulSoup, minimum: int, *selectors: str) -> str:
    for selector in selectors:
        for node in soup.select(selector):
            value = clean(node.get_text(" "))
            if len(value) >= minimum:
                return value
    return ""


def texts(soup: BeautifulSoup, *selectors: str) -> list[str]:
    values = []
    for selector in selectors:
        for node in soup.select(selector):
            value = clean(node.get_text(" "))
            if value and value.casefold() not in {item.casefold() for item in values}:
                values.append(value)
    return values


def image_url(soup: BeautifulSoup, *selectors: str) -> str:
    for selector in selectors:
        node = soup.select_one(selector)
        if not node:
            continue
        value = (
            node.get("data-src")
            or node.get("data-lazy-src")
            or node.get("src")
            or node.get("content")
            or ""
        )
        if not value and node.get("srcset"):
            value = str(node.get("srcset")).split(",")[-1].strip().split(" ")[0]
        if value and not value.endswith(".gif"):
            return value
    return ""


def json_ld_metadata(soup: BeautifulSoup) -> dict:
    """Read publisher-supplied Book metadata before relying on page layout."""
    candidates: list[dict] = []
    for node in soup.select("script[type='application/ld+json']"):
        try:
            payload = json.loads(node.string or node.get_text() or "{}")
        except (TypeError, json.JSONDecodeError):
            continue
        stack = payload if isinstance(payload, list) else [payload]
        while stack:
            value = stack.pop()
            if isinstance(value, list):
                stack.extend(value)
            elif isinstance(value, dict):
                graph = value.get("@graph")
                if isinstance(graph, list):
                    stack.extend(graph)
                kind = value.get("@type", "")
                kinds = kind if isinstance(kind, list) else [kind]
                if any(
                    str(item).casefold() in {"book", "creativework"} for item in kinds
                ):
                    candidates.append(value)
    if not candidates:
        return {}
    data = max(candidates, key=lambda item: len(str(item.get("description", ""))))
    authors = data.get("author") or data.get("creator") or []
    if not isinstance(authors, list):
        authors = [authors]
    author = ", ".join(
        clean(str(item.get("name", "") if isinstance(item, dict) else item))
        for item in authors
        if item
    )
    image = data.get("image") or ""
    if isinstance(image, list):
        image = image[0] if image else ""
    if isinstance(image, dict):
        image = image.get("url") or image.get("contentUrl") or ""
    genres = data.get("genre") or []
    if isinstance(genres, str):
        genres = [part.strip() for part in genres.split(",")]
    aliases = data.get("alternateName") or []
    if isinstance(aliases, str):
        aliases = [aliases]
    description = BeautifulSoup(
        str(data.get("description") or ""), "html.parser"
    ).get_text(" ")
    return {
        "title": clean(str(data.get("name") or data.get("headline") or "")),
        "author": clean(author),
        "synopsis": clean(description),
        "cover_url": str(image),
        "tags": [clean(str(tag)) for tag in genres if clean(str(tag))],
        "title_aliases": [clean(str(alias)) for alias in aliases if clean(str(alias))],
    }


def _catalogue_urls() -> tuple[set[str], set[str]]:
    """Return all known URLs and the subset whose metadata is complete."""
    novels = load_records()
    known, complete = set(), set()
    for novel in novels:
        urls = {
            str(item.get("url", ""))
            for item in novel.get("urls", [])
            if item.get("url")
        }
        known.update(urls)
        if (
            novel.get("author")
            and novel.get("cover_url")
            and len(str(novel.get("synopsis", ""))) >= 120
        ):
            complete.update(urls)
    return known, complete


def load_seen() -> set[str]:
    historic = set()
    if SCRAPED_URLS_PATH.exists():
        historic = {
            line.strip()
            for line in SCRAPED_URLS_PATH.read_text(encoding="utf-8").splitlines()
            if line.strip()
        }
    known, _ = _catalogue_urls()
    # Broad expansion never revisits a detail URL. Metadata repair is a separate,
    # title-targeted operation with its own retry ledger.
    return historic | known


def catalogue_title_keys() -> set[str]:
    novels = load_records()
    return {
        title_key(value)
        for novel in novels
        for value in [novel.get("title", ""), *(novel.get("title_aliases") or [])]
        if title_key(str(value))
    }


def load_repair_history() -> dict[str, dict]:
    try:
        payload = json.loads(REPAIR_HISTORY_PATH.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def save_repair_history(history: dict[str, dict]) -> None:
    REPAIR_HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = REPAIR_HISTORY_PATH.with_suffix(".json.tmp")
    temporary.write_text(
        json.dumps(history, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    temporary.replace(REPAIR_HISTORY_PATH)


def repair_candidates(
    catalogue: list[dict], history: dict[str, dict], current_time: int
) -> list[dict]:
    candidates = []
    for novel in catalogue:
        incomplete = (
            novel.get("hand_authored")
            or not novel.get("cover_url")
            or not novel.get("author")
            or len(str(novel.get("synopsis") or "")) < 120
        )
        if not incomplete:
            continue
        key = title_key(str(novel.get("title") or ""))
        previous = history.get(key, {})
        if (
            previous.get("status") == "repaired"
            or int(previous.get("retry_after") or 0) > current_time
        ):
            continue
        candidates.append(novel)
    return candidates


def load_state() -> dict[str, int]:
    try:
        return {
            str(key): max(1, int(value))
            for key, value in json.loads(STATE_PATH.read_text(encoding="utf-8")).items()
        }
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return {}


def save_state(state: dict[str, int]) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")


def mark_seen(url: str) -> None:
    SCRAPED_URLS_PATH.parent.mkdir(parents=True, exist_ok=True)
    with SCRAPED_URLS_PATH.open("a", encoding="utf-8") as handle:
        handle.write(url + "\n")


@dataclass
class ScrapedNovel:
    title: str
    synopsis: str
    author: str = ""
    tags: list[str] = field(default_factory=list)
    source: str = ""
    status: str = ""
    url: str = ""
    cover_url: str = ""
    title_aliases: list[str] = field(default_factory=list)

    def valid(self) -> bool:
        return bool(self.title) and len(self.synopsis) >= 80

    def as_dict(self) -> dict:
        return {
            "title": self.title,
            "author": self.author,
            "synopsis": self.synopsis,
            "tags": self.tags,
            "source": self.source,
            "status": self.status,
            "url": self.url,
            "cover_url": self.cover_url,
            "title_aliases": self.title_aliases,
        }


class BaseScraper(ABC):
    site_name = ""
    base_url = ""
    pages_per_run = 6

    def __init__(
        self, session, limit: int, seen: set[str], start_page: int = 1, query: str = ""
    ):
        self.session, self.limit, self.seen, self.items = session, limit, seen, []
        self.start_page, self.query = start_page, query.strip()
        self.listings_scanned = 0
        self.known_titles = catalogue_title_keys() if not self.query else set()
        self.collected_titles: set[str] = set()

    def page_numbers(self) -> range:
        return range(self.start_page, self.start_page + self.pages_per_run)

    def get(self, url: str) -> Optional[BeautifulSoup]:
        for attempt in range(3):
            try:
                response = self.session.get(url, timeout=20)
                if response.status_code in {429, 500, 502, 503, 504} and attempt < 2:
                    retry_after = float(response.headers.get("Retry-After") or 0)
                    time.sleep(max(retry_after, self.session.delay * (attempt + 2)))
                    continue
                response.raise_for_status()
                time.sleep(self.session.delay + random.uniform(0.1, 0.4))
                return BeautifulSoup(response.text, "lxml")
            except Exception as exc:
                if attempt == 2:
                    logger.warning("%s: %s", url[:70], exc)
                else:
                    time.sleep(self.session.delay * (attempt + 1))
        return None

    def scrape(self) -> list[dict]:
        listing_urls = (
            self.search_urls(self.query) if self.query else self.listing_urls()
        )
        sibling_urls: list[str] = []
        for url in listing_urls:
            if len(self.items) >= self.limit:
                break
            soup = self.get(url)
            if not soup:
                continue
            self.listings_scanned += 1
            logger.info("%s: scanning listing %s", self.site_name, url)
            for detail_url in self.links(soup):
                if len(self.items) >= self.limit:
                    break
                if detail_url in self.seen:
                    continue
                novel = self.detail(detail_url)
                if not novel or not novel.valid():
                    continue
                if (
                    self.query
                    and max(
                        self._title_similarity(value, self.query)
                        for value in [novel.title, *novel.title_aliases]
                    )
                    < 0.52
                ):
                    continue
                key = title_key(novel.title)
                if (
                    not key
                    or key in self.collected_titles
                    or (not self.query and key in self.known_titles)
                ):
                    self.seen.add(detail_url)
                    mark_seen(detail_url)
                    continue
                self.items.append(novel)
                self.seen.add(detail_url)
                mark_seen(detail_url)
                self.collected_titles.add(key)
                logger.info(
                    "%s: collected %d/%d: %s",
                    self.site_name,
                    len(self.items),
                    self.limit,
                    novel.title[:70],
                )
                if self.query:
                    sibling_urls.extend(self.series_siblings(detail_url))
        for detail_url in list(dict.fromkeys(sibling_urls))[:24]:
            if len(self.items) >= self.limit:
                break
            if detail_url in self.seen:
                continue
            novel = self.detail(detail_url)
            if novel and novel.valid():
                key = title_key(novel.title)
                if not key or key in self.collected_titles:
                    self.seen.add(detail_url)
                    mark_seen(detail_url)
                    continue
                self.items.append(novel)
                self.seen.add(detail_url)
                mark_seen(detail_url)
                self.collected_titles.add(key)
                logger.info(
                    "%s: collected related title %d/%d: %s",
                    self.site_name,
                    len(self.items),
                    self.limit,
                    novel.title[:70],
                )
        return [item.as_dict() for item in self.items]

    @staticmethod
    def _title_similarity(title: str, query: str) -> float:
        left, right = clean(title).casefold(), clean(query).casefold()
        if left == right:
            return 1.0
        if left in right or right in left:
            return 0.85
        return difflib.SequenceMatcher(None, left, right).ratio()

    def search_urls(self, query: str) -> list[str]:
        return []

    def series_siblings(self, detail_url: str) -> list[str]:
        soup = self.get(detail_url)
        if not soup:
            return []
        series_pages = [
            urljoin(self.base_url, str(link.get("href", "")))
            for link in soup.select("a[href*='/series/'],a[href*='series_id']")
        ]
        siblings: list[str] = []
        for series_url in list(dict.fromkeys(series_pages))[:2]:
            series = self.get(series_url)
            if series:
                siblings.extend(self.links(series))
        return [url for url in dict.fromkeys(siblings) if url != detail_url]

    @abstractmethod
    def listing_urls(self) -> list[str]: ...
    @abstractmethod
    def links(self, soup: BeautifulSoup) -> list[str]: ...
    @abstractmethod
    def detail(self, url: str) -> Optional[ScrapedNovel]: ...


class RoyalRoadScraper(BaseScraper):
    site_name = "royalroad"
    base_url = "https://www.royalroad.com"

    def listing_urls(self) -> list[str]:
        return [
            f"{self.base_url}/fictions/best-rated?tagsAdd={tag}&page={page}"
            for tag in ("cultivation", "progression", "litrpg", "fantasy")
            for page in self.page_numbers()
        ]

    def search_urls(self, query: str) -> list[str]:
        return [f"{self.base_url}/fictions/search?title={quote_plus(query)}"]

    def links(self, soup: BeautifulSoup) -> list[str]:
        return list(
            dict.fromkeys(
                urljoin(self.base_url, str(a.get("href", "")).split("?")[0])
                for a in soup.select("h2.fiction-title a,.fiction-list-item h2 a")
                if "/fiction/" in str(a.get("href", ""))
            )
        )

    def detail(self, url: str) -> Optional[ScrapedNovel]:
        soup = self.get(url)
        if not soup:
            return None
        structured = json_ld_metadata(soup)
        title = first_text(
            soup, "h1[property='name']", "h1.font-white", "h1"
        ) or structured.get("title", "")
        synopsis = first_text(
            soup, "div.description", "div.summary", ".fiction-description"
        ) or structured.get("synopsis", "")
        if not title:
            return None
        cover = image_url(
            soup,
            ".cover-art img",
            ".fiction-cover img",
            "img[src*='/images/covers/']",
            "meta[property='og:image']",
        ) or structured.get("cover_url", "")
        return ScrapedNovel(
            title,
            synopsis,
            first_text(soup, "a.author", "[property='author']")
            or structured.get("author", ""),
            texts(soup, "span.tags a", ".fiction-tags a") or structured.get("tags", []),
            "Royal Road",
            first_text(soup, ".label-success", ".label-warning"),
            url,
            urljoin(self.base_url, cover) if cover else "",
            structured.get("title_aliases", []),
        )


class GenreCatalogueScraper(BaseScraper):
    """Small resilient adapter for public genre listing pages."""

    listing_paths: tuple[str, ...] = ()
    title_selectors: tuple[str, ...] = ("h1",)
    synopsis_selectors: tuple[str, ...] = (
        "[itemprop='description']",
        ".summary",
        ".description",
        "#description",
    )
    tag_selectors: tuple[str, ...] = ("a[href*='genre']", "a[href*='tag']")
    link_selectors: tuple[str, ...] = (
        "a[href*='/book/']",
        "a[href*='/series/']",
        "a[href*='/novel/']",
    )

    def listing_urls(self) -> list[str]:
        return [
            urljoin(self.base_url, path.format(page=page))
            for path in self.listing_paths
            for page in self.page_numbers()
        ]

    def links(self, soup: BeautifulSoup) -> list[str]:
        urls = []
        for selector in self.link_selectors:
            for link in soup.select(selector):
                href = str(link.get("href", "")).split("?")[0]
                if href and "chapter" not in href:
                    urls.append(urljoin(self.base_url, href))
        return list(dict.fromkeys(urls))

    def detail(self, url: str) -> Optional[ScrapedNovel]:
        soup = self.get(url)
        if not soup:
            return None
        structured = json_ld_metadata(soup)
        title = first_text(soup, *self.title_selectors) or structured.get("title", "")
        synopsis = first_text(soup, *self.synopsis_selectors) or structured.get(
            "synopsis", ""
        )
        if not title:
            return None
        author = first_text(
            soup, ".author", "a.author", "[itemprop='author']", "[class*='author']"
        ) or structured.get("author", "")
        cover = image_url(
            soup,
            ".cover img",
            ".book img",
            ".poster img",
            "img[itemprop='image']",
            "meta[property='og:image']",
        ) or structured.get("cover_url", "")
        tags = list(dict.fromkeys(
            tag for tag in [*texts(soup, *self.tag_selectors)[:20], *structured.get("tags", [])]
            if tag.casefold() not in NAVIGATION_LABELS
        ))
        aliases = list(structured.get("title_aliases", []))
        if self.site_name == "novelupdates":
            for value in texts(
                soup,
                "#editassociated .seriesother",
                ".seriesother",
                "[class*='associated']",
            ):
                aliases.extend(
                    clean(part)
                    for part in re.split(r"\s*[|;/]\s*", value)
                    if clean(part) and clean(part).casefold() != title.casefold()
                )
        return ScrapedNovel(
            title,
            synopsis,
            author,
            tags,
            self.site_name,
            "",
            url,
            urljoin(self.base_url, cover) if cover else "",
            list(dict.fromkeys(aliases))[:30],
        )


class NovelFullScraper(GenreCatalogueScraper):
    site_name = "novelfull"
    base_url = "https://novelfull.com"
    listing_paths = ("/genre/Xianxia?page={page}", "/genre/Xuanhuan?page={page}")
    link_selectors = ("h3.truyen-title a", "div.list-truyen-item-wrap h3 a")
    title_selectors = ("h3.title", "h1.book-title", "h1")
    synopsis_selectors = (
        "div.desc-text",
        "#tab-description",
        "div[itemprop='description']",
    )

    def search_urls(self, query: str) -> list[str]:
        return [f"{self.base_url}/search?keyword={quote_plus(query)}"]


class NovelFireScraper(GenreCatalogueScraper):
    site_name = "novelfire_xianxia_xuanhuan"
    base_url = "https://novelfire.net"
    listing_paths = (
        "/genre-xianxia/sort-popular/status-ongoing/chinese-novel?page={page}",
        "/genre-xuanhuan/sort-popular/status-ongoing/chinese-novel?page={page}",
    )
    link_selectors = ("a[href*='/book/']",)
    synopsis_selectors = ("#summary", ".summary", "[class*='summary']", ".description")

    def search_urls(self, query: str) -> list[str]:
        return [f"{self.base_url}/search?keyword={quote_plus(query)}"]


class NovelUpdatesScraper(GenreCatalogueScraper):
    site_name = "novelupdates"
    base_url = "https://www.novelupdates.com"
    listing_paths = (
        "/genre/xianxia/page/{page}/?order=1&sort=2&status=2",
        "/genre/xuanhuan/page/{page}/?order=1&sort=2&status=2",
    )
    link_selectors = ("a[href*='/series/']",)
    synopsis_selectors = (
        ".series-summary",
        ".summary-content",
        "[class*='summary']",
        ".description",
    )

    def search_urls(self, query: str) -> list[str]:
        return [f"{self.base_url}/series-finder/?sf=1&sh={quote_plus(query)}"]

    def series_siblings(self, detail_url: str) -> list[str]:
        return []


class GoogleBooksScraper(BaseScraper):
    """Exact-title adapter for publisher and library metadata in Google Books."""

    site_name = "google_books"
    base_url = "https://www.googleapis.com"

    def listing_urls(self) -> list[str]:
        return []

    def links(self, soup: BeautifulSoup) -> list[str]:
        return []

    def detail(self, url: str) -> Optional[ScrapedNovel]:
        return None

    def scrape(self) -> list[dict]:
        if not self.query or self.limit <= 0:
            return []
        url = f"{self.base_url}/books/v1/volumes?q=intitle:{quote_plus(self.query)}&maxResults=20&printType=books"
        try:
            response = self.session.get(url, timeout=20)
            response.raise_for_status()
            payload = response.json()
            self.listings_scanned = 1
        except Exception as exc:
            logger.warning("%s: %s", url[:70], exc)
            return []
        for item in payload.get("items", []):
            info = item.get("volumeInfo") or {}
            title = clean(str(info.get("title") or ""))
            if not title or self._title_similarity(title, self.query) < 0.52:
                continue
            description = clean(
                BeautifulSoup(
                    str(info.get("description") or ""), "html.parser"
                ).get_text(" ")
            )
            images = info.get("imageLinks") or {}
            cover = (
                images.get("extraLarge")
                or images.get("large")
                or images.get("medium")
                or images.get("thumbnail")
                or ""
            )
            if cover.startswith("http://"):
                cover = "https://" + cover[7:]
            novel = ScrapedNovel(
                title=title,
                synopsis=description,
                author=", ".join(info.get("authors") or []),
                tags=[
                    clean(str(tag))
                    for tag in info.get("categories") or []
                    if clean(str(tag))
                ],
                source="Google Books",
                status="",
                url=info.get("canonicalVolumeLink") or info.get("infoLink") or "",
                cover_url=cover,
            )
            if novel.valid():
                self.items.append(novel)
                logger.info(
                    "%s: collected %d/%d: %s",
                    self.site_name,
                    len(self.items),
                    self.limit,
                    title[:70],
                )
            if len(self.items) >= self.limit:
                break
        return [item.as_dict() for item in self.items]


SCRAPERS = {
    "royalroad": RoyalRoadScraper,
    "novelfull": NovelFullScraper,
    "novelfire": NovelFireScraper,
    "novelupdates": NovelUpdatesScraper,
}
QUERY_SCRAPERS = {**SCRAPERS, "google_books": GoogleBooksScraper}


def session(delay: float):
    import requests

    result = requests.Session()
    result.headers.update({
        "User-Agent": "NoveList metadata collector/1.0",
        "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    })
    result.delay = delay
    return result


def _public_http_url(value: str) -> str:
    parsed = urlparse(value.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("A complete public HTTP or HTTPS URL is required")
    if parsed.hostname.casefold() in {"goodreads.com", "www.goodreads.com"}:
        raise ValueError("Goodreads pages are not supported as metadata sources")
    if parsed.hostname.casefold() in {"localhost", "localhost.localdomain"}:
        raise ValueError("Local addresses cannot be collected")
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
        raise ValueError("Private network addresses cannot be collected")
    return parsed.geturl()


def scrape_custom_url(client, value: str) -> list[dict]:
    """Collect one administrator-supplied public metadata page."""
    url = _public_http_url(value)
    try:
        response = client.get(url, timeout=25, allow_redirects=False)
        if 300 <= response.status_code < 400:
            raise ValueError("Redirecting metadata pages are not supported")
        response.raise_for_status()
        final_url = _public_http_url(response.url)
    except Exception as exc:
        logger.error("Custom metadata page could not be read: %s", exc)
        return []
    soup = BeautifulSoup(response.text, "lxml")
    structured = json_ld_metadata(soup)
    title = structured.get("title") or first_text(
        soup, "meta[property='og:title']", "h1", "title"
    )
    if not title:
        title_node = soup.select_one("meta[property='og:title']")
        title = clean(str(title_node.get("content", ""))) if title_node else ""
    description_node = soup.select_one(
        "meta[name='description'],meta[property='og:description']"
    )
    synopsis = structured.get("synopsis") or first_long_text(
        soup,
        80,
        ".j_synopsis",
        "[class*='synopsis']",
        "[id*='synopsis']",
        "[itemprop='description']",
        ".series-summary",
        ".book-description",
        ".description",
        ".summary",
        "#description",
    )
    if not synopsis and description_node:
        synopsis = clean(str(description_node.get("content", "")))
    author_node = soup.select_one("meta[name='author'],meta[property='book:author']")
    author = structured.get("author") or first_text(
        soup, "[itemprop='author']", ".author", "a[rel='author']"
    )
    if not author and author_node:
        author = clean(str(author_node.get("content", "")))
    if not author and description_node:
        match = re.search(
            r"written by (?:the author )?([^,]+)",
            str(description_node.get("content", "")),
            re.IGNORECASE,
        )
        author = clean(match.group(1)) if match else ""
    cover = structured.get("cover_url") or image_url(
        soup,
        "meta[property='og:image']",
        "meta[name='twitter:image']",
        "img[itemprop='image']",
        ".cover img",
        ".book-cover img",
    )
    tags = list(
        dict.fromkeys(
            clean(str(tag)).lstrip("# ")
            for tag in [
                *structured.get("tags", []),
                *texts(
                    soup, "[itemprop='genre']", "a[href*='genre']", "a[href*='tag']"
                )[:20],
            ]
            if clean(str(tag)).lstrip("# ")
        )
    )
    novel = ScrapedNovel(
        title=clean(title),
        synopsis=clean(synopsis),
        author=clean(author),
        tags=tags,
        source=urlparse(final_url).netloc.removeprefix("www."),
        url=final_url,
        cover_url=urljoin(final_url, cover) if cover else "",
        title_aliases=structured.get("title_aliases", []),
    )
    if not novel.valid():
        logger.error(
            "The supplied page did not expose a title and a usable description"
        )
        return []
    logger.info("custom: collected %s", novel.title[:70])
    return [novel.as_dict()]


def repair_incomplete(
    client, seen: set[str], limit: int, dry_run: bool, rebuild: bool
) -> None:
    catalogue = load_records()
    history = load_repair_history()
    current_time = int(time.time())
    incomplete = repair_candidates(catalogue, history, current_time)
    if not incomplete:
        logger.info("No incomplete catalogue records are due for repair")
        return
    incomplete.sort(
        key=lambda novel: (
            not novel.get("hand_authored"),
            bool(novel.get("cover_url")),
            bool(novel.get("author")),
            novel.get("title", ""),
        )
    )
    collected = []
    outcomes: dict[str, dict] = {}
    for position, novel in enumerate(incomplete[:limit], 1):
        title = str(novel.get("title") or "").strip()
        if not title:
            continue
        logger.info("Repairing %d/%d: %s", position, min(limit, len(incomplete)), title)
        matches = []
        repair_seen: set[str] = set()
        # Fast structured book metadata first, followed by specialist sources.
        for scraper_type in [
            GoogleBooksScraper,
            RoyalRoadScraper,
            NovelUpdatesScraper,
            NovelFullScraper,
            NovelFireScraper,
        ]:
            candidates = scraper_type(client, 3, repair_seen, query=title).scrape()
            matches.extend(
                item
                for item in candidates
                if max(
                    BaseScraper._title_similarity(str(value or ""), title)
                    for value in [item.get("title"), *(item.get("title_aliases") or [])]
                )
                >= 0.84
            )
            if any(
                item.get("author")
                and item.get("cover_url")
                and len(item.get("synopsis", "")) >= 120
                for item in matches
            ):
                break
        key = title_key(title)
        if matches:
            best = max(
                matches,
                key=lambda item: (
                    180 * bool(item.get("author"))
                    + 120 * bool(item.get("cover_url"))
                    + min(len(str(item.get("synopsis") or "")), 1200)
                    + 20 * len(item.get("tags") or [])
                ),
            )
            best["title"] = title
            collected.append(best)
            outcomes[key] = {
                "title": title,
                "status": "repaired",
                "last_attempt": current_time,
                "retry_after": 0,
            }
        else:
            outcomes[key] = {
                "title": title,
                "status": "unresolved",
                "last_attempt": current_time,
                "retry_after": current_time + 7 * 24 * 60 * 60,
            }
    if dry_run:
        print(json.dumps(collected[:20], ensure_ascii=False, indent=2))
        return
    history.update(outcomes)
    if not collected:
        save_repair_history(history)
        logger.error("No incomplete catalogue records could be enriched")
        raise SystemExit(4)
    from add_novels import add_novels

    add_novels(collected, rebuild=rebuild)
    save_repair_history(history)


def main() -> None:
    parser = argparse.ArgumentParser(description="Collect public catalogue metadata")
    parser.add_argument("--site", choices=[*SCRAPERS, "all"], default="royalroad")
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--delay", type=float, default=1.8)
    parser.add_argument("--query", default="")
    parser.add_argument("--url", default="")
    parser.add_argument("--repair-incomplete", action="store_true")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--no-rebuild", action="store_true")
    args = parser.parse_args()
    if args.limit < 1:
        parser.error("--limit must be at least 1")
    seen = load_seen()
    state = load_state()
    client = session(args.delay)
    results = []
    if args.repair_incomplete:
        repair_incomplete(client, seen, args.limit, args.dry_run, not args.no_rebuild)
        return
    if args.url:
        results = scrape_custom_url(client, args.url)
        if args.dry_run:
            print(json.dumps(results, ensure_ascii=False, indent=2))
            return
        if not results:
            raise SystemExit(4)
        if args.output:
            args.output.write_text(
                json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            return
        from add_novels import add_novels

        add_novels(results, rebuild=not args.no_rebuild)
        return
    scraper_types = QUERY_SCRAPERS if args.query else SCRAPERS
    sites = list(scraper_types) if args.site == "all" else [args.site]
    per_site = (
        (0 if args.limit == 0 else max(1, args.limit // len(sites)))
        if args.site == "all"
        else args.limit
    )
    listings_reached = 0
    for site in sites:
        start = 1 if args.query else state.get(site, 1)
        scraper = scraper_types[site](
            client, per_site, seen, start_page=start, query=args.query
        )
        results.extend(scraper.scrape())
        listings_reached += scraper.listings_scanned
        if not args.query and scraper.listings_scanned:
            state[site] = start + scraper.pages_per_run
    if args.dry_run:
        print(json.dumps(results[:5], ensure_ascii=False, indent=2))
        return
    if listings_reached == 0:
        logger.error(
            "No provider listing could be reached; the catalogue was not changed"
        )
        raise SystemExit(2)
    if args.query and not results:
        logger.error("No verified metadata record closely matched %r", args.query)
        raise SystemExit(4)
    save_state(state)
    if args.output:
        args.output.write_text(
            json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return
    from add_novels import add_novels

    add_novels(results, rebuild=not args.no_rebuild)


if __name__ == "__main__":
    main()
