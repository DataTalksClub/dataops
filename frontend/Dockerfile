FROM python:3.14-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends git openssh-client ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir 'uvicorn[standard]==0.34.0' 'httpx==0.27.2'

# The actual script + frontend are bind-mounted from the host at runtime
# (see compose.yaml). This image only carries the Python runtime + deps.
CMD ["python", "/app/serve_frontend.py"]
