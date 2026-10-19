# Image every code execution runs in: no network, non-root, read-only root file system.
FROM mirror.gcr.io/library/python:3.12-slim-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends nodejs fonts-dejavu-core zip unzip file \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /tmp/requirements.txt
# Optional extra CA bundle for builds behind a TLS-inspecting proxy
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export PIP_CERT=/run/secrets/ca; fi; \
    pip install --no-cache-dir -r /tmp/requirements.txt && rm /tmp/requirements.txt

RUN useradd --uid 1000 --create-home sandbox && mkdir -p /mnt/data && chown sandbox /mnt/data
USER sandbox
WORKDIR /mnt/data
ENV HOME=/mnt/data MPLBACKEND=Agg PYTHONDONTWRITEBYTECODE=1
