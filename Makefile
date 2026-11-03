.PHONY: vsix prod install lint deps
STAGE := build/vsix

deps:
	npm install

lint: deps
	npm run lint

vsix: deps
	npx @vscode/vsce package

prod: deps lint
	rm -rf dist $(STAGE)
	npm run check-types
	node esbuild.cjs --production
	mkdir -p $(STAGE)
	rsync -a --exclude '*.map' dist media README.md CHANGELOG.md LICENSE $(STAGE)/
	jq '.main = "./dist/extension.js" | .files = ["dist", "media", "LICENSE", "README.md", "CHANGELOG.md"] | del(.scripts, .dependencies, .devDependencies)' package.json > $(STAGE)/package.json
	cd $(STAGE) && npx @vscode/vsce package --no-dependencies -o ../../acpcode.vsix

install:
	code-insiders --install-extension acpcode.vsix
