export const name = "super-agent2-balance";
export const inject = ["deepseekAccount"];

interface Context {
  get(name: string): { await(): Promise<void> } | undefined;
  deepseekAccount: { getBalance(client: { locale: string; version: string; timezoneOffsetSeconds: number }): Promise<{ status: string; value?: { currency: string; balance: string }[]; bonusWallets?: { currency: string; balance: string }[] } | null> };
  effect(callback: () => void, name: string): void;
}

export function apply(ctx: Context): void {
  ctx.effect(() => {
    void (async () => {
      try {
        await ctx.get("loader")?.await();
        const result = await ctx.deepseekAccount.getBalance({ locale: "en-US", version: "0.0.0", timezoneOffsetSeconds: 0 });
        const safe = result?.status === "ready" && Array.isArray(result.value) && Array.isArray(result.bonusWallets)
          ? { status: "ready", value: result.value.map(({ currency, balance }) => ({ currency, balance })), bonusWallets: result.bonusWallets.map(({ currency, balance }) => ({ currency, balance })) }
          : null;
        process.stdout.write(`${JSON.stringify({ id: "superagent2-balance", result: safe })}\n`);
      } catch {
        process.stdout.write(`${JSON.stringify({ id: "superagent2-balance", result: null })}\n`);
      }
    })();
  }, "super-agent2-balance");
}
