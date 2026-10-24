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

IOS_APP_DIR := packages/app
IOS_BUILD_DIR := $(IOS_APP_DIR)/build/ios
IOS_SIMULATOR ?= iPhone 18 Pro
# Index-while-building only serves Xcode's editor, so skip it in command-line builds.
IOS_XCODEBUILD_FLAGS := -workspace $(IOS_APP_DIR)/ios/Paseo.xcworkspace -scheme Paseo \
	-configuration Release COMPILER_INDEX_STORE_ENABLE=NO

# Use an absolute path because Expo runs from packages/app. Target-specific exports also
# reach prerequisites without changing the environment for unrelated make targets.
install-cocoapods ios-prebuild ios-build ios-simulator-build: export GEM_HOME := $(CURDIR)/.gem
install-cocoapods ios-prebuild ios-build ios-simulator-build: export PATH := $(CURDIR)/.gem/bin:$(PATH)

.PHONY: install-cocoapods
install-cocoapods:
	test -x "$(GEM_HOME)/bin/pod" || gem install cocoapods --no-document

# Generates or updates packages/app/ios for ios-build and ios-simulator-build. Run ios-clean to
# regenerate it from scratch. Expo defaults to a clean prebuild, so --no-clean keeps Pods
# and the native project for incremental builds.
.PHONY: ios-prebuild
ios-prebuild: check-npm
	@test -n "$(strip $(IOS_BUNDLE_ID))" || { echo "IOS_BUNDLE_ID is required" >&2; exit 1; }
	$(MAKE) install-cocoapods app-deps
	cd $(IOS_APP_DIR) && EXPO_NO_GIT_STATUS=1 APP_VARIANT=production \
		IOS_BUNDLE_ID="$(IOS_BUNDLE_ID)" npx expo prebuild -p ios --no-clean

# Removes the generated iOS project and build outputs, so the next build starts from scratch.
.PHONY: ios-clean
ios-clean:
	rm -rf $(IOS_APP_DIR)/ios $(IOS_BUILD_DIR)

# Writes packages/app/build/ios/ipa/Paseo.ipa with a development profile. Set IOS_BUNDLE_ID,
# IOS_TEAM_ID and IOS_PROVISIONING_PROFILE explicitly. Generate export options from the
# same values used to sign the archive, leaving the checked-in template unchanged.
.PHONY: ios-build
ios-build:
	@test -n "$(strip $(IOS_BUNDLE_ID))" || { echo "IOS_BUNDLE_ID is required" >&2; exit 1; }
	@test -n "$(strip $(IOS_TEAM_ID))" || { echo "IOS_TEAM_ID is required" >&2; exit 1; }
	@test -n "$(strip $(IOS_PROVISIONING_PROFILE))" || { echo "IOS_PROVISIONING_PROFILE is required" >&2; exit 1; }
	$(MAKE) ios-prebuild
	mkdir -p $(IOS_BUILD_DIR)
	cp $(IOS_APP_DIR)/ExportOptions.plist $(IOS_BUILD_DIR)/ExportOptions.plist
	plutil -insert teamID -string "$(IOS_TEAM_ID)" $(IOS_BUILD_DIR)/ExportOptions.plist
	plutil -insert 'provisioningProfiles.$(subst .,\.,$(IOS_BUNDLE_ID))' -string "$(IOS_PROVISIONING_PROFILE)" \
		$(IOS_BUILD_DIR)/ExportOptions.plist
	xcodebuild $(IOS_XCODEBUILD_FLAGS) \
		-destination 'generic/platform=iOS' \
		-archivePath $(IOS_BUILD_DIR)/Paseo.xcarchive \
		archive \
		CODE_SIGN_STYLE=Manual \
		DEVELOPMENT_TEAM="$(IOS_TEAM_ID)" \
		CODE_SIGN_IDENTITY="Apple Development" \
		PROVISIONING_PROFILE_SPECIFIER="$(IOS_PROVISIONING_PROFILE)"
	xcodebuild -exportArchive \
		-archivePath $(IOS_BUILD_DIR)/Paseo.xcarchive \
		-exportOptionsPlist $(IOS_BUILD_DIR)/ExportOptions.plist \
		-exportPath $(IOS_BUILD_DIR)/ipa

# Builds the Release app with bundled JavaScript, so no Metro server is needed. A generic
# simulator destination builds every simulator architecture in Release, so build only this
# Mac's. Keep ad-hoc signing enabled: iOS rejects an unsigned launch storyboard and displays
# a black launch screen.
.PHONY: ios-simulator-build
ios-simulator-build: ios-prebuild
	xcodebuild $(IOS_XCODEBUILD_FLAGS) \
		-sdk iphonesimulator \
		-destination 'generic/platform=iOS Simulator' \
		-derivedDataPath $(IOS_BUILD_DIR)/simulator \
		ARCHS=$(shell uname -m) \
		CODE_SIGN_IDENTITY=-

# IOS_SIMULATOR accepts a device name or UDID from `xcrun simctl list devices`.
.PHONY: ios-simulator
ios-simulator: ios-simulator-build
	xcrun simctl bootstatus "$(IOS_SIMULATOR)" -b
	xcrun simctl install "$(IOS_SIMULATOR)" \
		$(IOS_BUILD_DIR)/simulator/Build/Products/Release-iphonesimulator/Paseo.app
	xcrun simctl launch "$(IOS_SIMULATOR)" "$(IOS_BUNDLE_ID)"

# Serves the ios-build IPA for over-the-air install. See scripts/ipa-distribution/README.md.
.PHONY: ios-serve
ios-serve:
	node scripts/ipa-distribution/server.mjs --ipa $(IOS_BUILD_DIR)/ipa/Paseo.ipa

# Writes artifacts/paseo-cli-<version>-<commit>.tgz. Run it on a host with
#   npx -y ./paseo-cli-<version>-<commit>.tgz daemon restart
.PHONY: cli-build
cli-build: check-npm
	node scripts/pack-cli-bundle.mjs
