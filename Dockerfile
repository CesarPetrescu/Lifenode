# syntax=docker/dockerfile:1.7
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    APP_HOME=/app

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt requirements-llm.txt ./

ARG INSTALL_LLM_BACKEND=1
RUN pip install --upgrade pip setuptools wheel && \
    if [ "$INSTALL_LLM_BACKEND" = "1" ]; then \
        pip install -r requirements-llm.txt; \
    else \
        pip install -r requirements.txt; \
    fi

COPY app ./app
COPY static ./static
COPY README.md ./

RUN mkdir -p /app/data/drive /models && \
    useradd --create-home --uid 10001 lifenode && \
    chown -R lifenode:lifenode /app /models

USER lifenode

ENV LIFENODE_DATA_DIR=/app/data \
    LIFENODE_DB_PATH=/app/data/lifenode.db \
    LIFENODE_DRIVE_DIR=/app/data/drive \
    LIFENODE_WIKI_LANG=en \
    LIFENODE_HOST=0.0.0.0 \
    LIFENODE_PORT=8000 \
    LIFENODE_WORKERS=1 \
    LIFENODE_LOG_LEVEL=INFO \
    LIFENODE_CORS_ORIGINS=*

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import os,sys,urllib.request; p=os.getenv('LIFENODE_PORT','8000'); u=f'http://127.0.0.1:{p}/api/health'; sys.exit(0 if urllib.request.urlopen(u, timeout=3).status==200 else 1)"

CMD ["sh", "-c", "uvicorn app.main:app --host ${LIFENODE_HOST} --port ${LIFENODE_PORT} --workers ${LIFENODE_WORKERS}"]

