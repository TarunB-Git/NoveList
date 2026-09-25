.PHONY: install install-dev index migrate-catalogue seed-demo backup serve health test lint collect-all collect-title repair-metadata collect-novelfire collect-novelfull collect-novelupdates

PYTHON ?= python3

-include .env
ADMIN_USERNAME ?= admin
PORT ?= 8080
CORS_ORIGINS ?= http://localhost:3000,http://localhost:8080,http://127.0.0.1:3000,http://127.0.0.1:8080
export ADMIN_USERNAME ADMIN_PASSWORD PORT CORS_ORIGINS NOVELIST_DATA_DIR
ifneq ($(strip $(CORS_ORIGIN_REGEX)),)
export CORS_ORIGIN_REGEX
endif

install:
	$(PYTHON) -m pip install -r backend/requirements.txt
	$(PYTHON) -m pip install -r scripts/requirements-scraper.txt

install-dev: install
	$(PYTHON) -m pip install -r requirements-dev.txt

index:
	$(PYTHON) scripts/build_index.py

migrate-catalogue:
	$(PYTHON) backend/catalogue_store.py

seed-demo:
	$(PYTHON) scripts/seed_demo.py
	$(MAKE) index

backup:
	@test -n "$(DEST)" || (echo "Set DEST=/path/to/backup.zip" >&2; exit 1)
	$(PYTHON) scripts/state_backup.py backup "$(DEST)"

serve:
	cd backend && $(PYTHON) main.py

health:
	curl -s http://localhost:8080/health | $(PYTHON) -m json.tool

test:
	$(PYTHON) -m unittest discover -s tests -v

lint:
	ruff check backend scripts tests
	node --check frontend/app.js

collect-all:
	$(PYTHON) scripts/scrape_novels.py --site all --limit 100

collect-title:
	$(PYTHON) scripts/scrape_novels.py --site all --limit 30 --query "$(QUERY)"

repair-metadata:
	$(PYTHON) scripts/scrape_novels.py --repair-incomplete --limit 20

collect-novelfire:
	$(PYTHON) scripts/scrape_novels.py --site novelfire --limit 100

collect-novelfull:
	$(PYTHON) scripts/scrape_novels.py --site novelfull --limit 100

collect-novelupdates:
	$(PYTHON) scripts/scrape_novels.py --site novelupdates --limit 100
