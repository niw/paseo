#!/usr/bin/env node
// Serves a signed IPA for over-the-air install behind an HTTPS proxy. See README.md.
import { execFileSync } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, readFileSync, realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { isMainModule } from "../is-main-module.mjs";

const HOST_CHARACTERS = /^[A-Za-z0-9.\-:[\]]+$/;

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" })[character],
  );
}

/** Reads the app's Info.plist with macOS unzip and plutil, so the server needs no dependencies. */
function readAppInfo(ipa) {
  const plists = execFileSync("unzip", ["-Z1", ipa], { encoding: "utf8", maxBuffer: 64 << 20 })
    .split("\n")
    .filter((name) => /^Payload\/[^/]+\.app\/Info\.plist$/.test(name));
  if (plists.length !== 1) throw new Error("IPA must contain exactly one application");
  // unzip treats [ and ] in member names as wildcards.
  const member = plists[0].replace(/[[\]*?]/g, "\\$&");
  const plist = execFileSync("unzip", ["-p", ipa, member], { maxBuffer: 16 << 20 });
  return JSON.parse(
    execFileSync("plutil", ["-convert", "json", "-o", "-", "-"], {
      input: plist,
      encoding: "utf8",
    }),
  );
}

/** The public origin the proxy forwarded, from X-Forwarded-Host/Proto or Host. */
function requestOrigin(headers) {
  const first = (value) =>
    String(value ?? "")
      .split(",")[0]
      .trim();
  const host = first(headers["x-forwarded-host"] ?? headers.host);
  const scheme = first(headers["x-forwarded-proto"] ?? "http").toLowerCase();
  if (!["http", "https"].includes(scheme) || !HOST_CHARACTERS.test(host)) return null;
  try {
    return new URL(`${scheme}://${host}`).hostname ? `${scheme}://${host}` : null;
  } catch {
    return null;
  }
}

function manifestPlist({ ipaUrl, identifier, version, title }) {
  const string = (value) => `<string>${escapeHtml(value)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array>
        <dict>
          <key>kind</key>${string("software-package")}
          <key>url</key>${string(ipaUrl)}
        </dict>
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key>${string(identifier)}
        <key>bundle-version</key>${string(version)}
        <key>kind</key>${string("software")}
        <key>title</key>${string(title)}
      </dict>
    </dict>
  </array>
</dict>
</plist>
`;
}

export function createIpaServer({ ipa, token }) {
  if (!token) throw new Error("token must not be empty");
  const ipaPath = realpathSync(ipa);
  const info = readAppInfo(ipaPath);
  const identifier = info.CFBundleIdentifier;
  const version = info.CFBundleVersion;
  const title = info.CFBundleDisplayName ?? info.CFBundleName ?? identifier;
  const shortVersion = info.CFBundleShortVersionString ?? version;
  const query = new URLSearchParams({ auth: token }).toString();
  const template = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const expectedToken = Buffer.from(token);

  function urls(origin) {
    const ipaUrl = `${origin}/itms-services/app.ipa?${query}`;
    const manifestUrl = `${origin}/itms-services/manifest.plist?${query}`;
    const installUrl = `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`;
    return { ipaUrl, installUrl };
  }

  function page(origin) {
    const { ipaUrl, installUrl } = urls(origin);
    const values = {
      TITLE: title,
      VERSION: `${shortVersion} (${version})`,
      INSTALL_URL: installUrl,
      IPA_URL: ipaUrl,
    };
    return template.replace(/\{\{(\w+)\}\}/g, (match, key) =>
      key in values ? escapeHtml(values[key]) : match,
    );
  }

  function authorized(searchParams) {
    const auth = searchParams.getAll("auth");
    if (auth.length !== 1) return false;
    const given = Buffer.from(auth[0]);
    return given.length === expectedToken.length && timingSafeEqual(given, expectedToken);
  }

  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    // Log the path only: query strings carry the token.
    response.on("finish", () =>
      console.error(`${request.method} ${JSON.stringify(url.pathname)} ${response.statusCode}`),
    );
    const send = (status, type, body, length = Buffer.byteLength(body)) => {
      response.writeHead(status, {
        "Content-Type": type,
        "Content-Length": length,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      });
      if (request.method === "HEAD" || body === null) response.end();
      else if (typeof body === "string") response.end(body);
      else body.pipe(response);
    };

    if (request.method !== "GET" && request.method !== "HEAD") {
      send(405, "text/plain; charset=utf-8", "Method not allowed\n");
      return;
    }
    const origin = requestOrigin(request.headers);
    if (!origin) {
      send(400, "text/plain; charset=utf-8", "Invalid request origin\n");
      return;
    }
    if (url.pathname === "/") {
      send(200, "text/html; charset=utf-8", page(origin));
      return;
    }
    if (!url.pathname.startsWith("/itms-services/")) {
      send(404, "text/plain; charset=utf-8", "Not found\n");
      return;
    }
    if (!authorized(url.searchParams)) {
      send(403, "text/plain; charset=utf-8", "Forbidden\n");
      return;
    }
    if (url.pathname === "/itms-services/manifest.plist") {
      send(200, "text/xml", manifestPlist({ ...urls(origin), identifier, version, title }));
      return;
    }
    if (url.pathname === "/itms-services/app.ipa") {
      let size;
      try {
        size = statSync(ipaPath).size;
      } catch {
        send(503, "text/plain; charset=utf-8", "IPA unavailable\n");
        return;
      }
      const body = request.method === "HEAD" ? null : createReadStream(ipaPath);
      body?.on("error", () => response.destroy());
      send(200, "application/octet-stream", body, size);
      return;
    }
    send(404, "text/plain; charset=utf-8", "Not found\n");
  });
}

function main() {
  const { values } = parseArgs({
    options: {
      ipa: { type: "string" },
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "3000" },
    },
  });
  if (!values.ipa) {
    console.error("usage: server.mjs --ipa /path/to/App.ipa [--host 127.0.0.1] [--port 3000]");
    process.exit(2);
  }
  const token = process.env.IPA_DISTRIBUTION_TOKEN ?? randomBytes(32).toString("base64url");
  let server;
  try {
    server = createIpaServer({ ipa: values.ipa, token });
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  server.listen(Number(values.port), values.host, () => {
    const { port } = server.address();
    console.log(`Listening on http://${values.host}:${port}`);
  });
}

if (isMainModule(import.meta.url)) main();
