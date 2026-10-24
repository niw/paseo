# IPA distribution

Serves a signed IPA for over-the-air install through an HTTPS proxy such as a Cloudflare tunnel. The server reads the app name, bundle identifier and version from the IPA. It does not sign or modify the IPA.

It uses only Node built-ins plus macOS `unzip` and `plutil` to read the IPA's `Info.plist`, so it runs on the Mac that built the IPA.

## Start the server

Build the IPA with `make ios-build`, then from the repository root:

```sh
make ios-serve
```

or directly:

```sh
node scripts/ipa-distribution/server.mjs --ipa /absolute/path/to/App.ipa --host 127.0.0.1 --port 3000
```

The server binds to `127.0.0.1:3000` by default. Point the tunnel at `http://127.0.0.1:3000`. Restart after replacing the IPA so its metadata is read again.

Links are built per request from `X-Forwarded-Host` (or `Host`) and `X-Forwarded-Proto` (or `http`). The proxy must keep the public host, set the forwarded scheme to `https`, and overwrite client-supplied forwarding headers, since the server trusts them.

## Token

A random token is generated on each start. Set `IPA_DISTRIBUTION_TOKEN` to a long random secret to keep links stable across restarts; an empty token is rejected. Access logs print only the method, path and status, never the query string.

## Cloudflare Access

Keep `/` behind Cloudflare Access: it shows the token-bearing links. Add a more specific Access application for `your-host.example/itms-services/*` with a Bypass policy, so the iOS installer can fetch without Safari's Access session. The server checks `?auth=TOKEN` on every request under that prefix, including `HEAD`.

| Path                                       | Authentication    |
| ------------------------------------------ | ----------------- |
| `/`                                        | Cloudflare Access |
| `/itms-services/manifest.plist?auth=TOKEN` | Server token      |
| `/itms-services/app.ipa?auth=TOKEN`        | Server token      |

The token grants download access to anyone who has it, so avoid logging query strings at the proxy. Responses carry `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. Run it behind the HTTPS proxy, not as a public HTTP server.

## Install

Open the public URL in Safari on the iPhone and tap Install. The device must be in the provisioning profile, and development builds need Developer Mode on. App Store export IPAs cannot be installed this way.
