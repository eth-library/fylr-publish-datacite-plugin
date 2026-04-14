PLUGIN_NAME = fylr-plugin-datacite
ZIP_NAME ?= $(PLUGIN_NAME).zip
BUILD_DIR = build

GIT_HASH  := $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
BUILD_DATE := $(shell date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "unknown")
BUILD_INFO := $(GIT_HASH) ($(BUILD_DATE))

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-30s\033[0m %s\n", $$1, $$2}'

all: build ## build all

build: clean ## build plugin (creates build folder)
	mkdir -p $(BUILD_DIR)/$(PLUGIN_NAME)
	sed 's/%%BUILD_INFO%%/$(BUILD_INFO)/' manifest.master.yml > $(BUILD_DIR)/$(PLUGIN_NAME)/manifest.yml
	cp -r server l10n $(BUILD_DIR)/$(PLUGIN_NAME)

zip: build ## build zip file for publishing
	cd $(BUILD_DIR) && zip $(ZIP_NAME) -r $(PLUGIN_NAME)

clean: ## clean build files
	rm -rf $(BUILD_DIR)
