# Image for CAD executions (build123d / OpenCascade): no network, non-root, read-only root fs.
FROM mirror.gcr.io/library/python:3.12-slim-bookworm

# OpenCascade wheels link against these X/GL libraries even without a display
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgl1 libglu1-mesa libxrender1 libxext6 fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

# Optional extra CA bundle for builds behind a TLS-inspecting proxy: put build-ca.pem into the build
# context. Plain COPY/RUN only, so the classic builder works too (servers without buildx)
COPY requirements.txt build-ca.pe[m] /tmp/
RUN if [ -f /tmp/build-ca.pem ]; then export PIP_CERT=/tmp/build-ca.pem; fi; \
    pip install --no-cache-dir -r /tmp/requirements.txt && rm -f /tmp/requirements.txt /tmp/build-ca.pem

# Warm up the CAD kernel import once at build time (and fail the build if it is broken)
RUN python3 -c "import build123d, trimesh; print('cad ok')"

RUN useradd --uid 1000 --create-home sandbox && mkdir -p /mnt/data && chown sandbox /mnt/data
USER sandbox
WORKDIR /mnt/data
ENV HOME=/mnt/data MPLBACKEND=Agg PYTHONDONTWRITEBYTECODE=1
