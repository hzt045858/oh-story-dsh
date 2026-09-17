# Third-party References

Copyright and license texts are preserved with the unmodified snapshots in
`third_party/`. `upstreams.json` pins each repository, revision, path and SHA-256.

- `wewrite`: Copyright holders listed in `third_party/wewrite/LICENSE`, MIT.
  Review/publishing source references and three YAML theme definitions are bundled.
  The article renderer reads their color tokens; it does not execute their CSS or runtime.
- `baoyu-skills`: Copyright holders listed in `third_party/baoyu/LICENSE`, MIT.
  Illustration prompt construction and multi-account design references are bundled.
- `wechat-article-skills`: Copyright holders listed in
  `third_party/aiworkskills/LICENSE`, Apache-2.0. API and pre-publish references are
  bundled unmodified. The selected upstream revision has no root NOTICE file.
- `gzh-design-skill`, `guizang-social-card-skill`, and `md2wechat-skill`:
  reference registry entries only. No code, templates, themes or prompts from these
  repositories are redistributed. Their respective AGPL and source-available
  licenses are not replaced by this repository's MIT license.

The DSH-native workflow, account registry, publisher, HTML renderer and card
generator are maintained here. Upstream snapshots are research material, not
independently registered Skills. Their platform instructions and credentials
examples do not override the current DSH task or this project's execution contract.
