import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
}

function htmlAsText(node: MarkdownNode): void {
  if (node.type === "html") {
    node.type = "text";
  }
  for (const child of node.children ?? []) {
    htmlAsText(child);
  }
}

function remarkHtmlAsText() {
  return (tree: MarkdownNode) => htmlAsText(tree);
}

const plugins = [remarkGfm, remarkHtmlAsText];

const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  img: ({ src, alt }) => (
    <a href={typeof src === "string" ? src : undefined} target="_blank" rel="noopener noreferrer">
      {alt}
    </a>
  ),
};

export const Markdown = memo(function Markdown({ text }: { readonly text: string }) {
  return (
    <ReactMarkdown remarkPlugins={plugins} components={components} skipHtml={false}>
      {text}
    </ReactMarkdown>
  );
});
