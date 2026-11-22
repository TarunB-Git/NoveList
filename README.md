# novelist

Search a novel catalogue, track your reading, and rank books on a personal tier list. novelist also supports CSV reading-list imports, community collections, and reviews. Guests can explore sample novels and [Project Gutenberg](https://www.gutenberg.org/) classics. Sign in to browse the installation's catalogue.

## Run locally

You’ll need Python 3.11 and Make. From the repository root:

```bash
python3 -m venv .venv
source .venv/bin/activate
cp .env.example .env
make install
```

Set a unique `ADMIN_PASSWORD` in `.env` before the first start. For a fresh catalogue, `make seed-demo` adds fictional books and builds the search index. The first index build downloads the sentence model. If you already have catalogue data, skip the seed.

```bash
make serve
```

Open [novelist on localhost](http://localhost:8080). Sign in with the configured `ADMIN_USERNAME` (default `admin`) and the password you set. You can also create a reader account through the sign-in form.

### Existing installations

- The default data directory is `backend/data/`. For a different directory, set `NOVELIST_DATA_DIR` to an absolute path. It holds the catalogue, accounts, libraries, covers, and search index.
- Local and hosted copies use separate accounts and data unless configured to use the same installation. `ADMIN_PASSWORD` only creates the initial account. Use your recovery code or run `python scripts/reset_password.py admin` on the host to reset an existing password. Point the script at the installation’s data directory if you use a custom path.
- Add or edit catalogue records in the Admin tab. Run `make index` after bulk changes and restart the server to load the new index. `make health` shows how many records are loaded.
- Back up data with `make backup DEST=/absolute/path/to/novelist-backup.zip`. The [deployment guide](docs/deployment.md#back-up-and-restore) covers restore.

## Develop

```bash
make install-dev
make test
make lint        # JavaScript syntax checks require Node.js
```

- [Frontend](frontend/) contains the HTML, shared stylesheet, book interactions, and API client.
- [Backend](backend/) contains FastAPI routes, SQLite storage, search, and tier suggestions.
- [Scripts](scripts/) contains catalogue, indexing, and backup tools.

Read the [architecture overview](docs/architecture.md), [search benchmark](docs/search-benchmark.md), or [deployment guide](docs/deployment.md) for more detail.

## Data and license

novelist stores catalogue metadata and source links. See [data sources and content rights](docs/data-sources.md) before importing or publishing third-party descriptions and covers. The code and original assets are licensed under [Apache 2.0](LICENSE). See [NOTICE](NOTICE) for attribution.
