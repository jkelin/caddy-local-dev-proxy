set unstable
set lists

default:
    @just --list

build:
    bun run build

test:
    bun test

typecheck:
    bun run typecheck

check: test typecheck

publish:
    bun run publish:npm
