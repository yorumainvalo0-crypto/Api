# Control plane: LibreChat Code API on :8000; starts one sandbox container per execution
# through the Docker socket.
FROM mirror.gcr.io/library/python:3.12-slim-bookworm
WORKDIR /app
COPY requirements.txt .
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export PIP_CERT=/run/secrets/ca; fi; \
    pip install --no-cache-dir -r requirements.txt
COPY runner ./runner
ENV STORE_DIR=/data/store
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3)"
CMD ["uvicorn", "runner.app:app_from_env", "--factory", "--host", "0.0.0.0", "--port", "8000"]
