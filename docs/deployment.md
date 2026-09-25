# Deploying NoveList on Render

NoveList is a single FastAPI process that also serves the frontend. Its two SQLite databases, cached covers, collector state, and search index live under `NOVELIST_DATA_DIR`. Keep that directory on a persistent disk. The repository does not contain catalogue records or covers.

The root `render.yaml` describes one paid Docker web service, one instance, and a 1 GB disk mounted at `/app/backend/data`. The `1c-2g` compute plan is a deliberate starting point for the local sentence-encoder model; check Render's current price before creating the service. Render's free service cannot attach a persistent disk. A disk-backed service has a brief interruption during deployment and cannot scale to multiple instances. [Render disk documentation](https://render.com/docs/disks)

## Before creating the service

1. Run `make test` and `make lint` locally. Create a remote Git repository and push this repository after reviewing `git status`; no catalogue database, covers, or index should be tracked.
2. Create a Render Blueprint from that repository's `render.yaml` in your existing account. Set a long, unique `ADMIN_PASSWORD` as a secret when prompted. The app reads Render's `PORT` automatically. `/health` is the health check.
3. Wait for the empty application to become healthy. A first deployment intentionally has zero catalogue records. To demonstrate the interface without third-party material, open the service shell and run `cd /app && python scripts/seed_demo.py && python scripts/build_index.py`, then restart the service. The seed refuses a nonempty catalogue.
4. Add a custom subdomain, such as `novels.example.com`, to this new service in Render, then set the DNS record Render specifies. Link to that subdomain from the portfolio. Keep NoveList at the domain root; its current asset and API paths are root-relative. [Render custom-domain documentation](https://render.com/docs/custom-domains)
5. Visit the domain over HTTPS. Check anonymous preview, sign-in, full search, a saved reading state, and persistence after a restart. A new account can sign in and browse the full catalogue. The preview limit is a product flow, not a content-rights control.

The local `docker compose up --build` setup also uses a single data mount at `backend/data/`. Its Nginx container serves the frontend on port 3000; the Render service uses FastAPI's built-in static serving and does not need Nginx.

## Back up and restore

From the repository root, run `make backup DEST=/absolute/path/novelist-backup.zip` or `python scripts/state_backup.py backup /absolute/path/novelist-backup.zip`. The tool uses SQLite's online backup API, includes cached covers and search artifacts, and refuses a catalogue/index mismatch. Copy the archive off the service's disk to storage you control and protect it as account data. Render's disk snapshots are useful but do not replace an independently retained backup. [Render disk snapshots](https://render.com/docs/disks#disk-snapshots)

To restore, stop the old service and use an **empty** data directory on the persistent disk. Run `python scripts/state_backup.py restore /absolute/path/novelist-backup.zip --data-dir /absolute/path/to/empty/data`. The tool checks file hashes and refuses to overwrite existing state. Set `NOVELIST_DATA_DIR` to that restored directory if it differs from the mounted default, then start the service and verify `/health`, sign-in, and search. Test a restore before treating a backup as your recovery plan.

## Content review

The optional seed contains fictional demonstration records only. Importing the old local catalogue or enabling metadata collection on a public service needs a source-by-source rights review for descriptions and covers. A sign-in wall does not establish permission to reuse third-party content. See [data sources](data-sources.md).
