# x

Get information out of X (Twitter) from the command line, on your own signed-in account. The tool
writes its own commands: ask for one it doesn't have and coding agents build it.

```sh
bun install && bunx playwright install chromium
bin/x context:add me --url https://x.com/<your handle>
bin/x context:login me          # sign in by hand in the window
bin/x help                      # the ops it has
bin/x request "the replies under a post, oldest first"
bin/x request:status R-0001 --wait
```

See `DESIGN.md`.
