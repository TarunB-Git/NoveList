from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
from bs4 import BeautifulSoup
from fastapi.testclient import TestClient


ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "scripts"))

import accounts  # noqa: E402
import add_novels  # noqa: E402
import build_index  # noqa: E402
import catalogue_admin  # noqa: E402
import catalogue_store  # noqa: E402
import collection  # noqa: E402
import community  # noqa: E402
import covers  # noqa: E402
import main  # noqa: E402
import search  # noqa: E402
from scrape_novels import NovelFireScraper, _public_http_url, repair_candidates, scrape_custom_url  # noqa: E402
from title_normalizer import title_key  # noqa: E402


class FakeResponse:
    url = "https://publisher.example/books/example"
    status_code = 200
    text = """<!doctype html><html><head>
      <script type="application/ld+json">{
        "@context":"https://schema.org","@type":"Book","name":"Example Novel",
        "author":{"@type":"Person","name":"Example Writer"},
        "alternateName":["Example Story"],
        "description":"A source-supplied description long enough to pass catalogue validation and remain useful in semantic search results.",
        "genre":["Fantasy","Adventure"],"image":"https://publisher.example/cover.jpg"
      }</script></head><body><h1>Example Novel</h1></body></html>"""

    def raise_for_status(self) -> None:
        return None


class FakeClient:
    def get(
        self, url: str, timeout: int = 25, allow_redirects: bool = False
    ) -> FakeResponse:
        return FakeResponse()


class CoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        collection.DB_PATH = self.root / "library.db"
        catalogue_store.DB_PATH = self.root / "catalogue.db"
        catalogue_admin.LOCK_PATH = self.root / "catalogue.lock"
        add_novels.LOCK_PATH = self.root / "catalogue.lock"

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_index_round_trip_and_mismatched_metadata(self) -> None:
        class FakeEmbedder:
            dim = 2

            def __init__(self, *args, **kwargs) -> None:
                pass

            def embed(self, texts: list[str]) -> np.ndarray:
                vectors = [
                    [1.0, 0.0] if "dragon" in value.casefold() else [0.0, 1.0]
                    for value in texts
                ]
                return np.asarray(vectors, dtype=np.float32)

            def embed_one(self, text: str) -> np.ndarray:
                return self.embed([text])[0]

        records = [
            {"id": 1, "title": "Dragon Road", "title_aliases": [], "author": "",
             "synopsis": "A dragon story", "tags": ["fantasy"]},
            {"id": 2, "title": "Quiet Garden", "title_aliases": [], "author": "",
             "synopsis": "A garden story", "tags": ["slice of life"]},
        ]
        data_path = self.root / "novels.json"
        data_path.write_text(json.dumps(records), encoding="utf-8")
        index_dir = self.root / "index"

        with patch.object(build_index, "Embedder", FakeEmbedder):
            build_index.build_index(data_path, index_dir, "test-model")
        self.assertTrue((index_dir / "vectors.npy").exists())
        self.assertTrue((index_dir / "metadata.json").exists())
        self.assertFalse((index_dir / "metadata.pkl").exists())

        with patch.object(search, "Embedder", FakeEmbedder):
            engine = search.SearchEngine(index_dir)
            results, _ = asyncio.run(engine.search("Dragon Road", top_k=2))
            self.assertEqual(results[0]["title"], "Dragon Road")
            (index_dir / "metadata.json").write_text(
                json.dumps(records[:1]), encoding="utf-8"
            )
            with self.assertRaisesRegex(ValueError, "out of sync"):
                search.SearchEngine(index_dir)

    def test_catalogue_import_preserves_local_json_and_rejects_repeat(self) -> None:
        source = self.root / "novels.json"
        source.write_text('[{"id": 1, "title": "Example"}]', encoding="utf-8")
        self.assertEqual(catalogue_store.import_json(source), 1)
        self.assertEqual(catalogue_store.load_records()[0]["title"], "Example")
        self.assertTrue(source.exists())
        with self.assertRaisesRegex(ValueError, "already contains"):
            catalogue_store.import_json(source)

    def test_empty_index_supports_a_fresh_install(self) -> None:
        class FakeEmbedder:
            dim = 2

            def __init__(self, *args, **kwargs) -> None:
                pass

        with patch.object(search, "Embedder", FakeEmbedder):
            engine = search.SearchEngine(self.root / "missing-index")
            results, rewritten = asyncio.run(engine.search("anything"))
        self.assertEqual(engine.num_indexed, 0)
        self.assertEqual((results, rewritten), ([], None))

    def test_goodreads_metadata_collection_is_disabled(self) -> None:
        with self.assertRaisesRegex(ValueError, "Goodreads pages are not supported"):
            _public_http_url("https://www.goodreads.com/book/show/123")

    def test_catalogue_scraper_excludes_navigation_labels(self) -> None:
        page = BeautifulSoup("""
            <h1>River of Stars</h1>
            <a href="/genre/fantasy">Fantasy</a>
            <a href="/genre/browse">Browse</a>
            <a href="/genre/latest-novels">Latest Novels</a>
            <a href="/tag/finished">Completed Novels</a>
            <a href="/tag/adventure">Adventure</a>
        """, "html.parser")
        scraper = NovelFireScraper.__new__(NovelFireScraper)
        scraper.get = lambda url: page
        novel = scraper.detail("https://novelfire.net/book/river-of-stars")
        self.assertIsNotNone(novel)
        self.assertEqual(novel.tags, ["Fantasy", "Adventure"])

    def test_tag_counts_each_novel_once(self) -> None:
        engine = SimpleNamespace(metadata=[
            {"tags": ["Fantasy", "fantasy", "Action"]},
            {"tags": ["FANTASY"]},
        ])
        with patch.object(main, "_engine", engine):
            tags = {
                tag["name"].casefold(): tag["count"]
                for tag in main.catalogue_tags()["tags"]
            }
        self.assertEqual(tags["fantasy"], 2)
        self.assertEqual(tags["action"], 1)

    def test_cover_fetch_rejects_untrusted_hosts_and_redirects(self) -> None:
        class Response:
            status_code = 302
            headers = {"content-type": "image/jpeg"}

            def raise_for_status(self) -> None:
                pass

            def iter_content(self, chunk_size):
                yield b"x" * 600

        cover_dir = self.root / "covers"
        cover_dir.mkdir()
        with (
            patch.object(covers, "COVERS_DIR", cover_dir),
            patch.dict(os.environ, {"COVER_EXTRA_HOSTS": ""}),
            patch("requests.get", return_value=Response()) as get,
        ):
            self.assertIsNone(covers.fetch_and_cache(1, "https://127.0.0.1/a.jpg"))
            self.assertIsNone(covers.fetch_and_cache(1, "http://www.royalroadcdn.com/a.jpg"))
            self.assertIsNone(covers.fetch_and_cache(1, "https://[invalid/a.jpg"))
            get.assert_not_called()
            self.assertIsNone(covers.fetch_and_cache(
                1, "https://www.royalroadcdn.com/a.jpg"
            ))
            self.assertFalse(covers.is_cached(1))
            self.assertFalse(get.call_args.kwargs["allow_redirects"])

    def test_api_search_and_save_flow(self) -> None:
        novel = {
            "id": 7, "title": "Dragon Road", "title_aliases": [],
            "author": "Test Author", "synopsis": "A short test description.",
            "tags": ["fantasy"], "cover_url": "", "urls": [],
        }

        class FakeSearchEngine:
            def __init__(self) -> None:
                self.metadata = [novel]
                self.metadata_by_id = {7: novel}
                self.metadata_by_title = {"dragon road": novel}
                self.num_indexed = 1

            async def search(self, query, top_k=8, filter_tags=None):
                return ([{
                    "novel_id": 7, "title": novel["title"], "score": 0.9,
                    "reason": "Exact title", "synopsis": novel["synopsis"],
                    "tags": novel["tags"], "urls": [], "author": novel["author"],
                    "cover_url": "",
                }], None)

        with (
            patch.dict(os.environ, {"ADMIN_PASSWORD": "temporary-admin-password"}),
            patch.object(main, "SearchEngine", FakeSearchEngine),
            TestClient(main.app) as client,
        ):
            self.assertEqual(client.get("/health").json()["total_indexed"], 1)
            result = client.post("/search", json={"query": "Dragon Road"})
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.json()["results"][0]["novel_id"], 7)
            account = client.post(
                "/auth/register",
                json={"username": "reader_api", "password": "test-password"},
            )
            self.assertEqual(account.status_code, 200)
            headers = {"Authorization": f"Bearer {account.json()['token']}"}
            saved = client.put(
                "/collection/7", json={"status": "reading", "rating": 5},
                headers=headers,
            )
            self.assertEqual(saved.status_code, 200)
            self.assertEqual(saved.json()["tier"], "S")
            library = client.get("/collection", headers=headers)
            self.assertEqual(library.json()["items"][0]["title"], "Dragon Road")

    def test_rating_saves_and_updates_taste_prediction(self) -> None:
        collection.initialise()
        first = collection.save_item(
            1,
            {
                "id": 1,
                "title": "First",
                "author": "",
                "synopsis": "",
                "tags": ["cultivation"],
                "cover_url": "",
            },
            "completed",
            5,
        )
        second = collection.save_item(
            1,
            {
                "id": 2,
                "title": "Second",
                "author": "",
                "synopsis": "",
                "tags": ["cultivation"],
                "cover_url": "",
            },
        )
        self.assertEqual(first["personal_rating"], 5)
        self.assertEqual(first["tier"], "S")
        self.assertIn("5/5 rating", first["prediction_reason"])
        self.assertEqual(second["status"], "plan_to_read")
        self.assertEqual(second["predicted_tier"], "S")
        self.assertEqual(collection.profile(1)["feedback_count"], 1)
        updated = collection.save_item(
            1,
            {
                "id": 1,
                "title": "First",
                "author": "",
                "synopsis": "",
                "tags": ["cultivation"],
                "cover_url": "",
            },
            "reading",
        )
        self.assertEqual(updated["tier"], "S")

    def test_account_login_and_recovery_rotation(self) -> None:
        os.environ["ADMIN_PASSWORD"] = "temporary-admin-password"
        accounts.initialise_accounts()
        created = accounts.register("reader_one", "initial-password")
        accounts.login("reader_one", "initial-password")
        replacement = accounts.reset_password(
            "reader_one", created["recovery_code"], "replacement-password"
        )
        self.assertNotEqual(replacement, created["recovery_code"])
        with self.assertRaises(ValueError):
            accounts.login("reader_one", "initial-password")
        self.assertEqual(
            accounts.login("reader_one", "replacement-password")["user"]["username"],
            "reader_one",
        )

    def test_catalogue_create_and_full_edit(self) -> None:
        record = catalogue_admin.create_record(
            {
                "title": "Example Novel",
                "title_aliases": ["Example"],
                "author": "Writer",
                "synopsis": "Description",
                "tags": ["fantasy"],
                "source": "Publisher",
                "status": "Ongoing",
                "cover_url": "https://publisher.example/cover.jpg",
                "urls": [
                    {"site": "Publisher", "url": "https://publisher.example/book"}
                ],
            }
        )
        updated, old_cover = catalogue_admin.update_record(
            record["id"], {**record, "title": "Example Novel Revised"}
        )
        self.assertEqual(updated["title"], "Example Novel Revised")
        self.assertEqual(old_cover, "https://publisher.example/cover.jpg")
        self.assertEqual(updated["urls"][0]["site"], "Publisher")

    def test_source_alias_links_a_translated_title(self) -> None:
        catalogue_store.save_records(json.loads(
            '[{"id":1,"title":"Coiling Dragon","title_aliases":["Panlong"],"synopsis":"Existing source description","author":"I Eat Tomatoes","tags":["cultivation"],"source":"Publisher","status":"Completed","hand_authored":false,"cover_url":"","urls":[]}]'
        ))
        add_novels.add_novels(
            [
                {
                    "title": "Panlong",
                    "title_aliases": ["Coiling Dragon"],
                    "synopsis": "A second source description that remains linked to the same catalogue record.",
                    "author": "I Eat Tomatoes",
                    "tags": ["fantasy"],
                    "source": "Second publisher",
                    "url": "https://publisher.example/panlong",
                }
            ],
            rebuild=False,
        )
        records = add_novels.load_dataset()
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["title"], "Coiling Dragon")
        self.assertEqual(
            records[0]["urls"][0]["url"], "https://publisher.example/panlong"
        )

    def test_custom_metadata_page_uses_structured_book_data(self) -> None:
        records = scrape_custom_url(
            FakeClient(), "https://publisher.example/books/example"
        )
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["title"], "Example Novel")
        self.assertEqual(records[0]["author"], "Example Writer")
        self.assertEqual(records[0]["title_aliases"], ["Example Story"])
        self.assertEqual(records[0]["cover_url"], "https://publisher.example/cover.jpg")

    def test_custom_metadata_page_rejects_redirects(self) -> None:
        class RedirectingClient:
            def get(self, url, timeout=25, allow_redirects=False):
                self.assert_redirects_disabled = not allow_redirects
                response = FakeResponse()
                response.status_code = 302
                return response

        client = RedirectingClient()
        self.assertEqual(
            scrape_custom_url(client, "https://publisher.example/books/example"), []
        )
        self.assertTrue(client.assert_redirects_disabled)

    def test_repair_ledger_skips_restored_and_cooling_down_titles(self) -> None:
        catalogue = [
            {"title": "Restored", "author": "", "cover_url": "", "synopsis": ""},
            {"title": "Cooling Down", "author": "", "cover_url": "", "synopsis": ""},
            {"title": "Ready", "author": "", "cover_url": "", "synopsis": ""},
        ]
        history = {
            title_key("Restored"): {"status": "repaired", "retry_after": 0},
            title_key("Cooling Down"): {
                "status": "unresolved",
                "retry_after": 200,
            },
        }
        self.assertEqual(
            [item["title"] for item in repair_candidates(catalogue, history, 100)],
            ["Ready"],
        )

    def test_admin_can_complete_reader_request(self) -> None:
        os.environ["ADMIN_PASSWORD"] = "temporary-admin-password"
        accounts.initialise_accounts()
        reader = accounts.register("requester", "request-password")
        community.initialise_community()
        community.request_novel(reader["id"], "Requested Novel", "")
        request = community.list_novel_requests()[0]
        updated = community.set_novel_request_status(request["id"], "resolved")
        self.assertEqual(updated["status"], "resolved")


if __name__ == "__main__":
    unittest.main()
