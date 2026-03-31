# Common Tasks

## Adding a New CLI Flag

1. `src/args.ts` — add parsing logic to `ArgumentParser`
2. `src/types/config.ts` — add field to `ParsedArguments`
3. `src/index.ts` — handle the flag in `main()`
4. `tests/` — add unit tests

## Modifying Tunnel Creation

Three files are involved, in order:
1. `src/tunnel.ts` → `TunnelOrchestrator.start()` — orchestration logic
2. `src/api.ts` → `APIClient.createTunnel()` — HTTP call to backend
3. `src/binary.ts` → `BinaryManager.spawn()` — process spawning

## Modifying the Backend Worker

1. `server/src/index.ts` — handlers
2. `server/wrangler.jsonc` — config, triggers, env vars
3. Required secrets: `CF_ACCOUNT_ID`, `CF_ZONE_ID`, `CF_DOMAIN`, `CF_API_TOKEN`
4. Key functions: `handleCreateTunnel()`, `handleDeleteTunnel()`, scheduled cleanup

## Adding New Types

1. Create/edit files in `src/types/`
2. Export from `src/types/index.ts`

## Adding a New Language

1. `src/constants.ts` — add language code to `AVAILABLE_LANGUAGES`
2. `src/types/i18n.ts` — add union type to `LanguageCode`
3. `src/lang.ts` — add translation object to `TRANSLATIONS`
4. `npm run build`

## Testing

- Use Vitest for testing
- Test files: `tests/*.test.ts`
- Focus on unit tests for utilities and parsers
- Mock external dependencies (axios, fs)
