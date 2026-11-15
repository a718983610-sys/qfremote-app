# QFRemote 分支保护策略（S-099）

> **执行状态：未配置——本文件只是策略文本。**分支保护规则只能由 GitHub
> 管理员在仓库 Settings → Branches（或 `gh api`）里执行，代码改动配不
> 出来。本线只出策略文件，执行记为**待管理员操作**，绝不谎称已配好。
> 执行后管理员须把规则截图／`gh api` 回显贴回发版群，本文件再改状态为已配置。

## 适用分支

- `lea-local-agent`（开发主线）
- `main`（发布线）

## 规则（两分支相同）

1. **PR 必须审查**：至少 1 名非作者审查通过才能合并；作者不能批自己的 PR；
   审查驳回后须重新审查。
2. **Required status checks（缺一不可，全部变绿才能合并）**：
   - Windows 构建与测试（`.github/workflows/windows.yml`：Node tests、
     Electron/NSIS 构建、LEA/USH 编译、白名单 --check、PE 核查、安装烟测）
   - Android 构建（`.github/workflows/android.yml` build job：analyze＋test＋
     更新链实测＋dev 产物验包）
   - Web E2E（S-071 的新增工作流落地后加入；落地前本项空缺，须在总表记一笔）
   - 版本／manifest 一致性（`tools/check-release-version.js`，由上述两个
     工作流内跑，不单独立项）
   - Secret 扫描与 license 扫描（有扫描工作流／GitHub Advanced Security
     开启后加入；开启前本项空缺，须在总表记一笔）
   - 要求分支为最新（Require branches to be up to date before merging）。
3. **禁止 force push、禁止删除分支**。
4. **限制直接 push**：保护分支上禁止直接 push，一律走 PR（含站长本人）。
5. **禁止绕过**：不设 bypass 名单；管理员也不绕过（紧急修复同样走 PR＋审查）。

## 正式发布环境（S-100/S-101/S-102 配套）

- 仓库 Settings → Environments 新建 `production`：
  - Required reviewers：至少 1 名（站长或其指定的发版负责人）；
  - 仅 `main` 分支与 `v*` tag 可部署到该环境；
  - 环境 Secret（安卓 keystore 等）只进挂了该环境的 release job，
    普通 PR 构建一律看不到。
- Dependabot 与 dependency review（第三方 action 更新 PR）：由管理员在
  Settings → Code security 开启，开启后第三方 action 的 SHA 更新走
  Dependabot PR＋人工审查，不直接改 tag。

## 管理员执行清单（逐项打勾）

- [ ] `lea-local-agent`：PR 必审（1 人）＋ required checks（上列已落地的项）＋禁 force push ＋禁删分支 ＋禁直接 push
- [ ] `main`：同上
- [ ] Environments → `production`：Required reviewers ≥1 人，仅 main／v* tag 可部署
- [ ] Code security：Dependabot alerts＋updates、secret scanning＋push protection、dependency review 开启
- [ ] 执行回显（规则截图或 `gh api` 输出）贴回发版群，本文件状态改为已配置

管理员可用命令（示例，需按实际仓库名替换，需管理员 token）：

```bash
gh api repos/<owner>/<repo>/branches/lea-local-agent/protection -X PUT \
  --input <(cat <<'JSON'
{
  "required_status_checks": {"strict": true, "contexts": []},
  "enforce_admins": true,
  "required_pull_request_reviews": {"required_approving_review_count": 1},
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
)
```

> 注意：`contexts` 须填入当时已落地的检查名（Windows／Android 工作流的
> job 名），填错名会导致 PR 永远合并不了；执行时以工作流实际 job 名为准，
> 不要照抄本文件的中文描述。
