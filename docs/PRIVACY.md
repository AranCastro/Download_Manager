# Privacy policy

*Applies to the Anabranch desktop app and the Anabranch Browser Connector extension. Last updated: 25 October 2026.*

Anabranch has no user accounts, no analytics and no advertising. Neither the app nor the extension sends any data to the developer.

## Desktop app

- **What it stores:** the download list, settings, the local API token, the browser pairings and any logins you save. They are kept on your computer in `%APPDATA%\Anabranch\`. Logins and cookies are encrypted with the Windows Data Protection API (DPAPI).
- **Which servers it contacts:**
  - The servers of the files you choose to download.
  - GitHub (`api.github.com`, `github.com` and its download hosts), to check for and download new versions of Anabranch and yt-dlp. These requests carry no personal data beyond what any web request reveals, such as your IP address.
  - GitHub, when you click **Install FFmpeg**, to download a static FFmpeg build.
- **Video sites:** YouTube links are handled by yt-dlp on your computer, which contacts YouTube directly. Cookies that the browser extension passes on are written to a temporary file for yt-dlp and deleted when the download ends.
- **Local API:** the API listens only on `127.0.0.1`, so other computers cannot reach it. Every request needs a token.

## Browser extension

- **Where data goes:** the extension communicates only with the Anabranch app on the same computer, at `http://127.0.0.1`. It contacts no other server, except to fetch a video playlist that the page itself has already loaded, in order to read the available qualities.
- **Permissions:**

| Permission | Why it is needed |
| --- | --- |
| `downloads` | To hand a browser download over to the app (the browser's download is cancelled and the app takes over). |
| `cookies` | To pass the site's cookies for the link being downloaded to the app, so that downloads that need a sign-in work. They are used only for that request. |
| `webRequest`, host access | To notice video streams (HLS/DASH) and media files that a page loads, so that they can be listed in the toolbar panel. The list is kept in the browser's session storage and is cleared when the tab navigates or closes. |
| `contextMenus` | For the *Download with Anabranch* menus. |
| `scripting` (Chromium), `tabs` (Firefox) | To collect the links on a page for *Download all links*. This happens only when you choose that menu. |
| `webNavigation` | To clear a tab's list of detected media when the tab navigates to a new page. |
| `storage` | To keep the extension's settings and its pairing token. |

- **What is not collected:** browsing history and page contents are neither collected nor stored.

## Contact

Questions or concerns: open an issue at <https://github.com/AranCastro/Download_Manager/issues>.
