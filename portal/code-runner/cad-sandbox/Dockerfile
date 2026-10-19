# Image for CAD executions (build123d / OpenCascade): no network, non-root, read-only root fs.
FROM mirror.gcr.io/library/python:3.12-slim-bookworm

# OpenCascade wheels link against these X/GL libraries even without a display
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgl1 libglu1-mesa libxrender1 libxext6 fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /tmp/requirements.txt
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export PIP_CERT=/run/secrets/ca; fi; \
    pip install --no-cache-dir -r /tmp/requirements.txt && rm /tmp/requirements.txt

# Warm up the CAD kernel import once at build time (and fail the build if it is broken)
RUN python3 -c "import build123d, trimesh; print('cad ok')"

RUN useradd --uid 1000 --create-home sandbox && mkdir -p /mnt/data && chown sandbox /mnt/data
USER sandbox
WORKDIR /mnt/data
ENV HOME=/mnt/data MPLBACKEND=Agg PYTHONDONTWRITEBYTECODE=1
