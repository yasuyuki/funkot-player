# Isolated verification tool; no Tauri, audio, Android or app dependencies.
FROM rust:1.93-slim-trixie
RUN apt-get update && apt-get install -y --no-install-recommends python3 curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN cargo install --locked kani-verifier --version 0.68.0 \
    && cargo kani setup
WORKDIR /work
