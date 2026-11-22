import { z } from "zod";

const FunctionCall = z.object({ type: z.literal("function_call"), call_id: z.string(), name: z.string(), arguments: z.string() });
export type LiveFunctionCall = z.infer<typeof FunctionCall>;

const ResponseEvent = z.object({
  type: z.literal("response.event"),
  delegation_id: z.string(),
  event: z.discriminatedUnion("type", [
    z.object({ type: z.literal("response.output_item.done"), item: FunctionCall }),
    z.object({ type: z.enum(["response.created", "response.completed", "response.failed", "response.incomplete"]), response: z.object({ id: z.string() }) }),
  ]),
});

export function liveFunctions() {
  const pending = new Map<string, LiveFunctionCall[]>();
  return (value: unknown) => {
    const parsed = ResponseEvent.safeParse(value);
    if (!parsed.success) return undefined;
    const { event, delegation_id: id } = parsed.data;
    if (event.type === "response.output_item.done") {
      pending.get(id)?.push(event.item);
    } else if (event.type === "response.created") {
      pending.set(id, []);
    } else {
      const calls = pending.get(id);
      pending.delete(id);
      if (event.type === "response.completed" && calls?.length) return calls;
    }
    return undefined;
  };
}

export function liveFunctionOutput(call: LiveFunctionCall, output: string) {
  return { type: "response.item.create", item: { type: "function_call_output", call_id: call.call_id, output } };
}
