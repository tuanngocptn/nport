# TypeScript Code Style

## TypeScript

- Use strict TypeScript with full type annotations
- Prefer `interface` over `type` for object shapes
- Use `type` for unions, intersections, and simple aliases
- Always import types with `import type { ... }`
- **Never use `any` type** unless absolutely necessary

## Naming Conventions

| Element | Convention | Example |
|---------|-----------|---------|
| Files | kebab-case | `config-manager.ts` |
| Classes | PascalCase | `TunnelOrchestrator` |
| Functions/Methods | camelCase | `createTunnel` |
| Constants | UPPER_SNAKE_CASE | `DEFAULT_PORT` |
| Types/Interfaces | PascalCase | `TunnelConfig` |

## Imports

- **Always use `.js` extension for relative imports** (ESM requirement — this is not optional)
- Group imports in this order: external packages → internal modules → types
- Use `import type` for type-only imports

```typescript
// ✅ Do
import axios from 'axios';
import { CONFIG } from './config.js';
import type { TunnelConfig } from './types/index.js';

// ❌ Don't — missing .js extension
import { something } from './module';

// ❌ Don't — uses any
function process(data: any) { ... }
```

## Error Handling

- Use descriptive error messages with recovery hints
- Never swallow errors silently in user-facing code
- Use `chalk` for colored error output
- Include actionable guidance (e.g., "try chmod +x", "check port is in use")

## Console Output

- Use `chalk` for colors
- Use `ora` for spinners
- Use `lang.t()` for translatable user-facing strings
- Keep messages friendly and actionable

```typescript
// ✅ Do
console.log(chalk.green('✔ Success'));
console.log(lang.t('tunnelCreated'));

// ❌ Don't
console.log('tunnel created');
```
