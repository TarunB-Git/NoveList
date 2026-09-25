# NoveList

NoveList is a self-hosted app for searching a novel catalogue and organizing a personal reading library and tier list.

## Overview

Visitors can browse and search a 24-record preview; signed-in readers can explore the full catalogue, save reading states and ratings, and arrange saved titles into S–D tiers. Accounts can publish reviews and shared collections. The catalogue belongs to the running installation; this repository ships only optional fictional demo records, not third-party book records or cover images.

## Current features

- Browse, search, and filter catalogue records by title, alias, author, tags, and description. Anonymous visitors see the latest 24 records; sign-in unlocks the whole catalogue.
- Save reading states and ratings, import a CSV reading list, and adjust tentative tier placements.
- Publish reviews and shared collections, follow collections, and request missing titles.
- Edit records and run administrator-controlled metadata collection jobs. Catalogue changes rebuild the search index.

## Getting started

Requirements: Python 3.11, `pip`, and `make`. The first index build downloads the `all-MiniLM-L6-v2` model if it is not cached. Node.js is needed for the JavaScript syntax check in `make lint`.

```bash
cp .env.example .env
# Set a long, unique ADMIN_PASSWORD in .env.
make install
make serve
```

Open <http://localhost:8080>. A fresh checkout starts with an empty catalogue. To explore the UI with 30 clearly fictional records, run `make seed-demo` before `make serve`; the seed refuses a nonempty catalogue. Sign in as the administrator to add real records. If you already have a local `backend/data/novels.json` from an older checkout, import it once, then build the index and restart the server:

```bash
make migrate-catalogue
make index
make serve
```

The import refuses to overwrite a nonempty catalogue database and leaves the JSON file intact. Only import records you are permitted to use. `backend/data/catalogue.db`, `backend/data/library.db`, cover caches, and the `backend/data/index/` search artifacts are ignored by Git and excluded from the Docker image. Set an absolute `NOVELIST_DATA_DIR` to move all mutable state to one persistent directory. Old `metadata.pkl` and `novels.faiss` artifacts are not loaded.

## How it works

The static client in `frontend/` calls the FastAPI app in `backend/main.py`. `backend/catalogue_store.py` stores catalogue records in SQLite; account, library, and community data use a separate SQLite database. An index build embeds catalogue text and writes NumPy vectors plus JSON metadata. The service loads those artifacts into an in-memory FAISS index and checks them against the catalogue database at startup. The 384-dimensional sentence encoder is not a generative LLM. Per-reader tier suggestions use a weighted average of personal ratings and chosen or confirmed tiers, adjusted by matching tags and reading state. Reordering or changing a tier recalculates still-tentative placements. This is a deterministic aid for saved books, not a trained recommendation system for unseen titles. The site’s **What is it?** tab explains both flows.

## Data and content

The application stores metadata and source links, not novel chapters or full books. The optional seed contains fictional demonstration records with no covers or source links; it is not a production catalogue. It can cache remote cover images locally, and its browser may request remote covers. Descriptions and covers can have separate rights even when their source pages are public. [Data sources and rights](docs/data-sources.md) records the known restrictions and the review needed before public deployment. The code license below does not apply to third-party catalogue content. Session tokens are stored in browser local storage; account and reading data stay in the local service database unless a user publishes a review or shared collection.

## Search and evaluation

`scripts/build_index.py` embeds titles, aliases, authors, tags, and descriptions with the local Sentence Transformers model `all-MiniLM-L6-v2`. Vectors are L2-normalized; an in-memory FAISS `IndexFlatIP` performs cosine-similarity retrieval. `backend/search.py` combines vector candidates with lexical title, alias, author, and tag matches, then applies exact tag filters. Displayed match reasons are explanations, not calibrated probabilities.

No judged query set or keyword baseline is present, so the repository makes no measured search-quality claim.

## Development and validation

```bash
make install-dev   # app, collector, test, and lint dependencies
make test          # unittest suite
make lint          # Ruff and JavaScript syntax check
make index         # rebuild from the local catalogue database
make health        # query a running service on localhost:8080
```

There is no configured type checker or frontend build step. GitHub Actions runs tests and lint on pushes and pull requests. Dependencies have version ranges rather than a lockfile.

## Deployment

`docker compose up --build` starts the backend on port 8080 and an Nginx frontend on port 3000. Set `ADMIN_PASSWORD` before starting; `ADMIN_USERNAME`, `NOVELIST_DATA_DIR`, `CORS_ORIGINS`, `CORS_ORIGIN_REGEX`, and `COVER_EXTRA_HOSTS` are configurable. Compose mounts `backend/data/` for both databases, covers, and the index. [Render deployment and backup instructions](docs/deployment.md) describe the separate, disk-backed service. A new installation has no catalogue until an administrator adds records, runs the optional demo seed, or imports a permitted local dataset. No public deployment URL is verified here.

## Limitations and future work

- Existing locally collected metadata needs a source-by-source accuracy and rights review before public use. Public accessibility alone does not establish reuse permission.
- Search relevance and catalogue quality have no human-judged evaluation.
- Dependencies have version ranges rather than a lockfile. Backups and empty-directory restores are supported, but operational backup scheduling and disaster-recovery drills are the operator’s responsibility.

## License and acknowledgements

The project source code and original interface assets are licensed under [Apache License 2.0](LICENSE). Redistributions must preserve its required notices; [NOTICE](NOTICE) names the copyright holder, and [CITATION.cff](CITATION.cff) gives a preferred citation for publications. This license does not grant rights to third-party descriptions, covers, or linked works. Search uses [Sentence Transformers](https://www.sbert.net/) and [FAISS](https://github.com/facebookresearch/faiss); other Python dependencies are listed in the requirements files.
