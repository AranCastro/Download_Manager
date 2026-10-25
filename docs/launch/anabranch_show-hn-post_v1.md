# Show HN post: draft v1

Post at <https://news.ycombinator.com/submit>. Put the GitHub URL in the **url** field and paste the text below into the **text** box. If the text does not appear at the top of the thread after submitting, post it as the first comment straight away.

## Before posting

- [ ] v1.3.0 is released, and the Scoop command on the website works.
- [ ] The website is live, and <https://anabranch.draran.online/demo/> opens over HTTPS.
- [ ] You have about two hours free to answer comments. Early replies matter more than anything else on Hacker News.
- [ ] Post on a weekday between 17:30 and 19:30 IST (08:00–10:00 US Eastern).
- [ ] Do not ask colleagues or students to upvote. Hacker News detects voting rings and buries those posts.

## Title (79 characters; the limit is 80)

```
Show HN: Anabranch – a Windows download manager that Claude can operate via MCP
```

Alternative (80 characters):

```
Show HN: Anabranch – open-source download manager that AI assistants can operate
```

## URL

```
https://github.com/AranCastro/Download_Manager
```

## Text (or first comment)

```
Hi HN. I manage GIS work at a geospatial training institute in India. A lot of my
week goes into downloading large datasets: Sentinel-2 tiles, SRTM elevation
models, Landsat archives on FTP servers, files behind data-portal logins. These
are often several GB each and are best fetched overnight.

I wanted what Internet Download Manager does (split each file across parallel
connections, resume after a dropped line), but I also wanted to hand the tedious
part to an AI assistant: "here are 40 tile links, download them from 01:30 with
4 connections each, then put the PC to sleep". So the app has an MCP server, and
Claude Desktop (or any MCP client) can check links, queue and schedule downloads,
supply logins and report progress through a local, token-protected API.

What it does:

- Up to 32 connections per file over HTTP, FTP and FTPS. A connection that
  finishes early takes over half of the largest remaining range.
- Resume from saved offsets, including after a reboot.
- Scheduler with start/stop times and weekdays; quit, sleep or shut down
  afterwards (with a 60-second countdown you can cancel).
- HTTP Basic/Digest and FTP logins, stored with Windows DPAPI.
- HLS and DASH streams, merged into one MP4 with FFmpeg; AES-128 HLS.
- Browser extension (Chrome, Edge, Firefox) that hands downloads to the app
  together with the site's cookies, so portal downloads behind a sign-in work.
- Updates itself from GitHub Releases. Also: Scoop, a portable exe, light and
  dark themes.

Stack: Electron + React. The download engine is plain Node.js, with node:test
tests against local HTTP, FTP and HLS servers. MIT licence.

You can try the interface in the browser, with simulated downloads, here:
https://anabranch.draran.online/demo/

Known gaps: Windows builds only for now; the exe is not code-signed yet, so
SmartScreen asks for confirmation; DASH manifests with several periods download
only the first period.

Much of the code was written with Claude Code, with me directing, testing and
reviewing.

I would particularly like to hear from people who move large scientific
datasets: which portals or protocols should it handle that it does not?
```

## Notes

- Keep the disclosure that Claude Code wrote much of the code. Hacker News readers ask about this, and saying it first avoids an argument in the comments.
- If someone asks how Anabranch compares with aria2 or Motrix, a fair answer: aria2 is a command-line engine (Motrix is a front end for it) with a JSON-RPC interface. Anabranch has its own engine, a Windows interface, and an MCP server that assistants can call without any glue code.
- Answer criticism briefly and factually; do not argue.
