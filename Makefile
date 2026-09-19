.PHONY: test realism build start extension

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
