import { text } from "@super-agent2/catalog";
import type { AllowanceReport } from "@super-agent2/protocol";
import { useRef } from "react";
import { compactValue, providersOf, type ProviderView } from "../live/allowance.js";
import { Icon } from "./icons.js";

function time(at: number): string {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(at);
}
function resetTime(at: number): string {
  const date = new Date(at);
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${time(at)}`;
}
function Provider({ provider }: { readonly provider: ProviderView }) {
  return <section className="allowance-provider">
    <div className="allowance-name"><strong>{provider.name}</strong>{provider.id === "dsh" ? <span className={`allowance-text--${provider.tone}`}>{provider.amount ?? text("allowance.unknown")}</span> : null}</div>
    {provider.unavailableUntil !== undefined ? <div className="allowance-text--bad">{provider.unavailableUntil === null ? text("allowance.unavailable") : text("allowance.unavailableUntil", { time: time(provider.unavailableUntil) })}</div> : null}
    {provider.windows.map((window) => <div className="allowance-window" key={window.name}>
      <div className={`allowance-meta allowance-text--${window.tone}`}><span>{text(`allowance.${window.name}`)}</span><span>{window.used === null ? text("allowance.unknown") : text("allowance.used", { percent: Math.round(window.used) })}</span></div>
      {window.used === null ? null : <div className="allowance-track"><div className={`allowance-fill allowance-fill--${window.tone}`} style={{ width: `${window.used}%` }} /></div>}
      {window.resetsAt === null ? null : <div className="allowance-reset">{text("allowance.reset", { time: resetTime(window.resetsAt) })}</div>}
    </div>)}
  </section>;
}
function Panel({ report, now, refresh }: { readonly report: AllowanceReport | null; readonly now: number; readonly refresh: () => void }) {
  return <div className="allowance-panel"><div className="allowance-heading"><strong>{text("allowance.title")}</strong><button className="icon-btn" type="button" aria-label={text("allowance.refresh")} title={text("allowance.refresh")} onClick={refresh}><Icon name="history" /></button></div>{providersOf(report, now).map((provider) => <Provider key={provider.id} provider={provider} />)}</div>;
}
export function AllowanceSidebar(props: { readonly report: AllowanceReport | null; readonly now: number; readonly refresh: () => void }) {
  return <div className="allowance-sidebar"><Panel {...props} /></div>;
}
export function AllowanceCompact(props: { readonly report: AllowanceReport | null; readonly now: number; readonly refresh: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  return <div className="allowance-mobile"><button className="allowance-compact" type="button" aria-label={text("allowance.open")} onClick={() => dialog.current?.showModal()}>{providersOf(props.report, props.now).map((provider) => <span className={`allowance-text--${provider.tone}`} key={provider.id}>{provider.compactName} {provider.unavailableUntil !== undefined ? text("allowance.unavailable") : compactValue(provider) ?? text("allowance.unknown")}</span>)}</button><dialog className="dlg allowance-dialog" ref={dialog} aria-label={text("allowance.title")}><button className="icon-btn allowance-close" type="button" aria-label={text("allowance.close")} onClick={() => dialog.current?.close()}><Icon name="x" /></button><Panel {...props} /></dialog></div>;
}
