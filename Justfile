set unstable
set lists

default:
    @just --list

[script]
[cache(inputs = ["src/index.ts", "package.json", "bun.lock"], outputs = "dist/index.js", extra = `bun --version`)]
build:
    bun run build

test:
    bun test

typecheck:
    bun run typecheck

check: test typecheck

publish:
    bun run publish:npm
