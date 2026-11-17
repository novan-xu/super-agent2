import { messages, type MessageKey, type Messages } from "./messages.js";

type Placeholders<Template extends string> = Template extends `${string}{${infer Name}}${infer Rest}`
  ? Name | Placeholders<Rest>
  : never;

export type Value = string | number;

export type Values<Key extends MessageKey> = [Placeholders<Messages[Key]>] extends [never]
  ? []
  : [values: { readonly [Name in Placeholders<Messages[Key]>]: Value }];

export function text<Key extends MessageKey>(key: Key, ...values: Values<Key>): string;
export function text(key: MessageKey, values?: Readonly<Record<string, Value>>): string {
  const template: string = messages[key];
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    const value = values?.[name];
    return value === undefined ? placeholder : String(value);
  });
}
