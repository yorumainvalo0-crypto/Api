# Image every code execution runs in: no network, non-root, read-only root file system.
FROM mirror.gcr.io/library/python:3.12-slim-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends nodejs fonts-dejavu-core zip unzip file \
    && rm -rf /var/lib/apt/lists/*

# Optional extra CA bundle for builds behind a TLS-inspecting proxy: put build-ca.pem into the build
# context. Plain COPY/RUN only, so the classic builder works too (servers without buildx)
COPY requirements.txt build-ca.pe[m] /tmp/
RUN if [ -f /tmp/build-ca.pem ]; then export PIP_CERT=/tmp/build-ca.pem; fi; \
    pip install --no-cache-dir -r /tmp/requirements.txt && rm -f /tmp/requirements.txt /tmp/build-ca.pem

RUN useradd --uid 1000 --create-home sandbox && mkdir -p /mnt/data && chown sandbox /mnt/data
USER sandbox
WORKDIR /mnt/data
ENV HOME=/mnt/data MPLBACKEND=Agg PYTHONDONTWRITEBYTECODE=1
