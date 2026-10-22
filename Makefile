ARCH ?= $(shell uname -m | sed 's/x86_64/x64/')

.PHONY: install
install: check-npm
	npm ci

.PHONY: check-npm
check-npm:
	@test "$$(npm --version | cut -d. -f1)" = 12 || { echo "npm 12 is required" >&2; exit 1; }

# NOTE: Ad-hoc signatures carry no Team ID, so the hardened runtime's library
# validation rejects the Electron framework at launch. Disable it for local builds.
.PHONY: macos-build
macos-build: check-npm
	npm run build:desktop -- --mac --$(ARCH) --publish never \
		-c.mac.identity=- -c.mac.notarize=false -c.mac.hardenedRuntime=false

# Builds one workspace package with tsc --incremental instead of its full `build` script. The
# build info lives in the output directory, so deleting that directory forces a full build
# instead of leaving tsc believing it is up to date.
app_deps_tsc = npm exec --workspace=@getpaseo/$(1) -- tsc -p tsconfig.json --incremental \
	--tsBuildInfoFile $(2)/.tsbuildinfo

# Builds the workspace packages the app imports, like `npm run build:app-deps`, but rebuilds
# only what changed since the last run.
.PHONY: app-deps
app-deps: check-npm
	npm run generate:validators --workspace=@getpaseo/protocol
	$(call app_deps_tsc,protocol,dist)
	$(call app_deps_tsc,relay,dist)
	$(call app_deps_tsc,client,dist)
	$(call app_deps_tsc,highlight,dist)
	$(call app_deps_tsc,plugin,dist)
	$(call app_deps_tsc,expo-two-way-audio,build)

# Writes artifacts/paseo-cli-<version>-<commit>.tgz. Run it on a host with
#   npx -y ./paseo-cli-<version>-<commit>.tgz daemon restart
.PHONY: cli-build
cli-build: check-npm
	node scripts/pack-cli-bundle.mjs
