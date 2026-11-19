import { performance } from "node:perf_hooks";

export type Vector = Float32Array;

export interface Scorer {
  readonly name: string;
  readonly loadMs: number;
  represent(text: string): Promise<Vector>;
  similarity(left: Vector, right: Vector): number;
}

export interface ModelSpec {
  readonly name: string;
  readonly model: string;
  readonly dtype: "fp32" | "q8";
  readonly pooling: "mean" | "cls";
  readonly prefix: string;
}

export const modelSpecs: readonly ModelSpec[] = [
  { name: "e5-small", model: "Xenova/multilingual-e5-small", dtype: "fp32", pooling: "mean", prefix: "query: " },
  { name: "bge-small-zh", model: "Xenova/bge-small-zh-v1.5", dtype: "fp32", pooling: "cls", prefix: "" },
  { name: "bge-m3", model: "Xenova/bge-m3", dtype: "q8", pooling: "cls", prefix: "" },
];

export function dot(left: Vector, right: Vector): number {
  let sum = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    sum += left[index]! * right[index]!;
  }
  return sum;
}

const bigramDimensions = 1 << 18;

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0) % bigramDimensions;
}

export function bigramUnits(text: string): string[] {
  const lowered = text.toLowerCase().normalize("NFKC");
  const units: string[] = [];
  for (const word of lowered.match(/[a-z0-9_.#-]{2,}/g) ?? []) {
    units.push(`w:${word}`);
  }
  const characters = [...lowered.replace(/[a-z0-9_.#-]+/g, " ").replace(/[\s\p{P}\p{S}]+/gu, " ")];
  for (let index = 0; index + 1 < characters.length; index += 1) {
    const pair = characters[index]! + characters[index + 1]!;
    if (!pair.includes(" ")) {
      units.push(`b:${pair}`);
    }
  }
  return units;
}

export function bigramScorer(): Scorer {
  return {
    name: "bigram",
    loadMs: 0,
    represent: (text) => {
      const counts = new Map<number, number>();
      for (const unit of bigramUnits(text)) {
        const key = hash(unit);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const keys = [...counts.keys()].sort((left, right) => left - right);
      const vector = new Float32Array(keys.length * 2);
      let norm = 0;
      keys.forEach((key, index) => {
        const weight = 1 + Math.log(counts.get(key)!);
        vector[index * 2] = key;
        vector[index * 2 + 1] = weight;
        norm += weight * weight;
      });
      const scale = norm === 0 ? 0 : 1 / Math.sqrt(norm);
      for (let index = 1; index < vector.length; index += 2) {
        vector[index] = vector[index]! * scale;
      }
      return Promise.resolve(vector);
    },
    similarity: (left, right) => {
      let leftIndex = 0;
      let rightIndex = 0;
      let sum = 0;
      while (leftIndex < left.length && rightIndex < right.length) {
        const leftKey = left[leftIndex]!;
        const rightKey = right[rightIndex]!;
        if (leftKey === rightKey) {
          sum += left[leftIndex + 1]! * right[rightIndex + 1]!;
          leftIndex += 2;
          rightIndex += 2;
        } else if (leftKey < rightKey) {
          leftIndex += 2;
        } else {
          rightIndex += 2;
        }
      }
      return sum;
    },
  };
}

export async function modelScorer(spec: ModelSpec, cacheDir: string): Promise<Scorer> {
  const transformers = await import("@huggingface/transformers");
  transformers.env.cacheDir = cacheDir;
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
