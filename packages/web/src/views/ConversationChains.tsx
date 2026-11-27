import { useEffect, useState } from "react";
import { hubApi } from "../hub/api.js";
import { text } from "@super-agent2/catalog";
import { arrangedAfter, cardAddress, chineseOf, type ChainsEntry, type Ticket } from "@super-agent2/protocol";
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
  const details = (item: typeof cards[number]) => <>
    {item.before.map((before) => <p key={before.id}>{text("conversation.chains.waits", { title: chineseOf(before.title) })}</p>)}
    <MissingChoices card={item} />
  </>;
  const identity = (item: Ticket, choice?: typeof cards[number]["choice"]) => <div className="conversation-chain-identity">
    <a href={cardAddress(`start:${item.id}`)}><TicketCodeLabel code={item.code} /></a>
    <span className="conversation-chain-title" title={chineseOf(item.title)}>{chineseOf(item.title)}</span>
    {choice === undefined ? null : <><span className="conversation-chain-choice" title={choice.machine ?? "—"}>{choice.machine ?? "—"}</span><span className="conversation-chain-engine">{choice.engine ?? "—"}</span></>}
  </div>;
  return <section className="wcard conversation-chains" aria-label={text("conversation.chains.title")}>
    {rows.map(({ snapshot, card, ticket, valid }) => <div key={snapshot.ticket} className="chain-block">
      <div className="conversation-chain-row">
        {ticket === undefined ? <span>{text("conversation.chains.unavailable")}</span> : identity(ticket, card?.choice)}
        {card === undefined ? <span className="conversation-chain-state">{ticket?.joinedInto != null ? text("conversation.chains.joined") : ticket?.state === "stopped" ? text("conversation.chains.stopped") : ticket === undefined ? null : text("conversation.chains.started")}</span>
          : card.fingerprint !== snapshot.fingerprint ? <span className="conversation-chain-state">{text("conversation.chains.changed")}</span>
            : <button className="btn btn-primary btn-sm" type="button" disabled={!valid} onClick={() => begin(rows.filter((row) => row.snapshot.ticket === snapshot.ticket && row.valid && row.card !== undefined))}>{text("chains.start")}</button>}
      </div>
      {card === undefined ? null : <>
        <div className="conversation-chain-details">{details(card)}{useOf(waiting, card.key).failure === null ? null : <p role="alert">{failureText(useOf(waiting, card.key).failure!)}</p>}</div>
        {arrangedAfter([card.ticket.id], cards.map((item) => item.ticket)).filter((id) => id !== card.ticket.id).map((id) => {
          const follower = cards.find((item) => item.ticket.id === id);
          return follower === undefined ? null : <div key={id} className="conversation-chain-follower" aria-label={text("conversation.chains.with", { title: chineseOf(follower.ticket.title) })}>
            <div className="conversation-chain-row">{identity(follower.ticket, follower.choice)}</div>
            <div className="conversation-chain-details">{details(follower)}</div>
          </div>;
        })}
      </>}
    </div>)}
    {ready.length > 1 ? <button className="btn btn-sm" type="button" onClick={() => begin(ready)}>{text("chains.startAll")}</button> : null}
  </section>;
}
