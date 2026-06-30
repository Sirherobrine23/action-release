import { context } from '@actions/github';
import { Config, resolveApiBaseUrl } from './util';
import { Release, ReleaseMutationParams, ReleaseNotesParams, Releaser } from './releases';

export interface GiteaReleaseAsset {
  id: number;
  name: string;
  size: number;
  download_count: number;
  created_at: string;
  uuid: string;
  browser_download_url: string;
}

export interface GiteaRelease {
  id: number;
  tag_name: string;
  target_commitish: string;
  name: string;
  body: string;
  url: string;
  html_url: string;
  tarball_url: string;
  zipball_url: string;
  upload_url: string;
  draft: boolean;
  prerelease: boolean;
  created_at: string;
  published_at: string;
  assets: GiteaReleaseAsset[];
}

type ApiError = Error & {
  status?: number;
  response?: { data?: any };
  request?: { url?: string };
  errors?: any;
};

const apiBaseUrl = (config: Config): string =>
  config.input_server_url
    ? resolveApiBaseUrl(config.input_server_url, 'v1')
    : context.apiUrl.replace(/\/$/, '');

const authHeaders = (token: string): HeadersInit => ({
  Authorization: `token ${token}`,
  Accept: 'application/json',
});

const normalizeAsset = (asset: GiteaReleaseAsset): { id: number; name: string } => ({
  id: asset.id,
  name: asset.name,
});

const normalizeRelease = (release: GiteaRelease): Release => ({
  id: release.id,
  upload_url: release.upload_url,
  html_url: release.html_url,
  tag_name: release.tag_name,
  name: release.name ?? null,
  body: release.body,
  target_commitish: release.target_commitish,
  draft: release.draft,
  prerelease: release.prerelease,
  assets: (release.assets || []).map(normalizeAsset),
});

const createApiError = async (response: Response): Promise<ApiError> => {
  const rawBody = await response.text();
  let data: any = rawBody;

  if (rawBody) {
    try {
      data = JSON.parse(rawBody);
    } catch {
      data = rawBody;
    }
  } else {
    data = {};
  }

  const message =
    (typeof data === 'object' && data && (data.message || data.error || data.err)) ||
    `${response.status} ${response.statusText}`;
  const error = new Error(String(message)) as ApiError;
  error.status = response.status;
  error.response = { data };
  error.request = { url: response.url };
  if (typeof data === 'object' && data && Array.isArray(data.errors)) {
    error.errors = data.errors;
  }
  return error;
};

const requestJson = async <T>(
  url: string,
  init: RequestInit & { token: string; expectStatus?: number[] },
): Promise<T> => {
  const { token, expectStatus = [200], ...requestInit } = init;
  const response = await fetch(url, {
    ...requestInit,
    headers: {
      ...authHeaders(token),
      ...(requestInit.headers || {}),
    },
  });

  if (!expectStatus.includes(response.status)) {
    throw await createApiError(response);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
};

const releaseBaseUrl = (apiBaseUrl: string, owner: string, repo: string): string =>
  `${apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

const releaseUrl = (apiBaseUrl: string, owner: string, repo: string, suffix: string): string =>
  `${releaseBaseUrl(apiBaseUrl, owner, repo)}${suffix}`;

const toJsonBody = (payload: Record<string, unknown>): string => JSON.stringify(payload);

export async function IsGitea(config: Config): Promise<boolean> {
  try {
    const res = await fetch(`${apiBaseUrl(config)}/settings/api`, {
      headers: authHeaders(config.github_token),
    });

    return res.status === 200;
  } catch {
    return false;
  }
}

export class GiteaReleaser implements Releaser {
  private readonly apiBaseUrl: string;

  constructor(private config: Config) {
    this.apiBaseUrl = apiBaseUrl(config);
  }

  async getReleaseByTag(params: {
    owner: string;
    repo: string;
    tag: string;
  }): Promise<{ data: Release }> {
    const url = releaseUrl(
      this.apiBaseUrl,
      params.owner,
      params.repo,
      `/releases/tags/${encodeURIComponent(params.tag)}`,
    );

    return requestJson<GiteaRelease>(url, {
      method: 'GET',
      token: this.config.github_token,
    }).then((data) => ({ data: normalizeRelease(data) }));
  }

  async getReleaseNotes(_params: ReleaseNotesParams): Promise<{
    data: {
      name: string;
      body: string;
    };
  }> {
    throw new Error('Gitea does not support automatic release notes generation.');
  }

  async createRelease(params: ReleaseMutationParams): Promise<{ data: Release }> {
    const url = releaseUrl(this.apiBaseUrl, params.owner, params.repo, '/releases');
    const payload = {
      tag_name: params.tag_name,
      target_commitish: params.target_commitish,
      name: params.name,
      body: params.body,
      draft: params.draft,
      prerelease: params.prerelease,
    };

    const data = await requestJson<GiteaRelease>(url, {
      method: 'POST',
      token: this.config.github_token,
      expectStatus: [200, 201],
      headers: {
        'content-type': 'application/json',
      },
      body: toJsonBody(payload),
    });

    return { data: normalizeRelease(data) };
  }

  async updateRelease(
    params: ReleaseMutationParams & {
      release_id: number;
      target_commitish: string;
    },
  ): Promise<{ data: Release }> {
    const url = releaseUrl(
      this.apiBaseUrl,
      params.owner,
      params.repo,
      `/releases/${params.release_id}`,
    );
    const payload = {
      tag_name: params.tag_name,
      target_commitish: params.target_commitish,
      name: params.name,
      body: params.body,
      draft: params.draft,
      prerelease: params.prerelease,
    };

    const data = await requestJson<GiteaRelease>(url, {
      method: 'PATCH',
      token: this.config.github_token,
      expectStatus: [200],
      headers: {
        'content-type': 'application/json',
      },
      body: toJsonBody(payload),
    });

    return { data: normalizeRelease(data) };
  }

  async finalizeRelease(params: {
    owner: string;
    repo: string;
    release_id: number;
    make_latest: 'true' | 'false' | 'legacy' | undefined;
    discussion_category_name: string | undefined;
  }): Promise<{ data: Release }> {
    const url = releaseUrl(
      this.apiBaseUrl,
      params.owner,
      params.repo,
      `/releases/${params.release_id}`,
    );
    const data = await requestJson<GiteaRelease>(url, {
      method: 'PATCH',
      token: this.config.github_token,
      expectStatus: [200],
      headers: {
        'content-type': 'application/json',
      },
      body: toJsonBody({ draft: false }),
    });

    return { data: normalizeRelease(data) };
  }

  async *allReleases(params: { owner: string; repo: string }): AsyncIterable<{ data: Release[] }> {
    const limit = 100;

    for (let page = 1; ; page += 1) {
      const url = new URL(releaseUrl(this.apiBaseUrl, params.owner, params.repo, '/releases'));
      url.searchParams.set('limit', `${limit}`);
      url.searchParams.set('page', `${page}`);

      const data = await requestJson<GiteaRelease[]>(url.toString(), {
        method: 'GET',
        token: this.config.github_token,
      });

      yield { data: data.map(normalizeRelease) };
      if (data.length < limit) {
        break;
      }
    }
  }

  async listReleaseAssets(params: {
    owner: string;
    repo: string;
    release_id: number;
  }): Promise<Array<{ id: number; name: string; label?: string | null; [key: string]: any }>> {
    const limit = 100;
    const url = new URL(
      releaseUrl(
        this.apiBaseUrl,
        params.owner,
        params.repo,
        `/releases/${params.release_id}/assets`,
      ),
    );
    url.searchParams.set('limit', `${limit}`);

    const assets = await requestJson<GiteaReleaseAsset[]>(url.toString(), {
      method: 'GET',
      token: this.config.github_token,
      expectStatus: [200],
    });

    return assets.map(normalizeAsset);
  }

  async deleteReleaseAsset(params: {
    owner: string;
    repo: string;
    release_id?: number;
    asset_id: number;
  }): Promise<void> {
    const releaseId = await this.resolveAssetReleaseId(params.owner, params.repo, params);
    if (releaseId === undefined) {
      throw new Error(`Unable to resolve release for asset ${params.asset_id}`);
    }

    await requestJson<void>(
      releaseUrl(
        this.apiBaseUrl,
        params.owner,
        params.repo,
        `/releases/${releaseId}/assets/${params.asset_id}`,
      ),
      {
        method: 'DELETE',
        token: this.config.github_token,
        expectStatus: [204],
      },
    );
  }

  async deleteRelease(params: { owner: string; repo: string; release_id: number }): Promise<void> {
    await requestJson<void>(
      releaseUrl(this.apiBaseUrl, params.owner, params.repo, `/releases/${params.release_id}`),
      {
        method: 'DELETE',
        token: this.config.github_token,
        expectStatus: [204],
      },
    );
  }

  async updateReleaseAsset(params: {
    owner: string;
    repo: string;
    release_id?: number;
    asset_id: number;
    name: string;
    label: string;
  }): Promise<{ data: any }> {
    const releaseId = await this.resolveAssetReleaseId(params.owner, params.repo, params);
    if (releaseId === undefined) {
      throw new Error(`Unable to resolve release for asset ${params.asset_id}`);
    }

    const data = await requestJson<GiteaReleaseAsset>(
      releaseUrl(
        this.apiBaseUrl,
        params.owner,
        params.repo,
        `/releases/${releaseId}/assets/${params.asset_id}`,
      ),
      {
        method: 'PATCH',
        token: this.config.github_token,
        expectStatus: [200],
        headers: {
          'content-type': 'application/json',
        },
        body: toJsonBody({ name: params.label || params.name }),
      },
    );

    return { data: normalizeAsset(data) };
  }

  async uploadReleaseAsset(params: {
    url: string;
    size: number;
    mime: string;
    token: string;
    data: any;
  }): Promise<{ status: number; data: any }> {
    const endpoint = new URL(params.url);
    const response = await fetch(endpoint.toString(), {
      method: 'POST',
      headers: {
        ...authHeaders(params.token),
        'content-length': `${params.size}`,
        'content-type': params.mime,
      },
      body: params.data,
      duplex: 'half' as any,
    } as any);

    const rawBody = await response.text();
    let data: any = {};
    if (rawBody) {
      try {
        data = JSON.parse(rawBody);
      } catch {
        data = rawBody;
      }
    }

    if (!response.ok && response.status !== 201) {
      const error = new Error(
        String((data && (data.message || data.error || data.err)) || response.statusText),
      ) as ApiError;
      error.status = response.status;
      error.response = { data };
      error.request = { url: response.url };
      throw error;
    }

    return { status: response.status, data };
  }

  private async resolveAssetReleaseId(
    owner: string,
    repo: string,
    params: { release_id?: number; asset_id: number },
  ): Promise<number | undefined> {
    if (params.release_id !== undefined) {
      return params.release_id;
    }

    for await (const page of this.allReleases({ owner, repo })) {
      const release = page.data.find((release) =>
        release.assets.some((asset) => asset.id === params.asset_id),
      );
      if (release) {
        return release.id;
      }
    }

    return undefined;
  }
}
