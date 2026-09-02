.PHONY: test realism build start

test:
	npm test

realism:
	npm run test:realism

build:
	npx tsc

start:
	node dist/index.js
