export function brainRestartPrompt(turn: string, earlierInputs: readonly string[]): string {
  const prompt = `[hub] A brain restart cut off turn ${turn} in this topic. Use the conversation history to identify the interrupted work. Some actions may already have taken effect. Check the current state of the relevant tickets, issues, and commands before acting. Avoid repeating work that already took effect, then finish the remaining work and report back to the owner.`;
  return earlierInputs.length === 0 ? prompt : `${prompt}\n\nEarlier hub inputs for context:\n${earlierInputs.join("\n\n")}`;
}
