FROM python:3.11-slim

# ── System deps ────────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential curl \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    NOVELIST_DATA_DIR=/app/backend/data

WORKDIR /app

# ── Python deps ────────────────────────────────────────────────────────────
COPY backend/requirements.txt /app/requirements.txt
COPY scripts/requirements-scraper.txt /app/requirements-scraper.txt
RUN pip install --no-cache-dir -r requirements.txt -r requirements-scraper.txt

# ── App code ───────────────────────────────────────────────────────────────
COPY backend/ /app/backend/
COPY scripts/  /app/scripts/
COPY frontend/ /app/frontend/

# Pre-download the embedding model during build (avoids cold-start delay)
RUN python -c "from sentence_transformers import SentenceTransformer; \
               SentenceTransformer('all-MiniLM-L6-v2')"

WORKDIR /app/backend

EXPOSE 8080
CMD ["python", "main.py"]
