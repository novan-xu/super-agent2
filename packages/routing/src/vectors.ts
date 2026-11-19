export type Vector = Float32Array;

export interface Scorer {
  readonly name: string;
  readonly loadMs: number;
  represent(text: string): Promise<Vector>;
  similarity(left: Vector, right: Vector): number;
}

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

export function bigramVector(text: string): Vector {
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
  return vector;
}

export function bigramSimilarity(left: Vector, right: Vector): number {
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
}

export function bigramScorer(): Scorer {
  return {
    name: "bigram",
    loadMs: 0,
    represent: (text) => Promise.resolve(bigramVector(text)),
    similarity: bigramSimilarity,
  };
}
