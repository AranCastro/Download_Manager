# Distributing Anabranch

This guide covers getting Anabranch onto users' computers at no cost. The build already does the following automatically:

- Builds the files for each release and attaches them to the GitHub Release.
- Keeps installed copies up to date.
- Writes the package-manager manifests.

A few steps need an account that only the maintainer can create. They are marked **(you)** below.

| Channel | Cost | Status |
| --- | --- | --- |
| Automatic updates | Free | Built in. The installed app updates itself from GitHub Releases. |
| Website with a live demo | Free (GitHub Pages) | Built and published by CI. Switch Pages on once **(you)**. |
| Scoop | Free | Works now (see below). |
| winget | Free | Each release includes ready-made manifests. The first submission is one pull request **(you)**. |
| Edge Add-ons | Free | Upload the store build of the extension **(you)**. |
| Firefox Add-ons (AMO) | Free | Upload the store build of the extension **(you)**. |
| Chrome Web Store | One-time US$5 registration fee | Optional. Same upload as Edge **(you)**. |
| Code signing (SignPath Foundation) | Free for open-source projects | Apply **(you)**. The build is then extended to sign each release. |

## 1. Releases and automatic updates

1. Raise `version` in `package.json` and merge the change into `main`.
2. In the Actions tab, open **Build Windows exe**, choose **Run workflow** on `main`, and enter the tag (for example `v1.3.1`). The tag must match the version in `package.json`.

The workflow publishes the release with these files:

- the installer and the portable exe;
- `latest.yml` and the `.blockmap`, which installed copies read to update themselves;
- `anabranch.json`, the Scoop manifest;
- `anabranch-winget-<version>.zip`, the winget manifests;
- the four extension zips: full and store builds, for Chromium and Firefox.

Installed copies (from the Setup exe) check for a new version 20 seconds after start and every 6 hours. They download it in the background and show **Restart now**. The portable exe cannot replace itself; it shows that a new version exists and links to the release. Users can switch updates off in **Options → General → Updates**. That setting also covers the daily `yt-dlp -U` for the copy of yt-dlp that the app installed.

## 2. Website (GitHub Pages)

The workflow `.github/workflows/pages.yml` builds the landing page (`site/`) and the browser demo of the app, and publishes them on every push to `main`. Pull requests only build them, as a check. Switch GitHub Pages on once **(you)**: in the repository, open **Settings → Pages → Build and deployment**, set **Source** to **GitHub Actions**, then rerun the **Website** workflow from the Actions tab. The site is then at <https://arancastro.github.io/Download_Manager/>.

Launch texts for Hacker News and AlternativeTo are in `docs/launch/`.

## 3. Scoop (works now)

Users install with:

```powershell
scoop install https://github.com/AranCastro/Download_Manager/releases/latest/download/anabranch.json
```

`scoop update anabranch` then fetches the newest release, because the manifest's address always points to the latest one.

## 4. winget (first submission by you)

The first version of a package must be submitted to [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs) as a pull request. In PowerShell on Windows:

```powershell
# 1. Download and extract the manifests from the latest release
Invoke-WebRequest https://github.com/AranCastro/Download_Manager/releases/latest/download/anabranch-winget-1.3.0.zip -OutFile winget.zip
Expand-Archive winget.zip -DestinationPath winget
$folder = Get-ChildItem winget\manifests\a\AranCastro\Anabranch | Select-Object -Last 1

# 2. Check them
winget validate --manifest $folder.FullName

# 3. Submit (wingetcreate opens the pull request from your GitHub account)
winget install Microsoft.WingetCreate
wingetcreate submit --token <GitHub token with public_repo scope> $folder.FullName
```

- Replace `1.3.0` with the release you are submitting.
- A Microsoft bot validates the pull request. A moderator merges it, usually within a few days.
- After that, anyone can run `winget install AranCastro.Anabranch`.
- For later versions: `wingetcreate update AranCastro.Anabranch --version <new version> --urls <Setup exe URL> --submit --token <token>`.

## 5. Browser extension stores

Use the **store** builds from the release: `anabranch-extension-chromium-store-<version>.zip` and `anabranch-extension-firefox-store-<version>.zip`.

- The store builds leave out the YouTube button. The Chrome Web Store, Edge Add-ons and AMO do not accept YouTube downloaders.
- YouTube downloading keeps working in the app itself.
- The full extension stays available for loading by hand.

### Edge Add-ons (free)

1. Register as a developer in [Microsoft Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/overview). Registration is free.
2. Choose **Create new extension** and upload the Chromium store zip.
3. Fill in the listing from section 7 below. Use `https://github.com/AranCastro/Download_Manager/blob/main/docs/PRIVACY.md` as the privacy policy URL.

### Firefox Add-ons (free)

1. Sign in at [addons.mozilla.org/developers](https://addons.mozilla.org/developers/).
2. Choose **Submit a New Add-on**, select **On this site**, and upload the Firefox store zip.
3. The code is not minified, so no separate source upload is needed.
4. Once it is approved, Firefox users install it permanently. The temporary add-on step in the README is then no longer needed.

### Chrome Web Store (US$5 once, optional)

1. Register at the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole). The one-time fee is US$5.
2. Upload the same Chromium store zip as for Edge.
3. In the **Privacy practices** tab, state:
   - the single purpose (section 7);
   - one justification per permission (copy the table from [PRIVACY.md](PRIVACY.md));
   - that no remote code is used;
   - that no user data is sold or transferred to third parties.

## 6. Code signing (free through SignPath Foundation)

SignPath Foundation signs open-source projects free of charge. It requires all of the following ([terms](https://signpath.org/terms)):

- an OSI-approved licence (MIT, in `LICENSE`);
- builds made from source in a verifiable way (GitHub Actions);
- multi-factor authentication for every team member, on both GitHub and SignPath;
- manual approval of each release before signing;
- a **Code signing policy** on the project's home page, naming the team roles and linking the privacy policy;
- "a certain verifiable reputation" for executable programs. A very new project may be asked to come back once it has users. The Scoop and winget channels above help build that reputation.

Steps **(you)**:

1. Turn on two-factor authentication for your GitHub account.
2. Apply at [signpath.org](https://signpath.org/) (choose **Apply**), with the repository URL.
3. When approved, add the section below to the README. Then send the API token, organisation ID and project slug as repository secrets. The workflow is then extended to send each release build to SignPath before it is published.

Section to add to the README after approval (adapted from the example SignPath gives; use their current wording if it differs):

```markdown
## Code signing policy

Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).

- Committers and reviewers: [Dr Aran Castro](https://github.com/AranCastro)
- Approvers: [Dr Aran Castro](https://github.com/AranCastro)

Privacy policy: see [docs/PRIVACY.md](docs/PRIVACY.md). This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it.
```

## 7. Store listing text

**Name:** Anabranch Browser Connector

**Summary (132 characters at most):**
Send downloads, links and video streams from the browser to Anabranch, a fast multi-connection download manager for Windows.

**Single purpose:** Hand downloads, links and media streams from the browser to the Anabranch desktop download manager running on the same computer.

**Category:** Productivity (Chrome, Edge); Download Management (Firefox)

**Description:**

> Anabranch Browser Connector links your browser to Anabranch, a free and open-source download manager for Windows. Anabranch is a separate desktop app, available from https://github.com/AranCastro/Download_Manager.
>
> - Downloads of the file types you choose are handed to Anabranch, which splits each file into parallel connections and resumes after interruptions.
> - Your cookies and referrer go with each download, so files behind a sign-in still download.
> - Right-click menus: *Download with Anabranch* for one link, and *Download all links* for a whole page.
> - Video streams (HLS and DASH) and media files that a page plays are listed in the toolbar panel, ready to download.
> - The extension talks only to the Anabranch app on your own computer (127.0.0.1). Nothing is sent to the developer or to third parties.
>
> First use: start Anabranch, click the extension's toolbar button, choose **Connect**, and approve the request in the app.

**Screenshots:** 1280×800 images of the toolbar panel and of the app's Add dialog. `docs/screenshot.png` can be cropped to this size.
