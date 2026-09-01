.PHONY: vsix install-vsix lint

lint:
	npm run lint

vsix:
	npx @vscode/vsce package

install-vsix: vsix
	code --install-extension $$(ls -t *.vsix | head -1)
