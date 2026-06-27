FROM ghcr.io/astral-sh/uv:python3.14-bookworm-slim

WORKDIR /app/lambda-functions

ENV UV_PROJECT_ENVIRONMENT=/opt/lambda-functions-venv
ENV PATH="/opt/lambda-functions-venv/bin:$PATH"

COPY pyproject.toml uv.lock README.md .python-version ./
COPY src ./src

RUN uv sync --extra search --frozen --no-dev

ENTRYPOINT []
CMD ["sh", "-c", "python -m lambda_functions.build_search_index --docs-dir ../content --output /tmp/search.index && python -m lambda_functions.local_server --host 0.0.0.0 --port 8787"]
