.PHONY: lint compile test package release install clean

lint:
	npm run lint

compile:
	npm run compile

test:
	npm test

package: compile
	npx --yes @vscode/vsce package --no-dependencies --skip-license --allow-missing-repository

release: compile test
	@git diff --quiet && git diff --cached --quiet || (echo "release requires clean tree"; exit 1)
	npm version patch --no-git-tag-version
	npx --yes @vscode/vsce package --no-dependencies --skip-license --allow-missing-repository

install: package
	code --install-extension $$(ls -t claude-ghost-*.vsix | head -n1) --force

clean:
	rm -rf out out-test claude-ghost-*.vsix
