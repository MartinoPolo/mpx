# Vendored `@tintinweb/pi-subagents` provenance

- Upstream: <https://github.com/tintinweb/pi-subagents>
- Commit: `8976c63f9857fb308926dd1d7369c2b7e059ffdc`
- Version: 0.14.3
- License: MIT; full text is in `LICENSE`.
- Provenance source: the maintained Phase F input snapshot `mpx-pi/extensions/subagents`.

The TypeScript in this directory is projection source, not an active package. It has no
nested lockfile and is not imported by `@mpx/runtime-pi` at runtime. The runtime projection
keeps nested orchestration disabled by default. Re-vendoring is an explicit source update;
startup, launch, and account selection never consult the provenance source repository.
