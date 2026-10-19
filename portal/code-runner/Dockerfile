# Control plane: LibreChat Code API on :8000; starts one sandbox container per execution
# through the Docker socket.
FROM mirror.gcr.io/library/python:3.12-slim-bookworm
WORKDIR /app
# Optional extra CA bundle for builds behind a TLS-inspecting proxy: put build-ca.pem into the build
# context. Plain COPY/RUN only, so the classic builder works too (servers without buildx)
COPY requirements.txt build-ca.pe[m] /tmp/
RUN if [ -f /tmp/build-ca.pem ]; then export PIP_CERT=/tmp/build-ca.pem; fi; \
    pip install --no-cache-dir -r /tmp/requirements.txt && rm -f /tmp/requirements.txt /tmp/build-ca.pem
COPY runner ./runner
ENV STORE_DIR=/data/store
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3)"
CMD ["uvicorn", "runner.app:app_from_env", "--factory", "--host", "0.0.0.0", "--port", "8000"]
