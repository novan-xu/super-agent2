import { RepositoryName } from "@super-agent2/protocol";
import type { CredentialSource } from "./credentials.js";
import { accountFor } from "./filing.js";
import { type Fetch, gitHubApiBase } from "./github-api.js";

export type ReleaseDownload =
  | { readonly ok: true; readonly body: ReadableStream<Uint8Array> }
  | { readonly ok: false; readonly reason: string };

export interface ReleaseSource {
  readonly version: string;
  open(): Promise<ReleaseDownload>;
}

export interface GitHubReleaseOptions {
  readonly repository: string;
  readonly version: string;
  readonly credentials: CredentialSource;
  readonly fetch: Fetch;
  readonly base?: string;
}

export function gitHubRelease(options: GitHubReleaseOptions): ReleaseSource {
  const repository = RepositoryName.parse(options.repository);
  return {
    version: options.version,
    open: async () => {
      const found = options.credentials(accountFor(repository));
      const token = found.ok ? found.credentials["GH_TOKEN"] : undefined;
      if (token === undefined || token === "") {
        return { ok: false, reason: found.ok ? `There is no GitHub token for ${repository}` : found.reason };
      }
      let response: Response;
      try {
        response = await options.fetch(`${options.base ?? gitHubApiBase}/repos/${repository}/tarball/${options.version}`, {
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "x-github-api-version": "2022-11-28",
            "user-agent": "super-agent2-hub",
          },
          redirect: "follow",
        });
      } catch (error) {
        return { ok: false, reason: `GitHub could not be reached: ${error instanceof Error ? error.message : String(error)}` };
      }
      if (!response.ok || response.body === null) {
        await response.body?.cancel();
        return { ok: false, reason: `GitHub answered ${response.status} to the tarball of ${repository} at ${options.version}` };
      }
      return { ok: true, body: response.body };
    },
  };
}
