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
