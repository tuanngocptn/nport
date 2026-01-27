# Contributing to NPort

> Thank you for your interest in contributing to NPort! 🎉

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Coding Guidelines](#coding-guidelines)
- [Making Changes](#making-changes)
- [Testing](#testing)
- [Submitting a Pull Request](#submitting-a-pull-request)
- [Adding Translations](#adding-translations)
- [Reporting Issues](#reporting-issues)

---

## Code of Conduct

By participating in this project, you agree to be respectful and inclusive. We welcome contributors of all backgrounds and experience levels.

---

## Getting Started

### Prerequisites

- **Node.js** >= 20.0.0
- **npm** >= 10.0.0
- **Git**

### Fork and Clone

1. Fork the repository on GitHub
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/nport.git
   cd nport
   ```

3. Add upstream remote:
   ```bash
   git remote add upstream https://github.com/tuanngocptn/nport.git
   ```

---

## Development Setup

### Install Dependencies

```bash
npm install
```

### Build TypeScript

```bash
npm run build
```

### Development Mode

```bash
# Watch mode - recompiles on changes
npm run dev
```

### Run CLI Locally

```bash
# After building
node dist/index.js 3000 -s test
```

### Server Development (Cloudflare Worker)

```bash
cd server

# Install dependencies
npm install

# Run local development server
npm run dev

# Run tests
npm test
```

---

## Project Structure

```
nport/
├── src/                     # TypeScript source
│   ├── index.ts             # Entry point
│   ├── tunnel.ts            # Tunnel orchestration
│   ├── api.ts               # Backend API client
│   ├── args.ts              # CLI argument parser
│   ├── binary.ts            # Cloudflared manager
│   ├── types/               # Type definitions
│   └── ...
├── tests/                   # Unit tests
├── dist/                    # Compiled output
├── server/                  # Backend (Cloudflare Worker)
├── website/                 # Static landing page
└── docs/                    # Documentation
```

---

## Coding Guidelines

### TypeScript

- Use **strict TypeScript** with full type annotations
- Prefer `interface` over `type` for object shapes
- Use `type` for unions, intersections, and simple aliases
- Always import types with `import type { ... }`

### Naming Conventions

| Type | Convention | Example |
|------|------------|---------|
| Files | kebab-case | `config-manager.ts` |
| Classes | PascalCase | `TunnelOrchestrator` |
| Functions/Methods | camelCase | `createTunnel` |
| Constants | UPPER_SNAKE_CASE | `DEFAULT_PORT` |
| Types/Interfaces | PascalCase | `TunnelConfig` |

### Imports

```typescript
// Use .js extension for relative imports (ESM requirement)
import { state } from './state.js';

// Group imports: external, internal, types
import axios from 'axios';
import { CONFIG } from './config.js';
import type { TunnelConfig } from './types/index.js';
```

### Console Output

- Use `chalk` for colors
- Use `ora` for spinners
- Use `lang.t()` for translatable strings
- Keep messages user-friendly

```typescript
// Good
console.log(chalk.green(`✔ ${lang.t('tunnelCreated')}`));

// Avoid
console.log('tunnel created');
```

---

## Making Changes

### Branch Naming

- `feature/description` - New features
- `fix/description` - Bug fixes
- `docs/description` - Documentation changes
- `refactor/description` - Code refactoring

### Commit Messages

Follow conventional commits:

```
type(scope): brief description

[optional body]

[optional footer]
```

Examples:
```
feat(cli): add --timeout flag for custom tunnel duration
fix(api): handle network timeout gracefully
docs(readme): add troubleshooting section
refactor(binary): extract download logic to separate function
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`

---

## Testing

### Run Tests

```bash
# All tests
npm test

# Watch mode
npm run test:watch
```

### Adding Tests

Create test files in `tests/`:

```typescript
// tests/feature.test.ts
import { describe, it, expect } from 'vitest';
import { myFunction } from '../src/feature.js';

describe('Feature Name', () => {
  it('should do something', () => {
    expect(myFunction()).toBe(expected);
  });
});
```

### Manual CLI Testing

```bash
# Build first
npm run build

# Test basic tunnel creation
node dist/index.js 3000

# Test with custom subdomain
node dist/index.js 3000 -s mytest

# Test version flag
node dist/index.js -v

# Test language selection
node dist/index.js -l
```

---

## Submitting a Pull Request

1. **Update your fork**:
   ```bash
   git fetch upstream
   git rebase upstream/main
   ```

2. **Create a feature branch**:
   ```bash
   git checkout -b feature/my-feature
   ```

3. **Make your changes** and commit:
   ```bash
   git add .
   git commit -m "feat: add my feature"
   ```

4. **Push to your fork**:
   ```bash
   git push origin feature/my-feature
   ```

5. **Open a Pull Request** on GitHub

### PR Checklist

- [ ] Code follows project style guidelines
- [ ] Used TypeScript with proper types
- [ ] Self-reviewed my code
- [ ] Updated documentation if needed
- [ ] Added/updated tests
- [ ] All tests pass (`npm test`)
- [ ] No TypeScript errors (`npm run lint`)

---

## Adding Translations

NPort supports multiple languages. To add a new language:

### 1. Update Constants

Edit `src/constants.ts`:

```typescript
export const AVAILABLE_LANGUAGES = ['en', 'vi', 'es'] as const;
```

### 2. Add Type Definition

Edit `src/types/i18n.ts`:

```typescript
export type LanguageCode = 'en' | 'vi' | 'es';
```

### 3. Add Translations

Edit `src/lang.ts`:

```typescript
const TRANSLATIONS: Record<LanguageCode, TranslationKeys> = {
  en: { /* English */ },
  vi: { /* Vietnamese */ },
  es: {  // Your new language
    header: "N P O R T  ⚡️  Gratis y de código abierto",
    creatingTunnel: "Creando túnel para el puerto {port}...",
    tunnelLive: "🚀 ¡ESTAMOS EN VIVO!",
    // ... translate all keys
  },
};
```

### 4. Rebuild and Test

```bash
npm run build
node dist/index.js -l
```

---

## Reporting Issues

### Before Submitting

1. Check [existing issues](https://github.com/tuanngocptn/nport/issues)
2. Try the latest version: `npm install -g nport@latest`
3. Gather system info: Node version, OS, error messages

### Issue Template

```markdown
## Description
Brief description of the issue

## Steps to Reproduce
1. Run `nport 3000 -s test`
2. ...
3. See error

## Expected Behavior
What you expected to happen

## Actual Behavior
What actually happened

## Environment
- NPort version: `nport -v`
- Node version: `node -v`
- OS: macOS 14.0 / Ubuntu 22.04 / Windows 11

## Logs
```
Paste any error messages here
```
```

---

## Questions?

- 📧 Email: tuanngocptn@gmail.com
- 🐛 Issues: [GitHub Issues](https://github.com/tuanngocptn/nport/issues)
- 💬 Discussions: [GitHub Discussions](https://github.com/tuanngocptn/nport/discussions)

---

Made with ❤️ in Vietnam by [Nick Pham](https://github.com/tuanngocptn)
