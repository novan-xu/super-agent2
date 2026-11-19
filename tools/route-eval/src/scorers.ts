import { bgeSmallZh, type ModelSpec } from "@super-agent2/routing";

export { bigramScorer, bigramUnits, dot, type ModelSpec, modelScorer, type Scorer, type Vector } from "@super-agent2/routing";

export const modelSpecs: readonly ModelSpec[] = [
  { name: "e5-small", model: "Xenova/multilingual-e5-small", dtype: "fp32", pooling: "mean", prefix: "query: " },
  bgeSmallZh,
  { name: "bge-m3", model: "Xenova/bge-m3", dtype: "q8", pooling: "cls", prefix: "" },
];
