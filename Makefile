.PHONY: vsix install lint deps

vsix: deps
	npx @vscode/vsce package

deps:
	@npm install

lint: deps
	npm run lint

install: vsix
	code --install-extension $$(ls -t *.vsix | head -1)
