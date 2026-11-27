import { useEffect, useState } from "react";
import { hubApi } from "../hub/api.js";
import { text } from "@super-agent2/catalog";
import { arrangedAfter, chineseOf, type ChainsEntry, type Ticket } from "@super-agent2/protocol";
import { cardAddress } from "../parts/app-path.js";
import { startCards } from "../live/chains.js";
import { canStartCard } from "../live/choice.js";
import { type WaitingState, useOf } from "../live/waiting.js";
import { failureText } from "./HoldCard.js";
import { MissingChoices } from "./StartCard.js";
import { TicketCodeLabel } from "./TicketParts.js";

export function ConversationChains({ entry, waiting, tickets, start }: { readonly entry: ChainsEntry; readonly waiting: WaitingState; readonly tickets: readonly Ticket[]; readonly start: (keys: readonly string[], fingerprints: Readonly<Record<string, string>>) => void }) {
  const [loaded, setLoaded] = useState<Readonly<Record<number, Ticket>>>({});
  const cards = startCards(waiting.cards);
  const missing = entry.chains.filter(({ ticket }) => !cards.some((card) => card.ticket.id === ticket) && !tickets.some((item) => item.id === ticket)).map(({ ticket }) => ticket).join(",");
  useEffect(() => {
    let active = true;
    if (waiting.known && missing !== "") void Promise.all(missing.split(",").map((id) => hubApi.ticket(Number(id)))).then((answers) => {
      if (active) setLoaded((before) => ({ ...before, ...Object.fromEntries(answers.flatMap((answer) => answer.ok ? [[answer.value.ticket.id, answer.value.ticket]] : [])) }));
    });
    return () => { active = false; };
  }, [missing, waiting.known]);
  const rows = entry.chains.map((snapshot) => {
    const card = cards.find((item) => item.ticket.id === snapshot.ticket);
    const ticket = card?.ticket ?? tickets.find((item) => item.id === snapshot.ticket) ?? loaded[snapshot.ticket];
    const valid = card !== undefined && card.fingerprint === snapshot.fingerprint && canStartCard(card) && useOf(waiting, card.key).step === "idle";
    return { snapshot, card, ticket, valid };
  });
  const ready = rows.filter((row) => row.valid && row.card !== undefined);
  const begin = (items: typeof ready) => start(items.map((row) => row.card!.key), Object.fromEntries(items.map((row) => [row.card!.key, row.snapshot.fingerprint])));
  return <section className="wcard conversation-chains" aria-label={text("conversation.chains.title")}>
    <h3>{text("conversation.chains.title")}</h3>
    {rows.map(({ snapshot, card, ticket, valid }) => <div key={snapshot.ticket} className="chain-block">
      {ticket === undefined ? <p>{text("conversation.chains.unavailable")}</p> : <>
        <p className="card-title"><TicketCodeLabel code={ticket.code} /> {chineseOf(ticket.title)}</p>
        <p>{ticket.issues.map((issue) => `#${issue.number}`).join(" → ")}</p>
      </>}
      {card === undefined ? <p>{ticket?.joinedInto != null ? text("conversation.chains.joined") : ticket?.state === "stopped" ? text("conversation.chains.stopped") : ticket === undefined ? text("conversation.chains.unavailable") : text("conversation.chains.started")}</p> : <>
        <p>{[card.choice.machine, card.choice.engine, card.choice.model, card.choice.effort].map((value) => value ?? "—").join(" · ")}</p>
        {card.before.map((before) => <p key={before.id}>{text("conversation.chains.waits", { title: chineseOf(before.title) })}</p>)}
        {arrangedAfter([card.ticket.id], cards.map((item) => item.ticket)).filter((id) => id !== card.ticket.id).map((id) => {
          const follower = cards.find((item) => item.ticket.id === id);
          return follower === undefined ? null : <div key={id}>
            <p>{text("conversation.chains.with", { title: chineseOf(follower.ticket.title) })} <TicketCodeLabel code={follower.ticket.code} /></p>
            <p>{follower.ticket.issues.map((issue) => `#${issue.number}`).join(" → ")}</p>
            {follower.before.map((before) => <p key={before.id}>{text("conversation.chains.waits", { title: chineseOf(before.title) })}</p>)}
            <p>{[follower.choice.machine, follower.choice.engine, follower.choice.model, follower.choice.effort].map((value) => value ?? "—").join(" · ")}</p>
            <MissingChoices card={follower} />
          </div>;
        })}
        {card.fingerprint !== snapshot.fingerprint ? <p>{text("conversation.chains.changed")}</p> : <MissingChoices card={card} />}
        {useOf(waiting, card.key).failure === null ? null : <p role="alert">{failureText(useOf(waiting, card.key).failure!)}</p>}
        <button className="btn btn-primary" type="button" disabled={!valid} onClick={() => begin(rows.filter((row) => row.snapshot.ticket === snapshot.ticket && row.valid && row.card !== undefined))}>{text("chains.start")}</button>
      </>}
      <a href={cardAddress(`start:${snapshot.ticket}`)}>{text("conversation.chains.workbench")}</a>
    </div>)}
    {ready.length > 1 ? <button className="btn btn-sm" type="button" onClick={() => begin(ready)}>{text("chains.startAll")}</button> : null}
  </section>;
}
