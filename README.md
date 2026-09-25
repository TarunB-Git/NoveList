# NoveList

NoveList combines metadata search with a personal reading library. It is a FastAPI service with a small, framework-free JavaScript client, SQLite storage, and a local sentence-embedding index.

## What you can do

- Search a novel catalogue by title, alias, author, tag, or description, with semantic and keyword matches in one result list.
- Track reading status and ratings, import a CSV reading list, and arrange saved books into S–D tiers.
- Get tentative tier placements based on your own ratings, confirmed placements, matching tags, and reading status.
- Share collections and reviews. Administrators can edit catalogue records and run metadata collection jobs.

Guests can browse a 24-record catalogue preview; an account opens the full catalogue and personal features.

## Run locally

Use Python 3.11, `pip`, and `make`. Set a unique `ADMIN_PASSWORD` in `.env` before the first start.

```bash
cp .env.example .env
make install
make seed-demo
make serve
```

Open <http://localhost:8080>. `make seed-demo` loads 30 fictional sample records into an empty catalogue and builds their search index. It also downloads the sentence model on first use. To start with your own catalogue, skip the seed, add records through the administrator interface, and run `make index` after bulk imports.

## How the code works

| Path | Responsibility |
| --- | --- |
| [`backend/main.py`](backend/main.py) | FastAPI routes, authentication boundaries, catalogue browsing, and static client delivery. |
| [`backend/catalogue_store.py`](backend/catalogue_store.py), [`backend/collection.py`](backend/collection.py) | SQLite catalogue and per-reader library state. |
| [`backend/embedder.py`](backend/embedder.py), [`scripts/build_index.py`](scripts/build_index.py) | Build normalized embeddings and write NumPy vectors with matching metadata. |
| [`backend/search.py`](backend/search.py) | Load vectors into FAISS; combine cosine similarity with exact and token matches, then apply tag filters. |
| [`scripts/state_backup.py`](scripts/state_backup.py) | Snapshot SQLite state and package index and cover files with checksum verification. |
| [`frontend/index.html`](frontend/index.html), [`frontend/app.js`](frontend/app.js) | Accessible page structure, hash-based navigation, API calls, and tier-list interactions. |

Catalogue records and account/library data live in separate SQLite databases under `NOVELIST_DATA_DIR`. An index build turns each record's title, aliases, author, description, and tags into a vector using `all-MiniLM-L6-v2`. At startup, the API checks that index metadata matches the catalogue database. A query is embedded by the same model; FAISS retrieves vector candidates, and lexical matches boost exact titles and matching metadata. Search results then pass through tag and guest-preview filters.

[`backend/collection.py`](backend/collection.py) computes a reader's tentative tier from weighted ratings and direct tier choices. Matching tags adjust that baseline; reading status affects the weight of each signal. A direct placement stays fixed while later feedback recalculates tentative placements for saved books. The **What is it?** tab walks through these flows in the app.

## Development

```bash
make install-dev  # add test and lint dependencies
make test         # Python unittest suite
make lint         # Ruff and JavaScript syntax check; requires Node.js
make index        # rebuild the index from the local catalogue
```

[GitHub Actions](.github/workflows/ci.yml) runs the tests and lint checks on pushes and pull requests. `docker compose up --build` runs the API and an Nginx frontend locally. For a disk-backed deployment and backup procedure, see [deployment](docs/deployment.md).

## Data and license

The repository includes an optional fictional demo seed; application databases, downloaded cover images, and built index files stay outside Git. The app stores catalogue metadata and source links rather than book text. See [data sources and content rights](docs/data-sources.md) before importing third-party descriptions or covers.

Project code and original interface assets are under [Apache License 2.0](LICENSE); see [NOTICE](NOTICE) and [citation metadata](CITATION.cff). Third-party catalogue content has separate rights.
