import { bgeSmallZh } from "./model.js";
import { minute, type Rules } from "./rules.js";

export const ownerTextLimit = 1_000;
export const replyTextLimit = 320;
export const recentOwnerItems = 5;
export const recentReplyItems = 3;

export type ConfigurationName = "model" | "bigram";

export interface Configuration {
  readonly name: ConfigurationName;
  readonly scorer: string;
  readonly rules: Rules;
}

export const modelConfiguration: Configuration = {
  name: "model",
  scorer: bgeSmallZh.name,
  rules: {
    question: "text",
    questionWindowMs: 30 * minute,
    references: true,
    shortLength: 12,
    shortWindowMs: 30 * minute,
    threshold: 0.43,
    margin: 0.05,
    time: { kind: "decay", beta: 0.048 },
    recencyWindowMs: 0,
  },
};

export const bigramConfiguration: Configuration = {
  name: "bigram",
  scorer: "bigram",
  rules: {
    question: "off",
    questionWindowMs: 0,
    references: false,
    shortLength: 12,
    shortWindowMs: 30 * minute,
    threshold: 0.055,
    margin: 0.091,
    time: { kind: "decay", beta: 0.18 },
    recencyWindowMs: 0,
  },
};

export const configurations: Readonly<Record<ConfigurationName, Configuration>> = {
  model: modelConfiguration,
  bigram: bigramConfiguration,
};
