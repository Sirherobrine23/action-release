import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@actions/github', () => ({
  context: {
    apiUrl: 'https://gitea.example/api/v1',
  },
}));

import { GiteaReleaser, IsGitea } from '../src/gitea';

describe('gitea', () => {
  const config = {
    github_token: 'test-token',
  } as any;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('detects Gitea from the settings API endpoint', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await expect(IsGitea(config)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://gitea.example/api/v1/settings/api',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'token test-token',
        }),
      }),
    );
  });

  it('prefers input.server_url when probing Gitea', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await expect(
      IsGitea({
        ...config,
        input_server_url: 'https://gitea.override.example',
      }),
    ).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://gitea.override.example/api/v1/settings/api',
      expect.any(Object),
    );
  });

  it('maps release and asset endpoints to the Gitea API', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 1,
            tag_name: 'v1.0.0',
            target_commitish: 'main',
            name: 'v1.0.0',
            body: 'body',
            url: 'https://gitea.example/api/v1/repos/owner/repo/releases/1',
            html_url: 'https://gitea.example/owner/repo/releases/tag/v1.0.0',
            tarball_url: '',
            zipball_url: '',
            upload_url: 'https://gitea.example/api/v1/repos/owner/repo/releases/1/assets',
            draft: true,
            prerelease: false,
            created_at: '2024-01-01T00:00:00Z',
            published_at: '',
            assets: [{ id: 9, name: 'release.txt' }],
          }),
          {
            status: 201,
            headers: { 'content-type': 'application/json' },
          },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 9,
            name: '.config',
            size: 12,
            download_count: 0,
            created_at: '2024-01-01T00:00:00Z',
            uuid: 'uuid',
            browser_download_url: 'https://gitea.example/download',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );

    const releaser = new GiteaReleaser(config);

    const release = await releaser.createRelease({
      owner: 'owner',
      repo: 'repo',
      tag_name: 'v1.0.0',
      name: 'v1.0.0',
      body: 'body',
      draft: true,
      prerelease: false,
      target_commitish: 'main',
      discussion_category_name: undefined,
      generate_release_notes: undefined,
      make_latest: undefined,
      previous_tag_name: undefined,
    });

    expect(release.data.assets).toEqual([{ id: 9, name: 'release.txt' }]);

    await releaser.deleteReleaseAsset({
      owner: 'owner',
      repo: 'repo',
      release_id: 1,
      asset_id: 9,
    });

    const updatedAsset = await releaser.updateReleaseAsset({
      owner: 'owner',
      repo: 'repo',
      release_id: 1,
      asset_id: 9,
      name: 'default.config',
      label: '.config',
    });

    expect(updatedAsset.data).toEqual({ id: 9, name: '.config' });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://gitea.example/api/v1/repos/owner/repo/releases',
      expect.objectContaining({
        method: 'POST',
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://gitea.example/api/v1/repos/owner/repo/releases/1/assets/9',
      expect.objectContaining({
        method: 'DELETE',
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'https://gitea.example/api/v1/repos/owner/repo/releases/1/assets/9',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ name: '.config' }),
      }),
    );
  });
});
