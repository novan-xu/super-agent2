import { performance } from "node:perf_hooks";
import { dot, type Scorer } from "./vectors.js";

export interface ModelSpec {
  readonly name: string;
  readonly model: string;
  readonly dtype: "fp32" | "q8";
  readonly pooling: "mean" | "cls";
  readonly prefix: string;
}

export interface ModelFile {
  readonly path: string;
  readonly sha256: string;
}

export interface PinnedModel extends ModelSpec {
  readonly revision: string;
  readonly files: readonly ModelFile[];
}

export const bgeSmallZh: PinnedModel = {
  name: "bge-small-zh",
  model: "Xenova/bge-small-zh-v1.5",
  revision: "75c43b069aac4d136ba6bc1122f995fedcfd2781",
  dtype: "fp32",
  pooling: "cls",
  prefix: "",
  files: [
    { path: "config.json", sha256: "d4193ead3a810fd694fa8a31d7fc72fbaebc0668b603e398734bf2f6538ff42f" },
    { path: "tokenizer.json", sha256: "48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26" },
    { path: "tokenizer_config.json", sha256: "e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a" },
    { path: "onnx/model.onnx", sha256: "69a0b846f4f116b5e6aabf9546ea6754d02264f3211a13a1bd69b31b8040749a" },
  ],
};

export interface ModelSource {
  readonly directory: string;
  readonly offline: boolean;
}

export async function modelScorer(spec: ModelSpec, source: ModelSource): Promise<Scorer> {
  const transformers = await import("@huggingface/transformers");
  if (source.offline) {
    transformers.env.allowRemoteModels = false;
    transformers.env.allowLocalModels = true;
    transformers.env.localModelPath = source.directory;
  } else {
    transformers.env.cacheDir = source.directory;
  }
  const started = performance.now();
  const extractor = await transformers.pipeline("feature-extraction", spec.model, { dtype: spec.dtype, device: "cpu" });
  const loadMs = performance.now() - started;
  return {
    name: spec.name,
    loadMs,
    represent: async (text) => {
      const output = await extractor(`${spec.prefix}${text}`, { pooling: spec.pooling, normalize: true });
      return Float32Array.from(output.data as Float32Array);
    },
    similarity: dot,
  };
}
