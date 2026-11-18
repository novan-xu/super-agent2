interface ToolRegistry {
  restrict(filter: { readonly allow: readonly string[] }): () => void;
  guard(check: () => string): () => void;
}

interface TextOnlyContext {
  readonly tools: ToolRegistry;
  on(event: "agent/created", listener: (payload: { readonly agent: { readonly ctx: { readonly tools: ToolRegistry } } }) => void): () => void;
}

export const name = "super-agent2-text-only";
export const inject = ["tools", "agents"];

export function apply(ctx: TextOnlyContext): void {
  ctx.tools.guard(() => "Tools are disabled in the topic router.");
  ctx.on("agent/created", ({ agent }) => {
    agent.ctx.tools.restrict({ allow: [] });
  });
}
