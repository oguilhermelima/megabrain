# WHY a container at all: the suite starts tmux servers, writes agent configs and installs
# modules, and every one of those can reach the operator's own machine when a variable is
# forgotten. Inside here it cannot, whatever the test gets wrong.
FROM debian:bookworm-slim

# Only what the suite actually calls. Keeping the list this short is what makes the image
# cheap enough to rebuild whenever a dependency question comes up.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     bash jq git tmux procps ca-certificates curl tar nodejs unzip \
  && rm -rf /var/lib/apt/lists/*

# Install the pinned host-compatible Bun release so the copied checkout can
# compile its contract-test binary inside the Linux container.
ENV BUN_INSTALL=/opt/bun
RUN curl -fsSL https://bun.sh/install | bash -s -- bun-v1.3.14 \
  && chmod -R a+rx "$BUN_INSTALL" \
  && ln -s "$BUN_INSTALL/bin/bun" /usr/local/bin/bun

# A non-root user, because running the suite as root hides permission mistakes that a real
# operator would hit, and because the tests create files the host may later inspect.
RUN useradd --create-home --shell /bin/bash runner
# Keep temporary Git repositories consistent with the project's macOS fixtures. Debian's
# default is still master, while the worktree scenarios intentionally use main.
RUN git config --system init.defaultBranch main
USER runner
WORKDIR /work

ENV HOME=/home/runner
ENTRYPOINT ["/bin/bash"]
