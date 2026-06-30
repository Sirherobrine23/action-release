import { GitHub } from '@actions/github/lib/utils';
import {
  Release,
  ReleaseMutationParams,
  ReleaseNotesParams,
  ReleaseAsset,
  ReleaseResult,
  Releaser,
  asset,
  finalizeRelease,
  findTagFromReleases,
  listReleaseAssets,
  mimeOrDefault,
  release,
  upload,
} from './releases';

type GitHub = InstanceType<typeof GitHub>;

export class GitHubReleaser implements Releaser {
  github: GitHub;

  constructor(github: GitHub) {
    this.github = github;
  }

  getReleaseByTag(params: {
    owner: string;
    repo: string;
    tag: string;
  }): Promise<{ data: Release }> {
    return this.github.rest.repos.getReleaseByTag(params);
  }

  async getReleaseNotes(params: ReleaseNotesParams): Promise<{
    data: {
      name: string;
      body: string;
    };
  }> {
    return await this.github.rest.repos.generateReleaseNotes(params);
  }

  private async prepareReleaseMutation<T extends ReleaseMutationParams>(
    params: T,
  ): Promise<Omit<T, 'previous_tag_name'>> {
    const { previous_tag_name, ...releaseParams } = params;

    if (
      typeof releaseParams.make_latest === 'string' &&
      !['true', 'false', 'legacy'].includes(releaseParams.make_latest)
    ) {
      releaseParams.make_latest = undefined;
    }
    if (releaseParams.generate_release_notes) {
      const releaseNotes = await this.getReleaseNotes({
        owner: releaseParams.owner,
        repo: releaseParams.repo,
        tag_name: releaseParams.tag_name,
        target_commitish: releaseParams.target_commitish,
        previous_tag_name,
      });
      releaseParams.generate_release_notes = false;
      if (releaseParams.body) {
        releaseParams.body = `${releaseParams.body}\n\n${releaseNotes.data.body}`;
      } else {
        releaseParams.body = releaseNotes.data.body;
      }
    }
    releaseParams.body = releaseParams.body
      ? this.truncateReleaseNotes(releaseParams.body)
      : undefined;
    return releaseParams;
  }

  truncateReleaseNotes(input: string): string {
    const githubNotesMaxCharLength = 125000;
    return input.substring(0, githubNotesMaxCharLength - 1);
  }

  async createRelease(params: ReleaseMutationParams): Promise<{ data: Release }> {
    return this.github.rest.repos.createRelease(await this.prepareReleaseMutation(params));
  }

  async updateRelease(
    params: ReleaseMutationParams & {
      release_id: number;
      target_commitish: string;
    },
  ): Promise<{ data: Release }> {
    return this.github.rest.repos.updateRelease(await this.prepareReleaseMutation(params));
  }

  async finalizeRelease(params: {
    owner: string;
    repo: string;
    release_id: number;
    make_latest: 'true' | 'false' | 'legacy' | undefined;
    discussion_category_name: string | undefined;
  }) {
    return await this.github.rest.repos.updateRelease({
      owner: params.owner,
      repo: params.repo,
      release_id: params.release_id,
      draft: false,
      make_latest: params.make_latest,
      discussion_category_name: params.discussion_category_name,
    });
  }

  allReleases(params: { owner: string; repo: string }): AsyncIterable<{ data: Release[] }> {
    const updatedParams = { per_page: 100, ...params };
    return this.github.paginate.iterator(
      this.github.rest.repos.listReleases.endpoint.merge(updatedParams),
    );
  }

  async listReleaseAssets(params: {
    owner: string;
    repo: string;
    release_id: number;
  }): Promise<Array<{ id: number; name: string; label?: string | null; [key: string]: any }>> {
    return this.github.paginate(this.github.rest.repos.listReleaseAssets, {
      ...params,
      per_page: 100,
    });
  }

  async deleteReleaseAsset(params: {
    owner: string;
    repo: string;
    release_id?: number;
    asset_id: number;
  }): Promise<void> {
    await this.github.rest.repos.deleteReleaseAsset(params);
  }

  async deleteRelease(params: { owner: string; repo: string; release_id: number }): Promise<void> {
    await this.github.rest.repos.deleteRelease(params);
  }

  async updateReleaseAsset(params: {
    owner: string;
    repo: string;
    release_id?: number;
    asset_id: number;
    name: string;
    label: string;
  }): Promise<{ data: any }> {
    return await this.github.rest.repos.updateReleaseAsset(params);
  }

  async uploadReleaseAsset(params: {
    url: string;
    size: number;
    mime: string;
    token: string;
    data: any;
  }): Promise<{ status: number; data: any }> {
    return this.github.request({
      method: 'POST',
      url: params.url,
      headers: {
        'content-length': `${params.size}`,
        'content-type': params.mime,
        authorization: `token ${params.token}`,
      },
      data: params.data,
    });
  }
}

export type {
  Release,
  ReleaseAsset,
  ReleaseResult,
  Releaser,
  ReleaseNotesParams,
  ReleaseMutationParams,
};
export {
  asset,
  finalizeRelease,
  findTagFromReleases,
  listReleaseAssets,
  mimeOrDefault,
  release,
  upload,
};
