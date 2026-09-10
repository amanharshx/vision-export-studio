import { invoke } from "@tauri-apps/api/core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const releaseAuthor = /@([A-Za-z0-9-]+(?:\[bot\])?)/g;
const releasePull = /(https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+))/g;

function friendlyReleaseNotes(notes: string) {
  return notes
    .replace(releaseAuthor, (_mention, author: string) => {
      const profile = author.endsWith("[bot]")
        ? `https://github.com/apps/${author.slice(0, -5)}`
        : `https://github.com/${author}`;
      return `[@${author}](${profile})`;
    })
    .replace(releasePull, "[#$2]($1)");
}

export function ReleaseNotes({ source }: { source: string }) {
  return (
    <article className="markdown-viewer max-w-none" aria-label="Changelog">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, children }) {
            if (!href) return <span>{children}</span>;
            return (
              <a
                href={href}
                onClick={(event) => {
                  event.preventDefault();
                  if (href.startsWith("https://") || href.startsWith("http://")) {
                    void invoke("open_url", { url: href });
                  }
                }}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {friendlyReleaseNotes(source)}
      </ReactMarkdown>
    </article>
  );
}
