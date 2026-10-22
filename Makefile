ARCH ?= $(shell uname -m | sed 's/x86_64/x64/')

.PHONY: install
# NOTE: `lefthook install --force` in the root `prepare` script rewrites .git/hooks,
# and it has no environment variable to skip it, so every install script is skipped
# and only the dependency patches are applied.
install:
	npm ci --ignore-scripts
	npm run postinstall

.PHONY: mac-adhoc
# NOTE: Ad-hoc signatures carry no Team ID, so the hardened runtime's library
# validation rejects the Electron framework at launch. Disable it for local builds.
mac-adhoc:
	npm_config_ignore_scripts=false npm run build:desktop -- --mac --$(ARCH) --publish never \
		-c.mac.identity=- -c.mac.notarize=false -c.mac.hardenedRuntime=false

.PHONY: cli-bundle
# Writes artifacts/paseo-cli-<version>-<commit>.tgz. Run it on a host with
#   npx -y ./paseo-cli-<version>-<commit>.tgz daemon restart
cli-bundle:
	node scripts/pack-cli-bundle.mjs
