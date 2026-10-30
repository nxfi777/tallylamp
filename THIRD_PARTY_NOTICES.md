# Third-party notices

Tallylamp is an independent project. It is not a fork of chikin, does not
preserve chikin APIs, and is not affiliated with or endorsed by chikin's author.

Some implementation ideas and small fragments were adapted from:

## chikin

Repository: https://github.com/jra3/chikin  
License: MIT  
Copyright (c) 2026 John Allen  
Reference commit: `c3175a1eeb1ed986a9523924f30044c04b59f2b9` (2026-08-28)

Adapted concepts (rewritten for Tallylamp's process-based Railway architecture):

- Headed Chrome on Xvfb with a persistent `--user-data-dir`
- Clearing Chrome `SingletonLock` / `SingletonSocket` / `SingletonCookie` on start
- Probing unprivileged user namespaces before enabling the renderer sandbox
- SSE comment keepalives on long-lived MCP streams (`: keepalive`)
- Conservative DNS-safe name charset for browser slugs
- Seed/golden profile cloning while Chrome is stopped
- The observation that chrome-devtools-mcp can connect to an already-running
  Chrome via `--browser-url`

The MIT license text for chikin is included below, as required for substantial
portions of the Software that informed those fragments.

```
MIT License

Copyright (c) 2026 John Allen

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

## chrome-devtools-mcp

https://github.com/ChromeDevTools/chrome-devtools-mcp  
Apache-2.0  
Pinned at 1.8.0. Tallylamp spawns it as a child and forwards its tools; it is
not vendored.

## Model Context Protocol TypeScript SDK

https://github.com/modelcontextprotocol/typescript-sdk  
MIT  
Pinned at 1.30.0.

## Geist and Geist Mono

https://github.com/vercel/geist-font  
SIL Open Font License 1.1  
Copyright 2024 The Geist Project Authors  
The Latin subsets ship inside the browser extension, in `extension/fonts/`, and with the
dashboard, in `dashboard/fonts/`, with the license beside them in each `OFL.txt`.

## Lucide

https://github.com/lucide-icons/lucide  
ISC  
Copyright (c) Lucide Contributors 2022. Portions copyright (c) Cole Bemis 2013-2022 as
part of Feather (MIT).  
The extension panel's icons (`extension/panel.js`) are Lucide's SVG paths.

```
ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of
Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors
2022.

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```
