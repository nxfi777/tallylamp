.PHONY: test realism build start extension store

# Where Chrome loads the Tallylamp Link extension from. A copy, not a symlink: an unpacked
# extension is read from its folder every time the browser starts, so it has to live on a
# disk that is always there, which a checkout on an external drive is not.
EXT_DEST ?= $(HOME)/Desktop/tallylamp-link

test:
	npm test

realism:
	npm run test:realism

build:
	npx tsc

start:
	node dist/index.js

# No --delete: EXT_DEST is a path somebody typed, and one typo away from their Desktop.
extension:
	mkdir -p "$(EXT_DEST)"
	rsync -a --exclude README.md extension/ "$(EXT_DEST)/"
	@echo "Copied to $(EXT_DEST). Load it at chrome://extensions with Load unpacked, or press its reload arrow if it is already loaded."

# The zip to upload in the Chrome Web Store dashboard. The release asset unzips into a folder
# for Load unpacked; the store wants manifest.json at the top of the zip instead. The listing
# text, images and review answers are in docs/chrome-web-store.md.
STORE_ZIP = dist/tallylamp-link-$(shell node -p "require('./extension/manifest.json').version")-store.zip
store:
	mkdir -p dist
	rm -f "$(STORE_ZIP)"
	cd extension && zip -r -X "../$(STORE_ZIP)" . -x README.md '.*' '*/.*'
	@unzip -l "$(STORE_ZIP)"
