# Third-Party Notices

Storecops bundles or loads the following third-party components. Their licenses require that the
copyright notice **and** the permission notice accompany any distribution — a bare
"Released under the MIT License" banner does not satisfy that, which is why the full texts are
reproduced here rather than merely referenced.

This file is verified against the code: `test/thirdPartyNotices.test.js` derives the list of
third-party assets actually referenced by `public/*.html` and fails if one is not documented below.

---

## Chart.js 4.4.1

- **Vendored at** `public/vendor/chart.umd.min.js` (loaded by `public/admin.html`)
- **License** MIT
- **Source** https://www.chartjs.org

The vendored bundle retains its copyright banner, but the minifier strips the permission notice, so
the full text is reproduced here.

```
MIT License

Copyright (c) 2014-2023 Chart.js Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Lucide 1.47.0

- **Vendored at** `public/vendor/lucide.min.js` (loaded by `public/index.html`
  and `public/app.html` as `/vendor/lucide.min.js`; upstream file
  `https://unpkg.com/lucide@1.47.0/dist/umd/lucide.min.js`, verified to contain
  `createIcons` and the ISC banner at vendor time)
- **License** ISC, with MIT for the icons derived from Feather
- **Source** https://lucide.dev

**Vendored deliberately — previously a pinned CDN script, before that `lucide@latest`.**
Every page load used to resolve upstream at request time, so a breaking release would have
broken the icon layer with no deploy and no diff to review. Vendoring removes the CDN
from the page and from the Content-Security-Policy entirely; re-vendor explicitly to
upgrade, and keep the license banner in the file.

```
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

### Icons derived from the Feather project

The Lucide icons listed below are derived from Feather and remain under the MIT License. This
covers the icon set in general use across the dashboard.

```
The MIT License (MIT)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Feather-derived icons in use: `alert-triangle`, `arrow-left`, `calendar`, `check`,
`chevron-down`, `chevron-left`, `chevron-right`, `chevron-up`, `clock`, `code`, `compass`,
`download`, `external-link`, `help-circle`, `info`, `key`, `layout`, `link`, `loader`, `lock`,
`log-in`, `log-out`, `maximize`, `minimize`, `minus`, `monitor`, `moon`, `more-horizontal`,
`more-vertical`, `plus`, `power`, `search`, `server`, `share`, `shopping-bag`, `smartphone`,
`table-2`, `target`, `terminal`, `trash-2`, `type`, `upload`, `x`, `zoom-in`, `zoom-out`.

---

## Google Fonts — Inter, Nunito, Baloo 2

- **Loaded from** `https://fonts.googleapis.com` (CSS) and `https://fonts.gstatic.com` (font files)
- **License** SIL Open Font License 1.1
- **Source** https://fonts.google.com

All three families are distributed under the SIL Open Font License 1.1, which permits bundling and
web embedding, including in commercial products. No attribution is required in the user interface.
Fonts are fetched from Google's CDN at runtime rather than self-hosted — see the note on
third-party requests in `public/privacy.html`.

---

## Runtime dependencies

Server-side npm dependencies are declared in `package.json` and their licenses are recorded in
`node_modules/*/LICENSE`. `test/dependencyHygiene.test.js` pins the `qs` override and scans for
known advisories (209 packages, 0 outstanding at the last run).

Note that `package.json` declares `"license": "UNLICENSED"`. That is the correct npm convention for
a proprietary application and is **not** an omission: the absence of a `LICENSE` file granting
rights is intentional. It does not affect the obligations above, which arise from third-party code
bundled *into* this application, not from this application's own terms.
