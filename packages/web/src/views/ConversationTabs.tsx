import { text } from "@super-agent2/catalog";
import { type PageRoute, pagePath, type TopicScope } from "@super-agent2/protocol";
import { useContext } from "react";
import { FeatureContext, transferEnabled } from "../live/features.js";
import { codeScope, dailyScope } from "../live/topic-scope.js";
import type { Navigate } from "../parts/route.js";
import { followLink } from "../parts/Shell.js";

const tabs = [
  { key: "code", label: "conversation.code", route: { view: "conversations", conversation: null, scope: codeScope } },
  { key: "daily", label: "conversation.daily", route: { view: "conversations", conversation: null, scope: dailyScope } },
  { key: "transfer", label: "conversation.transfer", route: { view: "transfer" } },
] as const satisfies readonly { key: string; label: string; route: PageRoute }[];

export function ConversationTabs({ scope, transfer, repositories, navigate }: {
  readonly scope: TopicScope;
  readonly transfer: boolean;
  readonly repositories: readonly string[];
  readonly navigate: Navigate;
}) {
  const active = transfer ? "transfer" : scope.kind === "daily" ? "daily" : "code";
  const canTransfer = transferEnabled(useContext(FeatureContext));
  const selected = scope.kind === "repository" ? scope.repository.toLowerCase() : "";
  return (
    <div className="conv-navigation">
      <nav className="conv-tabs" aria-label={text("conversation.tabs")}>
        {tabs.filter(({ key }) => key !== "transfer" || canTransfer).map(({ key, label, route }) => (
          <a key={key} href={pagePath(route)} aria-current={key === active ? "page" : undefined}
            onClick={(event) => followLink(event, () => navigate(route))}>
            {text(label)}
          </a>
        ))}
      </nav>
      {active === "code" ? (
        <select className="conv-repository" aria-label={text("conversation.repository")} value={selected} onChange={(event) => {
          const repository = repositories.find((name) => name.toLowerCase() === event.target.value);
          navigate({ view: "conversations", conversation: null, scope: repository === undefined ? codeScope : { kind: "repository", repository } });
        }}>
          <option value="">{text("conversation.repositories.all")}</option>
          {repositories.map((repository) => <option key={repository} value={repository.toLowerCase()}>{repository}</option>)}
        </select>
      ) : null}
    </div>
  );
}
