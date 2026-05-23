# Convenience targets for the ClawChat iOS workspace.
#
#   make project     - regenerate ClawChatApp.xcodeproj from project.yml
#   make build       - build the app for iOS Simulator (arm64) into .derived/
#   make open        - open the workspace in Xcode
#   make sim         - boot iPhone 17 simulator, install + launch the app
#   make clean       - wipe .derived/ and the regenerated project

WORKSPACE  := ClawChat.xcworkspace
SCHEME     := ClawChatApp
SIM_NAME   := iPhone 17
DERIVED    := .derived
BUNDLE_ID  := io.vulturelabs.clawchat

.PHONY: project build open sim clean test-ios

project:
	cd ClawChatApp && xcodegen

build:
	xcodebuild \
	  -workspace $(WORKSPACE) \
	  -scheme $(SCHEME) \
	  -destination "generic/platform=iOS Simulator" \
	  -configuration Debug \
	  -derivedDataPath $(DERIVED) \
	  build

open:
	open $(WORKSPACE)

# Boot a simulator, install the built .app, and launch it.
sim: build
	@SIM_UDID=$$(xcrun simctl list devices --json | python3 -c "import sys,json; d=json.load(sys.stdin)['devices']; \
		[print(dev['udid']) for k,v in d.items() if 'iOS' in k for dev in v if dev['name']=='$(SIM_NAME)']" | head -1); \
	if [ -z "$$SIM_UDID" ]; then echo "no simulator named '$(SIM_NAME)' found"; exit 1; fi; \
	xcrun simctl boot $$SIM_UDID 2>/dev/null || true; \
	open -a Simulator; \
	APP=$$(find $(DERIVED)/Build/Products -name 'ClawChatApp.app' -type d | head -1); \
	echo "installing $$APP onto $$SIM_UDID..."; \
	xcrun simctl install $$SIM_UDID $$APP; \
	xcrun simctl launch $$SIM_UDID $(BUNDLE_ID)

test-ios:
	cd ClawChat && swift test

clean:
	rm -rf $(DERIVED) ClawChatApp/ClawChatApp.xcodeproj
