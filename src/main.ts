import { setFailed, setOutput } from '@actions/core';
import { getOctokit } from '@actions/github';
import * as github from './github';
import * as gitea from './gitea';
import { finalizeRelease, listReleaseAssets, release, upload, Releaser } from './releases';
import { isTag, parseConfig, paths, resolveApiBaseUrl, unmatchedPatterns, uploadUrl } from './util';
import { env } from 'process';

async function run() {
  try {
    const config = parseConfig(env);
    if (!config.input_tag_name && !isTag(config.github_ref) && !config.input_draft) {
      throw new Error(`⚠️ GitHub Releases requires a tag`);
    }
    if (config.input_files) {
      const patterns = unmatchedPatterns(config.input_files, config.input_working_directory);
      patterns.forEach((pattern) => {
        if (config.input_fail_on_unmatched_files) {
          throw new Error(`⚠️  Pattern '${pattern}' does not match any files.`);
        } else {
          console.warn(`🤔 Pattern '${pattern}' does not match any files.`);
        }
      });
      if (patterns.length > 0 && config.input_fail_on_unmatched_files) {
        throw new Error(`⚠️ There were unmatched files`);
      }
    }

    const isGitea = await gitea.IsGitea(config);
    const gh = isGitea
      ? undefined
      : getOctokit(config.github_token, {
          ...(config.input_server_url
            ? { baseUrl: resolveApiBaseUrl(config.input_server_url, 'v3') }
            : {}),
          throttle: {
            onRateLimit: (retryAfter, options) => {
              console.warn(`Request quota exhausted for request ${options.method} ${options.url}`);
              if (options.request.retryCount === 0) {
                console.log(`Retrying after ${retryAfter} seconds!`);
                return true;
              }
            },
            onAbuseLimit: (retryAfter, options) => {
              console.warn(`Abuse detected for request ${options.method} ${options.url}`);
            },
          },
        });

    const releaser: Releaser = isGitea
      ? new gitea.GiteaReleaser(config)
      : new github.GitHubReleaser(gh!);
    const releaseConfig = isGitea
      ? {
          ...config,
          input_generate_release_notes: false,
          input_discussion_category_name: undefined,
          input_make_latest: undefined,
          input_previous_tag: undefined,
        }
      : config;

    if (isGitea) {
      if (config.input_generate_release_notes) {
        console.warn(`⚠️ generate_release_notes is ignored on Gitea.`);
      }
      if (config.input_discussion_category_name) {
        console.warn(`⚠️ discussion_category_name is ignored on Gitea.`);
      }
      if (config.input_make_latest) {
        console.warn(`⚠️ make_latest is ignored on Gitea.`);
      }
    }

    const releaseResult = await release(releaseConfig, releaser);
    let rel = releaseResult.release;
    const releaseWasCreated = releaseResult.created;
    let uploadedAssetIds: Set<number> = new Set();

    if (config.input_files && config.input_files.length > 0) {
      const files = paths(config.input_files, config.input_working_directory);
      if (files.length == 0) {
        if (config.input_fail_on_unmatched_files) {
          throw new Error(`⚠️ ${config.input_files} does not include a valid file.`);
        } else {
          console.warn(`🤔 ${config.input_files} does not include a valid file.`);
        }
      }
      const currentAssets = rel.assets;

      const uploadFile = async (path: string) => {
        const json = await upload(
          releaseConfig,
          releaser,
          uploadUrl(rel.upload_url),
          path,
          currentAssets,
        );
        return json ? (json.id as number) : undefined;
      };

      let results: (number | undefined)[];
      if (!config.input_preserve_order) {
        results = await Promise.all(files.map(uploadFile));
      } else {
        results = [];
        for (const path of files) {
          results.push(await uploadFile(path));
        }
      }

      uploadedAssetIds = new Set(results.filter((id): id is number => id !== undefined));
    }

    console.log('Finalizing release...');
    rel = await finalizeRelease(releaseConfig, releaser, rel, releaseWasCreated);

    console.log('Getting assets list...');
    {
      let assets: any[] = [];
      if (uploadedAssetIds.size > 0) {
        const updatedAssets = await listReleaseAssets(releaseConfig, releaser, rel);
        assets = updatedAssets
          .filter((a) => uploadedAssetIds.has(a.id))
          .map((a) => {
            const { uploader, ...rest } = a;
            return rest;
          });
      }
      setOutput('assets', assets);
    }

    console.log(`🎉 Release ready at ${rel.html_url}`);
    setOutput('url', rel.html_url);
    setOutput('id', rel.id.toString());
    setOutput('upload_url', rel.upload_url);
  } catch (error: any) {
    setFailed(error.message);
  }
}

run();
