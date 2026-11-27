import { text } from "@super-agent2/catalog";
import { type PeerStatus, remotePeerPrefix } from "@super-agent2/protocol";
import { Icon } from "../parts/icons.js";

export function RemoteView({ peers, online }: { readonly peers: readonly PeerStatus[]; readonly online: boolean }) {
  return <div className="page">
    {peers.length === 0 ? <p className="muted">{text("remote.empty")}</p> : <ul className="remote-list" aria-label={text("navigation.remote")}>
      {peers.map((peer) => {
        const connected = online && peer.online;
        return <li key={peer.name} className="mcard remote-peer">
          <Icon name="screen" />
          <strong className="od-truncate">{peer.name}</strong>
          <span className="remote-state"><span className={`dot ${connected ? "dot--ok" : "dot--bad"}`} />{text(connected ? "hub.online" : "remote.offline")}</span>
          {connected ? <a className="btn btn-sm" href={`${remotePeerPrefix(peer.name)}/`}>{text("remote.open")}</a> : null}
        </li>;
      })}
    </ul>}
  </div>;
}
