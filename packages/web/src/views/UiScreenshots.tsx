import { text } from "@super-agent2/catalog";
import type { ScreenshotFile, ScreenshotReport } from "@super-agent2/protocol";
import { useCallback, useState } from "react";
import { ticketFilePath } from "../hub/api.js";
import { FileViewer, type ViewFile } from "../parts/FileViewer.js";

function pairs(images: readonly ScreenshotFile[]) {
  const groups = new Map<string, { view: string; width: ScreenshotFile["width"]; before?: ScreenshotFile; after?: ScreenshotFile }>();
  for (const image of images) {
    const key = JSON.stringify([image.view, image.width]);
    const group = groups.get(key) ?? { view: image.view, width: image.width };
    group[image.phase] = image;
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function UiScreenshots({ reports }: { readonly reports: readonly ScreenshotReport[] }) {
  const [selected, select] = useState<ViewFile | null>(null);
  const close = useCallback(() => select(null), []);
  return <>
    {reports.map(({ ticket, pullRequest, images }) => <section className="ui-screenshots" key={`${ticket}-${pullRequest}`} aria-label={text("screenshots.title", { number: pullRequest })}>
      <h3>{text("screenshots.title", { number: pullRequest })}</h3>
      {pairs(images).map(({ view, width, before, after }) => <div key={JSON.stringify([view, width])} className="ui-screenshot-group">
        <h4>{text("screenshots.view", { view, width: text(`screenshots.${width}`) })}</h4>
        <div className="ui-screenshot-pair">
          {[before, after].map((image) => {
            if (image === undefined) return null;
            const url = ticketFilePath(ticket, image.name);
            const phase = text(`screenshots.${image.phase}`);
            const name = text("screenshots.image", { view, width: text(`screenshots.${width}`), phase });
            return <figure key={image.phase}>
              <a href={url} onClick={(event) => {
                event.preventDefault();
                history.pushState({ ...history.state, fileViewer: true }, "");
                select({ name, url, size: image.size, mime: image.mediaType });
              }}><img src={url} alt={name} loading="lazy" /></a>
              <figcaption>{phase}</figcaption>
            </figure>;
          })}
        </div>
      </div>)}
    </section>)}
    {selected === null ? null : <FileViewer files={[selected]} index={0} close={close} />}
  </>;
}
