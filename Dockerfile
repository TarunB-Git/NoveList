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
# The service runs on CPU; install the CPU wheel before sentence-transformers.
RUN pip install --no-cache-dir --timeout 120 --retries 3 torch --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir --timeout 120 --retries 3 -r requirements.txt -r requirements-scraper.txt

# Cache the model separately so frontend edits do not download it again.
RUN python -c "from sentence_transformers import SentenceTransformer; \
               SentenceTransformer('all-MiniLM-L6-v2')"

# ── App code ───────────────────────────────────────────────────────────────
COPY backend/ /app/backend/
COPY scripts/  /app/scripts/
COPY frontend/ /app/frontend/

WORKDIR /app/backend

EXPOSE 8080
CMD ["python", "main.py"]
