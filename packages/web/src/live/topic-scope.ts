import { type Conversation, type TopicScope, topicInScope } from "@super-agent2/protocol";

export const dailyScope: TopicScope = { kind: "daily" };
export const codeScope: TopicScope = { kind: "code" };

export function workbenchScope(repository: string | null | undefined): TopicScope {
  return repository === undefined ? codeScope : repository === null ? dailyScope : { kind: "repository", repository };
}

export function topicScopeKey(scope?: TopicScope): string {
  return scope?.kind === "repository" ? scope.repository.toLowerCase() : scope?.kind ?? "";
}

export function scopeOfTopic(topic: Conversation | undefined, preferred?: TopicScope): TopicScope {
  if (topic === undefined || (preferred !== undefined && topicInScope(topic, preferred))) {
    return preferred ?? dailyScope;
  }
  if (topic.repository !== null) {
    return { kind: "repository", repository: topic.repository };
  }
  return topic.needsRepository === true ? codeScope : dailyScope;
}

export function conversationRepositories(known: readonly string[], sources: readonly { readonly repository: string | null }[], scope: TopicScope): string[] {
  const repositories = new Map<string, string>();
  if (scope.kind === "repository") {
    repositories.set(scope.repository.toLowerCase(), scope.repository);
  }
  for (const repository of known) {
    repositories.set(repository.toLowerCase(), repository);
  }
  for (const { repository } of sources) {
    if (repository !== null) {
      repositories.set(repository.toLowerCase(), repository);
    }
  }
  return [...repositories.values()].sort((a, b) => a.localeCompare(b));
}
