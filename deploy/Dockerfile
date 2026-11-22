FROM node:24.14.1-bookworm-slim AS build
ENV CI=true
RUN npm install --global pnpm@12.18.0
WORKDIR /app
COPY . .
RUN --mount=type=cache,id=superagent2-pnpm-store,target=/pnpm-store pnpm install --frozen-lockfile --store-dir /pnpm-store
RUN pnpm --filter "@super-agent2/hub..." --filter "@super-agent2/brain..." --filter "@super-agent2/web..." build
RUN --mount=type=cache,id=superagent2-pnpm-store,target=/pnpm-store pnpm install --frozen-lockfile --prod --store-dir /pnpm-store

FROM node:24.14.1-bookworm-slim AS routing-model
ARG ROUTING_MODEL=Xenova/bge-small-zh-v1.5
ARG ROUTING_MODEL_REVISION=75c43b069aac4d136ba6bc1122f995fedcfd2781
RUN apt-get update \
 && apt-get install --yes --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /models/${ROUTING_MODEL}
RUN set -eu; \
    for pinned in \
      "config.json d4193ead3a810fd694fa8a31d7fc72fbaebc0668b603e398734bf2f6538ff42f" \
      "tokenizer.json 48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26" \
      "tokenizer_config.json e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a" \
      "onnx/model.onnx 69a0b846f4f116b5e6aabf9546ea6754d02264f3211a13a1bd69b31b8040749a"; do \
      file=${pinned%% *}; \
      mkdir -p "$(dirname "$file")"; \
      curl --fail --silent --show-error --location --retry 3 --output "$file" "https://huggingface.co/${ROUTING_MODEL}/resolve/${ROUTING_MODEL_REVISION}/$file"; \
      echo "${pinned##* }  $file" | sha256sum --check --strict; \
    done

FROM node:24.14.1-bookworm-slim AS hub
ARG GH_VERSION=2.102.0
RUN apt-get update \
 && apt-get install --yes --no-install-recommends bash ca-certificates curl git jq less openssh-client procps rsync sudo tar unzip xz-utils \
 && rm -rf /var/lib/apt/lists/*
RUN npm install --global @openai/codex@0.163.0 \
 && npm cache clean --force
RUN arch="$(dpkg --print-architecture)" \
 && curl --fail --silent --show-error --location "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${arch}.tar.gz" -o /tmp/gh.tar.gz \
 && tar -xzf /tmp/gh.tar.gz -C /tmp \
 && install -m 0755 "/tmp/gh_${GH_VERSION}_linux_${arch}/bin/gh" /usr/local/bin/gh \
 && rm -rf /tmp/gh.tar.gz "/tmp/gh_${GH_VERSION}_linux_${arch}"
RUN git config --system credential.https://github.com.helper "!/usr/local/bin/gh auth git-credential" \
 && printf 'node ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/node \
 && chmod 0440 /etc/sudoers.d/node \
 && mkdir -p /var/lib/superagent2/hub /var/lib/superagent2/link /share/Container/superagent2/projects /home/node/.ssh \
 && chmod 0700 /home/node/.ssh \
 && chown -R node:node /var/lib/superagent2 /share/Container/superagent2 /home/node
COPY --from=routing-model /models /opt/superagent2/models
COPY --from=build /app /app
USER node
WORKDIR /app/packages/hub
ENV NODE_ENV=production HOME=/home/node HUB_DATA_DIR=/var/lib/superagent2/hub HUB_PORT=8080 HUB_ROUTING_MODELS=/opt/superagent2/models
ARG SUPERAGENT2_REVISION=
ENV SUPERAGENT2_REVISION=${SUPERAGENT2_REVISION}
EXPOSE 8080
CMD ["node", "dist/main.js"]

FROM node:24.14.1-bookworm-slim AS brain
RUN apt-get update \
 && apt-get install --yes --no-install-recommends bash ca-certificates curl git jq less openssh-client procps ripgrep \
 && rm -rf /var/lib/apt/lists/*
RUN npm install --global @openai/codex@0.163.0 @anthropic-ai/claude-code@2.1.326 @deepseek-ai/dsh@0.2.1-rc.2 \
 && npm cache clean --force
RUN mkdir -p /home/node/.codex /home/node/.claude /home/node/.dsh /home/node/workspace /var/lib/superagent2/link /var/lib/superagent2/programs \
 && chown -R node:node /home/node /var/lib/superagent2
COPY --from=build /app /app
USER node
WORKDIR /app/packages/brain
ENV NODE_ENV=production HOME=/home/node CLAUDE_CONFIG_DIR=/home/node/.claude DISABLE_AUTOUPDATER=1
ARG SUPERAGENT2_REVISION=
ENV SUPERAGENT2_REVISION=${SUPERAGENT2_REVISION}
CMD ["node", "dist/main.js"]
